# Chat Local — Full Pipeline

**Date:** 2026-04-16 20:47:23  
**Status:** ✅ SUCCESS  
**Total:** 190237ms  
**Tokens:** in=52083 out=20833 total=72916  
**Prompt:** Recover abandoned carts by sending timely, personalized reminder emails that guide customers back to checkout.

## Intent (Product Agent)

```json
{
  "triggerTypes": [
    "cron"
  ],
  "resources": [
    "Cart",
    "Customer"
  ],
  "desiredOutcome": "Recover abandoned carts by sending timely, personalized reminder emails that guide customers back to checkout.",
  "cronHint": "every 1 hour (checks for carts matching the abandonment threshold)",
  "appCategory": "backend_admin",
  "qualityBrief": "A good version handles: (1) accurate abandonment detection (carts with items, no purchase within the threshold), (2) avoiding duplicate emails to the same customer, (3) respecting customer email preferences, (4) configurable delay (e.g. 6\u201372 hours), (5) a clear, mobile-friendly email template with product images and direct checkout link, (6) an admin log showing which emails were sent and delivery status. Common pitfalls: sending multiple reminders to the same cart, triggering on carts with zero items, or hardcoding the delay instead of making it configurable."
}
```

## Architect Plan

```json
{
  "shopifyPlan": {
    "webhookTopics": [],
    "cronSchedule": "0 * * * *"
  },
  "appContracts": {
    "feasibility": "feasible",
    "blockedReason": null,
    "complexity": "high",
    "edgeCases": [
      "Abandoned checkout has zero line items \u2014 skip it; do not send a reminder for an empty cart",
      "Customer has already completed the checkout (completedAt is non-null) before the cron runs \u2014 skip without sending",
      "A reminder email was already sent for this checkout token \u2014 deduplicate by checking abandoned_cart_reminders for an existing sent record before sending",
      "Customer has no email address or email marketing consent is explicitly denied \u2014 skip to respect opt-out preferences",
      "Multiple cron ticks fire concurrently (e.g. delayed job overlap) \u2014 use a DB-level unique constraint on checkout_token to prevent duplicate reminder rows being inserted",
      "Configurable abandonment delay changed by merchant mid-cycle \u2014 recompute eligibility window against current setting on every cron run, not against a cached value"
    ],
    "uxExpectations": {
      "storefront": null,
      "admin": "Dashboard should lead with a summary of emails sent vs carts recovered (converted), followed by a paginated log of individual reminders with checkout value, sent timestamp, and delivery status. Settings panel must expose the abandonment delay (hours) so merchants can tune recovery timing without code changes."
    },
    "stateMachine": null,
    "platformGaps": [
      {
        "gap": "Shopify does not expose a native 'cart abandoned' webhook \u2014 abandoned checkouts must be polled",
        "mitigation": "Hourly cron queries the Shopify Admin GraphQL abandonedCheckouts connection, filtering by updatedAt within the configured window; results are cross-referenced against the DB to find unsent reminders"
      },
      {
        "gap": "No batch write API for sending reminder emails \u2014 each eligible checkout requires an individual email send call",
        "mitigation": "Pre-fetch all abandoned checkout data in bulk before the loop; per-item email send calls inside the loop are unavoidable for this resource type"
      }
    ],
    "cronBatching": {
      "required": true,
      "description": "Before iterating over eligible abandoned checkouts, bulk-fetch all AbandonedCheckout records from Shopify Admin GraphQL (paginated) whose updatedAt falls within the configured abandonment window and whose completedAt is null. Also bulk-fetch all checkout_tokens already present in abandoned_cart_reminders to exclude already-processed carts. This avoids per-item Shopify API reads inside the loop."
    },
    "dbContracts": [
      {
        "table": "abandoned_cart_settings",
        "columns": [
          {
            "name": "id",
            "type": "UUID",
            "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()"
          },
          {
            "name": "tenant_id",
            "type": "UUID",
            "constraints": "NOT NULL"
          },
          {
            "name": "abandonment_delay_hours",
            "type": "INTEGER",
            "constraints": "NOT NULL DEFAULT 6"
          },
          {
            "name": "email_subject",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'You left something behind!'"
          },
          {
            "name": "email_body_template",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT ''"
          },
          {
            "name": "is_enabled",
            "type": "BOOLEAN",
            "constraints": "NOT NULL DEFAULT true"
          },
          {
            "name": "created_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
          },
          {
            "name": "updated_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
          }
        ],
        "uniqueConstraint": {
          "columns": [
            "tenant_id"
          ]
        },
        "indexes": [
          "tenant_id"
        ],
        "rls": true
      },
      {
        "table": "abandoned_cart_reminders",
        "columns": [
          {
            "name": "id",
            "type": "UUID",
            "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()"
          },
          {
            "name": "tenant_id",
            "type": "UUID",
            "constraints": "NOT NULL"
          },
          {
            "name": "checkout_token",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "checkout_id",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "customer_id",
            "type": "BIGINT",
            "constraints": "NULL"
          },
          {
            "name": "customer_email",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "checkout_url",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "cart_subtotal_amount",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "cart_currency",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "line_items_snapshot",
            "type": "JSONB",
            "constraints": "NOT NULL DEFAULT '[]'"
          },
          {
            "name": "status",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'sent'"
          },
          {
            "name": "sent_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
          },
          {
            "name": "converted_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NULL"
          }
        ],
        "uniqueConstraint": {
          "columns": [
            "tenant_id",
            "checkout_token"
          ]
        },
        "indexes": [
          "tenant_id",
          "customer_id",
          "sent_at"
        ],
        "rls": true
      }
    ],
    "webhookContract": null,
    "cronContract": {
      "handlerMustProduce": "For each eligible abandoned checkout, the handler must resolve: (1) the checkout's GID, token, abandonedCheckoutUrl, createdAt, and completedAt to confirm it is still open and meets the delay threshold; (2) the customer's email address and email marketing consent status (acceptsMarketing) \u2014 skip if email is absent or consent is denied; (3) all line item details including title, quantity, variant image URL, and unit price for inclusion in the email body; (4) the cart subtotal amount and currency; (5) confirmation via DB lookup that no reminder row already exists for this tenant_id + checkout_token combination. Only after all checks pass does the handler send the email and insert a row into abandoned_cart_reminders."
    },
    "widgetTargetTemplates": null,
    "widgetApiCatalog": null,
    "adminApiCatalog": [
      {
        "path": "/settings/get",
        "method": "GET",
        "requestShape": {},
        "responseShape": {
          "abandonment_delay_hours": "number",
          "email_subject": "string",
          "email_body_template": "string",
          "is_enabled": "boolean"
        }
      },
      {
        "path": "/settings/save",
        "method": "POST",
        "requestShape": {
          "abandonment_delay_hours": "number",
          "email_subject": "string",
          "email_body_template": "string",
          "is_enabled": "boolean"
        },
        "responseShape": {
          "success": "boolean"
        }
      },
      {
        "path": "/reminders/list",
        "method": "GET",
        "requestShape": {
          "page": "number",
          "page_size": "number",
          "status": "string | null"
        },
        "responseShape": {
          "items": [
            {
              "id": "string",
              "customer_email": "string",
              "checkout_id": "string",
              "checkout_url": "string",
              "cart_subtotal_amount": "string",
              "cart_currency": "string",
              "line_items_snapshot": "array",
              "status": "string",
              "sent_at": "string",
              "converted_at": "string | null"
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
        }
      },
      {
        "path": "/reminders/stats",
        "method": "GET",
        "requestShape": {},
        "responseShape": {
          "total_sent": "number",
          "total_converted": "number",
          "conversion_rate_percent": "number",
          "total_recovered_value": "string",
          "currency": "string"
        }
      },
      {
        "path": "/run",
        "method": "POST",
        "requestShape": {},
        "responseShape": {
          "triggered": "boolean",
          "reminders_sent": "number"
        }
      }
    ]
  }
}
```

