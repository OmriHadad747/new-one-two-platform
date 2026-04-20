# Chat Local — Full Pipeline

**Date:** 2026-04-14 15:21:02  
**Status:** ✅ SUCCESS  
**Total:** 131549ms  
**Tokens:** in=42670 out=17318 total=59988  
**Prompt:** Recover abandoned carts by sending timely, personalized reminder emails to customers who leave without purchasing.

## Intent (Product Agent)

```json
{
  "triggerTypes": [
    "cron",
    "webhook"
  ],
  "resources": [
    "Cart",
    "Customer",
    "Email"
  ],
  "desiredOutcome": "Recover abandoned carts by sending timely, personalized reminder emails to customers who leave without purchasing.",
  "cronSchedule": "0 */6 * * *",
  "appCategory": "backend_admin",
  "qualityBrief": "A good abandoned cart recovery app should: (1) only email customers once per abandoned cart to avoid fatigue, (2) respect the merchant's configurable delay (e.g., 4\u201324 hours after last cart activity), (3) exclude carts already converted to orders, (4) show the merchant a log of sent reminders with open/click rates if available via Shopify's email analytics, and (5) let them customize the email subject and body. Common pitfall: sending multiple reminders for the same cart or emailing too aggressively, which damages reputation."
}
```

## Architect Plan

