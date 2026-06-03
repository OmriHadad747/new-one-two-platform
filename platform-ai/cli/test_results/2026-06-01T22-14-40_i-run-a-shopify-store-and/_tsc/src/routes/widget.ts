import { Request, Response, Router } from "express";
import { randomBytes } from "crypto";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import type {
  WaitlistEntryRow,
  WaitlistSnapshotRow,
  StorefrontProductQueryResponse,
  WidgetAvailabilityResponse,
  WidgetSignupPostRequest,
  WidgetSignupPostResponse,
  WidgetSignupGetResponse,
  WidgetUnsubscribeResponse,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── GET /widget/availability ────────────────────────────────────────────────
// Returns live availability for a product/variant so the widget decides
// whether to show the sign-up form.

widgetRouter.get("/widget/availability", async (req: Request, res: Response) => {
  const productExternalIdRaw = typeof req.query.product_external_id === "string"
    ? req.query.product_external_id
    : null;
  const variantExternalIdRaw = typeof req.query.variant_external_id === "string"
    ? req.query.variant_external_id
    : null;

  if (!productExternalIdRaw) {
    res.status(400).json({ error: "product_external_id is required" });
    return;
  }

  // Validate shape: numeric strings only
  if (!/^\d+$/.test(productExternalIdRaw)) {
    res.status(400).json({ error: "product_external_id must be a numeric string" });
    return;
  }
  if (variantExternalIdRaw !== null && !/^\d+$/.test(variantExternalIdRaw)) {
    res.status(400).json({ error: "variant_external_id must be a numeric string" });
    return;
  }

  const shopify = await shopifyClientFor(req.platform!);

  // Use Storefront API to get live availability
  const data = await shopify.storefront<StorefrontProductQueryResponse>(
    `query GetProduct($id: ID!) {
       product(id: $id) {
         id
         title
         variants(first: 100) {
           edges {
             node {
               id
               title
               availableForSale
             }
           }
         }
       }
     }`,
    { id: `gid://shopify/Product/${productExternalIdRaw}` },
  );

  if (!data.product) {
    res.status(404).json({ error: "product not found" });
    return;
  }

  const productTitle = data.product.title.replace(/\x00/g, "");
  let available = false;
  let variantLabel = "";

  if (variantExternalIdRaw) {
    // Look for the specific variant
    const variantGid = `gid://shopify/ProductVariant/${variantExternalIdRaw}`;
    const variantEdge = data.product.variants.edges.find(
      (e) => e.node.id === variantGid,
    );
    if (variantEdge) {
      available = variantEdge.node.availableForSale;
      variantLabel = variantEdge.node.title.replace(/\x00/g, "");
    }
  } else {
    // Product-level: available if ANY variant is in stock
    available = data.product.variants.edges.some((e) => e.node.availableForSale);
    variantLabel = "";
  }

  const response: WidgetAvailabilityResponse = {
    available,
    product_title: productTitle,
    variant_label: variantLabel,
  };

  res.status(200).json(response);
});

// ─── POST /widget/signup ─────────────────────────────────────────────────────
// Register a shopper's email on the waitlist for a sold-out item.

widgetRouter.post("/widget/signup", async (req: Request, res: Response) => {
  const body = req.body as Partial<WidgetSignupPostRequest>;

  const shopperEmail = typeof body.shopper_email === "string" ? body.shopper_email.trim() : null;
  const productExternalId = typeof body.product_external_id === "string" ? body.product_external_id : null;
  const variantExternalId = typeof body.variant_external_id === "string" ? body.variant_external_id : null;
  const scope = body.scope === "variant" || body.scope === "product" ? body.scope : null;

  if (!shopperEmail || !productExternalId || !scope) {
    res.status(400).json({ error: "shopper_email, product_external_id, and scope are required" });
    return;
  }

  if (!/^\d+$/.test(productExternalId)) {
    res.status(400).json({ error: "product_external_id must be a numeric string" });
    return;
  }
  if (variantExternalId !== null && !/^\d+$/.test(variantExternalId)) {
    res.status(400).json({ error: "variant_external_id must be a numeric string" });
    return;
  }
  if (scope === "variant" && !variantExternalId) {
    res.status(400).json({ error: "variant_external_id required when scope is variant" });
    return;
  }

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shopperEmail)) {
    res.status(400).json({ error: "invalid email address" });
    return;
  }

  const safeEmail = shopperEmail.replace(/\x00/g, "");

  // Check for existing active entry (dedup)
  const existing = await sql<Pick<WaitlistEntryRow, "id">[]>`
    SELECT id FROM waitlist_entries
    WHERE shopper_email = ${safeEmail}
      AND product_external_id = ${productExternalId}
      AND variant_external_id IS NOT DISTINCT FROM ${variantExternalId}
      AND deleted_at IS NULL
    LIMIT 1
  `;

  if (existing.length > 0) {
    const response: WidgetSignupPostResponse = {
      already_registered: true,
      message: "You're already on the waitlist for this item.",
    };
    res.status(200).json(response);
    return;
  }

  // Generate unsubscribe token
  const unsubscribeToken = randomBytes(24).toString("hex");

  // Insert new waitlist entry — use ON CONFLICT for race safety
  await sql`
    INSERT INTO waitlist_entries (
      shopper_email,
      product_external_id,
      variant_external_id,
      scope,
      unsubscribe_token,
      status
    ) VALUES (
      ${safeEmail},
      ${productExternalId},
      ${variantExternalId},
      ${scope},
      ${unsubscribeToken},
      'active'
    )
    ON CONFLICT (shopper_email, product_external_id, variant_external_id) DO NOTHING
  `;

  // Fetch product title for snapshot (from Storefront)
  let productTitle = "";
  try {
    const shopify = await shopifyClientFor(req.platform!);
    const data = await shopify.storefront<StorefrontProductQueryResponse>(
      `query GetProductTitle($id: ID!) {
         product(id: $id) {
           id
           title
           variants(first: 1) {
             edges {
               node { id title availableForSale }
             }
           }
         }
       }`,
      { id: `gid://shopify/Product/${productExternalId}` },
    );
    productTitle = (data.product?.title ?? "").replace(/\x00/g, "");
  } catch {
    productTitle = "Unknown Product";
  }

  // Upsert snapshot — increment active_entry_count
  await sql`
    INSERT INTO waitlist_snapshots (
      product_external_id,
      product_title,
      active_entry_count,
      total_notified_count,
      total_conversion_count,
      last_updated_at
    ) VALUES (
      ${productExternalId},
      ${productTitle},
      1,
      0,
      0,
      now()
    )
    ON CONFLICT (product_external_id) DO UPDATE SET
      active_entry_count = waitlist_snapshots.active_entry_count + 1,
      product_title = EXCLUDED.product_title,
      last_updated_at = now()
  `;

  console.log(
    { requestId: req.platform!.requestId, product_external_id: productExternalId, scope },
    "waitlist signup recorded",
  );

  const response: WidgetSignupPostResponse = {
    already_registered: false,
    message: "You're on the list! We'll email you when it's back in stock.",
  };
  res.status(201).json(response);
});

