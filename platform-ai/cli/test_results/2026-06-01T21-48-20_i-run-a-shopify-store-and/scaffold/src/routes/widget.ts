import { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { widgetRouter } from "../lib/router.js";
import crypto from "crypto";
import {
  VariantAvailabilityRow,
  WaitlistSignupRow,
  VariantExternalId,
  ProductExternalId,
  WidgetStatusResponse,
  WidgetSignupResponse,
  WidgetUnsubscribeResponse,
} from "../types/contracts.js";

// ─── GET /widget/status ───────────────────────────────────────────────────────
widgetRouter.get("/widget/status", async (req: Request, res: Response) => {
  // Validate query params
  const variantExternalId =
    typeof req.query.variant_external_id === "string"
      ? (req.query.variant_external_id as VariantExternalId)
      : null;

  const productExternalId =
    typeof req.query.product_external_id === "string"
      ? (req.query.product_external_id as ProductExternalId)
      : null;

  const email =
    typeof req.query.email === "string" ? req.query.email : null;

  if (!variantExternalId || !productExternalId) {
    res.status(400).json({ error: "variant_external_id and product_external_id are required" });
    return;
  }

  // Validate that variant_external_id and product_external_id are numeric strings
  if (!/^\d+$/.test(variantExternalId) || !/^\d+$/.test(productExternalId)) {
    res.status(400).json({ error: "ids must be numeric strings" });
    return;
  }

  // Check availability state from variant_availability table
  const [availRow] = await sql<VariantAvailabilityRow[]>`
    SELECT availability_state
    FROM variant_availability
    WHERE variant_external_id = ${variantExternalId}
    LIMIT 1
  `;

  // If no row in variant_availability, assume in stock (widget should not show)
  const isOutOfStock = availRow?.availability_state === "out_of_stock";

  // Check variant_title from signups (may not exist yet)
  const [signupSample] = await sql<{ variant_title: string }[]>`
    SELECT variant_title
    FROM waitlist_signups
    WHERE variant_external_id = ${variantExternalId}
    LIMIT 1
  `;
  const variantTitle = signupSample?.variant_title ?? "Default Title";

  // Check if the email is already signed up
  let alreadySignedUp = false;
  if (email) {
    const [existing] = await sql<{ id: string }[]>`
      SELECT id
      FROM waitlist_signups
      WHERE shopper_email = ${email}
        AND variant_external_id = ${variantExternalId}
        AND status = 'active'
      LIMIT 1
    `;
    alreadySignedUp = existing != null;
  }

  const response: WidgetStatusResponse = {
    is_out_of_stock: isOutOfStock,
    already_signed_up: alreadySignedUp,
    variant_title: variantTitle,
  };

  res.json(response);
});

// ─── POST /widget/signups ─────────────────────────────────────────────────────
widgetRouter.post("/widget/signups", async (req: Request, res: Response) => {
  const shopperEmail =
    typeof req.body.shopper_email === "string" ? req.body.shopper_email.trim() : null;
  const variantExternalId =
    typeof req.body.variant_external_id === "string"
      ? (req.body.variant_external_id as VariantExternalId)
      : null;
  const productExternalId =
    typeof req.body.product_external_id === "string"
      ? (req.body.product_external_id as ProductExternalId)
      : null;

  if (!shopperEmail || !variantExternalId || !productExternalId) {
    res.status(400).json({ success: false, message: "shopper_email, variant_external_id, and product_external_id are required" });
    return;
  }

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shopperEmail)) {
    res.status(400).json({ success: false, message: "Invalid email address" });
    return;
  }

  // Validate ids are numeric
  if (!/^\d+$/.test(variantExternalId) || !/^\d+$/.test(productExternalId)) {
    res.status(400).json({ success: false, message: "ids must be numeric strings" });
    return;
  }

  // Get product/variant titles from the storefront — we need denormalized data.
  // Since the widget doesn't have product info in the request, we'll look for
  // existing signups for this variant to get titles, or fall back to placeholders
  // that the merchant can see in the admin. The widget route gets product/variant
  // titles from existing signups if available; otherwise we use the variant id as title.
  const [existingSample] = await sql<{ product_title: string; variant_title: string; product_url: string }[]>`
    SELECT product_title, variant_title, product_url
    FROM waitlist_signups
    WHERE variant_external_id = ${variantExternalId}
    LIMIT 1
  `;

  // If we have no prior signups, we need product context. The widget should
  // pass product_title, variant_title, and product_url. We'll accept them
  // from the request body if provided.
  const productTitle = (
    typeof req.body.product_title === "string"
      ? req.body.product_title.replace(/\0/g, "")
      : existingSample?.product_title ?? ""
  );

  const variantTitle = (
    typeof req.body.variant_title === "string"
      ? req.body.variant_title.replace(/\0/g, "")
      : existingSample?.variant_title ?? "Default Title"
  );

  const productUrl = (
    typeof req.body.product_url === "string"
      ? req.body.product_url.replace(/\0/g, "")
      : existingSample?.product_url ?? ""
  );

  // Generate a unique unsubscribe token
  const unsubscribeToken = crypto.randomBytes(32).toString("hex");

  // Idempotent insert — ON CONFLICT does nothing (same email + variant)
  await sql`
    INSERT INTO waitlist_signups
      (shopper_email, variant_external_id, product_external_id,
       product_title, variant_title, product_url,
       unsubscribe_token, status, signed_up_at)
    VALUES
      (${shopperEmail}, ${variantExternalId}, ${productExternalId},
       ${productTitle}, ${variantTitle}, ${productUrl},
       ${unsubscribeToken}, 'active', now())
    ON CONFLICT (shopper_email, variant_external_id) DO NOTHING
  `;

  // Upsert demand snapshot — increment active_signup_count only if signup was new
  // We do this safely: recount from source of truth
  await sql`
    INSERT INTO demand_snapshots
      (variant_external_id, product_external_id, product_title, variant_title,
       active_signup_count, total_notified, total_converted, snapshot_updated_at)
    VALUES
      (${variantExternalId}, ${productExternalId}, ${productTitle}, ${variantTitle},
       1, 0, 0, now())
    ON CONFLICT (variant_external_id) DO UPDATE
      SET active_signup_count = (
            SELECT COUNT(*)
            FROM waitlist_signups
            WHERE variant_external_id = ${variantExternalId}
              AND status = 'active'
              AND deleted_at IS NULL
          ),
          snapshot_updated_at = now()
  `;

  const response: WidgetSignupResponse = {
    success: true,
    message: "You're on the list! We'll email you when this item is back in stock.",
  };

  res.status(201).json(response);
});

