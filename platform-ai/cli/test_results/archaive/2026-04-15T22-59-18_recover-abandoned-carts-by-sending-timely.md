# Chat Local — Full Pipeline

**Date:** 2026-04-15 22:59:18  
**Status:** ✅ SUCCESS  
**Total:** 277997ms  
**Tokens:** in=45703 out=34583 total=80286  
**Prompt:** Recover abandoned carts by sending timely, templated reminder emails to customers who leave without purchasing.

## Intent (Product Agent)

```json
{
  "triggerTypes": [
    "cron"
  ],
  "resources": [
    "Cart",
    "Customer",
    "Email"
  ],
  "desiredOutcome": "Recover abandoned carts by sending timely, templated reminder emails to customers who leave without purchasing.",
  "cronSchedule": "0 */6 * * *",
  "appCategory": "backend_admin",
  "qualityBrief": "A good version handles these details: (1) only email carts abandoned longer than the merchant's configured threshold; (2) don't re-email the same customer multiple times for the same cart; (3) exclude carts that were completed after abandonment; (4) include a clear, direct link back to the cart or checkout; (5) show the merchant an admin panel listing sent reminders, delivery status, and recovery rate so they can refine timing and messaging."
}
```

## Architect Plan

```json
{
  "shopifyPlan": {
    "webhookTopics": [],
    "cronSchedule": "0 */6 * * *"
  },
  "appContracts": {
    "feasibility": "feasible",
    "blockedReason": null,
    "complexity": "high",
    "edgeCases": [
      "A customer completes their checkout after the cron runs but before the reminder email is sent \u2014 verify cart is still open via Shopify Abandoned Checkouts API before sending",
      "The same customer abandons multiple carts in a short window \u2014 ensure deduplication is per-cart (checkout token), not just per-customer",
      "Shopify abandons_checkouts API returns the same checkout across multiple cron runs \u2014 idempotency key (checkout_token + reminder sequence) must prevent duplicate sends",
      "Customer has no email address on their abandoned checkout \u2014 skip silently and log a skipped_reason to avoid null-email send failures",
      "Merchant updates the abandonment threshold in settings between cron runs \u2014 apply the new threshold on the next run without retroactively re-emailing already-processed carts",
      "Cart total is zero or contains only free items \u2014 still process normally unless merchant explicitly excludes via settings; do not assume zero-value carts should be skipped"
    ],
    "uxExpectations": {
      "storefront": null,
      "admin": "Dashboard should lead with recovery rate (recovered revenue vs. total abandoned value) as the headline metric, followed by a paginated log of sent reminders showing cart value, customer email, sent timestamp, delivery status, and whether the cart was subsequently recovered. Merchant should be able to configure the abandonment threshold and email template from a dedicated settings panel, and trigger an immediate manual run to test the configuration."
    },
    "stateMachine": null,
    "platformGaps": [
      {
        "gap": "Shopify does not provide a native delivery receipt or open/click webhook for transactional emails sent via the platform email capability",
        "mitigation": "Track delivery status as an enum column (pending, sent, failed) updated synchronously at send time; mark a cart as recovered by checking on each cron run whether the checkout has transitioned to completed status via Shopify Abandoned Checkouts API"
      },
      {
        "gap": "No batch write API for marking checkouts as emailed \u2014 each reminder record requires an individual DB insert",
        "mitigation": "Pre-fetch all abandoned checkouts in bulk before the loop; per-item DB inserts and email sends inside the loop are unavoidable for this resource type"
      }
    ],
    "cronBatching": {
      "required": true,
      "description": "Before the loop begins, bulk-fetch all abandoned checkouts from Shopify that were updated beyond the merchant-configured threshold ago (using the Shopify Admin REST /admin/api/2024-01/checkouts.json?status=open endpoint with updated_at_max filter). Also bulk-fetch all checkout tokens that have already received a reminder this cycle from the DB to enable deduplication without per-item queries."
    },
    "dbContracts": [
      {
        "table": "abandonment_settings",
        "columns": [
          {
            "name": "id",
            "type": "UUID",
            "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()"
          },
          {
            "name": "tenant_id",
            "type": "UUID",
            "constraints": "NOT NULL UNIQUE"
          },
          {
            "name": "abandonment_threshold_minutes",
            "type": "INTEGER",
            "constraints": "NOT NULL DEFAULT 60"
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
        "table": "cart_reminders",
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
            "name": "cart_value",
            "type": "NUMERIC(12,2)",
            "constraints": "NOT NULL"
          },
          {
            "name": "currency",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'USD'"
          },
          {
            "name": "checkout_url",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "delivery_status",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'pending'"
          },
          {
            "name": "skipped_reason",
            "type": "TEXT",
            "constraints": "NULL"
          },
          {
            "name": "recovered",
            "type": "BOOLEAN",
            "constraints": "NOT NULL DEFAULT FALSE"
          },
          {
            "name": "recovered_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NULL"
          },
          {
            "name": "sent_at",
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
          "customer_id"
        ],
        "rls": true
      }
    ],
    "webhookContract": null,
    "cronContract": {
      "handlerMustProduce": "Before iterating, bulk-fetch from Shopify all open abandoned checkouts updated before (now minus abandonment_threshold_minutes) using the Admin REST Abandoned Checkouts endpoint. Also load from the DB the full set of checkout_tokens already present in cart_reminders for this tenant to deduplicate. Also load the tenant's abandonment_settings row to get threshold, email subject, and body template. For each candidate checkout: confirm it has a non-null email; confirm no existing cart_reminders row exists for that checkout_token+tenant_id; render the email body by substituting checkout_url, cart_value, and customer first name into the template; send the email; insert a cart_reminders row with delivery_status='sent' on success or 'failed' on error. In a second pass, for any existing cart_reminders rows with recovered=false, query Shopify to check whether the corresponding checkout is now completed and if so set recovered=true and recovered_at=now()."
    },
    "widgetTargetTemplates": null,
    "widgetApiCatalog": null,
    "adminApiCatalog": [
      {
        "path": "/settings/get",
        "method": "GET",
        "requestShape": {},
        "responseShape": {
          "abandonment_threshold_minutes": "number",
          "email_subject": "string",
          "email_body_template": "string"
        }
      },
      {
        "path": "/settings/save",
        "method": "POST",
        "requestShape": {
          "abandonment_threshold_minutes": "number",
          "email_subject": "string",
          "email_body_template": "string"
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
          "delivery_status": "string | null",
          "recovered": "boolean | null"
        },
        "responseShape": {
          "items": [
            {
              "id": "string",
              "checkout_token": "string",
              "customer_email": "string",
              "cart_value": "number",
              "currency": "string",
              "checkout_url": "string",
              "delivery_status": "string",
              "recovered": "boolean",
              "recovered_at": "string | null",
              "sent_at": "string"
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
          "total_reminders_sent": "number",
          "total_recovered": "number",
          "total_abandoned_value": "number",
          "total_recovered_value": "number",
          "recovery_rate_percent": "number",
          "currency": "string"
        }
      },
      {
        "path": "/run",
        "method": "POST",
        "requestShape": {},
        "responseShape": {
          "triggered": "boolean",
          "message": "string"
        }
      }
    ]
  }
}
```

