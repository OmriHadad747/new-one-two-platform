import { sql } from "../lib/db.js";
import { platform, QuotaExceeded } from "../lib/platform.js";
import { shopifyClientFor } from "../lib/shopify.js";

type JobFn = (payload: unknown) => Promise<void>;

interface AbandonedCartRow {
  id: string;
  checkout_token: string;
  shopify_checkout_id: string;
  customer_email: string;
  customer_display_name: string | null;
  total_price_cents: string | number;
  currency: string;
  recovery_url: string | null;
  line_items_json: string;
}

interface ShopifyAbandonedCheckout {
  id: string;
  completedAt: string | null;
  abandonedCheckoutUrl: string | null;
}

export const jobs: Record<string, JobFn> = {
  main: async (_payload) => {
    const jobName = "main";

    // 1. Read settings
    const settingsRows = await sql<
      { delay_hours: number; is_enabled: boolean }[]
    >`
      SELECT delay_hours, is_enabled
      FROM abandoned_cart_settings
      WHERE singleton = true
    `;

    if (settingsRows.length === 0) {
      console.log({ jobName }, "no settings row found, exiting");
      return;
    }

    const { delay_hours, is_enabled } = settingsRows[0];

    if (!is_enabled) {
      console.log({ jobName }, "reminders disabled, exiting");
      return;
    }

    // 2. Query due carts (atomic claim — mark reminder_sent_at only after confirmed send)
    const dueCarts = await sql<AbandonedCartRow[]>`
      SELECT
        id,
        checkout_token,
        shopify_checkout_id,
        customer_email,
        customer_display_name,
        total_price_cents,
        currency,
        recovery_url,
        line_items_json
      FROM abandoned_carts
      WHERE status = 'pending'
        AND customer_email IS NOT NULL
        AND last_activity_at <= NOW() - (${delay_hours} || ' hours')::interval
        AND reminder_sent_at IS NULL
    `;

    if (dueCarts.length === 0) {
      console.log({ jobName }, "no carts due for reminder");
      return;
    }

    console.log({ jobName, count: dueCarts.length }, "carts due for reminder");

    // 3. Bulk-fetch Shopify abandoned checkouts to check completedAt
    const shopify = await shopifyClientFor();

    const checkoutMap = new Map<string, ShopifyAbandonedCheckout>();

    for await (const nodes of shopify.graphqlPaginate(
      `query FetchAbandonedCheckouts($cursor: String) {
        abandonedCheckouts(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              completedAt
              abandonedCheckoutUrl
            }
          }
        }
      }`,
      {},
      "abandonedCheckouts",
    )) {
      for (const node of nodes as ShopifyAbandonedCheckout[]) {
        // Map by numeric ID extracted from GID (matches shopify_checkout_id in DB)
        const gidParts = node.id.split("/");
        const numericId = gidParts[gidParts.length - 1];
        checkoutMap.set(numericId, node);
      }
    }

    console.log({ jobName, fetched: checkoutMap.size }, "fetched Shopify abandoned checkouts");

    // 4. Process each due cart
    for (const cart of dueCarts) {
      const shopifyData = checkoutMap.get(String(cart.shopify_checkout_id));

      // If Shopify says it's completed, mark recovered and skip
      if (shopifyData && shopifyData.completedAt) {
        await sql`
          UPDATE abandoned_carts
          SET status = 'recovered'
          WHERE id = ${cart.id}
            AND status = 'pending'
            AND reminder_sent_at IS NULL
        `;

        await sql`
          INSERT INTO reminder_log (
            abandoned_cart_id,
            customer_email,
            customer_display_name,
            total_price_cents,
            currency,
            outcome,
            sent_at
          ) VALUES (
            ${cart.id},
            ${cart.customer_email},
            ${cart.customer_display_name},
            ${cart.total_price_cents},
            ${cart.currency},
            'skipped_recovered',
            NOW()
          )
          ON CONFLICT DO NOTHING
        `;

        console.log(
          { jobName, cartId: cart.id, outcome: "skipped_recovered" },
          "cart already recovered, skipping",
        );
        continue;
      }

      // Determine the recovery URL — prefer fresh Shopify data, fall back to DB value
      const recoveryUrl =
        shopifyData?.abandonedCheckoutUrl ?? cart.recovery_url ?? null;

      const totalPriceCents = Number(cart.total_price_cents);

      // Atomic claim — only send if we can flip reminder_sent_at from NULL
      const claimed = await sql<{ id: string }[]>`
        UPDATE abandoned_carts
        SET reminder_sent_at = NOW(),
            status = 'sent'
        WHERE id = ${cart.id}
          AND status = 'pending'
          AND reminder_sent_at IS NULL
        RETURNING id
      `;

      if (claimed.length === 0) {
        // Already claimed by a concurrent run — skip
        console.log({ jobName, cartId: cart.id }, "cart already claimed, skipping");
        continue;
      }

      try {
        const result = await platform.email.send({
          to: cart.customer_email,
          data: {
            customerDisplayName: cart.customer_display_name ?? cart.customer_email,
            recoveryUrl: recoveryUrl ?? "",
            totalPriceCents,
            currency: cart.currency,
            lineItemsSummary: cart.line_items_json,
          },
        });

        if (result.delivered) {
          await sql`
            INSERT INTO reminder_log (
              abandoned_cart_id,
              customer_email,
              customer_display_name,
              total_price_cents,
              currency,
              outcome,
              sent_at
            ) VALUES (
              ${cart.id},
              ${cart.customer_email},
              ${cart.customer_display_name},
              ${totalPriceCents},
              ${cart.currency},
              'sent',
              NOW()
            )
            ON CONFLICT DO NOTHING
          `;

          console.log(
            { jobName, cartId: cart.id, outcome: "sent" },
            "reminder sent successfully",
          );
        } else {
          // Soft failure (suppressed / missing_config / provider_failed) — revert claim
          await sql`
            UPDATE abandoned_carts
            SET reminder_sent_at = NULL,
                status = 'pending'
            WHERE id = ${cart.id}
          `;

          await sql`
            INSERT INTO reminder_log (
              abandoned_cart_id,
              customer_email,
              customer_display_name,
              total_price_cents,
              currency,
              outcome,
              sent_at
            ) VALUES (
              ${cart.id},
              ${cart.customer_email},
              ${cart.customer_display_name},
              ${totalPriceCents},
              ${cart.currency},
              'failed',
              NOW()
            )
            ON CONFLICT DO NOTHING
          `;

          console.warn(
            { jobName, cartId: cart.id, reason: result.reason, outcome: "failed" },
            "reminder send not delivered",
          );
        }
      } catch (err) {
        if (err instanceof QuotaExceeded) {
          // Revert the claim so the cart can be retried next run
          await sql`
            UPDATE abandoned_carts
            SET reminder_sent_at = NULL,
                status = 'pending'
            WHERE id = ${cart.id}
          `;

          console.warn(
            { jobName, limit: (err as QuotaExceeded).limit },
            "email quota exceeded, stopping",
          );
          return;
        }

        // Unexpected error — revert claim so next retry can attempt it
        await sql`
          UPDATE abandoned_carts
          SET reminder_sent_at = NULL,
              status = 'pending'
          WHERE id = ${cart.id}
        `;

        await sql`
          INSERT INTO reminder_log (
            abandoned_cart_id,
            customer_email,
            customer_display_name,
            total_price_cents,
            currency,
            outcome,
            sent_at
          ) VALUES (
            ${cart.id},
            ${cart.customer_email},
            ${cart.customer_display_name},
            ${totalPriceCents},
            ${cart.currency},
            'failed',
            NOW()
          )
          ON CONFLICT DO NOTHING
        `;

        console.error(
          { jobName, cartId: cart.id, err: String(err) },
          "unexpected error sending reminder",
        );
      }
    }
  },
};