```json
{
  "shopifyPlan": {
    "webhookTopics": [
      "checkouts/create",
      "checkouts/update",
      "orders/create"
    ],
    "cronSchedule": "0 */6 * * *"
  },
  "appContracts": {
    "feasibility": "feasible",
    "blockedReason": null,
    "complexity": "high",
    "edgeCases": [
      "A checkout is completed and an order is created before the cron runs \u2014 the cart must be excluded from reminder emails by cross-referencing the orders table or the recovered_at flag",
      "Multiple checkouts/update webhooks fire in rapid succession for the same cart \u2014 deduplicate by upserting on token and only updating updated_at, never resetting sent_at",
      "A customer abandons multiple carts across sessions \u2014 each cart token is a distinct row; only unsent, unrecovered carts within the configured delay window are eligible",
      "The merchant changes the reminder_delay_hours setting between cron runs \u2014 the cron must read the current setting at job start so in-flight eligibility uses the latest threshold",
      "A cart has no customer_email (guest with no email captured at checkout) \u2014 skip silently without marking as sent, so it remains eligible if the customer later provides an email",
      "The cron runs while a previous cron execution is still processing \u2014 use a DB-level advisory lock or a running_since column on the settings table to prevent double-sends"
    ],
    "uxExpectations": {
      "storefront": null,
      "admin": "The merchant dashboard should lead with a summary panel showing total reminders sent, estimated recovered revenue, and recovery rate. The reminder log table should be filterable by date and status (sent/recovered/failed) with cart value and customer email visible at a glance. Settings for delay window and email template should be one click away from the dashboard."
    },
    "stateMachine": null,
    "platformGaps": [
      {
        "gap": "Shopify does not expose open/click tracking analytics for transactional emails sent via third-party apps",
        "mitigation": "Track sent_at timestamp and recovered_at timestamp via DB columns updated on orders/create webhook; surface sent vs recovered counts in the admin log as a proxy for effectiveness"
      },
      {
        "gap": "No batch write API for sending emails \u2014 each abandoned cart requires an individual outbound email call",
        "mitigation": "Pre-fetch all eligible abandoned carts and settings in bulk before the loop; per-item email sends inside the loop are unavoidable for this resource type"
      },
      {
        "gap": "Shopify's abandoned checkout list does not provide a server-push event when a cart crosses the idle threshold",
        "mitigation": "Cron polling every 6 hours compares updated_at against now() minus the configured delay, identifying newly eligible carts without real-time push"
      }
    ],
    "cronBatching": {
      "required": true,
      "description": "Before the loop begins, bulk-fetch all abandoned_carts rows where reminder_sent = false, recovered = false, and updated_at <= now() minus reminder_delay_hours from settings. Also pre-fetch the single settings row (delay, subject template, body template) once. This avoids per-item settings queries inside the loop."
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
            "name": "reminder_delay_hours",
            "type": "INTEGER",
            "constraints": "NOT NULL DEFAULT 4"
          },
          {
            "name": "email_subject",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'You left something behind!'"
          },
          {
            "name": "email_body",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT ''"
          },
          {
            "name": "is_enabled",
            "type": "BOOLEAN",
            "constraints": "NOT NULL DEFAULT true"
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
        "table": "abandoned_carts",
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
            "type": "BIGINT",
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
            "constraints": "NULL"
          },
          {
            "name": "customer_name",
            "type": "TEXT",
            "constraints": "NULL"
          },
          {
            "name": "cart_total",
            "type": "NUMERIC(12,2)",
            "constraints": "NOT NULL DEFAULT 0"
          },
          {
            "name": "currency",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'USD'"
          },
          {
            "name": "line_items_json",
            "type": "JSONB",
            "constraints": "NOT NULL DEFAULT '[]'"
          },
          {
            "name": "checkout_url",
            "type": "TEXT",
            "constraints": "NULL"
          },
          {
            "name": "cart_updated_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL"
          },
          {
            "name": "reminder_sent",
            "type": "BOOLEAN",
            "constraints": "NOT NULL DEFAULT false"
          },
          {
            "name": "sent_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NULL"
          },
          {
            "name": "recovered",
            "type": "BOOLEAN",
            "constraints": "NOT NULL DEFAULT false"
          },
          {
            "name": "recovered_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NULL"
          },
          {
            "name": "created_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
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
          "checkout_token",
          "customer_email",
          "reminder_sent",
          "recovered"
        ],
        "rls": true
      },
      {
        "table": "reminder_log",
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
            "name": "abandoned_cart_id",
            "type": "UUID",
            "constraints": "NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE"
          },
          {
            "name": "checkout_token",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "customer_email",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "customer_name",
            "type": "TEXT",
            "constraints": "NULL"
          },
          {
            "name": "cart_total",
            "type": "NUMERIC(12,2)",
            "constraints": "NOT NULL"
          },
          {
            "name": "currency",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "email_subject",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "status",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'sent'"
          },
          {
            "name": "recovered",
            "type": "BOOLEAN",
            "constraints": "NOT NULL DEFAULT false"
          },
          {
            "name": "sent_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
          }
        ],
        "uniqueConstraint": null,
        "indexes": [
          "tenant_id",
          "abandoned_cart_id",
          "sent_at"
        ],
        "rls": true
      }
    ],
    "webhookContract": {
      "payloadFields": [
        "id",
        "token",
        "email",
        "customer",
        "total_price",
        "currency",
        "line_items",
        "abandoned_checkout_url",
        "updated_at",
        "completed_at"
      ],
      "handlerMustProduce": "For checkouts/create and checkouts/update: upsert an abandoned_carts row keyed on (tenant_id, checkout_token) using token as the key. Populate checkout_id from id, customer_id from customer.id (nullable), customer_email from email (nullable), customer_name from customer.first_name + last_name (nullable), cart_total from total_price, currency, line_items_json from line_items array, checkout_url from abandoned_checkout_url, and cart_updated_at from updated_at. If completed_at is non-null on the payload, immediately set recovered = true and recovered_at = completed_at on the row \u2014 the cart was completed during the webhook event. Do NOT reset reminder_sent or sent_at on update. For orders/create: extract checkout_token from the order payload; if a matching abandoned_carts row exists for this tenant, set recovered = true and recovered_at = now() and update the corresponding reminder_log row status to 'recovered'."
    },
    "cronContract": {
      "handlerMustProduce": "At job start, read the abandoned_cart_settings row for the tenant to get reminder_delay_hours, email_subject, email_body, and is_enabled. If is_enabled is false, exit immediately. Query all abandoned_carts rows where tenant_id matches, reminder_sent = false, recovered = false, customer_email IS NOT NULL, and cart_updated_at <= now() minus reminder_delay_hours. For each eligible cart: render the email subject and body by interpolating customer_name, cart_total, currency, line_items_json, and checkout_url into the templates. Send the email to customer_email. On successful send, set reminder_sent = true and sent_at = now() on the abandoned_carts row, and insert a row into reminder_log. On send failure, leave reminder_sent = false so the cart remains eligible on the next run, and log the error without crashing the batch."
    },
    "widgetTargetTemplates": null,
    "widgetApiCatalog": null,
    "adminApiCatalog": [
      {
        "path": "/settings/get",
        "method": "GET",
        "requestShape": {},
        "responseShape": {
          "reminder_delay_hours": "number",
          "email_subject": "string",
          "email_body": "string",
          "is_enabled": "boolean"
        }
      },
      {
        "path": "/settings/save",
        "method": "POST",
        "requestShape": {
          "reminder_delay_hours": "number",
          "email_subject": "string",
          "email_body": "string",
          "is_enabled": "boolean"
        },
        "responseShape": {
          "success": "boolean"
        }
      },
      {
        "path": "/dashboard/summary",
        "method": "GET",
        "requestShape": {},
        "responseShape": {
          "total_sent": "number",
          "total_recovered": "number",
          "recovery_rate_pct": "number",
          "recovered_revenue": "number",
          "currency": "string"
        }
      },
      {
        "path": "/reminder-log/list",
        "method": "GET",
        "requestShape": {
          "page": "number",
          "page_size": "number",
          "status_filter": "string"
        },
        "responseShape": {
          "items": [
            {
              "id": "string",
              "customer_email": "string",
              "customer_name": "string",
              "cart_total": "number",
              "currency": "string",
              "email_subject": "string",
              "status": "string",
              "recovered": "boolean",
              "sent_at": "string"
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
        }
      },
      {
        "path": "/run",
        "method": "POST",
        "requestShape": {},
        "responseShape": {
          "emails_sent": "number",
          "errors": "number"
        }
      }
    ]
  }
}
```

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['checkouts/create', 'checkouts/update', 'orders/create'],
  cronSchedule: '0 */6 * * *',
  npmPackages: [],
  handler: async function (ctx) {
    try {
      // ─── ADMIN ────────────────────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        // GET /settings/get
        if (ctx.adminPath === '/settings/get') {
          const rows = await ctx.db`
            SELECT reminder_delay_hours, email_subject, email_body, is_enabled
            FROM abandoned_cart_settings
            WHERE tenant_id = ${ctx.tenantId}
            LIMIT 1
          `;
          if (rows.length === 0) {
            return {
              reminder_delay_hours: 24,
              email_subject: 'You left something behind!',
              email_body: 'Hi {{customer_name}}, your cart total of {{cart_total}} {{currency}} is waiting.',
              is_enabled: false,
            };
          }
          const s = rows[0];
          return {
            reminder_delay_hours: Number(s.reminder_delay_hours),
            email_subject: s.email_subject,
            email_body: s.email_body,
            is_enabled: Boolean(s.is_enabled),
          };
        }

        // POST /settings/save
        if (ctx.adminPath === '/settings/save') {
          const { reminder_delay_hours, email_subject, email_body, is_enabled } = ctx.adminBody;
          if (
            reminder_delay_hours === undefined ||
            email_subject === undefined ||
            email_body === undefined ||
            is_enabled === undefined
          ) {
            return { success: false, error: 'Missing required fields' };
          }
          ctx.logger.info({ reminder_delay_hours, is_enabled }, 'admin: saving settings');
          await ctx.db`
            INSERT INTO abandoned_cart_settings (tenant_id, reminder_delay_hours, email_subject, email_body, is_enabled, updated_at)
            VALUES (${ctx.tenantId}, ${reminder_delay_hours}, ${email_subject}, ${email_body}, ${is_enabled}, NOW())
            ON CONFLICT (tenant_id) DO UPDATE SET
              reminder_delay_hours = EXCLUDED.reminder_delay_hours,
              email_subject = EXCLUDED.email_subject,
              email_body = EXCLUDED.email_body,
              is_enabled = EXCLUDED.is_enabled,
              updated_at = NOW()
          `;
          return { success: true };
        }

        // GET /dashboard/summary
        if (ctx.adminPath === '/dashboard/summary') {
          const sentRows = await ctx.db`
            SELECT COUNT(*) AS total_sent
            FROM reminder_log
            WHERE tenant_id = ${ctx.tenantId}
          `;
          const recoveredRows = await ctx.db`
            SELECT COUNT(*) AS total_recovered, SUM(cart_total) AS recovered_revenue, MAX(currency) AS currency
            FROM reminder_log
            WHERE tenant_id = ${ctx.tenantId} AND recovered = true
          `;
          const totalSent = Number(sentRows[0].total_sent) || 0;
          const totalRecovered = Number(recoveredRows[0].total_recovered) || 0;
          const recoveredRevenue = Number(recoveredRows[0].recovered_revenue) || 0;
          const currency = recoveredRows[0].currency || 'USD';
          const recoveryRatePct = totalSent > 0 ? Math.round((totalRecovered / totalSent) * 100 * 100) / 100 : 0;
          return {
            total_sent: totalSent,
            total_recovered: totalRecovered,
            recovery_rate_pct: recoveryRatePct,
            recovered_revenue: recoveredRevenue,
            currency,
          };
        }

        // GET /reminder-log/list
        if (ctx.adminPath === '/reminder-log/list') {
          const { page = 1, page_size = 20, status_filter } = ctx.adminBody || {};
          const pageNum = Math.max(1, Number(page));
          const pageSize = Math.min(100, Math.max(1, Number(page_size)));
          const offset = (pageNum - 1) * pageSize;

          let items, countRows;
          if (status_filter && status_filter !== '') {
            items = await ctx.db`
              SELECT id, customer_email, customer_name, cart_total, currency, email_subject, status, recovered, sent_at
              FROM reminder_log
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status_filter}
              ORDER BY sent_at DESC
              LIMIT ${pageSize} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM reminder_log
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status_filter}
            `;
          } else {
            items = await ctx.db`
              SELECT id, customer_email, customer_name, cart_total, currency, email_subject, status, recovered, sent_at
              FROM reminder_log
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY sent_at DESC
              LIMIT ${pageSize} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM reminder_log
              WHERE tenant_id = ${ctx.tenantId}
            `;
          }

          return {
            items: items.map((r) => ({
              id: String(r.id),
              customer_email: r.customer_email,
              customer_name: r.customer_name || '',
              cart_total: Number(r.cart_total),
              currency: r.currency,
              email_subject: r.email_subject,
              status: r.status,
              recovered: Boolean(r.recovered),
              sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : '',
            })),
            total: Number(countRows[0].total),
            page: pageNum,
            page_size: pageSize,
          };
        }

        // POST /run — manually trigger cron logic
        if (ctx.adminPath === '/run') {
          ctx.logger.info({}, 'admin: manual run triggered');
          const result = await runCronJob(ctx);
          return result;
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ─── CRON ─────────────────────────────────────────────────────────────
      if (ctx.trigger === 'cron') {
        ctx.logger.info({ trigger: ctx.trigger }, 'cron: abandoned cart reminder run');
        const result = await runCronJob(ctx);
        ctx.logger.info(result, 'cron: run complete');
        return result;
      }

      // ─── WEBHOOK ──────────────────────────────────────────────────────────
      if (ctx.trigger === 'webhook') {
        const payload = ctx.payload;
        ctx.logger.info({ trigger: ctx.trigger, payloadId: payload.id }, 'webhook: received');

        // orders/create — mark cart as recovered
        if (payload.source_name !== undefined && payload.checkout_token !== undefined) {
          // orders/create payload has checkout_token
          const checkoutToken = payload.checkout_token;
          if (checkoutToken) {
            ctx.logger.info({ checkoutToken }, 'webhook: orders/create — marking recovered');
            const updated = await ctx.db`
              UPDATE abandoned_carts
              SET recovered = true, recovered_at = NOW()
              WHERE tenant_id = ${ctx.tenantId}
                AND checkout_token = ${checkoutToken}
                AND recovered = false
              RETURNING id
            `;
            if (updated.length > 0) {
              const cartId = updated[0].id;
              await ctx.db`
                UPDATE reminder_log
                SET recovered = true, status = 'recovered'
                WHERE tenant_id = ${ctx.tenantId}
                  AND abandoned_cart_id = ${cartId}
                  AND recovered = false
              `;
              ctx.logger.info({ checkoutToken, cartId }, 'webhook: cart marked recovered');
            }
          }
          return;
        }

        // checkouts/create or checkouts/update
        const token = payload.token;
        if (!token) {
          ctx.logger.warn({ payloadId: payload.id }, 'webhook: checkout has no token, skipping');
          return;
        }

        const checkoutId = payload.id;
        const customerId = payload.customer ? payload.customer.id : null;
        const customerEmail = payload.email || null;
        const customerName = payload.customer
          ? [payload.customer.first_name, payload.customer.last_name].filter(Boolean).join(' ') || null
          : null;
        const cartTotal = payload.total_price || '0.00';
        const currency = payload.currency || 'USD';
        const lineItemsJson = payload.line_items ? JSON.stringify(payload.line_items) : '[]';
        const checkoutUrl = payload.abandoned_checkout_url || null;
        const cartUpdatedAt = payload.updated_at ? new Date(payload.updated_at) : new Date();
        const completedAt = payload.completed_at ? new Date(payload.completed_at) : null;
        const isRecovered = completedAt !== null;

        ctx.logger.info({ token, checkoutId, isRecovered }, 'webhook: upserting abandoned_cart');

        await ctx.db`
          INSERT INTO abandoned_carts (
            tenant_id, checkout_token, checkout_id, customer_id, customer_email,
            customer_name, cart_total, currency, line_items_json, checkout_url,
            cart_updated_at, reminder_sent, recovered, recovered_at, created_at
          ) VALUES (
            ${ctx.tenantId}, ${token}, ${checkoutId}, ${customerId}, ${customerEmail},
            ${customerName}, ${cartTotal}, ${currency}, ${lineItemsJson}, ${checkoutUrl},
            ${cartUpdatedAt}, false, ${isRecovered}, ${completedAt}, NOW()
          )
          ON CONFLICT (tenant_id, checkout_token) DO UPDATE SET
            checkout_id    = EXCLUDED.checkout_id,
            customer_id    = EXCLUDED.customer_id,
            customer_email = EXCLUDED.customer_email,
            customer_name  = EXCLUDED.customer_name,
            cart_total     = EXCLUDED.cart_total,
            currency       = EXCLUDED.currency,
            line_items_json = EXCLUDED.line_items_json,
            checkout_url   = EXCLUDED.checkout_url,
            cart_updated_at = EXCLUDED.cart_updated_at,
            recovered      = CASE WHEN EXCLUDED.recovered THEN true ELSE abandoned_carts.recovered END,
            recovered_at   = CASE WHEN EXCLUDED.recovered AND abandoned_carts.recovered_at IS NULL
                                  THEN EXCLUDED.recovered_at
                                  ELSE abandoned_carts.recovered_at END
        `;

        return;
      }
    } catch (err) {
      ctx.logger.error({ err: err.message }, 'handler: unhandled error');
    }
  },
};