// ─── POST /widget/unsubscribe ─────────────────────────────────────────────────
widgetRouter.post("/widget/unsubscribe", async (req: Request, res: Response) => {
  const unsubscribeToken =
    typeof req.body.unsubscribe_token === "string"
      ? req.body.unsubscribe_token.trim()
      : null;

  if (!unsubscribeToken) {
    res.status(400).json({ success: false, error: "unsubscribe_token is required" });
    return;
  }

  // Find the signup with this token
  const [signup] = await sql<WaitlistSignupRow[]>`
    SELECT *
    FROM waitlist_signups
    WHERE unsubscribe_token = ${unsubscribeToken}
    LIMIT 1
  `;

  if (!signup) {
    // Return success even if token not found (idempotent)
    const response: WidgetUnsubscribeResponse = { success: true };
    res.json(response);
    return;
  }

  // Unsubscribe all active signups for this shopper's email
  await sql`
    UPDATE waitlist_signups
    SET status = 'unsubscribed'
    WHERE shopper_email = ${signup.shopper_email}
      AND status = 'active'
  `;

  console.log(
    {
      requestId: req.platform!.requestId,
      email: signup.shopper_email,
      token: unsubscribeToken,
    },
    "shopper unsubscribed from all waitlists"
  );

  const response: WidgetUnsubscribeResponse = { success: true };
  res.json(response);
});
