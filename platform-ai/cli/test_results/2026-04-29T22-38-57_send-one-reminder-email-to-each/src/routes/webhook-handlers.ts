import type { Request } from "express";
import type { WebhookHandler } from "./webhook-handlers.js";
import { sql } from "../lib/db.js";

interface CheckoutPayload {
  token?: string;
  id?: number | string;
  email?: string;
  customer?: {
    id?: number | string;
    first_name?: string;
    last_name?: string;
  } | null;
  total_price?: string;
  presentment_currency?: string;
  abandoned_checkout_url?: string | null;
  line_items?: unknown[];
  updated_at?: string;
  completed_at?: string | null;
}

export const webhookHandlers: Record<string, WebhookHandler> = {
  "checkouts/create": async (payload, req) => {
    const p = (payload ?? {}) as CheckoutPayload;
    const requestId = req.platform!.requestId;
    const shopDomain = req.platform!.shopDomain;

    const checkoutToken = p.token ?? null;
    const shopifyCheckoutId = p.id != null ? String(p.id) : null;

    console.log(
      { requestId, topic: "checkouts/create", checkoutToken, shopifyCheckoutId },
      "webhook received",
    );

    if (!checkoutToken || !shopifyCheckoutId) {
      console.warn({ requestId, topic: "checkouts/create" }, "missing token or id, skipping");
      return;
    }

    const customerEmail = (p.email ?? p.customer?.email ?? null) as string | null;
    const customerId = p.customer?.id != null ? String(p.customer.id) : null;
    const firstName = p.customer?.first_name ?? null;
    const lastName = p.customer?.last_name ?? null;
    const customerDisplayName =
      firstName || lastName ? `${firstName ?? ""} ${lastName ?? ""}`.trim() : null;

    const totalPriceCents =
      p.total_price != null ? Math.round(parseFloat(p.total_price) * 100) : 0;
    const currency = p.presentment_currency ?? "USD";

    let recoveryUrl: string | null = p.abandoned_checkout_url ?? null;
    if (!recoveryUrl && checkoutToken) {
      recoveryUrl = `https://${shopDomain}/checkout/recover/${checkoutToken}`;
    }

    const lineItemsJson = JSON.stringify(p.line_items ?? []);
    const lastActivityAt = p.updated_at ?? new Date().toISOString();
    const isCompleted = p.completed_at != null && p.completed_at !== "";

    let status: string;
    let ineligibleReason: string | null = null;

    if (isCompleted) {
      status = "recovered";
    } else if (!customerEmail) {
      status = "ineligible";
      ineligibleReason = "no_email";
    } else {
      status = "pending";
    }

    const safeLineItemsJson = lineItemsJson.replace(/\u0000/g, "");
    const safeCustomerDisplayName = customerDisplayName
      ? customerDisplayName.replace(/\u0000/g, "")
      : null;
    const safeRecoveryUrl = recoveryUrl ? recoveryUrl.replace(/\u0000/g, "") : null;
    const safeCustomerEmail = customerEmail ? customerEmail.replace(/\u0000/g, "") : null;

    await sql`
      INSERT INTO abandoned_carts (
        checkout_token,
        shopify_checkout_id,
        customer_id,
        customer_email,
        customer_display_name,
        total_price_cents,
        currency,
        recovery_url,
        line_items_json,
        status,
        ineligible_reason,
        last_activity_at
      ) VALUES (
        ${checkoutToken},
        ${shopifyCheckoutId},
        ${customerId},
        ${safeCustomerEmail},
        ${safeCustomerDisplayName},
        ${totalPriceCents},
        ${currency},
        ${safeRecoveryUrl},
        ${safeLineItemsJson},
        ${status},
        ${ineligibleReason},
        ${lastActivityAt}
      )
      ON CONFLICT (checkout_token) DO UPDATE SET
        shopify_checkout_id   = EXCLUDED.shopify_checkout_id,
        customer_id           = EXCLUDED.customer_id,
        customer_email        = EXCLUDED.customer_email,
        customer_display_name = EXCLUDED.customer_display_name,
        total_price_cents     = EXCLUDED.total_price_cents,
        currency              = EXCLUDED.currency,
        recovery_url          = EXCLUDED.recovery_url,
        line_items_json       = EXCLUDED.line_items_json,
        status                = EXCLUDED.status,
        ineligible_reason     = EXCLUDED.ineligible_reason,
        last_activity_at      = EXCLUDED.last_activity_at
    `;

    console.log(
      { requestId, topic: "checkouts/create", checkoutToken, status },
      "upserted abandoned cart",
    );
  },

  "checkouts/update": async (payload, req) => {
    const p = (payload ?? {}) as CheckoutPayload;
    const requestId = req.platform!.requestId;
    const shopDomain = req.platform!.shopDomain;

    const checkoutToken = p.token ?? null;
    const shopifyCheckoutId = p.id != null ? String(p.id) : null;

    console.log(
      { requestId, topic: "checkouts/update", checkoutToken, shopifyCheckoutId },
      "webhook received",
    );

    if (!checkoutToken || !shopifyCheckoutId) {
      console.warn({ requestId, topic: "checkouts/update" }, "missing token or id, skipping");
      return;
    }

    const customerEmail = (p.email ?? p.customer?.email ?? null) as string | null;
    const customerId = p.customer?.id != null ? String(p.customer.id) : null;
    const firstName = p.customer?.first_name ?? null;
    const lastName = p.customer?.last_name ?? null;
    const customerDisplayName =
      firstName || lastName ? `${firstName ?? ""} ${lastName ?? ""}`.trim() : null;

    const totalPriceCents =
      p.total_price != null ? Math.round(parseFloat(p.total_price) * 100) : 0;
    const currency = p.presentment_currency ?? "USD";

    let recoveryUrl: string | null = p.abandoned_checkout_url ?? null;
    if (!recoveryUrl && checkoutToken) {
      recoveryUrl = `https://${shopDomain}/checkout/recover/${checkoutToken}`;
    }

    const lineItemsJson = JSON.stringify(p.line_items ?? []);
    const lastActivityAt = p.updated_at ?? new Date().toISOString();
    const isCompleted = p.completed_at != null && p.completed_at !== "";

    let status: string;
    let ineligibleReason: string | null = null;

    if (isCompleted) {
      status = "recovered";
    } else if (!customerEmail) {
      status = "ineligible";
      ineligibleReason = "no_email";
    } else {
      status = "pending";
    }

    const safeLineItemsJson = lineItemsJson.replace(/\u0000/g, "");
    const safeCustomerDisplayName = customerDisplayName
      ? customerDisplayName.replace(/\u0000/g, "")
      : null;
    const safeRecoveryUrl = recoveryUrl ? recoveryUrl.replace(/\u0000/g, "") : null;
    const safeCustomerEmail = customerEmail ? customerEmail.replace(/\u0000/g, "") : null;

    // For updates, only reset reminder_sent_at if status is going back to pending
    // (cart was edited again). We reset last_activity_at unconditionally.
    await sql`
      INSERT INTO abandoned_carts (
        checkout_token,
        shopify_checkout_id,
        customer_id,
        customer_email,
        customer_display_name,
        total_price_cents,
        currency,
        recovery_url,
        line_items_json,
        status,
        ineligible_reason,
        last_activity_at
      ) VALUES (
        ${checkoutToken},
        ${shopifyCheckoutId},
        ${customerId},
        ${safeCustomerEmail},
        ${safeCustomerDisplayName},
        ${totalPriceCents},
        ${currency},
        ${safeRecoveryUrl},
        ${safeLineItemsJson},
        ${status},
        ${ineligibleReason},
        ${lastActivityAt}
      )
      ON CONFLICT (checkout_token) DO UPDATE SET
        shopify_checkout_id   = EXCLUDED.shopify_checkout_id,
        customer_id           = EXCLUDED.customer_id,
        customer_email        = EXCLUDED.customer_email,
        customer_display_name = EXCLUDED.customer_display_name,
        total_price_cents     = EXCLUDED.total_price_cents,
        currency              = EXCLUDED.currency,
        recovery_url          = EXCLUDED.recovery_url,
        line_items_json       = EXCLUDED.line_items_json,
        status                = CASE
          WHEN EXCLUDED.status = 'recovered' THEN 'recovered'
          WHEN abandoned_carts.status = 'sent' THEN 'sent'
          ELSE EXCLUDED.status
        END,
        ineligible_reason     = EXCLUDED.ineligible_reason,
        last_activity_at      = EXCLUDED.last_activity_at,
        reminder_sent_at      = CASE
          WHEN EXCLUDED.status = 'pending' AND abandoned_carts.status = 'pending'
            THEN NULL
          ELSE abandoned_carts.reminder_sent_at
        END
    `;

    console.log(
      { requestId, topic: "checkouts/update", checkoutToken, status },
      "upserted abandoned cart",
    );
  },
};