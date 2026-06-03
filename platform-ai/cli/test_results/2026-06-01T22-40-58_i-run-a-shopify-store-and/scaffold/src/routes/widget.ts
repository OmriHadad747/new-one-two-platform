import { Request, Response, Router } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { randomBytes } from "crypto";
import type {
  ItemScope,
  WaitlistEntryRow,
  WidgetAvailabilityResponse,
  WidgetSignupCheckResponse,
  WidgetSignupRequest,
  WidgetSignupResponse,
  WidgetUnsubscribeResponse,
  StorefrontProduct,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── GET /widget/availability ────────────────────────────────────────────────
// Returns whether a given product or variant is currently sold out.
widgetRouter.get("/widget/availability", async (req: Request, res: Response): Promise<void> => {
  const itemExternalIdRaw = typeof req.query.item_external_id === "string"
    ? req.query.item_external_id
    : null;
  const itemScopeRaw = typeof req.query.item_scope === "string"
    ? req.query.item_scope
    : null;

  if (!itemExternalIdRaw || !itemScopeRaw) {
    res.status(400).json({ error: "item_external_id and item_scope are required" });
    return;
  }

  const itemExternalId = parseInt(itemExternalIdRaw, 10);
  if (isNaN(itemExternalId)) {
    res.status(400).json({ error: "item_external_id must be a numeric id" });
    return;
  }

  if (itemScopeRaw !== "variant" && itemScopeRaw !== "product") {
    res.status(400).json({ error: "item_scope must be 'variant' or 'product'" });
    return;
  }
  const itemScope: ItemScope = itemScopeRaw;

  const shopify = await shopifyClientFor(req.platform!);

  if (itemScope === "product") {
    // Query product-level availability via Storefront API
    const data = await shopify.storefront<{ product: StorefrontProduct | null }>(
      `query GetProductAvailability($id: ID!) {
         product(id: $id) {
           id
           title
           availableForSale
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
      { id: `gid://shopify/Product/${itemExternalId}` },
    );

    if (!data.product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const sold_out = !data.product.availableForSale;
    const response: WidgetAvailabilityResponse = {
      sold_out,
      item_title: data.product.title.replace(/\x00/g, ""),
      item_scope: "product",
    };
    res.json(response);
    return;
  }

  // variant scope — query variant availability via Storefront API
  const data = await shopify.storefront<{
    node: { id: string; title: string; availableForSale: boolean; product: { title: string } } | null;
  }>(
    `query GetVariantAvailability($id: ID!) {
       node(id: $id) {
         ... on ProductVariant {
           id
           title
           availableForSale
           product { title }
         }
       }
     }`,
    { id: `gid://shopify/ProductVariant/${itemExternalId}` },
  );

  if (!data.node) {
    res.status(404).json({ error: "Variant not found" });
    return;
  }

  const variantNode = data.node;
  const sold_out = !variantNode.availableForSale;
  const variantTitle = variantNode.title.replace(/\x00/g, "");
  const productTitle = variantNode.product.title.replace(/\x00/g, "");
  const item_title = variantTitle === "Default Title" ? productTitle : `${productTitle} - ${variantTitle}`;

  const response: WidgetAvailabilityResponse = {
    sold_out,
    item_title,
    item_scope: "variant",
  };
  res.json(response);
});

// ─── GET /widget/signup ──────────────────────────────────────────────────────
// Check if a given email is already on the waitlist for an item.
widgetRouter.get("/widget/signup", async (req: Request, res: Response): Promise<void> => {
  const email = typeof req.query.email === "string" ? req.query.email : null;
  const itemExternalIdRaw = typeof req.query.item_external_id === "string"
    ? req.query.item_external_id
    : null;
  const itemScopeRaw = typeof req.query.item_scope === "string"
    ? req.query.item_scope
    : null;

  if (!email || !itemExternalIdRaw || !itemScopeRaw) {
    res.status(400).json({ error: "email, item_external_id, and item_scope are required" });
    return;
  }

  const itemExternalId = parseInt(itemExternalIdRaw, 10);
  if (isNaN(itemExternalId)) {
    res.status(400).json({ error: "item_external_id must be a numeric id" });
    return;
  }

  if (itemScopeRaw !== "variant" && itemScopeRaw !== "product") {
    res.status(400).json({ error: "item_scope must be 'variant' or 'product'" });
    return;
  }

  const [row] = await sql<WaitlistEntryRow[]>`
    SELECT id, queue_position, status
    FROM waitlist_entries
    WHERE email = ${email}
      AND item_external_id = ${itemExternalId}
  `;

  if (!row) {
    const response: WidgetSignupCheckResponse = {
      already_signed_up: false,
      queue_position: null,
    };
    res.json(response);
    return;
  }

  const response: WidgetSignupCheckResponse = {
    already_signed_up: true,
    queue_position: row.queue_position,
  };
  res.json(response);
});

// ─── POST /widget/signup ─────────────────────────────────────────────────────
// Register a shopper's email on the waitlist for a sold-out item.
widgetRouter.post("/widget/signup", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<Record<string, unknown>>;

  if (!body.email || typeof body.email !== "string") {
    res.status(400).json({ error: "email is required" });
    return;
  }
  if (!body.item_external_id || typeof body.item_external_id !== "string") {
    res.status(400).json({ error: "item_external_id must be a string numeric id" });
    return;
  }
  if (body.item_scope !== "variant" && body.item_scope !== "product") {
    res.status(400).json({ error: "item_scope must be 'variant' or 'product'" });
    return;
  }
  if (!body.product_external_id || typeof body.product_external_id !== "string") {
    res.status(400).json({ error: "product_external_id is required" });
    return;
  }

  const email = body.email.replace(/\x00/g, "");
  const itemExternalId = parseInt(body.item_external_id, 10);
  if (isNaN(itemExternalId)) {
    res.status(400).json({ error: "item_external_id must be a numeric id" });
    return;
  }
  const itemScope: ItemScope = body.item_scope;
  const productExternalId = parseInt(body.product_external_id, 10);
  if (isNaN(productExternalId)) {
    res.status(400).json({ error: "product_external_id must be a numeric id" });
    return;
  }

  // Compute next queue position within this item
  const [countRow] = await sql<{ max_pos: number | null }[]>`
    SELECT MAX(queue_position) AS max_pos
    FROM waitlist_entries
    WHERE item_external_id = ${itemExternalId}
  `;
  const nextQueuePosition = (countRow?.max_pos ?? 0) + 1;

  const unsubscribeToken = randomBytes(32).toString("hex");

  // Idempotent insert — ON CONFLICT on (email, item_external_id)
  const [inserted] = await sql<{ id: string; queue_position: number; existed: boolean }[]>`
    INSERT INTO waitlist_entries
      (email, item_external_id, item_scope, product_external_id, queue_position, status, unsubscribe_token)
    VALUES
      (${email}, ${itemExternalId}, ${itemScope}, ${productExternalId}, ${nextQueuePosition}, 'active', ${unsubscribeToken})
    ON CONFLICT (email, item_external_id) DO UPDATE
      SET email = EXCLUDED.email  -- no-op update to trigger RETURNING
    RETURNING id, queue_position, (xmax <> 0) AS existed
  `;

  if (!inserted) {
    res.status(500).json({ error: "Failed to register signup" });
    return;
  }

  const response: WidgetSignupResponse = {
    success: true,
    queue_position: inserted.queue_position,
    already_existed: Boolean(inserted.existed),
  };
  res.json(response);
});

// ─── POST /widget/unsubscribe ────────────────────────────────────────────────
// Remove a shopper from all active waitlists via unsubscribe token.
widgetRouter.post("/widget/unsubscribe", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<{ unsubscribe_token: string }>;
  const token = body.unsubscribe_token;

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "unsubscribe_token is required" });
    return;
  }

  // Fetch email for this token
  const [tokenRow] = await sql<{ email: string }[]>`
    SELECT email
    FROM waitlist_entries
    WHERE unsubscribe_token = ${token}
    LIMIT 1
  `;

  if (!tokenRow) {
    // Token not found — still return success (idempotent)
    const response: WidgetUnsubscribeResponse = { success: true, removed_count: 0 };
    res.json(response);
    return;
  }

  // Mark all active entries for this email as unsubscribed
  const updated = await sql<{ id: string }[]>`
    UPDATE waitlist_entries
    SET status = 'unsubscribed'
    WHERE email = ${tokenRow.email}
      AND status = 'active'
    RETURNING id
  `;

  const response: WidgetUnsubscribeResponse = {
    success: true,
    removed_count: updated.length,
  };
  res.json(response);
});
