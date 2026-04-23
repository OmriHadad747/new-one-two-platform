import { sql } from "../lib/db.js";
import { platform, QuotaExceeded } from "../lib/platform.js";
import { shopifyClientFor } from "../lib/shopify.js";

type JobFn = (payload: unknown) => Promise<void>;

interface ShopifyCheckout {
  id: number;
  token: string;
  email: string | null;
  customer_id: number | null;
  completed_at: string | null;
  updated_at: string;
  total_price: string;
  currency: string;
  line_items: ShopifyLineItem[];
  abandoned_checkout_url: string;
}

interface ShopifyLineItem {
  title: string;
  quantity: number;
  price: string;
  product_id: number | null;
  variant_id: number | null;
  properties?: { name: string; value: string }[];
}

interface ShopifyCustomer {
  id: number;
  email: string;
  first_name: string | null;
  accepts_marketing: boolean;
  email_marketing_consent?: {
    state: string;
  };
}

export const jobs: Record<string, JobFn> = {
  main: async (_payload) => {
    // ── 1. Read settings ──────────────────────────────────────────────
    const settingsRows = await sql`
      SELECT abandonment_delay_minutes, is_enabled
      FROM abandonment_settings
      LIMIT 1
    `;

    if (settingsRows.length === 0 || !settingsRows[0].is_enabled) {
      console.log({ jobName: "main" }, "cron main: disabled or not configured, skipping");
      return;
    }

    const delayMinutes = Number(settingsRows[0].abandonment_delay_minutes);
    const cutoff = new Date(Date.now() - delayMinutes * 60 * 1000);
    const cutoffIso = cutoff.toISOString();

    // ── 2. Bulk-fetch abandoned checkouts from Shopify ────────────────
    // We fetch all checkouts updated before the cutoff (i.e., inactive for >= delay)
    // and not yet completed (recovered).
    const shopify = shopifyClientFor({
      tenantId: "",
      appId: "",
      shopDomain: process.env["SHOP_DOMAIN"] ?? "",
      requestId: "cron-main",
    } as any);

    const allCheckouts: ShopifyCheckout[] = [];
    for await (const batch of shopify.rest.paginate("/checkouts.json", {
      updated_at_max: cutoffIso,
      limit: 250,
    })) {
      for (const checkout of batch as ShopifyCheckout[]) {
        // Only include incomplete (abandoned) checkouts
        if (checkout.completed_at == null && checkout.email) {
          allCheckouts.push(checkout);
        }
      }
    }

    console.log(
      { jobName: "main", checkoutCount: allCheckouts.length },
      "cron main: fetched abandoned checkouts",
    );

    if (allCheckouts.length === 0) {
      return;
    }

    // ── 3. Bulk-fetch customer records for consent check ──────────────
    const customerIds = [
      ...new Set(
        allCheckouts
          .filter((c) => c.customer_id != null)
          .map((c) => c.customer_id as number),
      ),
    ];

    const customerMap = new Map<string, ShopifyCustomer>();

    const BATCH = 250;
    for (let i = 0; i < customerIds.length; i += BATCH) {
      const chunk = customerIds.slice(i, i + BATCH);
      const resp = await shopify.rest.get(
        `/customers.json?ids=${chunk.join(",")}&fields=id,email,first_name,accepts_marketing,email_marketing_consent`,
      );
      for (const customer of (resp.customers ?? []) as ShopifyCustomer[]) {
        customerMap.set(String(customer.id), customer);
      }
    }

    // ── 4. Load already-queued checkout IDs (sent or pending) ────────
    const existingRows = await sql`
      SELECT checkout_id
      FROM abandoned_cart_queue
      WHERE status IN ('sent', 'pending')
    `;
    const existingCheckoutIds = new Set<string>(
      existingRows.map((r) => String(r.checkout_id)),
    );

    // ── 5. Deduplicate on customer_email: keep most recently updated cart ──
    // Build a map of email → most-recently-updated checkout
    const emailToLatestCheckout = new Map<string, ShopifyCheckout>();
    for (const checkout of allCheckouts) {
      if (!checkout.email) continue;
      const email = checkout.email.toLowerCase();
      const existing = emailToLatestCheckout.get(email);
      if (
        !existing ||
        new Date(checkout.updated_at) > new Date(existing.updated_at)
      ) {
        emailToLatestCheckout.set(email, checkout);
      }
    }

    // ── 6. Per-item loop: upsert eligible carts into queue ─────────────
    for (const [emailKey, checkout] of emailToLatestCheckout) {
      // Skip if no email (already filtered above, but be defensive)
      if (!checkout.email) {
        console.log({ jobName: "main", checkoutId: checkout.id }, "skip: no email");
        continue;
      }

      // Skip if customer_id missing (no consent record to check)
      if (!checkout.customer_id) {
        console.log({ jobName: "main", checkoutId: checkout.id }, "skip: no customer_id (guest)");
        continue;
      }

      // Skip if checkout already queued or sent
      if (existingCheckoutIds.has(String(checkout.id))) {
        console.log({ jobName: "main", checkoutId: checkout.id }, "skip: already queued");
        continue;
      }

      // Skip if cart was converted (completed_at set on re-check)
      if (checkout.completed_at != null) {
        console.log({ jobName: "main", checkoutId: checkout.id }, "skip: cart converted");
        continue;
      }

      // Skip if updated_at is more recent than the cutoff (cart is still active)
      if (new Date(checkout.updated_at) > cutoff) {
        console.log({ jobName: "main", checkoutId: checkout.id }, "skip: cart still active");
        continue;
      }

      // Check email marketing consent
      const customer = customerMap.get(String(checkout.customer_id));
      if (!customer) {
        console.log({ jobName: "main", checkoutId: checkout.id }, "skip: customer not found");
        continue;
      }

      // Check consent: prefer email_marketing_consent.state if available, else accepts_marketing
      const consentState = customer.email_marketing_consent?.state;
      const hasConsent = consentState
        ? consentState === "subscribed"
        : customer.accepts_marketing;

      if (!hasConsent) {
        console.log({ jobName: "main", checkoutId: checkout.id }, "skip: no marketing consent");
        continue;
      }

      // Build line_items_snapshot
      const lineItemsSnapshot = (checkout.line_items ?? []).map((item) => ({
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        image_url: null as string | null, // REST checkout line items don't include image directly
      }));

      // Upsert into abandoned_cart_queue
      await sql`
        INSERT INTO abandoned_cart_queue (
          checkout_id,
          customer_id,
          customer_email,
          customer_first_name,
          cart_token,
          abandoned_at,
          cart_total_price,
          cart_currency,
          line_items_snapshot,
          recovery_url,
          status,
          created_at
        ) VALUES (
          ${checkout.id},
          ${checkout.customer_id},
          ${checkout.email},
          ${customer.first_name ?? null},
          ${checkout.token},
          ${checkout.updated_at},
          ${checkout.total_price},
          ${checkout.currency},
          ${JSON.stringify(lineItemsSnapshot)},
          ${checkout.abandoned_checkout_url},
          'pending',
          NOW()
        )
        ON CONFLICT (checkout_id) DO UPDATE
          SET
            customer_email       = EXCLUDED.customer_email,
            customer_first_name  = EXCLUDED.customer_first_name,
            cart_total_price     = EXCLUDED.cart_total_price,
            cart_currency        = EXCLUDED.cart_currency,
            line_items_snapshot  = EXCLUDED.line_items_snapshot,
            recovery_url         = EXCLUDED.recovery_url,
            abandoned_at         = EXCLUDED.abandoned_at
          WHERE abandoned_cart_queue.status = 'pending'
      `;

      console.log(
        { jobName: "main", checkoutId: checkout.id, email: emailKey },
        "cron main: upserted cart into queue",
      );
    }

    // ── 7. Second pass: send emails for all pending rows ─────────────
    // Use FOR UPDATE SKIP LOCKED to prevent duplicate sends in overlapping runs
    const pendingRows = await sql`
      SELECT
        id,
        checkout_id,
        customer_email,
        customer_first_name,
        cart_total_price,
        cart_currency,
        line_items_snapshot,
        recovery_url
      FROM abandoned_cart_queue
      WHERE status = 'pending'
      FOR UPDATE SKIP LOCKED
    `;

    console.log(
      { jobName: "main", pendingCount: pendingRows.length },
      "cron main: processing pending queue rows",
    );

    for (const row of pendingRows) {
      const lineItems = (row.line_items_snapshot as { title: string; quantity: number; price: string; image_url: string | null }[]) ?? [];

      // Build a human-readable summary of line items for the email
      const lineItemsSummary = lineItems
        .map((item) => `${item.title} × ${item.quantity} ($${item.price})`)
        .join(", ");

      let emailResult: Awaited<ReturnType<typeof platform.email.send>> | null = null;
      let sendError: string | null = null;

      try {
        emailResult = await platform.email.send({
          to: row.customer_email as string,
          data: {
            customerFirstName: (row.customer_first_name as string | null) ?? "there",
            cartTotalPrice: row.cart_total_price as string,
            cartCurrency: row.cart_currency as string,
            lineItemsSummary,
            recoveryUrl: row.recovery_url as string,
          },
        });
      } catch (err) {
        if (err instanceof QuotaExceeded) {
          console.warn(
            { jobName: "main", limit: err.limit },
            "cron main: email quota exceeded, stopping tick",
          );
          // Revert claim — leave status as pending so next tick retries
          return;
        }
        sendError = err instanceof Error ? err.message.replace(/\u0000/g, "") : "unknown_error";
        console.error({ jobName: "main", checkoutId: row.checkout_id, err }, "cron main: email send threw");
      }

      if (sendError) {
        // Mark as failed
        await sql`
          UPDATE abandoned_cart_queue
          SET status = 'failed', failed_reason = ${sendError}
          WHERE id = ${row.id}
        `;
        await sql`
          INSERT INTO abandonment_send_log (
            queue_id, customer_email, checkout_id, cart_total_price, status, failed_reason, sent_at
          ) VALUES (
            ${row.id}, ${row.customer_email}, ${row.checkout_id}, ${row.cart_total_price},
            'failed', ${sendError}, NOW()
          )
        `;
        continue;
      }

      if (!emailResult) continue;

      if (!emailResult.delivered) {
        // Soft failure: provider_failed, suppressed, or missing_config
        const reason = emailResult.reason;
        console.warn(
          { jobName: "main", checkoutId: row.checkout_id, reason },
          "cron main: email not delivered (soft failure)",
        );
        await sql`
          UPDATE abandoned_cart_queue
          SET status = 'failed', failed_reason = ${reason}
          WHERE id = ${row.id}
        `;
        await sql`
          INSERT INTO abandonment_send_log (
            queue_id, customer_email, checkout_id, cart_total_price, status, failed_reason, sent_at
          ) VALUES (
            ${row.id}, ${row.customer_email}, ${row.checkout_id}, ${row.cart_total_price},
            'failed', ${reason}, NOW()
          )
        `;
        continue;
      }

      // Success
      await sql`
        UPDATE abandoned_cart_queue
        SET status = 'sent', sent_at = NOW()
        WHERE id = ${row.id}
      `;
      await sql`
        INSERT INTO abandonment_send_log (
          queue_id, customer_email, checkout_id, cart_total_price, status, failed_reason, sent_at
        ) VALUES (
          ${row.id}, ${row.customer_email}, ${row.checkout_id}, ${row.cart_total_price},
          'sent', NULL, NOW()
        )
      `;

      console.log(
        { jobName: "main", checkoutId: row.checkout_id, email: row.customer_email },
        "cron main: abandonment email sent successfully",
      );
    }
  },
};