// ─── GET /widget/signup ──────────────────────────────────────────────────────
// Check whether a given email is already on the waitlist for an item.

widgetRouter.get("/widget/signup", async (req: Request, res: Response) => {
  const shopperEmail = typeof req.query.shopper_email === "string" ? req.query.shopper_email : null;
  const productExternalId = typeof req.query.product_external_id === "string" ? req.query.product_external_id : null;
  const variantExternalId = typeof req.query.variant_external_id === "string" ? req.query.variant_external_id : null;

  if (!shopperEmail || !productExternalId) {
    res.status(400).json({ error: "shopper_email and product_external_id are required" });
    return;
  }

  if (!/^\d+$/.test(productExternalId)) {
    res.status(400).json({ error: "product_external_id must be a numeric string" });
    return;
  }
  if (variantExternalId !== null && !/^\d+$/.test(variantExternalId)) {
    res.status(400).json({ error: "variant_external_id must be a numeric string" });
    return;
  }

  const existing = await sql<Pick<WaitlistEntryRow, "id">[]>`
    SELECT id FROM waitlist_entries
    WHERE shopper_email = ${shopperEmail}
      AND product_external_id = ${productExternalId}
      AND variant_external_id IS NOT DISTINCT FROM ${variantExternalId}
      AND deleted_at IS NULL
      AND status != 'removed'
    LIMIT 1
  `;

  const response: WidgetSignupGetResponse = { registered: existing.length > 0 };
  res.status(200).json(response);
});

// ─── POST /widget/unsubscribe ────────────────────────────────────────────────
// Remove a shopper from all their waitlist entries using their token.

widgetRouter.post("/widget/unsubscribe", async (req: Request, res: Response) => {
  const unsubscribeToken = typeof req.body.unsubscribe_token === "string"
    ? req.body.unsubscribe_token
    : null;

  if (!unsubscribeToken) {
    res.status(400).json({ error: "unsubscribe_token is required" });
    return;
  }

  // Find all non-removed entries for this token
  const entriesToRemove = await sql<Pick<WaitlistEntryRow, "id" | "product_external_id">[]>`
    SELECT id, product_external_id FROM waitlist_entries
    WHERE unsubscribe_token = ${unsubscribeToken}
      AND status != 'removed'
      AND deleted_at IS NULL
  `;

  if (entriesToRemove.length === 0) {
    const response: WidgetUnsubscribeResponse = { success: true, entries_removed: 0 };
    res.status(200).json(response);
    return;
  }

  const entryIds = entriesToRemove.map((e) => e.id);

  // Tombstone all entries
  await sql`
    UPDATE waitlist_entries
    SET
      status = 'removed',
      deleted_at = now()
    WHERE id = ANY(${entryIds})
  `;

  // Update snapshot counts — decrement active_entry_count per product
  // Group by product_external_id for snapshot updates
  const productCounts = new Map<string, number>();
  for (const entry of entriesToRemove) {
    const pid = String(entry.product_external_id);
    productCounts.set(pid, (productCounts.get(pid) ?? 0) + 1);
  }

  for (const [productExternalId, count] of productCounts) {
    await sql`
      UPDATE waitlist_snapshots
      SET
        active_entry_count = GREATEST(0, active_entry_count - ${count}),
        last_updated_at = now()
      WHERE product_external_id = ${productExternalId}
    `;
  }

  console.log(
    { requestId: req.platform!.requestId, entries_removed: entriesToRemove.length },
    "unsubscribe processed",
  );

  const response: WidgetUnsubscribeResponse = {
    success: true,
    entries_removed: entriesToRemove.length,
  };
  res.status(200).json(response);
});

// Suppress unused import
void (null as unknown as WaitlistSnapshotRow);