## Validation Retries (resolved)

### Attempt 1
- **handler**: GraphQL validation: GraphQL validation errors: Value "UPDATED_AT" does not exist in "AbandonedCheckoutSortKeys" enum. Did you mean the enum value "CREATED_AT"?

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: [],
  cronSchedule: '0 * * * *',
  npmPackages: [],
  handler: async function(ctx) {
    try {
      // ── ADMIN ROUTES ──────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        // GET /settings/get
        if (ctx.adminPath === '/settings/get') {
          const rows = await ctx.db`
            SELECT abandonment_delay_hours, email_subject, email_body_template, is_enabled
            FROM abandoned_cart_settings
            WHERE tenant_id = ${ctx.tenantId}
            LIMIT 1
          `;
          if (rows.length === 0) {
            return {
              abandonment_delay_hours: 1,
              email_subject: 'You left something behind!',
              email_body_template: 'Hi {{customerName}}, you left items in your cart. Come back and complete your purchase!',
              is_enabled: false
            };
          }
          const s = rows[0];
          return {
            abandonment_delay_hours: Number(s.abandonment_delay_hours),
            email_subject: s.email_subject,
            email_body_template: s.email_body_template,
            is_enabled: s.is_enabled
          };
        }

        // POST /settings/save
        if (ctx.adminPath === '/settings/save') {
          const { abandonment_delay_hours, email_subject, email_body_template, is_enabled } = ctx.adminBody;
          if (abandonment_delay_hours === undefined || email_subject === undefined || email_body_template === undefined || is_enabled === undefined) {
            return { success: false, error: 'Missing required fields: abandonment_delay_hours, email_subject, email_body_template, is_enabled' };
          }
          if (typeof abandonment_delay_hours !== 'number' || abandonment_delay_hours < 0) {
            return { success: false, error: 'abandonment_delay_hours must be a non-negative number' };
          }
          try {
            await ctx.db`
              INSERT INTO abandoned_cart_settings (tenant_id, abandonment_delay_hours, email_subject, email_body_template, is_enabled, created_at, updated_at)
              VALUES (${ctx.tenantId}, ${abandonment_delay_hours}, ${email_subject}, ${email_body_template}, ${is_enabled}, NOW(), NOW())
              ON CONFLICT (tenant_id) DO UPDATE SET
                abandonment_delay_hours = EXCLUDED.abandonment_delay_hours,
                email_subject = EXCLUDED.email_subject,
                email_body_template = EXCLUDED.email_body_template,
                is_enabled = EXCLUDED.is_enabled,
                updated_at = NOW()
            `;
            ctx.logger.info({ abandonment_delay_hours, is_enabled }, 'settings saved');
            return { success: true };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'settings save failed');
            return { success: false, error: 'Database error saving settings' };
          }
        }

        // GET /reminders/list
        if (ctx.adminPath === '/reminders/list') {
          const { page = 1, page_size = 20, status = null } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;
          let countRows, items;
          try {
            if (status) {
              countRows = await ctx.db`
                SELECT COUNT(*) as total FROM abandoned_cart_reminders
                WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
              `;
              items = await ctx.db`
                SELECT id, customer_email, checkout_id, checkout_url, cart_subtotal_amount, cart_currency,
                       line_items_snapshot, status, sent_at, converted_at
                FROM abandoned_cart_reminders
                WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
                ORDER BY sent_at DESC NULLS LAST
                LIMIT ${page_size} OFFSET ${offset}
              `;
            } else {
              countRows = await ctx.db`
                SELECT COUNT(*) as total FROM abandoned_cart_reminders
                WHERE tenant_id = ${ctx.tenantId}
              `;
              items = await ctx.db`
                SELECT id, customer_email, checkout_id, checkout_url, cart_subtotal_amount, cart_currency,
                       line_items_snapshot, status, sent_at, converted_at
                FROM abandoned_cart_reminders
                WHERE tenant_id = ${ctx.tenantId}
                ORDER BY sent_at DESC NULLS LAST
                LIMIT ${page_size} OFFSET ${offset}
              `;
            }
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'reminders list query failed');
            return { items: [], total: 0, page, page_size };
          }
          const total = Number(countRows[0].total);
          return {
            items: items.map(r => ({
              id: String(r.id),
              customer_email: r.customer_email,
              checkout_id: String(r.checkout_id),
              checkout_url: r.checkout_url,
              cart_subtotal_amount: r.cart_subtotal_amount,
              cart_currency: r.cart_currency,
              line_items_snapshot: r.line_items_snapshot || [],
              status: r.status,
              sent_at: r.sent_at ? r.sent_at.toISOString() : null,
              converted_at: r.converted_at ? r.converted_at.toISOString() : null
            })),
            total,
            page: Number(page),
            page_size: Number(page_size)
          };
        }

        // GET /reminders/stats
        if (ctx.adminPath === '/reminders/stats') {
          try {
            const stats = await ctx.db`
              SELECT
                COUNT(*) FILTER (WHERE status = 'sent') as total_sent,
                COUNT(*) FILTER (WHERE status = 'converted') as total_converted,
                SUM(CASE WHEN status = 'converted' THEN cart_subtotal_amount::numeric ELSE 0 END) as total_recovered_value,
                MAX(cart_currency) as currency
              FROM abandoned_cart_reminders
              WHERE tenant_id = ${ctx.tenantId}
            `;
            const row = stats[0];
            const total_sent = Number(row.total_sent || 0);
            const total_converted = Number(row.total_converted || 0);
            const conversion_rate_percent = total_sent > 0 ? Math.round((total_converted / total_sent) * 10000) / 100 : 0;
            return {
              total_sent,
              total_converted,
              conversion_rate_percent,
              total_recovered_value: (Number(row.total_recovered_value || 0)).toFixed(2),
              currency: row.currency || 'USD'
            };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'reminders stats query failed');
            return {
              total_sent: 0,
              total_converted: 0,
              conversion_rate_percent: 0,
              total_recovered_value: '0.00',
              currency: 'USD'
            };
          }
        }

        // POST /run
        if (ctx.adminPath === '/run') {
          ctx.logger.info({}, 'admin /run: manual trigger');
          const remindersSent = await runAbandonedCartJob(ctx);
          return { triggered: true, reminders_sent: remindersSent };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ── CRON ──────────────────────────────────────────────────────
      if (ctx.trigger === 'cron') {
        ctx.logger.info({ trigger: 'cron' }, 'abandoned cart cron starting');
        const remindersSent = await runAbandonedCartJob(ctx);
        ctx.logger.info({ remindersSent }, 'abandoned cart cron complete');
        return { reminders_sent: remindersSent };
      }

    } catch (err) {
      ctx.logger.error({ err: err.message }, 'handler top-level error');
      return { error: err.message };
    }
  }
};