## Validation Retries (resolved)

### Attempt 1
- **admin_ui**: setTimeout delay 1200ms exceeds 500ms — use event-driven patterns, not timers

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: [],
  cronSchedule: '0 */6 * * *',
  npmPackages: [],

  handler: async function (ctx) {
    // ── Admin routes ──────────────────────────────────────────────────────────
    if (ctx.trigger === 'admin') {
      const path = ctx.adminPath;
      const body = ctx.adminBody || {};

      // GET /settings/get
      if (path === '/settings/get') {
        const rows = await ctx.db`
          SELECT abandonment_threshold_minutes, email_subject, email_body_template
          FROM abandonment_settings
          WHERE tenant_id = ${ctx.tenantId}
          LIMIT 1
        `;
        if (rows.length === 0) {
          return {
            abandonment_threshold_minutes: 60,
            email_subject: 'You left something behind!',
            email_body_template: ''
          };
        }
        return {
          abandonment_threshold_minutes: rows[0].abandonment_threshold_minutes,
          email_subject: rows[0].email_subject,
          email_body_template: rows[0].email_body_template
        };
      }

      // POST /settings/save
      if (path === '/settings/save') {
        const { abandonment_threshold_minutes, email_subject, email_body_template } = body;
        await ctx.db`
          INSERT INTO abandonment_settings (tenant_id, abandonment_threshold_minutes, email_subject, email_body_template, updated_at)
          VALUES (${ctx.tenantId}, ${abandonment_threshold_minutes}, ${email_subject}, ${email_body_template}, now())
          ON CONFLICT (tenant_id) DO UPDATE SET
            abandonment_threshold_minutes = EXCLUDED.abandonment_threshold_minutes,
            email_subject = EXCLUDED.email_subject,
            email_body_template = EXCLUDED.email_body_template,
            updated_at = now()
        `;
        return { success: true };
      }

      // GET /reminders/list
      if (path === '/reminders/list') {
        const page = parseInt(body.page) || 1;
        const page_size = parseInt(body.page_size) || 20;
        const offset = (page - 1) * page_size;
        const delivery_status = body.delivery_status || null;
        const recovered = body.recovered !== undefined && body.recovered !== null ? body.recovered : null;

        let filters = ctx.db`WHERE tenant_id = ${ctx.tenantId} AND skipped_reason IS NULL`;

        // Build dynamic query
        let countQuery, itemsQuery;
        if (delivery_status !== null && recovered !== null) {
          countQuery = await ctx.db`
            SELECT COUNT(*) as total FROM cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
              AND skipped_reason IS NULL
              AND delivery_status = ${delivery_status}
              AND recovered = ${recovered}
          `;
          itemsQuery = await ctx.db`
            SELECT id, checkout_token, customer_email, cart_value, currency, checkout_url,
                   delivery_status, recovered, recovered_at, sent_at
            FROM cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
              AND skipped_reason IS NULL
              AND delivery_status = ${delivery_status}
              AND recovered = ${recovered}
            ORDER BY sent_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;
        } else if (delivery_status !== null) {
          countQuery = await ctx.db`
            SELECT COUNT(*) as total FROM cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
              AND skipped_reason IS NULL
              AND delivery_status = ${delivery_status}
          `;
          itemsQuery = await ctx.db`
            SELECT id, checkout_token, customer_email, cart_value, currency, checkout_url,
                   delivery_status, recovered, recovered_at, sent_at
            FROM cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
              AND skipped_reason IS NULL
              AND delivery_status = ${delivery_status}
            ORDER BY sent_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;
        } else if (recovered !== null) {
          countQuery = await ctx.db`
            SELECT COUNT(*) as total FROM cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
              AND skipped_reason IS NULL
              AND recovered = ${recovered}
          `;
          itemsQuery = await ctx.db`
            SELECT id, checkout_token, customer_email, cart_value, currency, checkout_url,
                   delivery_status, recovered, recovered_at, sent_at
            FROM cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
              AND skipped_reason IS NULL
              AND recovered = ${recovered}
            ORDER BY sent_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;
        } else {
          countQuery = await ctx.db`
            SELECT COUNT(*) as total FROM cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
              AND skipped_reason IS NULL
          `;
          itemsQuery = await ctx.db`
            SELECT id, checkout_token, customer_email, cart_value, currency, checkout_url,
                   delivery_status, recovered, recovered_at, sent_at
            FROM cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
              AND skipped_reason IS NULL
            ORDER BY sent_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;
        }

        const total = parseInt(countQuery[0].total);
        return {
          items: itemsQuery.map(r => ({
            id: r.id,
            checkout_token: r.checkout_token,
            customer_email: r.customer_email,
            cart_value: parseFloat(r.cart_value),
            currency: r.currency,
            checkout_url: r.checkout_url,
            delivery_status: r.delivery_status,
            recovered: r.recovered,
            recovered_at: r.recovered_at ? r.recovered_at.toISOString() : null,
            sent_at: r.sent_at ? r.sent_at.toISOString() : ''
          })),
          total,
          page,
          page_size
        };
      }

      // GET /reminders/stats
      if (path === '/reminders/stats') {
        const stats = await ctx.db`
          SELECT
            COUNT(*) FILTER (WHERE delivery_status = 'sent' AND skipped_reason IS NULL) AS total_reminders_sent,
            COUNT(*) FILTER (WHERE recovered = TRUE AND skipped_reason IS NULL) AS total_recovered,
            COALESCE(SUM(cart_value) FILTER (WHERE skipped_reason IS NULL), 0) AS total_abandoned_value,
            COALESCE(SUM(cart_value) FILTER (WHERE recovered = TRUE AND skipped_reason IS NULL), 0) AS total_recovered_value,
            MAX(currency) AS currency
          FROM cart_reminders
          WHERE tenant_id = ${ctx.tenantId}
        `;
        const row = stats[0];
        const total_reminders_sent = parseInt(row.total_reminders_sent) || 0;
        const total_recovered = parseInt(row.total_recovered) || 0;
        const total_abandoned_value = parseFloat(row.total_abandoned_value) || 0;
        const total_recovered_value = parseFloat(row.total_recovered_value) || 0;
        const recovery_rate_percent = total_reminders_sent > 0
          ? parseFloat(((total_recovered / total_reminders_sent) * 100).toFixed(2))
          : 0;
        return {
          total_reminders_sent,
          total_recovered,
          total_abandoned_value,
          total_recovered_value,
          recovery_rate_percent,
          currency: row.currency || 'USD'
        };
      }

      // POST /run — manual trigger
      if (path === '/run') {
        try {
          await runCronLogic(ctx);
          return { triggered: true, message: 'Abandoned cart recovery run completed successfully.' };
        } catch (err) {
          ctx.logger.error('Manual run failed: ' + err.message);
          return { triggered: false, message: 'Run failed: ' + err.message };
        }
      }

      return { error: 'Unknown admin path' };
    }

    // ── Cron trigger ─────────────────────────────────────────────────────────
    if (ctx.trigger === 'cron') {
      await runCronLogic(ctx);
    }
  }
};

