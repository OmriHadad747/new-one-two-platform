import { Router } from "express";
import type { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import crypto from "crypto";
import type {
  WidgetAvailabilityResponse,
  WidgetSignupStatusResponse,
  WidgetSignupRequest,
  WidgetSignupResponse,
  WidgetUnsubscribeRequest,
  WidgetUnsubscribeResponse,
  StorefrontProductQueryResult,
  SignupLevel,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── GET /widget/availability ─────────────────────────────────────────────────

widgetRouter.get("/widget/availability", async (req: Request, res: Response): Promise<void> => {
  const productIdRaw = typeof req.query.product_id === "string" ? req.query.product_id : null;
  const variantIdRaw = typeof req.query.variant_id === "string" ? req.query.variant_id : null;

  if (!productIdRaw) {
    res.status(400).json({ error: "product_id is required" });
    return;
  }

  if (!/^\d+$/.test(productIdRaw)) {
    res.status(400).json({ error: "product_id must be a numeric string" });
    return;
  }

  if (variantIdRaw !== null && !/^\d+$/.test(variantIdRaw)) {
    res.status(400).json({ error: "variant_id must be a numeric string" });
    return;
  }

  try {
    const shopify = await shopifyClientFor(req.platform!);

    // productIdRaw is a validated numeric string (Shopify product ID from the storefront page).
    // The storefront API accepts a product GID. The numeric ID originates from Shopify's own
    // page data (liquid template), so we format it as a GID to satisfy the API's ID type.
    const productGid = `gid://shopify/Product/${productIdRaw}`;

    const data = await shopify.storefront<StorefrontProductQueryResult>(
      `query CheckAvailability($id: ID!) {
         product(id: $id) {
           id
           title
           availableForSale
           variants(first: 250) {
             nodes {
               id
               availableForSale
               selectedOptions {
                 name
                 value
               }
             }
           }
         }
       }`,
      { id: productGid },
    );

    if (!data.product) {
      res.status(404).json({ error: "product not found" });
      return;
    }

    let available: boolean;
    let signupLevel: SignupLevel;

    if (variantIdRaw) {
      const variantGid = `gid://shopify/ProductVariant/${variantIdRaw}`;
      const variant = data.product.variants.nodes.find((v) => v.id === variantGid);
      if (!variant) {
        res.status(404).json({ error: "variant not found" });
        return;
      }
      available = variant.availableForSale;
      signupLevel = "variant";
    } else {
      available = data.product.availableForSale;
      signupLevel = "product";
    }

    const response: WidgetAvailabilityResponse = { available, signup_level: signupLevel };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "availability check failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── GET /widget/signup-status ────────────────────────────────────────────────

widgetRouter.get("/widget/signup-status", async (req: Request, res: Response): Promise<void> => {
  const productIdRaw = typeof req.query.product_id === "string" ? req.query.product_id : null;
  const variantIdRaw = typeof req.query.variant_id === "string" ? req.query.variant_id : null;
  const email = typeof req.query.email === "string" ? req.query.email : null;

  if (!productIdRaw || !email) {
    res.status(400).json({ error: "product_id and email are required" });
    return;
  }

  if (!/^\d+$/.test(productIdRaw)) {
    res.status(400).json({ error: "product_id must be a numeric string" });
    return;
  }

  if (variantIdRaw !== null && !/^\d+$/.test(variantIdRaw)) {
    res.status(400).json({ error: "variant_id must be a numeric string" });
    return;
  }

  try {
    const safeEmail = email.replace(/\0/g, "").trim().toLowerCase();

    let rows: { id: string }[];
    if (variantIdRaw !== null) {
      rows = await sql<{ id: string }[]>`
        SELECT id FROM waitlist_entries
        WHERE shopper_email = ${safeEmail}
        AND product_external_id = ${productIdRaw}::bigint
        AND variant_external_id = ${variantIdRaw}::bigint
        AND status != 'unsubscribed'
        LIMIT 1
      `;
    } else {
      rows = await sql<{ id: string }[]>`
        SELECT id FROM waitlist_entries
        WHERE shopper_email = ${safeEmail}
        AND product_external_id = ${productIdRaw}::bigint
        AND variant_external_id IS NULL
        AND status != 'unsubscribed'
        LIMIT 1
      `;
    }

    const response: WidgetSignupStatusResponse = { already_signed_up: rows.length > 0 };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "signup-status check failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── POST /widget/signup ──────────────────────────────────────────────────────

widgetRouter.post("/widget/signup", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<WidgetSignupRequest>;

  const productIdRaw = typeof body.product_id === "string" ? body.product_id : null;
  const variantIdRaw = typeof body.variant_id === "string" ? body.variant_id : null;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
  const itemDisplayName = typeof body.item_display_name === "string" ? body.item_display_name.trim() : null;
  const itemPageUrl = typeof body.item_page_url === "string" ? body.item_page_url.trim() : null;
  const signupLevel = typeof body.signup_level === "string" ? body.signup_level : null;

  if (!productIdRaw || !email || !itemDisplayName || !itemPageUrl || !signupLevel) {
    res.status(400).json({ error: "product_id, email, item_display_name, item_page_url, signup_level are required" });
    return;
  }

  if (!/^\d+$/.test(productIdRaw)) {
    res.status(400).json({ error: "product_id must be a numeric string" });
    return;
  }

  if (variantIdRaw !== null && !/^\d+$/.test(variantIdRaw)) {
    res.status(400).json({ error: "variant_id must be a numeric string" });
    return;
  }

  if (signupLevel !== "variant" && signupLevel !== "product") {
    res.status(400).json({ error: "signup_level must be 'variant' or 'product'" });
    return;
  }

  // For product-level signups, variant_id must NOT be present
  if (signupLevel === "product" && variantIdRaw !== null) {
    res.status(400).json({ error: "variant_id must not be provided for product-level signups" });
    return;
  }

  // For variant-level signups, variant_id is required
  if (signupLevel === "variant" && variantIdRaw === null) {
    res.status(400).json({ error: "variant_id is required for variant-level signups" });
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "invalid email address" });
    return;
  }

  try {
    const safeDisplayName = itemDisplayName.replace(/\0/g, "");
    const safeUrl = itemPageUrl.replace(/\0/g, "");
    const safeEmail = email.replace(/\0/g, "");

    const unsubscribeToken = crypto.randomBytes(32).toString("hex");

    // Atomically insert; ON CONFLICT handles duplicates without a pre-check race
    let insertedRows: { id: string }[];
    if (variantIdRaw !== null) {
      insertedRows = await sql<{ id: string }[]>`
        INSERT INTO waitlist_entries (
          shopper_email, product_external_id, variant_external_id,
          item_display_name, item_page_url, signup_level, status,
          unsubscribe_token, signed_up_at
        ) VALUES (
          ${safeEmail}, ${productIdRaw}::bigint, ${variantIdRaw}::bigint,
          ${safeDisplayName}, ${safeUrl}, ${signupLevel}, 'active',
          ${unsubscribeToken}, now()
        )
        ON CONFLICT (shopper_email, product_external_id, variant_external_id) DO NOTHING
        RETURNING id
      `;
    } else {
      insertedRows = await sql<{ id: string }[]>`
        INSERT INTO waitlist_entries (
          shopper_email, product_external_id, variant_external_id,
          item_display_name, item_page_url, signup_level, status,
          unsubscribe_token, signed_up_at
        ) VALUES (
          ${safeEmail}, ${productIdRaw}::bigint, NULL,
          ${safeDisplayName}, ${safeUrl}, ${signupLevel}, 'active',
          ${unsubscribeToken}, now()
        )
        ON CONFLICT (shopper_email, product_external_id, variant_external_id) DO NOTHING
        RETURNING id
      `;
    }

    // RETURNING id is empty when DO NOTHING fired — that means already signed up
    const alreadySignedUp = insertedRows.length === 0;

    if (!alreadySignedUp) {

      // Upsert dashboard snapshot
      if (variantIdRaw !== null) {
        await sql`
          INSERT INTO dashboard_snapshots (
            product_external_id, variant_external_id, item_display_name,
            active_waitlist_count, total_signups, total_notified, total_conversions,
            snapshot_updated_at
          ) VALUES (
            ${productIdRaw}::bigint, ${variantIdRaw}::bigint, ${safeDisplayName},
            1, 1, 0, 0, now()
          )
          ON CONFLICT (product_external_id, variant_external_id) DO UPDATE SET
            active_waitlist_count = dashboard_snapshots.active_waitlist_count + 1,
            total_signups = dashboard_snapshots.total_signups + 1,
            item_display_name = EXCLUDED.item_display_name,
            snapshot_updated_at = now()
        `;
      } else {
        // Product-level snapshot: NULL variant — use explicit SELECT+UPDATE/INSERT for correctness
        // (PostgreSQL unique constraints do not match NULL values, so ON CONFLICT won't fire)
        const [existingProductSnap] = await sql<{ id: string; active_waitlist_count: number; total_signups: number }[]>`
          SELECT id, active_waitlist_count, total_signups
          FROM dashboard_snapshots
          WHERE product_external_id = ${productIdRaw}::bigint
          AND variant_external_id IS NULL
          LIMIT 1
        `;
        if (existingProductSnap) {
          await sql`
            UPDATE dashboard_snapshots
            SET active_waitlist_count = ${existingProductSnap.active_waitlist_count + 1},
                total_signups = ${existingProductSnap.total_signups + 1},
                item_display_name = ${safeDisplayName},
                snapshot_updated_at = now()
            WHERE id = ${existingProductSnap.id}
          `;
        } else {
          await sql`
            INSERT INTO dashboard_snapshots (
              product_external_id, variant_external_id, item_display_name,
              active_waitlist_count, total_signups, total_notified, total_conversions,
              snapshot_updated_at
            ) VALUES (
              ${productIdRaw}::bigint, NULL, ${safeDisplayName},
              1, 1, 0, 0, now()
            )
          `;
        }
      }
    }

    const response: WidgetSignupResponse = { success: true, already_signed_up: alreadySignedUp };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "signup failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── POST /widget/unsubscribe ──────────────────────────────────────────────────

widgetRouter.post("/widget/unsubscribe", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<WidgetUnsubscribeRequest>;
  const token = typeof body.token === "string" ? body.token.trim() : null;

  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  try {
    const safeToken = token.replace(/\0/g, "");

    const [entry] = await sql<{ id: string; shopper_email: string }[]>`
      SELECT id, shopper_email
      FROM waitlist_entries
      WHERE unsubscribe_token = ${safeToken}
      LIMIT 1
    `;

    if (!entry) {
      // Token not found — return success to avoid token enumeration
      const response: WidgetUnsubscribeResponse = { success: true };
      res.json(response);
      return;
    }

    const safeEmail = entry.shopper_email.replace(/\0/g, "");

    await sql`
      UPDATE waitlist_entries
      SET status = 'unsubscribed'
      WHERE shopper_email = ${safeEmail}
      AND status IN ('active', 'notified')
    `;

    const response: WidgetUnsubscribeResponse = { success: true };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "unsubscribe failed");
    res.status(500).json({ error: "internal error" });
  }
});