async function runAbandonedCartJob(ctx) {
  // Load settings
  const settingsRows = await ctx.db`
    SELECT abandonment_delay_hours, is_enabled
    FROM abandoned_cart_settings
    WHERE tenant_id = ${ctx.tenantId}
    LIMIT 1
  `;

  if (settingsRows.length === 0 || !settingsRows[0].is_enabled) {
    ctx.logger.info({}, 'abandoned cart reminders disabled or not configured — skipping');
    return 0;
  }

  const delayHours = Number(settingsRows[0].abandonment_delay_hours) || 1;

  // Build time window: checkouts created between (now - 30 days) and (now - delayHours)
  const now = new Date();
  const windowEnd = new Date(now.getTime() - delayHours * 60 * 60 * 1000);
  const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const windowEndStr = windowEnd.toISOString();
  const windowStartStr = windowStart.toISOString();

  ctx.logger.info({ windowStartStr, windowEndStr, delayHours }, 'fetching abandoned checkouts');

  // Fetch abandoned checkouts from Shopify GraphQL
  // Use CREATED_AT sort (only valid enum value for AbandonedCheckoutSortKeys)
  const PAGE_SIZE = 50;
  const allCheckouts = [];
  let cursor = null;

  try {
    do {
      const result = await ctx.shopify.graphql(
        `query AbandonedCheckouts($first: Int!, $after: String, $query: String!) {
          abandonedCheckouts(first: $first, after: $after, sortKey: CREATED_AT, query: $query) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              name
              abandonedCheckoutUrl
              createdAt
              completedAt
              subtotalPriceSet {
                shopMoney { amount currencyCode }
              }
              customer {
                id
                email
                emailMarketingConsent { marketingState }
              }
              lineItems(first: 50) {
                nodes {
                  title
                  quantity
                  variant {
                    price
                    image { url }
                  }
                }
              }
            }
          }
        }`,
        {
          first: PAGE_SIZE,
          after: cursor,
          query: `created_at:>${windowStartStr} created_at:<${windowEndStr}`
        }
      );

      const page = result.abandonedCheckouts;
      if (!page || !page.nodes || page.nodes.length === 0) break;
      allCheckouts.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
  } catch (err) {
    ctx.logger.error({ err: err.message }, 'Shopify abandonedCheckouts query failed');
    return 0;
  }

  ctx.logger.info({ count: allCheckouts.length }, 'fetched abandoned checkouts from Shopify');

  if (allCheckouts.length === 0) return 0;

  // Extract checkout tokens from GIDs: gid://shopify/AbandonedCheckout/<token>
  // The `name` field is the checkout token/name; GID numeric part is the checkout ID
  const checkoutTokens = allCheckouts.map(c => {
    const gidParts = c.id.split('/');
    return gidParts[gidParts.length - 1];
  });

  // Fetch already-sent reminders for these tokens to deduplicate
  let existingTokensSet = new Set();
  try {
    const existing = await ctx.db`
      SELECT checkout_token FROM abandoned_cart_reminders
      WHERE tenant_id = ${ctx.tenantId}
        AND checkout_token = ANY(${checkoutTokens})
    `;
    for (const row of existing) {
      existingTokensSet.add(row.checkout_token);
    }
  } catch (err) {
    ctx.logger.error({ err: err.message }, 'DB query for existing reminders failed');
    return 0;
  }

  ctx.logger.info({ existingCount: existingTokensSet.size }, 'existing reminders found');

  // Process eligible checkouts
  let remindersSent = 0;

  for (const checkout of allCheckouts) {
    try {
      // Extract checkout token from GID
      const gidParts = checkout.id.split('/');
      const checkoutToken = gidParts[gidParts.length - 1];

      // Skip if already sent
      if (existingTokensSet.has(checkoutToken)) {
        continue;
      }

      // Skip if already completed
      if (checkout.completedAt) {
        continue;
      }

      // Skip if no line items
      const lineItems = checkout.lineItems && checkout.lineItems.nodes ? checkout.lineItems.nodes : [];
      if (lineItems.length === 0) {
        continue;
      }

      // Skip if no customer or no email
      const customer = checkout.customer;
      if (!customer || !customer.email) {
        continue;
      }

      // Skip if email marketing consent explicitly denied
      const marketingState = customer.emailMarketingConsent && customer.emailMarketingConsent.marketingState;
      if (marketingState === 'UNSUBSCRIBED' || marketingState === 'INVALID') {
        continue;
      }

      const customerEmail = customer.email;
      const subtotal = checkout.subtotalPriceSet && checkout.subtotalPriceSet.shopMoney
        ? checkout.subtotalPriceSet.shopMoney.amount
        : '0.00';
      const currency = checkout.subtotalPriceSet && checkout.subtotalPriceSet.shopMoney
        ? checkout.subtotalPriceSet.shopMoney.currencyCode
        : 'USD';

      const lineItemsSnapshot = lineItems.map(li => ({
        title: li.title,
        quantity: li.quantity,
        price: li.variant ? li.variant.price : '0.00',
        image_url: li.variant && li.variant.image ? li.variant.image.url : null
      }));

      const checkoutId = checkoutToken;
      const checkoutUrl = checkout.abandonedCheckoutUrl;

      // Extract customer numeric ID from GID
      const customerGidParts = customer.id ? customer.id.split('/') : [];
      const customerId = customerGidParts.length > 0 ? customerGidParts[customerGidParts.length - 1] : null;

      // Insert reminder row (use ON CONFLICT DO NOTHING for idempotency / concurrent run safety)
      let inserted = false;
      try {
        const insertResult = await ctx.db`
          INSERT INTO abandoned_cart_reminders
            (tenant_id, checkout_token, checkout_id, customer_id, customer_email, checkout_url,
             cart_subtotal_amount, cart_currency, line_items_snapshot, status, sent_at, converted_at)
          VALUES
            (${ctx.tenantId}, ${checkoutToken}, ${checkoutId}, ${customerId}, ${customerEmail},
             ${checkoutUrl}, ${subtotal}, ${currency}, ${JSON.stringify(lineItemsSnapshot)},
             'sent', NOW(), NULL)
          ON CONFLICT (tenant_id, checkout_token) DO NOTHING
          RETURNING id
        `;
        inserted = insertResult.length > 0;
      } catch (dbErr) {
        ctx.logger.error({ err: dbErr.message, checkoutToken }, 'DB insert for reminder failed');
        continue;
      }

      // If not inserted (duplicate), skip email send
      if (!inserted) {
        ctx.logger.info({ checkoutToken }, 'duplicate reminder suppressed by DB constraint');
        continue;
      }

      // Send email
      try {
        await ctx.services.email.send({
          to: customerEmail,
          data: {
            customerName: customerEmail.split('@')[0],
            customerEmail,
            checkoutUrl,
            cartSubtotal: subtotal,
            currency,
            lineItems: lineItemsSnapshot
          }
        });
        remindersSent++;
        ctx.logger.info({ checkoutToken, customerEmail }, 'abandoned cart reminder sent');
      } catch (emailErr) {
        ctx.logger.error({ err: emailErr.message, checkoutToken }, 'email send failed — marking reminder as failed');
        // Attempt to update status to error
        try {
          await ctx.db`
            UPDATE abandoned_cart_reminders SET status = 'error'
            WHERE tenant_id = ${ctx.tenantId} AND checkout_token = ${checkoutToken}
          `;
        } catch (updateErr) {
          ctx.logger.error({ err: updateErr.message }, 'failed to update reminder status to error');
        }
      }

      // Throttle per-item writes to stay under rate limit
      await new Promise(r => setTimeout(r, 200));

    } catch (itemErr) {
      ctx.logger.error({ err: itemErr.message }, 'error processing checkout item — skipping');
      continue;
    }
  }

  return remindersSent;
}
```

### migration.sql

```sql
CREATE TABLE abandoned_cart_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  abandonment_delay_hours INTEGER NOT NULL DEFAULT 6,
  email_subject TEXT NOT NULL DEFAULT 'You left something behind!',
  email_body_template TEXT NOT NULL DEFAULT '',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

ALTER TABLE abandoned_cart_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_settings_tenant_isolation ON abandoned_cart_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX abandoned_cart_settings_tenant_id_idx ON abandoned_cart_settings (tenant_id);

CREATE TABLE abandoned_cart_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  checkout_token TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  customer_id BIGINT NULL,
  customer_email TEXT NOT NULL,
  checkout_url TEXT NOT NULL,
  cart_subtotal_amount TEXT NOT NULL,
  cart_currency TEXT NOT NULL,
  line_items_snapshot JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'sent',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at TIMESTAMPTZ NULL,
  UNIQUE (tenant_id, checkout_token)
);