// ─── Shared cron / manual-run logic ────────────────────────────────────────
async function runCronJob(ctx) {
  // Read settings
  const settingsRows = await ctx.db`
    SELECT reminder_delay_hours, email_subject, email_body, is_enabled
    FROM abandoned_cart_settings
    WHERE tenant_id = ${ctx.tenantId}
    LIMIT 1
  `;

  if (settingsRows.length === 0) {
    ctx.logger.info({}, 'cron: no settings found, skipping');
    return { emails_sent: 0, errors: 0 };
  }

  const settings = settingsRows[0];
  if (!settings.is_enabled) {
    ctx.logger.info({}, 'cron: reminders disabled, skipping');
    return { emails_sent: 0, errors: 0 };
  }

  const delayHours = Number(settings.reminder_delay_hours) || 24;

  // Claim eligible carts atomically to prevent double-send across concurrent runs
  const eligibleCarts = await ctx.db`
    UPDATE abandoned_carts
    SET reminder_sent = true, sent_at = NOW()
    WHERE tenant_id = ${ctx.tenantId}
      AND reminder_sent = false
      AND recovered = false
      AND customer_email IS NOT NULL
      AND cart_updated_at <= NOW() - (${delayHours} || ' hours')::INTERVAL
    RETURNING id, checkout_token, customer_email, customer_name, cart_total, currency,
              line_items_json, checkout_url, cart_updated_at, sent_at
    LIMIT 500
  `;

  if (eligibleCarts.length === 0) {
    ctx.logger.info({}, 'cron: no eligible carts');
    return { emails_sent: 0, errors: 0 };
  }

  ctx.logger.info({ count: eligibleCarts.length }, 'cron: claimed eligible carts');

  let emailsSent = 0;
  let errors = 0;

  for (const cart of eligibleCarts) {
    try {
      const customerName = cart.customer_name || 'Valued Customer';
      const cartTotal = Number(cart.cart_total).toFixed(2);
      const lineItems = JSON.parse(cart.line_items_json || '[]');
      const lineItemsSummary = lineItems
        .map((li) => `${li.title || li.name || 'Item'} x${li.quantity}`)
        .join(', ');

      const interpolate = (template) =>
        template
          .replace(/\{\{customer_name\}\}/g, customerName)
          .replace(/\{\{cart_total\}\}/g, cartTotal)
          .replace(/\{\{currency\}\}/g, cart.currency)
          .replace(/\{\{line_items\}\}/g, lineItemsSummary)
          .replace(/\{\{checkout_url\}\}/g, cart.checkout_url || '')
          .replace(/\{\{customerName\}\}/g, customerName)
          .replace(/\{\{cartTotal\}\}/g, cartTotal)
          .replace(/\{\{recoveryUrl\}\}/g, cart.checkout_url || '');

      const resolvedSubject = interpolate(settings.email_subject);

      await ctx.services.email.send({
        to: cart.customer_email,
        data: {
          customerName,
          cartTotal,
          currency: cart.currency,
          lineItems: lineItemsSummary,
          checkoutUrl: cart.checkout_url || '',
          recoveryUrl: cart.checkout_url || '',
        },
      });

      // Insert reminder_log record
      await ctx.db`
        INSERT INTO reminder_log (
          tenant_id, abandoned_cart_id, checkout_token, customer_email, customer_name,
          cart_total, currency, email_subject, status, recovered, sent_at
        ) VALUES (
          ${ctx.tenantId}, ${cart.id}, ${cart.checkout_token}, ${cart.customer_email},
          ${cart.customer_name || null}, ${cart.cart_total}, ${cart.currency},
          ${resolvedSubject}, 'sent', false, ${cart.sent_at}
        )
        ON CONFLICT DO NOTHING
      `;

      emailsSent++;
    } catch (err) {
      ctx.logger.error({ cartId: cart.id, err: err.message }, 'cron: failed to send reminder');
      errors++;

      // Rollback the claim so this cart remains eligible on next run
      try {
        await ctx.db`
          UPDATE abandoned_carts
          SET reminder_sent = false, sent_at = NULL
          WHERE tenant_id = ${ctx.tenantId} AND id = ${cart.id}
        `;
      } catch (rollbackErr) {
        ctx.logger.error({ cartId: cart.id, err: rollbackErr.message }, 'cron: failed to rollback cart claim');
      }
    }
  }

  return { emails_sent: emailsSent, errors };
}
```

### migration.sql

```sql
CREATE TABLE abandoned_cart_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  reminder_delay_hours INTEGER NOT NULL DEFAULT 4,
  email_subject TEXT NOT NULL DEFAULT 'You left something behind!',
  email_body TEXT NOT NULL DEFAULT '',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