// ── Shared cron logic ─────────────────────────────────────────────────────────
async function runCronLogic(ctx) {
  // 1. Load settings
  const settingsRows = await ctx.db`
    SELECT abandonment_threshold_minutes, email_subject, email_body_template
    FROM abandonment_settings
    WHERE tenant_id = ${ctx.tenantId}
    LIMIT 1
  `;
  const settings = settingsRows.length > 0 ? settingsRows[0] : {
    abandonment_threshold_minutes: 60,
    email_subject: 'You left something behind!',
    email_body_template: ''
  };
  const thresholdMinutes = settings.abandonment_threshold_minutes;

  // 2. Calculate time window — only fetch checkouts updated before the threshold
  const now = new Date();
  const updatedAtMax = new Date(now.getTime() - thresholdMinutes * 60 * 1000).toISOString();

  // 3. Bulk-fetch ALL open abandoned checkouts from Shopify (paginate to get all)
  let allAbandonedCheckouts = [];
  let sinceId = null;
  const limit = 250;
  while (true) {
    let endpoint = `/checkouts.json?status=open&updated_at_max=${encodeURIComponent(updatedAtMax)}&limit=${limit}`;
    if (sinceId) endpoint += `&since_id=${sinceId}`;
    const response = await ctx.shopify.get(endpoint);
    const checkouts = (response && response.checkouts) ? response.checkouts : [];
    if (checkouts.length === 0) break;
    allAbandonedCheckouts = allAbandonedCheckouts.concat(checkouts);
    if (checkouts.length < limit) break;
    sinceId = checkouts[checkouts.length - 1].id;
  }

  ctx.logger.info(`Fetched ${allAbandonedCheckouts.length} abandoned checkouts from Shopify.`);

  // 4. Build a map of checkouts by token for quick lookup
  const checkoutByToken = {};
  for (const co of allAbandonedCheckouts) {
    if (co.token) checkoutByToken[co.token] = co;
  }

  // 5. Bulk-fetch all checkout tokens already processed for this tenant
  const existingRows = await ctx.db`
    SELECT checkout_token FROM cart_reminders
    WHERE tenant_id = ${ctx.tenantId}
  `;
  const processedTokens = new Set(existingRows.map(r => r.checkout_token));

  // 6. First pass — send reminders to new abandoned checkouts
  for (const checkout of allAbandonedCheckouts) {
    const token = checkout.token;
    if (!token) continue;

    // Skip if already processed
    if (processedTokens.has(token)) continue;

    const customerEmail = checkout.email;
    const checkoutUrl = checkout.abandoned_checkout_url || '';
    const cartValue = parseFloat(checkout.total_price || '0');
    const currency = checkout.currency || 'USD';
    const customerId = checkout.customer && checkout.customer.id ? checkout.customer.id : null;
    const customerFirstName = (checkout.customer && checkout.customer.first_name) ? checkout.customer.first_name : 'there';

    // Skip if no email
    if (!customerEmail) {
      ctx.logger.info(`Skipping checkout ${token}: no customer email.`);
      // Record skipped — use placeholder email to satisfy NOT NULL, mark reason
      await ctx.db`
        INSERT INTO cart_reminders (
          tenant_id, checkout_token, customer_id, customer_email,
          cart_value, currency, checkout_url, delivery_status, skipped_reason, recovered, sent_at
        ) VALUES (
          ${ctx.tenantId}, ${token}, ${customerId}, ${'no-email@skipped'},
          ${cartValue}, ${currency}, ${checkoutUrl}, ${'skipped'}, ${'no_customer_email'}, ${false}, now()
        )
        ON CONFLICT (tenant_id, checkout_token) DO NOTHING
      `;
      processedTokens.add(token);
      continue;
    }

    // Verify checkout is still open using already-fetched data
    // (checkout came from status=open query, so it is open; this is our freshness check)
    // If the checkout has a completed_at it was already converted
    if (checkout.completed_at) {
      ctx.logger.info(`Skipping checkout ${token}: already completed.`);
      processedTokens.add(token);
      continue;
    }

    // Render email body
    const emailBody = (settings.email_body_template || '')
      .replace(/\{\{first_name\}\}/g, customerFirstName)
      .replace(/\{\{checkout_url\}\}/g, checkoutUrl)
      .replace(/\{\{cart_value\}\}/g, cartValue.toFixed(2))
      .replace(/\{\{currency\}\}/g, currency);

    // Send email
    let deliveryStatus = 'pending';
    try {
      await ctx.services.email.send({
        to: customerEmail,
        data: {
          subject: settings.email_subject,
          body: emailBody,
          checkout_url: checkoutUrl,
          cart_value: cartValue,
          currency,
          first_name: customerFirstName
        }
      });
      deliveryStatus = 'sent';
      ctx.logger.info(`Reminder sent to ${customerEmail} for checkout ${token}.`);
    } catch (err) {
      deliveryStatus = 'failed';
      ctx.logger.error(`Failed to send reminder to ${customerEmail} for checkout ${token}: ${err.message}`);
    }

    // Insert reminder record
    await ctx.db`
      INSERT INTO cart_reminders (
        tenant_id, checkout_token, customer_id, customer_email,
        cart_value, currency, checkout_url, delivery_status, skipped_reason, recovered, sent_at
      ) VALUES (
        ${ctx.tenantId}, ${token}, ${customerId}, ${customerEmail},
        ${cartValue}, ${currency}, ${checkoutUrl}, ${deliveryStatus}, ${null}, ${false}, now()
      )
      ON CONFLICT (tenant_id, checkout_token) DO NOTHING
    `;
    processedTokens.add(token);
  }

  // 7. Second pass — check recovery status for unrecovered sent reminders
  // Bulk-fetch all unrecovered reminder tokens for this tenant
  const unrecoveredRows = await ctx.db`
    SELECT id, checkout_token FROM cart_reminders
    WHERE tenant_id = ${ctx.tenantId}
      AND recovered = FALSE
      AND delivery_status = 'sent'
  `;

  if (unrecoveredRows.length === 0) {
    ctx.logger.info('No unrecovered reminders to check.');
    return;
  }

  // Build set of tokens to check recovery for
  // We bulk-fetch completed checkouts from Shopify to avoid per-item calls
  // Shopify doesn't support batch lookup by token, but we can fetch recently completed checkouts
  // Strategy: fetch all checkouts with status != open (completed) updated in the past 30 days
  // and cross-reference with our unrecovered tokens
  const unrecoveredTokenSet = new Set(unrecoveredRows.map(r => r.checkout_token));
  const unrecoveredById = {};
  for (const r of unrecoveredRows) unrecoveredById[r.checkout_token] = r.id;

  // Bulk-fetch completed checkouts (no status filter = all, but we look for completed_at IS NOT NULL)
  // We fetch from Shopify using status parameter - 'closed' covers completed orders
  let completedCheckouts = [];
  let completedSinceId = null;
  while (true) {
    let endpoint = `/checkouts.json?limit=${limit}`;
    if (completedSinceId) endpoint += `&since_id=${completedSinceId}`;
    const response = await ctx.shopify.get(endpoint);
    const checkouts = (response && response.checkouts) ? response.checkouts : [];
    if (checkouts.length === 0) break;
    completedCheckouts = completedCheckouts.concat(checkouts);
    if (checkouts.length < limit) break;
    completedSinceId = checkouts[checkouts.length - 1].id;
  }

  // Build a map of completed checkouts by token
  const completedByToken = {};
  for (const co of completedCheckouts) {
    if (co.token && co.completed_at) {
      completedByToken[co.token] = co;
    }
  }

  // Update recovery status for matching tokens
  for (const row of unrecoveredRows) {
    const token = row.checkout_token;
    if (completedByToken[token]) {
      await ctx.db`
        UPDATE cart_reminders
        SET recovered = TRUE, recovered_at = now()
        WHERE tenant_id = ${ctx.tenantId}
          AND checkout_token = ${token}
          AND recovered = FALSE
      `;
      ctx.logger.info(`Checkout ${token} marked as recovered.`);
    }
  }

  ctx.logger.info('Abandoned cart recovery cron run complete.');
}
```

### migration.sql

```sql
CREATE TABLE IF NOT EXISTS abandonment_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE,
  abandonment_threshold_minutes INTEGER NOT NULL DEFAULT 60,
  email_subject TEXT NOT NULL DEFAULT 'You left something behind!',
  email_body_template TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_abandonment_settings_tenant_id ON abandonment_settings(tenant_id);

