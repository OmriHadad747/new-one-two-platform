import { sql } from "../lib/db.js";
import { platform, QuotaExceeded } from "../lib/platform.js";
import { shopifyClientFor } from "../lib/shopify.js";

type JobFn = (payload: unknown) => Promise<void>;

interface AbandonedCheckoutNode {
  id: string;
  token: string;
  abandonedCheckoutUrl: string;
  customer: {
    id: string;
    email: string | null;
    firstName: string | null;
  } | null;
  email: string | null;
  lineItems: {
    edges: Array<{
      node: {
        title: string;
        quantity: number;
        variant: {
          image: { url: string } | null;
        } | null;
      };
    }>;
  };
  totalPriceSet: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  createdAt: string;
  updatedAt: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const jobs: Record<string, JobFn> = {
  main: async (_payload) => {
    const jobName = "main";

    // 1. Read settings once before the loop
    const settingsRows = await sql<{ delay_minutes: number; is_enabled: boolean }[]>`
      SELECT delay_minutes, is_enabled FROM abandoned_cart_settings WHERE singleton = true
    `;
    const settings = settingsRows[0];

    if (!settings) {
      console.log({ jobName }, "no settings row found — skipping run");
      return;
    }

    const { delay_minutes, is_enabled } = settings;

    if (!is_enabled) {
      console.log({ jobName }, "abandoned cart emails disabled — skipping run");
      return;
    }

    // 2. Bulk-fetch all abandoned checkouts from Shopify before the loop
    const shopify = await shopifyClientFor();

    const checkoutMap = new Map<string, AbandonedCheckoutNode>();

    for await (const nodes of shopify.graphqlPaginate(
      `query AbandonedCheckouts($cursor: String) {
        abandonedCheckouts(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              token
              abandonedCheckoutUrl
              customer {
                id
                email
                firstName
              }
              email
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    quantity
                    variant {
                      image {
                        url
                      }
                    }
                  }
                }
              }
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              createdAt
              updatedAt
            }
          }
        }
      }`,
      {},
      "abandonedCheckouts",
    )) {
      for (const node of nodes as AbandonedCheckoutNode[]) {
        if (node.token) {
          checkoutMap.set(node.token, node);
        }
      }
    }

    console.log({ jobName, checkoutCount: checkoutMap.size }, "fetched abandoned checkouts from Shopify");

    if (checkoutMap.size === 0) {
      console.log({ jobName }, "no abandoned checkouts returned — done");
      return;
    }

    // 3. Load all already-recorded cart tokens from DB in one query
    const existingTokenRows = await sql<{ cart_token: string }[]>`
      SELECT cart_token FROM abandoned_cart_emails
    `;
    const existingTokens = new Set(existingTokenRows.map((r) => r.cart_token));

    console.log({ jobName, existingCount: existingTokens.size }, "loaded existing cart tokens from DB");

    const now = Date.now();
    const delayMs = delay_minutes * 60 * 1000;

    // 4. Loop — no Shopify calls inside; use pre-fetched data only
    for (const [token, checkout] of checkoutMap) {
      // Skip if already recorded (sent, failed, or skipped)
      if (existingTokens.has(token)) {
        continue;
      }

      // Check if cart is still abandoned (no completed_at equivalent — presence in abandonedCheckouts means it's open)
      // The API only returns open abandoned checkouts; if the checkout has updatedAt very recently, re-check delay

      // Determine customer email — prefer checkout.email, fallback to customer.email
      const rawEmail: string | null = checkout.email ?? checkout.customer?.email ?? null;

      if (!rawEmail) {
        console.log({ jobName, token }, "no email — marking skipped_no_email");
        await sql`
          INSERT INTO abandoned_cart_emails
            (cart_token, customer_email, customer_id, cart_subtotal_cents, currency,
             line_items_json, recovery_url, abandoned_at, cart_updated_at,
             status, failure_reason, email_sent_at, detected_at)
          VALUES
            (${token}, '', ${checkout.customer?.id ?? null}, 0, '',
             ${JSON.stringify([])}, ${checkout.abandonedCheckoutUrl},
             ${checkout.createdAt}, ${checkout.updatedAt},
             'skipped_no_email', 'no_customer_email', NULL, NOW())
          ON CONFLICT (cart_token) DO NOTHING
        `;
        continue;
      }

      const email = rawEmail.trim().toLowerCase();

      if (!EMAIL_REGEX.test(email)) {
        console.log({ jobName, token }, "invalid email format — marking failed");
        await sql`
          INSERT INTO abandoned_cart_emails
            (cart_token, customer_email, customer_id, cart_subtotal_cents, currency,
             line_items_json, recovery_url, abandoned_at, cart_updated_at,
             status, failure_reason, email_sent_at, detected_at)
          VALUES
            (${token}, ${email}, ${checkout.customer?.id ?? null}, 0, '',
             ${JSON.stringify([])}, ${checkout.abandonedCheckoutUrl},
             ${checkout.createdAt}, ${checkout.updatedAt},
             'failed', 'invalid_email_format', NULL, NOW())
          ON CONFLICT (cart_token) DO NOTHING
        `;
        continue;
      }

      // Check delay window: cart must have been idle (updatedAt) for at least delay_minutes
      const cartUpdatedAt = new Date(checkout.updatedAt).getTime();
      const idleMs = now - cartUpdatedAt;

      if (idleMs < delayMs) {
        // Cart was updated recently — not yet eligible, do not record so it can be picked up next run
        console.log({ jobName, token, idleMs, delayMs }, "cart within delay window — skipping for now");
        continue;
      }

      // Parse subtotal as integer cents
      const subtotalCents = Math.round(parseFloat(checkout.totalPriceSet.shopMoney.amount) * 100);
      const currency = checkout.totalPriceSet.shopMoney.currencyCode;
      const subtotalDecimal = (subtotalCents / 100).toFixed(2);

      const lineItems = checkout.lineItems.edges.map((e) => ({
        title: e.node.title,
        quantity: e.node.quantity,
        imageUrl: e.node.variant?.image?.url ?? null,
      }));

      const firstName = checkout.customer?.firstName ?? null;
      const customerFirstName = firstName && firstName.trim() !== "" ? firstName.trim() : "there";
      const recoveryUrl = checkout.abandonedCheckoutUrl;

      // Send email — atomic claim via INSERT first, then send
      // We use a two-step approach but need idempotency:
      // Insert a 'pending' row atomically; if insert succeeds we own this cart
      const claimed = await sql<{ id: string }[]>`
        INSERT INTO abandoned_cart_emails
          (cart_token, customer_email, customer_id, cart_subtotal_cents, currency,
           line_items_json, recovery_url, abandoned_at, cart_updated_at,
           status, failure_reason, email_sent_at, detected_at)
        VALUES
          (${token}, ${email}, ${checkout.customer?.id ?? null}, ${subtotalCents}, ${currency},
           ${JSON.stringify(lineItems)}, ${recoveryUrl},
           ${checkout.createdAt}, ${checkout.updatedAt},
           'pending', NULL, NULL, NOW())
        ON CONFLICT (cart_token) DO NOTHING
        RETURNING id
      `;

      if (claimed.length === 0) {
        // Another cron run already claimed this cart — skip
        console.log({ jobName, token }, "cart already claimed by another run — skipping");
        continue;
      }

      const claimedId = claimed[0]!.id;

      console.log({ jobName, token, claimedId, email }, "sending abandoned cart email");

      try {
        const result = await platform.email.send({
          to: email,
          data: {
            customerFirstName,
            cartSubtotal: `${subtotalDecimal} ${currency}`,
            recoveryUrl,
          },
        });

        if (result.delivered) {
          await sql`
            UPDATE abandoned_cart_emails
            SET status = 'sent', email_sent_at = NOW()
            WHERE id = ${claimedId} AND status = 'pending'
          `;
          console.log({ jobName, token, claimedId }, "email sent successfully");
        } else {
          const safeReason = result.reason.replace(/\u0000/g, "");
          await sql`
            UPDATE abandoned_cart_emails
            SET status = 'failed', failure_reason = ${safeReason}
            WHERE id = ${claimedId} AND status = 'pending'
          `;
          console.log({ jobName, token, claimedId, reason: result.reason }, "email not delivered (soft failure)");
        }
      } catch (err) {
        if (err instanceof QuotaExceeded) {
          console.warn({ jobName, limit: err.limit }, "email quota exceeded — stopping loop");
          await sql`
            UPDATE abandoned_cart_emails
            SET status = 'failed', failure_reason = 'quota_exceeded'
            WHERE id = ${claimedId} AND status = 'pending'
          `;
          return;
        }
        const safeReason = (err instanceof Error ? err.message : String(err)).replace(/\u0000/g, "").slice(0, 500);
        await sql`
          UPDATE abandoned_cart_emails
          SET status = 'failed', failure_reason = ${safeReason}
          WHERE id = ${claimedId} AND status = 'pending'
        `;
        console.error({ jobName, token, claimedId, err }, "unexpected error sending email");
      }
    }

    console.log({ jobName }, "abandoned cart job complete");
  },
};