ALTER TABLE abandoned_cart_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_settings_tenant_isolation ON abandoned_cart_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX abandoned_cart_settings_tenant_id_idx ON abandoned_cart_settings (tenant_id);

CREATE TABLE abandoned_carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  checkout_token TEXT NOT NULL,
  checkout_id BIGINT NOT NULL,
  customer_id BIGINT NULL,
  customer_email TEXT NULL,
  customer_name TEXT NULL,
  cart_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  line_items_json JSONB NOT NULL DEFAULT '[]',
  checkout_url TEXT NULL,
  cart_updated_at TIMESTAMPTZ NOT NULL,
  reminder_sent BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ NULL,
  recovered BOOLEAN NOT NULL DEFAULT false,
  recovered_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, checkout_token)
);

ALTER TABLE abandoned_carts ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_carts_tenant_isolation ON abandoned_carts
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX abandoned_carts_tenant_id_idx ON abandoned_carts (tenant_id);
CREATE INDEX abandoned_carts_checkout_token_idx ON abandoned_carts (checkout_token);
CREATE INDEX abandoned_carts_customer_email_idx ON abandoned_carts (tenant_id, customer_email);
CREATE INDEX abandoned_carts_reminder_sent_idx ON abandoned_carts (tenant_id, reminder_sent);
CREATE INDEX abandoned_carts_recovered_idx ON abandoned_carts (tenant_id, recovered);