CREATE TABLE IF NOT EXISTS cart_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  checkout_token TEXT NOT NULL,
  customer_id BIGINT NULL,
  customer_email TEXT NOT NULL,
  cart_value NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  checkout_url TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  skipped_reason TEXT NULL,
  recovered BOOLEAN NOT NULL DEFAULT FALSE,
  recovered_at TIMESTAMPTZ NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, checkout_token)
);

CREATE INDEX IF NOT EXISTS idx_cart_reminders_tenant_id ON cart_reminders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cart_reminders_checkout_token ON cart_reminders(checkout_token);
CREATE INDEX IF NOT EXISTS idx_cart_reminders_customer_id ON cart_reminders(customer_id);
```

### admin_ui.js

```javascript
import { useState, useEffect, useCallback } from 'react';

const DEFAULT_SETTINGS = {
  abandonment_threshold_minutes: 60,
  email_subject: 'You left something behind!',
  email_body_template: 'Hi {{first_name}},\n\nYou left items in your cart! Complete your purchase here:\n\n{{checkout_url}}\n\nCart Total: {{currency}} {{cart_value}}\n\nDon\'t miss out!'
};

export default function App({ bridge }) {
  const [view, setView] = useState('dashboard');
  const [stats, setStats] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [remindersTotal, setRemindersTotal] = useState(0);
  const [remindersPage, setRemindersPage] = useState(1);
  const [pageSize] = useState(20);
  const [filterStatus, setFilterStatus] = useState(null);
  const [filterRecovered, setFilterRecovered] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchStats = useCallback(async () => {
    try {
      const res = await bridge.call('/reminders/stats', {});
      setStats(res);
    } catch (e) {
      setError('Failed to load stats.');
    }
  }, [bridge]);

  const fetchReminders = useCallback(async (page, status, recovered) => {
    setLoading(true);
    try {
      const body = { page, page_size: pageSize };
      if (status !== null) body.delivery_status = status;
      if (recovered !== null) body.recovered = recovered;
      const res = await bridge.call('/reminders/list', body);
      setReminders(res.items || []);
      setRemindersTotal(res.total || 0);
    } catch (e) {
      setError('Failed to load reminders.');
    } finally {
      setLoading(false);
    }
  }, [bridge, pageSize]);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await bridge.call('/settings/get', {});
      setSettings(res);
      setSettingsDraft(res);
    } catch (e) {
      setError('Failed to load settings.');
    }
  }, [bridge]);

  useEffect(() => {
    fetchStats();
    fetchSettings();
  }, [fetchStats, fetchSettings]);

  useEffect(() => {
    if (view === 'reminders') {
      fetchReminders(remindersPage, filterStatus, filterRecovered);
    }
  }, [view, remindersPage, filterStatus, filterRecovered, fetchReminders]);

  const handleSaveSettings = async () => {
    setSaving(true);
    setError('');
    try {
      await bridge.call('/settings/save', {
        abandonment_threshold_minutes: parseInt(settingsDraft.abandonment_threshold_minutes) || 60,
        email_subject: settingsDraft.email_subject,
        email_body_template: settingsDraft.email_body_template
      });
      setSettings(settingsDraft);
      setError('');
    } catch (e) {
      setError('Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleManualRun = async () => {
    setRunLoading(true);
    setRunMsg('');
    try {
      const res = await bridge.call('/run', {});
      setRunMsg(res.message || (res.triggered ? 'Run complete.' : 'Run failed.'));
      await fetchStats();
    } catch (e) {
      setRunMsg('Manual run failed.');
    } finally {
      setRunLoading(false);
    }
  };

  const styles = {
    container: { fontFamily: 'Inter, sans-serif', maxWidth: 1100, margin: '0 auto', padding: '24px 16px', color: '#1a1a1a' },
    nav: { display: 'flex', gap: 8, marginBottom: 28, borderBottom: '2px solid #e5e7eb', paddingBottom: 0 },
    navBtn: (active) => ({
      padding: '10px 20px', border: 'none', background: 'none', cursor: 'pointer',
      fontWeight: active ? 700 : 400, color: active ? '#4f46e5' : '#6b7280',
      borderBottom: active ? '2px solid #4f46e5' : '2px solid transparent',
      marginBottom: -2, fontSize: 15
    }),
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' },
    statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 24 },
    statCard: { background: '#f8f7ff', border: '1px solid #e0e0f0', borderRadius: 10, padding: '18px 22px', textAlign: 'center' },
    statLabel: { color: '#6b7280', fontSize: 13, marginBottom: 6 },
    statValue: { fontSize: 28, fontWeight: 700, color: '#4f46e5' },
    statSub: { fontSize: 12, color: '#9ca3af', marginTop: 2 },
    heading: { fontSize: 22, fontWeight: 700, marginBottom: 16 },
    subheading: { fontSize: 16, fontWeight: 600, marginBottom: 12 },
    btn: (variant) => ({
      padding: '9px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14,
      background: variant === 'primary' ? '#4f46e5' : variant === 'danger' ? '#ef4444' : '#f3f4f6',
      color: variant === 'primary' || variant === 'danger' ? '#fff' : '#374151'
    }),
    input: { width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', marginBottom: 14 },
    textarea: { width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', marginBottom: 14, minHeight: 140, fontFamily: 'monospace' },
    label: { display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 5, color: '#374151' },
    table: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '10px 12px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', fontSize: 13, fontWeight: 600, color: '#6b7280' },
    td: { padding: '10px 12px', borderBottom: '1px solid #f3f4f6', fontSize: 13, color: '#374151', verticalAlign: 'middle' },
    badge: (type) => ({
      display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: type === 'sent' ? '#d1fae5' : type === 'failed' ? '#fee2e2' : type === 'skipped' ? '#f3f4f6' : '#e0e7ff',
      color: type === 'sent' ? '#065f46' : type === 'failed' ? '#991b1b' : type === 'skipped' ? '#6b7280' : '#3730a3'
    }),
    recoveredBadge: (r) => ({
      display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: r ? '#d1fae5' : '#f3f4f6',
      color: r ? '#065f46' : '#6b7280'
    }),
    filterBar: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
    select: { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, cursor: 'pointer' },
    pager: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, alignItems: 'center' },
    hint: { fontSize: 12, color: '#9ca3af', marginBottom: 10 },
    errorBox: { background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 14 },
    successBox: { background: '#d1fae5', color: '#065f46', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 14 }
  };

  const totalPages = Math.max(1, Math.ceil(remindersTotal / pageSize));

  return (
    <div style={styles.container}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>Abandoned Cart Recovery</h1>
        <p style={{ color: '#6b7280', fontSize: 14 }}>Recover lost revenue by sending timely reminder emails to customers who abandon their carts.</p>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.nav}>
        {['dashboard', 'reminders', 'settings'].map(v => (
          <button key={v} style={styles.navBtn(view === v)} onClick={() => { setView(v); setError(''); }}>
            {v.charAt(0).toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>

      {/* Dashboard */}
      {view === 'dashboard' && (
        <div>
          <div style={styles.statsGrid}>
            <div style={styles.statCard}>
              <div style={styles.statLabel}>Recovery Rate</div>
              <div style={styles.statValue}>{stats ? stats.recovery_rate_percent.toFixed(1) + '%' : '—'}</div>
              <div style={styles.statSub}>Recovered / Sent</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statLabel}>Reminders Sent</div>
              <div style={styles.statValue}>{stats ? stats.total_reminders_sent : '—'}</div>
              <div style={styles.statSub}>Total emails dispatched</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statLabel}>Carts Recovered</div>
              <div style={styles.statValue}>{stats ? stats.total_recovered : '—'}</div>
              <div style={styles.statSub}>Completed after reminder</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statLabel}>Abandoned Value</div>
              <div style={styles.statValue}>{stats ? (stats.currency + ' ' + Number(stats.total_abandoned_value).toFixed(2)) : '—'}</div>
              <div style={styles.statSub}>Total cart value tracked</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statLabel}>Recovered Value</div>
              <div style={styles.statValue}>{stats ? (stats.currency + ' ' + Number(stats.total_recovered_value).toFixed(2)) : '—'}</div>
              <div style={styles.statSub}>Revenue recovered</div>
            </div>
          </div>

          <div style={styles.card}>
            <div style={styles.subheading}>Manual Run</div>
            <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 14 }}>Trigger the abandoned cart check immediately to test your configuration.</p>
            {runMsg && <div style={runMsg.toLowerCase().includes('fail') ? styles.errorBox : styles.successBox}>{runMsg}</div>}
            <button style={styles.btn('primary')} onClick={handleManualRun} disabled={runLoading}>
              {runLoading ? 'Running...' : 'Run Now'}
            </button>
          </div>

          <div style={styles.card}>
            <div style={styles.subheading}>Current Settings</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              <div><strong>Abandonment Threshold:</strong> {settings.abandonment_threshold_minutes} minutes</div>
              <div style={{ marginTop: 6 }}><strong>Email Subject:</strong> {settings.email_subject}</div>
            </div>
            <button style={{ ...styles.btn('secondary'), marginTop: 12 }} onClick={() => setView('settings')}>Edit Settings</button>
          </div>
        </div>
      )}

      {/* Reminders Log */}
      {view === 'reminders' && (
        <div>
          <h2 style={styles.heading}>Sent Reminders</h2>
          <div style={styles.filterBar}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Status:</label>
            <select style={styles.select} value={filterStatus || ''} onChange={e => { setFilterStatus(e.target.value || null); setRemindersPage(1); }}>
              <option value=''>All</option>
              <option value='sent'>Sent</option>
              <option value='failed'>Failed</option>
              <option value='skipped'>Skipped</option>
            </select>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Recovered:</label>
            <select style={styles.select} value={filterRecovered === null ? '' : String(filterRecovered)} onChange={e => {
              const v = e.target.value;
              setFilterRecovered(v === '' ? null : v === 'true');
              setRemindersPage(1);
            }}>
              <option value=''>All</option>
              <option value='true'>Yes</option>
              <option value='false'>No</option>
            </select>
            <button style={styles.btn('secondary')} onClick={() => fetchReminders(remindersPage, filterStatus, filterRecovered)}>Refresh</button>
          </div>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
          ) : (
            <div style={styles.card}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Customer Email</th>
                    <th style={styles.th}>Cart Value</th>
                    <th style={styles.th}>Status</th>
                    <th style={styles.th}>Recovered</th>
                    <th style={styles.th}>Sent At</th>
                    <th style={styles.th}>Checkout</th>
                  </tr>
                </thead>
                <tbody>
                  {reminders.length === 0 ? (
                    <tr><td colSpan={6} style={{ ...styles.td, textAlign: 'center', color: '#9ca3af', padding: 32 }}>No reminders found.</td></tr>
                  ) : reminders.map(r => (
                    <tr key={r.id}>
                      <td style={styles.td}>{r.customer_email}</td>
                      <td style={styles.td}>{r.currency} {Number(r.cart_value).toFixed(2)}</td>
                      <td style={styles.td}><span style={styles.badge(r.delivery_status)}>{r.delivery_status}</span></td>
                      <td style={styles.td}><span style={styles.recoveredBadge(r.recovered)}>{r.recovered ? 'Yes' : 'No'}</span></td>
                      <td style={styles.td}>{r.sent_at ? new Date(r.sent_at).toLocaleString() : '—'}</td>
                      <td style={styles.td}>
                        {r.checkout_url ? <a href={r.checkout_url} target='_blank' rel='noopener noreferrer' style={{ color: '#4f46e5' }}>Link</a> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={styles.pager}>
                <span style={{ fontSize: 13, color: '#6b7280' }}>{remindersTotal} total</span>
                <button style={styles.btn('secondary')} onClick={() => setRemindersPage(p => Math.max(1, p - 1))} disabled={remindersPage <= 1}>← Prev</button>
                <span style={{ fontSize: 13 }}>Page {remindersPage} / {totalPages}</span>
                <button style={styles.btn('secondary')} onClick={() => setRemindersPage(p => Math.min(totalPages, p + 1))} disabled={remindersPage >= totalPages}>Next →</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Settings */}
      {view === 'settings' && (
        <div>
          <h2 style={styles.heading}>Settings</h2>
          <div style={styles.card}>
            <div style={styles.subheading}>Abandonment Configuration</div>
            <label style={styles.label}>Abandonment Threshold (minutes)</label>
            <p style={styles.hint}>Only email carts that have been abandoned for at least this many minutes.</p>
            <input
              type='number' min={1} style={styles.input}
              value={settingsDraft.abandonment_threshold_minutes}
              onChange={e => setSettingsDraft(s => ({ ...s, abandonment_threshold_minutes: e.target.value }))}
            />

            <label style={styles.label}>Email Subject</label>
            <input
              type='text' style={styles.input}
              value={settingsDraft.email_subject}
              onChange={e => setSettingsDraft(s => ({ ...s, email_subject: e.target.value }))}
            />

            <label style={styles.label}>Email Body Template</label>
            <p style={styles.hint}>Available variables: {'{{first_name}}'}, {'{{checkout_url}}'}, {'{{cart_value}}'}, {'{{currency}}'}</p>
            <textarea
              style={styles.textarea}
              value={settingsDraft.email_body_template}
              onChange={e => setSettingsDraft(s => ({ ...s, email_body_template: e.target.value }))}
            />

            {saving && <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>Saving...</div>}
            <button style={styles.btn('primary')} onClick={handleSaveSettings} disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```


## Explanation

Your store now automatically finds customers who added items to their cart but didn't complete their purchase, and sends them a friendly reminder email to come back and finish checkout. Every 6 hours, the app checks your store for abandoned carts that have been sitting for longer than your chosen time period (you set this threshold in the app settings). For each eligible cart, a reminder email is sent once—we keep track to make sure the same customer doesn't get multiple reminders for the same cart. If a customer completes their purchase after receiving a reminder, we recognize that and stop sending them more emails for that cart.

In your Shopify Admin, you'll find a dashboard showing all the reminders we've sent, whether each email went through successfully, and how many abandoned carts were recovered (converted to completed orders) after receiving a reminder. This gives you insight into how well your recovery strategy is working. You can adjust your settings anytime—like changing how long a cart must sit before we send a reminder, or updating the email message itself—and those changes take effect immediately on the next automatic check. The app also includes a "Send now" option if you want to manually trigger a reminder run outside the regular 6-hour schedule.