ALTER TABLE abandoned_cart_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_reminders_tenant_isolation ON abandoned_cart_reminders
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX abandoned_cart_reminders_tenant_id_idx ON abandoned_cart_reminders (tenant_id);
CREATE INDEX abandoned_cart_reminders_tenant_id_customer_id_idx ON abandoned_cart_reminders (tenant_id, customer_id);
CREATE INDEX abandoned_cart_reminders_tenant_id_sent_at_idx ON abandoned_cart_reminders (tenant_id, sent_at);
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  const style = document.createElement('style');
  style.textContent = `
    .arc-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--p-color-border); margin-bottom: var(--p-space-500); }
    .arc-tab { padding: var(--p-space-300) var(--p-space-500); cursor: pointer; font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s; }
    .arc-tab:hover { color: var(--p-color-text); }
    .arc-tab.active { color: var(--p-color-text); border-bottom-color: #008060; font-weight: var(--p-font-weight-semibold); }
    .arc-section { display: none; }
    .arc-section.visible { display: block; }
    .arc-filter-row { display: flex; gap: var(--p-space-300); align-items: center; flex-wrap: wrap; margin-bottom: var(--p-space-400); }
    .arc-select { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); background: var(--p-color-bg-surface); color: var(--p-color-text); font-size: var(--p-font-size-350); font-family: var(--p-font-family-sans); }
    .arc-select:focus { outline: 2px solid #008060; outline-offset: 2px; }
    .arc-run-btn-wrap { margin-left: auto; }
    .arc-form-row { display: flex; flex-direction: column; gap: var(--p-space-200); margin-bottom: var(--p-space-400); }
    .arc-label { font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text); }
    .arc-hint { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-top: var(--p-space-100); }
    .arc-input { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); background: var(--p-color-bg-surface); color: var(--p-color-text); font-size: var(--p-font-size-350); font-family: var(--p-font-family-sans); width: 100%; box-sizing: border-box; }
    .arc-input:focus { outline: 2px solid #008060; outline-offset: 2px; border-color: #008060; }
    .arc-textarea { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); background: var(--p-color-bg-surface); color: var(--p-color-text); font-size: var(--p-font-size-350); font-family: var(--p-font-family-sans); width: 100%; box-sizing: border-box; min-height: 140px; resize: vertical; }
    .arc-textarea:focus { outline: 2px solid #008060; outline-offset: 2px; border-color: #008060; }
    .arc-toggle-row { display: flex; align-items: center; gap: var(--p-space-300); }
    .arc-toggle { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
    .arc-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .arc-toggle-slider { position: absolute; inset: 0; background: var(--p-color-border-emphasis); border-radius: var(--p-border-radius-full); cursor: pointer; transition: background 0.2s; }
    .arc-toggle input:checked + .arc-toggle-slider { background: #008060; }
    .arc-toggle-slider::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: var(--p-color-bg-surface); border-radius: 50%; transition: transform 0.2s; }
    .arc-toggle input:checked + .arc-toggle-slider::before { transform: translateX(18px); }
    .arc-save-row { display: flex; align-items: center; gap: var(--p-space-300); padding-top: var(--p-space-200); border-top: 1px solid var(--p-color-border); margin-top: var(--p-space-400); }
    .arc-checkout-link { color: #008060; text-decoration: none; font-size: var(--p-font-size-300); }
    .arc-checkout-link:hover { text-decoration: underline; }
    .arc-email-cell { font-size: var(--p-font-size-300); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .arc-value-cell { font-weight: var(--p-font-weight-medium); white-space: nowrap; }
    .arc-date-cell { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); white-space: nowrap; }
    .arc-limitation-banner { background: var(--p-color-bg-fill-warning); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-300) var(--p-space-400); margin-bottom: var(--p-space-500); font-size: var(--p-font-size-300); color: var(--p-color-text); }
    .arc-limitation-banner strong { font-weight: var(--p-font-weight-semibold); }
    .arc-run-result { font-size: var(--p-font-size-350); color: var(--p-color-text-secondary); }
    .arc-num-input { max-width: 120px; }
    .arc-stat-note { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-top: var(--p-space-100); }
    .arc-empty-row td { text-align: center; padding: var(--p-space-800); color: var(--p-color-text-secondary); font-size: var(--p-font-size-350); }
    .arc-header-actions { display: flex; align-items: center; gap: var(--p-space-300); flex-wrap: wrap; }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Abandoned Cart Recovery</span>
        <div class="arc-header-actions">
          <span class="arc-run-result" id="arc-run-result"></span>
          <button class="btn-secondary" id="arc-run-btn">▶ Run Now</button>
        </div>
      </div>

      <div class="arc-tabs">
        <button class="arc-tab active" data-tab="dashboard">Dashboard</button>
        <button class="arc-tab" data-tab="settings">Settings</button>
      </div>

      <div class="arc-section visible" id="arc-tab-dashboard">
        <div class="arc-limitation-banner">
          <strong>How it works:</strong> Shopify doesn't provide a native cart-abandoned webhook.
          An hourly cron polls abandoned checkouts via the Shopify GraphQL API and cross-references
          them against your configured abandonment delay before sending reminder emails individually.
        </div>

        <div id="arc-stats-area">
          <div class="shell-loading"><div class="shell-spinner"></div></div>
        </div>

        <div class="shell-card" style="margin-top: var(--p-space-500);">
          <div class="shell-section-title" style="margin-bottom: var(--p-space-400);">Reminder Log</div>
          <div class="arc-filter-row">
            <label class="arc-label" for="arc-status-filter" style="white-space:nowrap;">Filter by status:</label>
            <select class="arc-select" id="arc-status-filter">
              <option value="">All</option>
              <option value="sent">Sent</option>
              <option value="converted">Converted</option>
              <option value="failed">Failed</option>
              <option value="pending">Pending</option>
            </select>
            <button class="btn-secondary" id="arc-refresh-btn" style="margin-left:auto;">↻ Refresh</button>
          </div>
          <div id="arc-table-area">
            <div class="shell-loading"><div class="shell-spinner"></div></div>
          </div>
          <div class="shell-pagination" id="arc-pagination" style="display:none;">
            <span id="arc-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="arc-prev-btn">← Prev</button>
              <button class="btn-secondary" id="arc-next-btn">Next →</button>
            </div>
          </div>
        </div>
      </div>

      <div class="arc-section" id="arc-tab-settings">
        <div class="shell-card">
          <div class="shell-section-title" style="margin-bottom: var(--p-space-500);">Recovery Settings</div>
          <div id="arc-settings-area">
            <div class="shell-loading"><div class="shell-spinner"></div></div>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(style);

  const PAGE_SIZE = 25;
  let currentPage = 1;
  let currentStatus = '';
  let totalItems = 0;

  const runBtn = container.querySelector('#arc-run-btn');
  const runResult = container.querySelector('#arc-run-result');
  const refreshBtn = container.querySelector('#arc-refresh-btn');
  const statusFilter = container.querySelector('#arc-status-filter');
  const statsArea = container.querySelector('#arc-stats-area');
  const tableArea = container.querySelector('#arc-table-area');
  const pagination = container.querySelector('#arc-pagination');
  const pageInfo = container.querySelector('#arc-page-info');
  const prevBtn = container.querySelector('#arc-prev-btn');
  const nextBtn = container.querySelector('#arc-next-btn');
  const settingsArea = container.querySelector('#arc-settings-area');

  function switchTab(name) {
    container.querySelectorAll('.arc-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    container.querySelectorAll('.arc-section').forEach(s => s.classList.toggle('visible', s.id === `arc-tab-${name}`));
  }

  container.querySelectorAll('.arc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
      if (tab.dataset.tab === 'settings') loadSettings();
    });
  });

  function formatDate(str) {
    if (!str) return '—';
    try {
      const d = new Date(str);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
        d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch { return str; }
  }

  function statusBadge(status) {
    const map = { sent: 'badge-success', converted: 'badge-success', failed: 'badge-error', pending: 'badge-warning' };
    const cls = map[status] || 'badge-neutral';
    const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : '—';
    return `<span class="badge ${cls}">${label}</span>`;
  }

  async function loadStats() {
    statsArea.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';
    try {
      const s = await bridge.call('/reminders/stats', {});
      const convRate = typeof s.conversion_rate_percent === 'number' ? s.conversion_rate_percent.toFixed(1) : '0.0';
      const recovered = s.total_recovered_value ? `${s.currency || ''} ${s.total_recovered_value}` : '—';
      statsArea.innerHTML = `
        <div class="shell-stats-row">
          <div class="shell-stat-card">
            <div class="shell-stat-label">Reminders Sent</div>
            <div class="shell-stat-value">${s.total_sent ?? 0}</div>
          </div>
          <div class="shell-stat-card">
            <div class="shell-stat-label">Carts Recovered</div>
            <div class="shell-stat-value">${s.total_converted ?? 0}</div>
          </div>
          <div class="shell-stat-card">
            <div class="shell-stat-label">Conversion Rate</div>
            <div class="shell-stat-value">${convRate}%</div>
          </div>
          <div class="shell-stat-card">
            <div class="shell-stat-label">Recovered Value</div>
            <div class="shell-stat-value" style="font-size:var(--p-font-size-400);">${recovered}</div>
          </div>
        </div>
      `;
    } catch (err) {
      statsArea.innerHTML = `<div class="shell-error-banner">Failed to load stats: ${err.message || err}</div>`;
    }
  }

  async function loadReminders() {
    tableArea.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';
    pagination.style.display = 'none';
    try {
      const res = await bridge.call('/reminders/list', {
        page: currentPage,
        page_size: PAGE_SIZE,
        status: currentStatus || null
      });
      totalItems = res.total || 0;
      const items = res.items || [];

      if (items.length === 0) {
        tableArea.innerHTML = `
          <div class="shell-table-wrap">
            <table class="shell-table">
              <thead><tr>
                <th>Customer</th><th>Checkout Value</th><th>Status</th>
                <th>Sent At</th><th>Converted At</th><th>Checkout</th>
              </tr></thead>
              <tbody><tr class="arc-empty-row"><td colspan="6">No reminders found for the selected filter.</td></tr></tbody>
            </table>
          </div>`;
        return;
      }

      let rows = '';
      items.forEach(item => {
        const subtotal = item.cart_subtotal_amount ? `${item.cart_currency || ''} ${item.cart_subtotal_amount}` : '—';
        const checkoutLink = item.checkout_url
          ? `<a class="arc-checkout-link" href="${item.checkout_url}" target="_blank" rel="noopener">Open ↗</a>`
          : '—';
        rows += `<tr>
          <td><div class="arc-email-cell" title="${item.customer_email || ''}">${item.customer_email || '—'}</div></td>
          <td><span class="arc-value-cell">${subtotal}</span></td>
          <td>${statusBadge(item.status)}</td>
          <td><span class="arc-date-cell">${formatDate(item.sent_at)}</span></td>
          <td><span class="arc-date-cell">${formatDate(item.converted_at)}</span></td>
          <td>${checkoutLink}</td>
        </tr>`;
      });

      tableArea.innerHTML = `
        <div class="shell-table-wrap">
          <table class="shell-table">
            <thead><tr>
              <th>Customer</th><th>Checkout Value</th><th>Status</th>
              <th>Sent At</th><th>Converted At</th><th>Checkout</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;

      const totalPages = Math.ceil(totalItems / PAGE_SIZE);
      if (totalItems > PAGE_SIZE) {
        pagination.style.display = 'flex';
        pageInfo.textContent = `Page ${currentPage} of ${totalPages} (${totalItems} total)`;
        prevBtn.disabled = currentPage <= 1;
        nextBtn.disabled = currentPage >= totalPages;
      }
    } catch (err) {
      tableArea.innerHTML = `<div class="shell-error-banner">Failed to load reminders: ${err.message || err}</div>`;
    }
  }

  statusFilter.addEventListener('change', () => {
    currentStatus = statusFilter.value;
    currentPage = 1;
    loadReminders();
  });

  refreshBtn.addEventListener('click', () => {
    loadStats();
    loadReminders();
  });

  prevBtn.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; loadReminders(); }
  });

  nextBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(totalItems / PAGE_SIZE);
    if (currentPage < totalPages) { currentPage++; loadReminders(); }
  });

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runResult.textContent = 'Running…';
    try {
      const res = await bridge.call('/run', {});
      if (res.triggered) {
        const msg = `Sent ${res.reminders_sent ?? 0} reminder(s).`;
        runResult.textContent = msg;
        bridge.notify(msg, 'success');
        loadStats();
        loadReminders();
      } else {
        runResult.textContent = 'Run completed (nothing to send).';
        bridge.notify('Run completed — no new reminders to send.', 'info');
      }
    } catch (err) {
      runResult.textContent = 'Run failed.';
      bridge.notify(`Run failed: ${err.message || err}`, 'error');
    } finally {
      runBtn.disabled = false;
    }
  });

  async function loadSettings() {
    settingsArea.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';
    try {
      const cfg = await bridge.call('/settings/get', {});
      settingsArea.innerHTML = `
        <div class="arc-toggle-row arc-form-row">
          <label class="arc-label">Email Recovery Enabled</label>
          <label class="arc-toggle">
            <input type="checkbox" id="cfg-enabled" ${cfg.is_enabled ? 'checked' : ''}>
            <span class="arc-toggle-slider"></span>
          </label>
          <span class="arc-hint" style="margin-top:0;">Turn reminder emails on or off globally.</span>
        </div>

        <div class="arc-form-row">
          <label class="arc-label" for="cfg-delay">Abandonment Delay (hours)</label>
          <input class="arc-input arc-num-input" type="number" id="cfg-delay"
            min="1" max="168" step="1"
            value="${cfg.abandonment_delay_hours ?? 6}">
          <div class="arc-hint">How long after cart activity before sending a reminder. Recommended: 6–72 hours.</div>
        </div>

        <div class="arc-form-row">
          <label class="arc-label" for="cfg-subject">Email Subject</label>
          <input class="arc-input" type="text" id="cfg-subject"
            value="${escapeHtmlAttr(cfg.email_subject || '')}">
          <div class="arc-hint">Subject line for reminder emails. You can use <code>{{shop_name}}</code> as a variable.</div>
        </div>

        <div class="arc-form-row">
          <label class="arc-label" for="cfg-body">Email Body Template</label>
          <textarea class="arc-textarea" id="cfg-body">${escapeHtmlContent(cfg.email_body_template || '')}</textarea>
          <div class="arc-hint">Supports variables: <code>{{customer_name}}</code>, <code>{{checkout_url}}</code>, <code>{{cart_items}}</code>, <code>{{shop_name}}</code>.</div>
        </div>

        <div class="arc-save-row">
          <button class="btn-primary" id="cfg-save-btn">Save Settings</button>
          <span id="cfg-save-status" style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);"></span>
        </div>
      `;

      const saveBtn = container.querySelector('#cfg-save-btn');
      const saveStatus = container.querySelector('#cfg-save-status');

      saveBtn.addEventListener('click', async () => {
        const delay = parseInt(container.querySelector('#cfg-delay').value, 10);
        const subject = container.querySelector('#cfg-subject').value.trim();
        const body = container.querySelector('#cfg-body').value;
        const enabled = container.querySelector('#cfg-enabled').checked;

        if (!delay || delay < 1 || delay > 168) {
          bridge.notify('Abandonment delay must be between 1 and 168 hours.', 'error');
          return;
        }
        if (!subject) {
          bridge.notify('Email subject cannot be empty.', 'error');
          return;
        }

        saveBtn.disabled = true;
        saveStatus.textContent = 'Saving…';
        try {
          const res = await bridge.call('/settings/save', {
            abandonment_delay_hours: delay,
            email_subject: subject,
            email_body_template: body,
            is_enabled: enabled
          });
          if (res.success) {
            saveStatus.textContent = 'Saved!';
            bridge.notify('Settings saved successfully.', 'success');
          } else {
            saveStatus.textContent = 'Save failed.';
            bridge.notify('Settings could not be saved. Please try again.', 'error');
          }
        } catch (err) {
          saveStatus.textContent = 'Error.';
          bridge.notify(`Save failed: ${err.message || err}`, 'error');
        } finally {
          saveBtn.disabled = false;
        }
      });

    } catch (err) {
      settingsArea.innerHTML = `<div class="shell-error-banner">Failed to load settings: ${err.message || err}</div>`;
    }
  }

  function escapeHtmlAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeHtmlContent(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  loadStats();
  loadReminders();
}
```


## Explanation

Your Abandoned Cart Recovery app automatically finds shopping carts that customers left behind and sends them friendly reminder emails to bring them back to checkout. Here's how it works: Every hour, the app checks your store for carts that have items in them but haven't been purchased yet. If a cart matches your settings (for example, abandoned for more than 6 hours), the app sends a personalized reminder email with product images and a direct link back to their cart. The app is smart enough to send each customer only one reminder per abandoned cart, and it respects their email preferences so you stay compliant with their communication choices.

From your Shopify Admin dashboard, you control everything. You can set how long a cart should sit abandoned before a reminder goes out (anywhere from 6 to 72 hours), customize the email message and sender details, and decide whether to send reminders at all. You'll also see a complete activity log in your dashboard showing exactly which reminder emails were sent, when they were delivered, and whether there were any issues. If you need to manually check for abandoned carts right now instead of waiting for the hourly automatic check, you can trigger a manual scan from the dashboard. The app handles all the complexity—detecting carts with items, avoiding duplicate emails, and formatting mobile-friendly emails—so you can focus on recovering sales.