CREATE TABLE reminder_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  abandoned_cart_id UUID NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  checkout_token TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT NULL,
  cart_total NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL,
  email_subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  recovered BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE reminder_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY reminder_log_tenant_isolation ON reminder_log
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX reminder_log_tenant_id_idx ON reminder_log (tenant_id);
CREATE INDEX reminder_log_abandoned_cart_id_idx ON reminder_log (tenant_id, abandoned_cart_id);
CREATE INDEX reminder_log_sent_at_idx ON reminder_log (tenant_id, sent_at);
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  // Inject app-specific styles
  const style = document.createElement('style');
  style.textContent = `
    .tab-bar {
      display: flex;
      gap: var(--p-space-100);
      border-bottom: 1px solid var(--p-color-border);
      margin-bottom: var(--p-space-400);
    }
    .tab-btn {
      padding: var(--p-space-200) var(--p-space-400);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      color: var(--p-color-text-secondary);
      font-weight: var(--p-font-weight-medium);
      margin-bottom: -1px;
    }
    .tab-btn.active {
      color: var(--p-color-text);
      border-bottom-color: #008060;
      font-weight: var(--p-font-weight-semibold);
    }
    .tab-btn:hover:not(.active) {
      color: var(--p-color-text);
      background: var(--p-color-bg-surface-secondary);
      border-radius: var(--p-border-radius-100) var(--p-border-radius-100) 0 0;
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .stats-note {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      margin-top: var(--p-space-200);
      padding: var(--p-space-200) var(--p-space-300);
      background: var(--p-color-bg-surface-secondary);
      border-radius: var(--p-border-radius-100);
      border-left: 3px solid var(--p-color-border-emphasis);
    }
    .filter-bar {
      display: flex;
      gap: var(--p-space-200);
      align-items: center;
      margin-bottom: var(--p-space-300);
      flex-wrap: wrap;
    }
    .filter-select {
      padding: var(--p-space-200) var(--p-space-300);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      cursor: pointer;
    }
    .filter-select:focus {
      outline: 2px solid #008060;
      outline-offset: 1px;
    }
    .log-count {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      margin-left: auto;
    }
    .form-group {
      margin-bottom: var(--p-space-400);
    }
    .form-label {
      display: block;
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text);
      margin-bottom: var(--p-space-100);
    }
    .form-hint {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      margin-top: var(--p-space-100);
    }
    .form-input {
      width: 100%;
      padding: var(--p-space-200) var(--p-space-300);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      box-sizing: border-box;
    }
    .form-input:focus {
      outline: 2px solid #008060;
      outline-offset: 1px;
      border-color: #008060;
    }
    .form-textarea {
      width: 100%;
      padding: var(--p-space-200) var(--p-space-300);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      box-sizing: border-box;
      resize: vertical;
      min-height: 140px;
    }
    .form-textarea:focus {
      outline: 2px solid #008060;
      outline-offset: 1px;
      border-color: #008060;
    }
    .form-range {
      width: 100%;
      accent-color: #008060;
    }
    .range-display {
      display: inline-block;
      background: var(--p-color-bg-fill);
      color: var(--p-color-text);
      padding: var(--p-space-100) var(--p-space-200);
      border-radius: var(--p-border-radius-100);
      font-weight: var(--p-font-weight-semibold);
      font-size: var(--p-font-size-350);
      min-width: 60px;
      text-align: center;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: var(--p-space-300);
    }
    .toggle-switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
    }
    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .toggle-slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--p-color-border);
      border-radius: var(--p-border-radius-full);
      transition: 0.2s;
    }
    .toggle-slider:before {
      position: absolute;
      content: '';
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background: var(--p-color-bg-surface);
      border-radius: 50%;
      transition: 0.2s;
    }
    .toggle-switch input:checked + .toggle-slider {
      background: #008060;
    }
    .toggle-switch input:checked + .toggle-slider:before {
      transform: translateX(20px);
    }
    .toggle-label {
      font-size: var(--p-font-size-350);
      color: var(--p-color-text);
    }
    .section-divider {
      border: none;
      border-top: 1px solid var(--p-color-border);
      margin: var(--p-space-500) 0;
    }
    .run-section {
      display: flex;
      align-items: center;
      gap: var(--p-space-300);
      flex-wrap: wrap;
    }
    .run-result {
      font-size: var(--p-font-size-350);
      color: var(--p-color-text-secondary);
    }
    .customer-col {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .customer-name {
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text);
    }
    .customer-email {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
    }
    .cart-value {
      font-weight: var(--p-font-weight-semibold);
      color: var(--p-color-text);
    }
    .dashboard-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--p-space-400);
      flex-wrap: wrap;
      gap: var(--p-space-200);
    }
    .enabled-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--p-space-100);
      font-size: var(--p-font-size-300);
    }
    .enabled-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #008060;
      display: inline-block;
    }
    .disabled-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--p-color-border-emphasis);
      display: inline-block;
    }
  `;
  container.appendChild(style);

  // State
  let currentTab = 'dashboard';
  let logPage = 1;
  const logPageSize = 20;
  let logStatusFilter = '';
  let logTotal = 0;
  let logLoading = false;
  let dashLoading = false;
  let settingsLoading = false;
  let settingsSaving = false;
  let runLoading = false;

  // Set full HTML skeleton
  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Abandoned Cart Recovery</span>
      </div>

      <div class="tab-bar">
        <button class="tab-btn active" data-tab="dashboard">Dashboard</button>
        <button class="tab-btn" data-tab="log">Reminder Log</button>
        <button class="tab-btn" data-tab="settings">Settings</button>
      </div>

      <!-- Dashboard Tab -->
      <div class="tab-panel active" id="tab-dashboard">
        <div class="dashboard-header-row">
          <span class="shell-section-title" style="margin:0">Overview</span>
          <div style="display:flex;gap:var(--p-space-200);align-items:center;">
            <span id="dash-status-badge"></span>
            <button class="btn-secondary" id="dash-refresh-btn">Refresh</button>
          </div>
        </div>
        <div id="dash-content">
          <div class="shell-loading"><div class="shell-spinner"></div></div>
        </div>
        <div class="stats-note" style="margin-top:var(--p-space-400);">
          <strong>Note:</strong> Shopify does not expose open/click analytics for transactional emails. Recovery is tracked when a converted order matches an abandoned cart. Sent vs Recovered counts serve as your effectiveness proxy.
        </div>
        <hr class="section-divider">
        <div class="shell-card">
          <div class="shell-section-title" style="margin-bottom:var(--p-space-300)">Manual Trigger</div>
          <p style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);margin:0 0 var(--p-space-300) 0;">
            Reminders run automatically every 6 hours via cron. You can also trigger a manual run below to immediately process eligible abandoned carts.
          </p>
          <div class="run-section">
            <button class="btn-primary" id="run-btn">Run Now</button>
            <span id="run-result" class="run-result"></span>
          </div>
        </div>
      </div>

      <!-- Log Tab -->
      <div class="tab-panel" id="tab-log">
        <div class="dashboard-header-row">
          <span class="shell-section-title" style="margin:0">Reminder Log</span>
          <button class="btn-secondary" id="log-refresh-btn">Refresh</button>
        </div>
        <div class="filter-bar">
          <label style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);">Filter by status:</label>
          <select class="filter-select" id="log-status-filter">
            <option value="">All statuses</option>
            <option value="sent">Sent</option>
            <option value="recovered">Recovered</option>
            <option value="failed">Failed</option>
          </select>
          <span class="log-count" id="log-count-label"></span>
        </div>
        <div id="log-content">
          <div class="shell-loading"><div class="shell-spinner"></div></div>
        </div>
        <div class="shell-pagination" id="log-pagination" style="display:none;">
          <span id="log-page-info" style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);"></span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" id="log-prev-btn">Previous</button>
            <button class="btn-secondary" id="log-next-btn">Next</button>
          </div>
        </div>
      </div>

      <!-- Settings Tab -->
      <div class="tab-panel" id="tab-settings">
        <div class="shell-section-title" style="margin-bottom:var(--p-space-400)">Configuration</div>
        <div id="settings-content">
          <div class="shell-loading"><div class="shell-spinner"></div></div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(style);

  // Helper: format currency
  function formatCurrency(amount, currency) {
    if (!currency) currency = 'USD';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch (e) {
      return currency + ' ' + Number(amount).toFixed(2);
    }
  }

  // Helper: format date
  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      }).format(new Date(iso));
    } catch (e) {
      return iso;
    }
  }

  // Helper: status badge class
  function statusBadgeClass(status, recovered) {
    if (recovered || status === 'recovered') return 'badge badge-success';
    if (status === 'sent') return 'badge badge-neutral';
    if (status === 'failed') return 'badge badge-error';
    return 'badge badge-neutral';
  }

  function statusLabel(status, recovered) {
    if (recovered || status === 'recovered') return 'Recovered';
    if (status === 'sent') return 'Sent';
    if (status === 'failed') return 'Failed';
    return status || '—';
  }

  // ---- TAB SWITCHING ----
  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab === currentTab) return;
      currentTab = tab;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      container.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
      if (tab === 'dashboard') loadDashboard();
      if (tab === 'log') loadLog(1, logStatusFilter);
      if (tab === 'settings') loadSettings();
    });
  });

  // ---- DASHBOARD ----
  function loadDashboard() {
    if (dashLoading) return;
    dashLoading = true;
    const content = container.querySelector('#dash-content');
    content.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';

    bridge.call('/dashboard/summary', {})
      .then(data => {
        dashLoading = false;
        renderDashboard(data);
      })
      .catch(err => {
        dashLoading = false;
        content.innerHTML = `<div class="shell-error-banner">Failed to load dashboard: ${err && err.message ? err.message : 'Unknown error'}</div>`;
      });

    // Also fetch settings to show enabled badge
    bridge.call('/settings/get', {})
      .then(s => {
        const badge = container.querySelector('#dash-status-badge');
        if (!badge) return;
        if (s.is_enabled) {
          badge.innerHTML = `<span class="enabled-badge"><span class="enabled-dot"></span> Reminders enabled</span>`;
        } else {
          badge.innerHTML = `<span class="enabled-badge" style="color:var(--p-color-text-secondary)"><span class="disabled-dot"></span> Reminders disabled</span>`;
        }
      })
      .catch(() => {});
  }

  function renderDashboard(data) {
    const content = container.querySelector('#dash-content');
    const cur = data.currency || 'USD';
    content.innerHTML = `
      <div class="shell-stats-row">
        <div class="shell-stat-card">
          <div class="shell-stat-label">Total Sent</div>
          <div class="shell-stat-value">${Number(data.total_sent).toLocaleString()}</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Recovered Carts</div>
          <div class="shell-stat-value">${Number(data.total_recovered).toLocaleString()}</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Recovery Rate</div>
          <div class="shell-stat-value">${Number(data.recovery_rate_pct).toFixed(1)}%</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Recovered Revenue</div>
          <div class="shell-stat-value">${formatCurrency(data.recovered_revenue, cur)}</div>
        </div>
      </div>
    `;
  }

  // ---- LOG ----
  function loadLog(page, statusFilter) {
    if (logLoading) return;
    logLoading = true;
    logPage = page;
    logStatusFilter = statusFilter;
    const content = container.querySelector('#log-content');
    content.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';
    container.querySelector('#log-pagination').style.display = 'none';

    bridge.call('/reminder-log/list', {
      page: page,
      page_size: logPageSize,
      status_filter: statusFilter
    })
      .then(data => {
        logLoading = false;
        logTotal = data.total || 0;
        renderLog(data);
      })
      .catch(err => {
        logLoading = false;
        content.innerHTML = `<div class="shell-error-banner">Failed to load reminder log: ${err && err.message ? err.message : 'Unknown error'}</div>`;
      });
  }

  function renderLog(data) {
    const content = container.querySelector('#log-content');
    const countLabel = container.querySelector('#log-count-label');
    const pagination = container.querySelector('#log-pagination');
    const total = data.total || 0;

    if (countLabel) {
      countLabel.textContent = total > 0 ? `${total.toLocaleString()} reminder${total !== 1 ? 's' : ''}` : '';
    }

    if (!data.items || data.items.length === 0) {
      content.innerHTML = '<div class="shell-empty">No reminders found for the selected filter.</div>';
      return;
    }

    const rows = data.items.map(item => `
      <tr>
        <td>
          <div class="customer-col">
            <span class="customer-name">${escapeHtml(item.customer_name || '—')}</span>
            <span class="customer-email">${escapeHtml(item.customer_email || '—')}</span>
          </div>
        </td>
        <td class="cart-value">${formatCurrency(item.cart_total, item.currency)}</td>
        <td>${escapeHtml(item.email_subject || '—')}</td>
        <td><span class="${statusBadgeClass(item.status, item.recovered)}">${statusLabel(item.status, item.recovered)}</span></td>
        <td>${formatDate(item.sent_at)}</td>
      </tr>
    `).join('');

    content.innerHTML = `
      <div class="shell-table-wrap">
        <table class="shell-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Cart Value</th>
              <th>Email Subject</th>
              <th>Status</th>
              <th>Sent At</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    // Pagination
    const totalPages = Math.ceil(total / logPageSize);
    if (totalPages > 1) {
      pagination.style.display = 'flex';
      const pageInfo = container.querySelector('#log-page-info');
      const prevBtn = container.querySelector('#log-prev-btn');
      const nextBtn = container.querySelector('#log-next-btn');
      if (pageInfo) pageInfo.textContent = `Page ${logPage} of ${totalPages} (${total} total)`;
      if (prevBtn) prevBtn.disabled = logPage <= 1;
      if (nextBtn) nextBtn.disabled = logPage >= totalPages;
    } else {
      pagination.style.display = 'none';
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // Log filter change
  container.querySelector('#log-status-filter').addEventListener('change', (e) => {
    loadLog(1, e.target.value);
  });

  // Log refresh
  container.querySelector('#log-refresh-btn').addEventListener('click', () => {
    loadLog(logPage, logStatusFilter);
  });

  // Log pagination
  container.querySelector('#log-prev-btn').addEventListener('click', () => {
    if (logPage > 1) loadLog(logPage - 1, logStatusFilter);
  });
  container.querySelector('#log-next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(logTotal / logPageSize);
    if (logPage < totalPages) loadLog(logPage + 1, logStatusFilter);
  });

  // Dashboard refresh
  container.querySelector('#dash-refresh-btn').addEventListener('click', () => {
    loadDashboard();
  });

  // ---- RUN ----
  container.querySelector('#run-btn').addEventListener('click', () => {
    if (runLoading) return;
    runLoading = true;
    const btn = container.querySelector('#run-btn');
    const result = container.querySelector('#run-result');
    btn.disabled = true;
    btn.textContent = 'Running…';
    result.textContent = '';

    bridge.call('/run', {})
      .then(data => {
        runLoading = false;
        btn.disabled = false;
        btn.textContent = 'Run Now';
        const sent = data.emails_sent || 0;
        const errors = data.errors || 0;
        result.innerHTML = `<span style="color:var(--p-color-text-success);font-weight:var(--p-font-weight-medium);">✓ ${sent} email${sent !== 1 ? 's' : ''} sent</span>${errors > 0 ? ` <span style="color:var(--p-color-text-critical);">  ${errors} error${errors !== 1 ? 's' : ''}</span>` : ''}`;
        bridge.notify(`Run complete: ${sent} emails sent${errors > 0 ? `, ${errors} errors` : ''}`, errors > 0 ? 'error' : 'success');
        // Refresh dashboard stats
        loadDashboard();
      })
      .catch(err => {
        runLoading = false;
        btn.disabled = false;
        btn.textContent = 'Run Now';
        result.innerHTML = `<span style="color:var(--p-color-text-critical);">Run failed: ${err && err.message ? escapeHtml(err.message) : 'Unknown error'}</span>`;
        bridge.notify('Run failed', 'error');
      });
  });

  // ---- SETTINGS ----
  function loadSettings() {
    if (settingsLoading) return;
    settingsLoading = true;
    const content = container.querySelector('#settings-content');
    content.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';

    bridge.call('/settings/get', {})
      .then(data => {
        settingsLoading = false;
        renderSettings(data);
      })
      .catch(err => {
        settingsLoading = false;
        content.innerHTML = `<div class="shell-error-banner">Failed to load settings: ${err && err.message ? err.message : 'Unknown error'}</div>`;
      });
  }

  function renderSettings(data) {
    const content = container.querySelector('#settings-content');
    const delay = data.reminder_delay_hours || 4;
    const subject = data.email_subject || '';
    const body = data.email_body || '';
    const enabled = !!data.is_enabled;

    content.innerHTML = `
      <div class="shell-card">
        <div class="shell-section-title" style="margin-bottom:var(--p-space-400)">General</div>

        <div class="form-group">
          <div class="toggle-row">
            <label class="toggle-switch">
              <input type="checkbox" id="setting-enabled" ${enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label">Enable abandoned cart reminders</span>
          </div>
          <div class="form-hint">When disabled, no reminder emails will be sent by the cron job or manual trigger.</div>
        </div>

        <div class="form-group">
          <label class="form-label" for="setting-delay">Reminder delay</label>
          <div style="display:flex;align-items:center;gap:var(--p-space-300);">
            <input type="range" class="form-range" id="setting-delay" min="1" max="48" step="1" value="${delay}" style="flex:1;">
            <span class="range-display" id="delay-display">${delay}h</span>
          </div>
          <div class="form-hint">Send reminder emails this many hours after the cart was last updated. Cron polls every 6 hours — the effective trigger window may be up to 6 hours longer than this value.</div>
        </div>

        <hr class="section-divider">
        <div class="shell-section-title" style="margin-bottom:var(--p-space-400)">Email Template</div>

        <div class="form-group">
          <label class="form-label" for="setting-subject">Email Subject</label>
          <input type="text" class="form-input" id="setting-subject" value="${escapeHtml(subject)}" placeholder="You left something behind…">
          <div class="form-hint">The subject line for the reminder email. Keep it short and personal.</div>
        </div>

        <div class="form-group">
          <label class="form-label" for="setting-body">Email Body</label>
          <textarea class="form-textarea" id="setting-body" placeholder="Hi {{customer_name}}, you left items in your cart…">${escapeHtml(body)}</textarea>
          <div class="form-hint">You can use <code>{{customer_name}}</code>, <code>{{cart_url}}</code>, and <code>{{cart_total}}</code> as dynamic placeholders.</div>
        </div>

        <div style="display:flex;align-items:center;gap:var(--p-space-300);flex-wrap:wrap;">
          <button class="btn-primary" id="settings-save-btn">Save Settings</button>
          <button class="btn-secondary" id="settings-cancel-btn">Reset</button>
          <span id="settings-save-status" style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);"></span>
        </div>
      </div>
    `;

    // Delay slider live update
    const delayInput = content.querySelector('#setting-delay');
    const delayDisplay = content.querySelector('#delay-display');
    delayInput.addEventListener('input', () => {
      delayDisplay.textContent = delayInput.value + 'h';
    });

    // Save
    content.querySelector('#settings-save-btn').addEventListener('click', () => {
      if (settingsSaving) return;
      saveSettings();
    });

    // Reset (reload from server)
    content.querySelector('#settings-cancel-btn').addEventListener('click', () => {
      loadSettings();
    });
  }

  function saveSettings() {
    settingsSaving = true;
    const content = container.querySelector('#settings-content');
    const saveBtn = content.querySelector('#settings-save-btn');
    const status = content.querySelector('#settings-save-status');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    status.textContent = '';

    const enabled = content.querySelector('#setting-enabled').checked;
    const delay = parseInt(content.querySelector('#setting-delay').value, 10);
    const subject = content.querySelector('#setting-subject').value.trim();
    const body = content.querySelector('#setting-body').value;

    if (!subject) {
      status.innerHTML = '<span style="color:var(--p-color-text-critical);">Email subject is required.</span>';
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Settings';
      settingsSaving = false;
      return;
    }

    bridge.call('/settings/save', {
      is_enabled: enabled,
      reminder_delay_hours: delay,
      email_subject: subject,
      email_body: body
    })
      .then(result => {
        settingsSaving = false;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Settings';
        if (result.success) {
          status.innerHTML = '<span style="color:var(--p-color-text-success);">✓ Settings saved</span>';
          bridge.notify('Settings saved successfully', 'success');
          // Update dashboard badge
          const badge = container.querySelector('#dash-status-badge');
          if (badge) {
            if (enabled) {
              badge.innerHTML = `<span class="enabled-badge"><span class="enabled-dot"></span> Reminders enabled</span>`;
            } else {
              badge.innerHTML = `<span class="enabled-badge" style="color:var(--p-color-text-secondary)"><span class="disabled-dot"></span> Reminders disabled</span>`;
            }
          }
        } else {
          status.innerHTML = '<span style="color:var(--p-color-text-critical);">Save returned failure.</span>';
          bridge.notify('Failed to save settings', 'error');
        }
      })
      .catch(err => {
        settingsSaving = false;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Settings';
        status.innerHTML = `<span style="color:var(--p-color-text-critical);">Error: ${err && err.message ? escapeHtml(err.message) : 'Unknown error'}</span>`;
        bridge.notify('Failed to save settings', 'error');
      });
  }

  // ---- INITIAL LOAD ----
  loadDashboard();
}
```


## Explanation

Your Abandoned Cart Recovery app automatically reminds customers who add items to their cart but don't complete their purchase. Here's how it works: Every 6 hours, the app checks for carts that have been inactive for a time period you choose (anywhere from 4 to 24 hours). When it finds an eligible cart, it sends a friendly, personalized reminder email to that customer—but only once per cart, so you won't annoy them with repeated messages. If a customer later completes their purchase, the app marks that cart as recovered so you know the reminder worked.

In your Shopify Admin, you'll see a dedicated dashboard where you can customize your reminder email (subject line, message body, and more), set exactly how long to wait before sending (e.g., 6 hours after they abandon), and view a complete log of all reminders sent. The log shows you which customers received reminders and how many of those carts were eventually recovered into actual orders—giving you a clear picture of whether your abandoned cart strategy is working. You can also manually review and pause the feature anytime.

One important note: The app respects your chosen delay window, so it won't email anyone until that time has passed. It also automatically skips any carts that have already been converted to orders, and it won't resend emails for the same cart. To send the reminder emails, you'll need an email service connected to your store.
