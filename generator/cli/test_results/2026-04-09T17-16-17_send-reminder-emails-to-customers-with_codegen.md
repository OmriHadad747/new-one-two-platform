# Chat Local — Codegen Output

**Date:** 2026-04-09 17:16:17  
**Prompt:** Send reminder emails to customers with abandoned carts after a configurable delay, with admin visibility into sends and performance.

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: [],
  cronSchedule: '0 */6 * * *',
  npmPackages: ['dayjs@1.11.13', 'handlebars@4.7.8'],
  handler: async function(ctx) {
    const dayjs = require('dayjs');
    const Handlebars = require('handlebars');

    // ─── ADMIN TRIGGER ────────────────────────────────────────────────────────
    if (ctx.trigger === 'admin') {
      ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

      // GET /settings/get
      if (ctx.adminPath === '/settings/get') {
        try {
          const rows = await ctx.db`
            SELECT delay_hours, email_subject, email_body_html, is_enabled
            FROM abandoned_cart_settings
            WHERE tenant_id = ${ctx.tenantId}
            LIMIT 1
          `;
          if (rows.length === 0) {
            return {
              delay_hours: 1,
              email_subject: 'You left something behind!',
              email_body_html: '<p>Hi {{customer_name}}, your cart total is {{cart_total}} {{currency}}. <a href="{{recovery_url}}">Complete your purchase</a>.</p>',
              is_enabled: false
            };
          }
          const s = rows[0];
          return {
            delay_hours: Number(s.delay_hours),
            email_subject: s.email_subject,
            email_body_html: s.email_body_html,
            is_enabled: s.is_enabled
          };
        } catch (err) {
          ctx.logger.error({ err }, 'settings/get error');
          return { error: 'Failed to load settings' };
        }
      }

      // POST /settings/save
      if (ctx.adminPath === '/settings/save') {
        try {
          const { delay_hours, email_subject, email_body_html, is_enabled } = ctx.adminBody;
          const existing = await ctx.db`
            SELECT id FROM abandoned_cart_settings WHERE tenant_id = ${ctx.tenantId} LIMIT 1
          `;
          if (existing.length === 0) {
            await ctx.db`
              INSERT INTO abandoned_cart_settings (tenant_id, delay_hours, email_subject, email_body_html, is_enabled, created_at, updated_at)
              VALUES (${ctx.tenantId}, ${delay_hours}, ${email_subject}, ${email_body_html}, ${is_enabled}, NOW(), NOW())
            `;
          } else {
            await ctx.db`
              UPDATE abandoned_cart_settings
              SET delay_hours = ${delay_hours},
                  email_subject = ${email_subject},
                  email_body_html = ${email_body_html},
                  is_enabled = ${is_enabled},
                  updated_at = NOW()
              WHERE tenant_id = ${ctx.tenantId}
            `;
          }
          ctx.logger.info({ delay_hours, is_enabled }, 'settings saved');
          return { success: true };
        } catch (err) {
          ctx.logger.error({ err }, 'settings/save error');
          return { success: false };
        }
      }

      // GET /sends/list
      if (ctx.adminPath === '/sends/list') {
        try {
          const { page = 1, page_size = 20, customer_email = null, date_from = null, date_to = null } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          let countResult, rows;
          if (customer_email && date_from && date_to) {
            countResult = await ctx.db`
              SELECT COUNT(*)::int as total FROM abandoned_cart_sends
              WHERE tenant_id = ${ctx.tenantId}
                AND customer_email ILIKE ${'%' + customer_email + '%'}
                AND sent_at >= ${date_from}::timestamptz
                AND sent_at <= ${date_to}::timestamptz
            `;
            rows = await ctx.db`
              SELECT * FROM abandoned_cart_sends
              WHERE tenant_id = ${ctx.tenantId}
                AND customer_email ILIKE ${'%' + customer_email + '%'}
                AND sent_at >= ${date_from}::timestamptz
                AND sent_at <= ${date_to}::timestamptz
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          } else if (customer_email) {
            countResult = await ctx.db`
              SELECT COUNT(*)::int as total FROM abandoned_cart_sends
              WHERE tenant_id = ${ctx.tenantId}
                AND customer_email ILIKE ${'%' + customer_email + '%'}
            `;
            rows = await ctx.db`
              SELECT * FROM abandoned_cart_sends
              WHERE tenant_id = ${ctx.tenantId}
                AND customer_email ILIKE ${'%' + customer_email + '%'}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          } else if (date_from && date_to) {
            countResult = await ctx.db`
              SELECT COUNT(*)::int as total FROM abandoned_cart_sends
              WHERE tenant_id = ${ctx.tenantId}
                AND sent_at >= ${date_from}::timestamptz
                AND sent_at <= ${date_to}::timestamptz
            `;
            rows = await ctx.db`
              SELECT * FROM abandoned_cart_sends
              WHERE tenant_id = ${ctx.tenantId}
                AND sent_at >= ${date_from}::timestamptz
                AND sent_at <= ${date_to}::timestamptz
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          } else {
            countResult = await ctx.db`
              SELECT COUNT(*)::int as total FROM abandoned_cart_sends
              WHERE tenant_id = ${ctx.tenantId}
            `;
            rows = await ctx.db`
              SELECT * FROM abandoned_cart_sends
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          }

          const total = countResult[0].total;
          const items = rows.map(r => ({
            id: String(r.id),
            checkout_token: r.checkout_token,
            checkout_id: Number(r.checkout_id),
            customer_id: r.customer_id ? Number(r.customer_id) : null,
            customer_email: r.customer_email,
            cart_total: r.cart_total,
            currency: r.currency,
            line_items_json: typeof r.line_items_json === 'string' ? JSON.parse(r.line_items_json) : r.line_items_json,
            send_status: r.send_status,
            sent_at: r.sent_at ? r.sent_at.toISOString() : null,
            cron_run_id: r.cron_run_id ? String(r.cron_run_id) : null
          }));
          return { items, total, page: Number(page), page_size: Number(page_size) };
        } catch (err) {
          ctx.logger.error({ err }, 'sends/list error');
          return { items: [], total: 0, page: 1, page_size: 20 };
        }
      }

      // GET /runs/list
      if (ctx.adminPath === '/runs/list') {
        try {
          const { page = 1, page_size = 20 } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          const countResult = await ctx.db`
            SELECT COUNT(*)::int as total FROM cron_run_log WHERE tenant_id = ${ctx.tenantId}
          `;
          const rows = await ctx.db`
            SELECT * FROM cron_run_log
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY started_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;
          const total = countResult[0].total;
          const items = rows.map(r => ({
            id: String(r.id),
            started_at: r.started_at ? r.started_at.toISOString() : null,
            finished_at: r.finished_at ? r.finished_at.toISOString() : null,
            checkouts_fetched: Number(r.checkouts_fetched || 0),
            emails_sent: Number(r.emails_sent || 0),
            emails_skipped: Number(r.emails_skipped || 0),
            status: r.status,
            error_message: r.error_message || null
          }));
          return { items, total, page: Number(page), page_size: Number(page_size) };
        } catch (err) {
          ctx.logger.error({ err }, 'runs/list error');
          return { items: [], total: 0, page: 1, page_size: 20 };
        }
      }

      // GET /runs/stats
      if (ctx.adminPath === '/runs/stats') {
        try {
          const totalSends = await ctx.db`
            SELECT COUNT(*)::int as count FROM abandoned_cart_sends WHERE tenant_id = ${ctx.tenantId}
          `;
          const sends30 = await ctx.db`
            SELECT COUNT(*)::int as count FROM abandoned_cart_sends
            WHERE tenant_id = ${ctx.tenantId}
              AND sent_at >= NOW() - INTERVAL '30 days'
          `;
          const lastRun = await ctx.db`
            SELECT started_at, status FROM cron_run_log
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY started_at DESC
            LIMIT 1
          `;
          const totalRuns = await ctx.db`
            SELECT COUNT(*)::int as count FROM cron_run_log WHERE tenant_id = ${ctx.tenantId}
          `;
          return {
            total_sends_all_time: totalSends[0].count,
            sends_last_30_days: sends30[0].count,
            last_run_at: lastRun.length > 0 ? lastRun[0].started_at.toISOString() : null,
            last_run_status: lastRun.length > 0 ? lastRun[0].status : null,
            total_runs: totalRuns[0].count
          };
        } catch (err) {
          ctx.logger.error({ err }, 'runs/stats error');
          return { total_sends_all_time: 0, sends_last_30_days: 0, last_run_at: null, last_run_status: null, total_runs: 0 };
        }
      }

      // POST /run — manual trigger
      if (ctx.adminPath === '/run') {
        try {
          const result = await runAbandonedCartJob(ctx, dayjs, Handlebars);
          return {
            success: true,
            cron_run_id: String(result.cron_run_id),
            emails_sent: result.emails_sent,
            emails_skipped: result.emails_skipped,
            checkouts_fetched: result.checkouts_fetched
          };
        } catch (err) {
          ctx.logger.error({ err }, '/run error');
          return { success: false, cron_run_id: '', emails_sent: 0, emails_skipped: 0, checkouts_fetched: 0 };
        }
      }

      ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
      return { error: 'unknown path' };
    }

    // ─── CRON TRIGGER ─────────────────────────────────────────────────────────
    if (ctx.trigger === 'cron') {
      ctx.logger.info({ trigger: ctx.trigger }, 'cron: abandoned cart job starting');
      try {
        await runAbandonedCartJob(ctx, dayjs, Handlebars);
      } catch (err) {
        ctx.logger.error({ err }, 'cron: abandoned cart job failed');
      }
      return;
    }
  }
};

async function runAbandonedCartJob(ctx, dayjs, Handlebars) {
  // Step 1: Load settings
  const settingsRows = await ctx.db`
    SELECT delay_hours, email_subject, email_body_html, is_enabled
    FROM abandoned_cart_settings
    WHERE tenant_id = ${ctx.tenantId}
    LIMIT 1
  `;

  if (settingsRows.length === 0 || !settingsRows[0].is_enabled) {
    ctx.logger.info({ is_enabled: settingsRows.length > 0 ? settingsRows[0].is_enabled : false }, 'cron: abandoned cart disabled or not configured — skipping');
    // Still create a minimal log entry so /run returns meaningful data
    const logInsert = await ctx.db`
      INSERT INTO cron_run_log (tenant_id, started_at, finished_at, checkouts_fetched, emails_sent, emails_skipped, status)
      VALUES (${ctx.tenantId}, NOW(), NOW(), 0, 0, 0, 'skipped')
      RETURNING id
    `;
    return { cron_run_id: logInsert[0].id, emails_sent: 0, emails_skipped: 0, checkouts_fetched: 0 };
  }

  const { delay_hours, email_subject, email_body_html } = settingsRows[0];

  // Step 2: Insert cron_run_log row
  const logInsert = await ctx.db`
    INSERT INTO cron_run_log (tenant_id, started_at, checkouts_fetched, emails_sent, emails_skipped, status)
    VALUES (${ctx.tenantId}, NOW(), 0, 0, 0, 'running')
    RETURNING id
  `;
  const cron_run_id = logInsert[0].id;

  let emails_sent = 0;
  let emails_skipped = 0;
  let checkouts_fetched = 0;

  try {
    // Step 3: Bulk-fetch abandoned checkouts from Shopify
    // Abandoned checkouts: completed_at is null, updated_at older than delay_hours
    const cutoffTime = dayjs().subtract(Number(delay_hours), 'hour').toISOString();

    let allCheckouts = [];
    let sinceId = 0;

    while (true) {
      const response = await ctx.shopify.get(
        `/checkouts.json?status=open&updated_at_max=${encodeURIComponent(cutoffTime)}&limit=250&since_id=${sinceId}`
      );
      const checkouts = response.checkouts || [];
      if (checkouts.length === 0) break;

      // Filter: completed_at must be null (truly abandoned)
      const abandoned = checkouts.filter(c => !c.completed_at);
      allCheckouts = allCheckouts.concat(abandoned);

      sinceId = checkouts[checkouts.length - 1].id;
      if (checkouts.length < 250) break;

      await new Promise(r => setTimeout(r, 300));
    }

    checkouts_fetched = allCheckouts.length;
    ctx.logger.info({ checkouts_fetched }, 'cron: fetched abandoned checkouts');

    // Step 4: Bulk-fetch already-sent checkout tokens for this tenant
    const sentRows = await ctx.db`
      SELECT checkout_token FROM abandoned_cart_sends WHERE tenant_id = ${ctx.tenantId}
    `;
    const alreadySentTokens = new Set(sentRows.map(r => r.checkout_token));

    // Compile email template once
    const emailTemplate = Handlebars.compile(email_body_html || '');

    // Step 5: Process each checkout
    for (const checkout of allCheckouts) {
      const token = checkout.token;

      // Skip if already sent
      if (alreadySentTokens.has(token)) {
        emails_skipped++;
        continue;
      }

      // Must have an email
      const customerEmail = checkout.email;
      if (!customerEmail) {
        emails_skipped++;
        continue;
      }

      const customerName = checkout.billing_address
        ? (checkout.billing_address.first_name || checkout.shipping_address && checkout.shipping_address.first_name || 'Customer')
        : (checkout.shipping_address ? checkout.shipping_address.first_name || 'Customer' : 'Customer');

      const cartTotal = checkout.total_price || '0.00';
      const currency = checkout.currency || '';
      const recoveryUrl = checkout.abandoned_checkout_url || '';
      const lineItems = checkout.line_items || [];
      const customerId = checkout.customer ? checkout.customer.id : null;
      const checkoutId = checkout.id;

      // Render email body
      let renderedBody;
      try {
        renderedBody = emailTemplate({
          customer_name: customerName,
          cart_total: cartTotal,
          currency: currency,
          recovery_url: recoveryUrl,
          line_items: lineItems
        });
      } catch (templateErr) {
        ctx.logger.warn({ templateErr, token }, 'cron: template render failed, using raw html');
        renderedBody = email_body_html;
      }

      // Send email
      try {
        await ctx.services.email.send({
          to: customerEmail,
          subject: email_subject,
          data: {
            customer_name: customerName,
            cart_total: cartTotal,
            currency: currency,
            recovery_url: recoveryUrl,
            body_html: renderedBody
          }
        });
      } catch (emailErr) {
        ctx.logger.error({ emailErr, token }, 'cron: email send failed — skipping insert');
        emails_skipped++;
        continue;
      }

      // Insert send record
      try {
        await ctx.db`
          INSERT INTO abandoned_cart_sends
            (tenant_id, checkout_token, checkout_id, customer_id, customer_email, cart_total, currency, line_items_json, send_status, sent_at, cron_run_id)
          VALUES
            (${ctx.tenantId}, ${token}, ${checkoutId}, ${customerId}, ${customerEmail}, ${cartTotal}, ${currency}, ${JSON.stringify(lineItems)}, 'sent', NOW(), ${cron_run_id})
        `;
        emails_sent++;
        // Mark as sent in memory to prevent duplicates within same run
        alreadySentTokens.add(token);
      } catch (dbErr) {
        ctx.logger.error({ dbErr, token }, 'cron: failed to insert send record');
        emails_skipped++;
      }
    }

    // Step 6: Update cron_run_log with completed status
    await ctx.db`
      UPDATE cron_run_log
      SET finished_at = NOW(),
          checkouts_fetched = ${checkouts_fetched},
          emails_sent = ${emails_sent},
          emails_skipped = ${emails_skipped},
          status = 'completed'
      WHERE id = ${cron_run_id} AND tenant_id = ${ctx.tenantId}
    `;

    ctx.logger.info({ cron_run_id: String(cron_run_id), emails_sent, emails_skipped, checkouts_fetched }, 'cron: abandoned cart job completed');

    return { cron_run_id, emails_sent, emails_skipped, checkouts_fetched };

  } catch (err) {
    ctx.logger.error({ err, cron_run_id: String(cron_run_id) }, 'cron: abandoned cart job failed');

    try {
      await ctx.db`
        UPDATE cron_run_log
        SET finished_at = NOW(),
            checkouts_fetched = ${checkouts_fetched},
            emails_sent = ${emails_sent},
            emails_skipped = ${emails_skipped},
            status = 'failed',
            error_message = ${err.message || String(err)}
        WHERE id = ${cron_run_id} AND tenant_id = ${ctx.tenantId}
      `;
    } catch (logErr) {
      ctx.logger.error({ logErr }, 'cron: failed to update cron_run_log with error status');
    }

    throw err;
  }
}
```

### migration.sql

```sql
CREATE TABLE abandoned_cart_settings (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  delay_hours      INTEGER     NOT NULL DEFAULT 1,
  email_subject    TEXT        NOT NULL DEFAULT 'You left something behind!',
  email_body_html  TEXT        NOT NULL DEFAULT '',
  is_enabled       BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

ALTER TABLE abandoned_cart_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_settings_tenant_isolation ON abandoned_cart_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX abandoned_cart_settings_tenant_id_idx ON abandoned_cart_settings (tenant_id);

CREATE TABLE abandoned_cart_sends (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  checkout_token   TEXT        NOT NULL,
  checkout_id      BIGINT      NOT NULL,
  customer_id      BIGINT      NULL,
  customer_email   TEXT        NOT NULL,
  cart_total       TEXT        NOT NULL,
  currency         TEXT        NOT NULL,
  line_items_json  JSONB       NOT NULL DEFAULT '[]',
  send_status      TEXT        NOT NULL DEFAULT 'sent',
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cron_run_id      UUID        NULL,
  UNIQUE (tenant_id, checkout_token)
);

ALTER TABLE abandoned_cart_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_sends_tenant_isolation ON abandoned_cart_sends
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX abandoned_cart_sends_tenant_id_idx ON abandoned_cart_sends (tenant_id);
CREATE INDEX abandoned_cart_sends_customer_id_idx ON abandoned_cart_sends (tenant_id, customer_id);
CREATE INDEX abandoned_cart_sends_sent_at_idx ON abandoned_cart_sends (tenant_id, sent_at);
CREATE INDEX abandoned_cart_sends_cron_run_id_idx ON abandoned_cart_sends (tenant_id, cron_run_id);

CREATE TABLE cron_run_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ NULL,
  checkouts_fetched   INTEGER     NOT NULL DEFAULT 0,
  emails_sent         INTEGER     NOT NULL DEFAULT 0,
  emails_skipped      INTEGER     NOT NULL DEFAULT 0,
  status              TEXT        NOT NULL DEFAULT 'running',
  error_message       TEXT        NULL
);

ALTER TABLE cron_run_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY cron_run_log_tenant_isolation ON cron_run_log
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX cron_run_log_tenant_id_idx ON cron_run_log (tenant_id);
CREATE INDEX cron_run_log_started_at_idx ON cron_run_log (tenant_id, started_at);
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  const style = document.createElement('style');
  style.textContent = `
    .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--p-color-border); margin-bottom: var(--p-space-400); }
    .tab-btn {
      background: none; border: none; border-bottom: 2px solid transparent;
      padding: var(--p-space-300) var(--p-space-500); cursor: pointer;
      font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text-secondary); margin-bottom: -1px;
    }
    .tab-btn.active { color: var(--p-color-text); border-bottom-color: #008060; }
    .tab-btn:hover:not(.active) { color: var(--p-color-text); background: var(--p-color-bg-surface-secondary); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .form-row { margin-bottom: var(--p-space-400); }
    .form-label {
      display: block; font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium); color: var(--p-color-text);
      margin-bottom: var(--p-space-100);
    }
    .form-hint { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-top: var(--p-space-100); }
    .form-input, .form-textarea {
      width: 100%; box-sizing: border-box;
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      padding: var(--p-space-200) var(--p-space-300);
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      color: var(--p-color-text);
      background: var(--p-color-bg-surface);
    }
    .form-input:focus, .form-textarea:focus {
      outline: 2px solid #008060; outline-offset: 1px; border-color: #008060;
    }
    .form-textarea { min-height: 180px; resize: vertical; font-family: monospace; font-size: var(--p-font-size-300); }
    .toggle-row { display: flex; align-items: center; gap: var(--p-space-300); }
    .toggle-switch {
      position: relative; width: 44px; height: 24px; cursor: pointer;
    }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute; inset: 0; border-radius: var(--p-border-radius-full);
      background: var(--p-color-border); transition: background 0.2s;
    }
    .toggle-slider::before {
      content: ''; position: absolute;
      width: 18px; height: 18px; left: 3px; top: 3px;
      border-radius: 50%; background: white; transition: transform 0.2s;
    }
    .toggle-switch input:checked + .toggle-slider { background: #008060; }
    .toggle-switch input:checked + .toggle-slider::before { transform: translateX(20px); }
    .filter-row { display: flex; gap: var(--p-space-300); flex-wrap: wrap; align-items: flex-end; margin-bottom: var(--p-space-400); }
    .filter-group { display: flex; flex-direction: column; gap: var(--p-space-100); }
    .filter-label { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); font-weight: var(--p-font-weight-medium); }
    .filter-input {
      border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100);
      padding: var(--p-space-150, 6px) var(--p-space-300); font-size: var(--p-font-size-350);
      color: var(--p-color-text); background: var(--p-color-bg-surface);
      font-family: var(--p-font-family-sans);
    }
    .filter-input:focus { outline: 2px solid #008060; border-color: #008060; }
    .run-btn-row { display: flex; align-items: center; gap: var(--p-space-300); margin-bottom: var(--p-space-400); }
    .run-result {
      padding: var(--p-space-300) var(--p-space-400);
      background: var(--p-color-bg-fill-success);
      border-radius: var(--p-border-radius-100);
      font-size: var(--p-font-size-350);
      color: var(--p-color-text-success);
    }
    .limitation-banner {
      background: var(--p-color-bg-surface-secondary);
      border: 1px solid var(--p-color-border);
      border-left: 4px solid var(--p-color-border-emphasis);
      border-radius: var(--p-border-radius-100);
      padding: var(--p-space-300) var(--p-space-400);
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      margin-bottom: var(--p-space-400);
    }
    .limitation-banner strong { color: var(--p-color-text); }
    .sends-toolbar { display: flex; gap: var(--p-space-300); align-items: center; flex-wrap: wrap; }
    .table-meta { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-bottom: var(--p-space-200); }
    .line-items-cell { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
    .section-actions { display: flex; gap: var(--p-space-300); align-items: center; margin-bottom: var(--p-space-400); }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Abandoned Cart Recovery</span>
      </div>

      <div class="tabs">
        <button class="tab-btn active" data-tab="dashboard">Dashboard</button>
        <button class="tab-btn" data-tab="sends">Email Sends</button>
        <button class="tab-btn" data-tab="runs">Cron Runs</button>
        <button class="tab-btn" data-tab="settings">Settings</button>
      </div>

      <!-- DASHBOARD TAB -->
      <div class="tab-content active" id="tab-dashboard">
        <div class="shell-stats-row" id="stats-row">
          <div class="shell-stat-card">
            <div class="shell-stat-label">Total Sends (All Time)</div>
            <div class="shell-stat-value" id="stat-total">—</div>
          </div>
          <div class="shell-stat-card">
            <div class="shell-stat-label">Sends (Last 30 Days)</div>
            <div class="shell-stat-value" id="stat-30d">—</div>
          </div>
          <div class="shell-stat-card">
            <div class="shell-stat-label">Total Cron Runs</div>
            <div class="shell-stat-value" id="stat-runs">—</div>
          </div>
          <div class="shell-stat-card">
            <div class="shell-stat-label">Last Run Status</div>
            <div class="shell-stat-value" id="stat-last-status">—</div>
          </div>
        </div>
        <div id="stats-loading" class="shell-loading"><span class="shell-spinner"></span> Loading stats…</div>
        <div id="stats-error" class="shell-error-banner" style="display:none;"></div>

        <div class="shell-card" style="margin-top: var(--p-space-400);">
          <div class="shell-section-title">Manual Run</div>
          <p style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);margin:0 0 var(--p-space-300);">
            Trigger the abandoned cart recovery job immediately without waiting for the next scheduled cron run.
          </p>
          <div class="limitation-banner">
            <strong>Platform Notes:</strong> Abandoned checkouts are fetched via the Shopify Admin REST API
            (<code>GET /admin/api/2024-01/checkouts.json</code>). Each reminder email is sent individually per checkout.
            Open/click tracking is not available via Shopify — only send-level metrics are tracked.
          </div>
          <div class="run-btn-row">
            <button class="btn-primary" id="run-now-btn">▶ Run Now</button>
            <span id="run-loading" style="display:none;font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);">
              <span class="shell-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px;"></span> Running…
            </span>
          </div>
          <div id="run-result" style="display:none;" class="run-result"></div>
        </div>

        <div class="shell-card" style="margin-top: var(--p-space-400);">
          <div class="shell-section-title">Last Run</div>
          <div id="last-run-info" style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);">Loading…</div>
        </div>
      </div>

      <!-- SENDS TAB -->
      <div class="tab-content" id="tab-sends">
        <div class="shell-card">
          <div class="shell-section-title">Email Sends</div>
          <div class="filter-row">
            <div class="filter-group">
              <label class="filter-label">Customer Email</label>
              <input class="filter-input" id="filter-email" type="text" placeholder="filter@example.com" style="width:220px;">
            </div>
            <div class="filter-group">
              <label class="filter-label">Date From</label>
              <input class="filter-input" id="filter-date-from" type="date">
            </div>
            <div class="filter-group">
              <label class="filter-label">Date To</label>
              <input class="filter-input" id="filter-date-to" type="date">
            </div>
            <div class="filter-group" style="justify-content:flex-end;">
              <button class="btn-primary" id="sends-search-btn" style="margin-top:auto;">Search</button>
            </div>
            <div class="filter-group" style="justify-content:flex-end;">
              <button class="btn-secondary" id="sends-reset-btn" style="margin-top:auto;">Reset</button>
            </div>
          </div>
          <div id="sends-table-meta" class="table-meta"></div>
          <div id="sends-loading" class="shell-loading" style="display:none;"><span class="shell-spinner"></span> Loading…</div>
          <div id="sends-error" class="shell-error-banner" style="display:none;"></div>
          <div class="shell-table-wrap" id="sends-table-wrap">
            <table class="shell-table" id="sends-table">
              <thead>
                <tr>
                  <th>Customer Email</th>
                  <th>Cart Total</th>
                  <th>Status</th>
                  <th>Sent At</th>
                  <th>Checkout ID</th>
                  <th>Items</th>
                </tr>
              </thead>
              <tbody id="sends-tbody"></tbody>
            </table>
          </div>
          <div class="shell-pagination">
            <span id="sends-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="sends-prev-btn" disabled>← Prev</button>
              <button class="btn-secondary" id="sends-next-btn" disabled>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- RUNS TAB -->
      <div class="tab-content" id="tab-runs">
        <div class="shell-card">
          <div class="shell-section-title">Cron Run History</div>
          <div class="section-actions">
            <button class="btn-secondary" id="runs-refresh-btn">↺ Refresh</button>
          </div>
          <div id="runs-loading" class="shell-loading" style="display:none;"><span class="shell-spinner"></span> Loading…</div>
          <div id="runs-error" class="shell-error-banner" style="display:none;"></div>
          <div id="runs-table-meta" class="table-meta"></div>
          <div class="shell-table-wrap">
            <table class="shell-table" id="runs-table">
              <thead>
                <tr>
                  <th>Started At</th>
                  <th>Finished At</th>
                  <th>Status</th>
                  <th>Checkouts Fetched</th>
                  <th>Emails Sent</th>
                  <th>Emails Skipped</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody id="runs-tbody"></tbody>
            </table>
          </div>
          <div class="shell-pagination">
            <span id="runs-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="runs-prev-btn" disabled>← Prev</button>
              <button class="btn-secondary" id="runs-next-btn" disabled>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- SETTINGS TAB -->
      <div class="tab-content" id="tab-settings">
        <div class="shell-card">
          <div class="shell-section-title">Recovery Settings</div>
          <div id="settings-loading" class="shell-loading"><span class="shell-spinner"></span> Loading settings…</div>
          <div id="settings-error" class="shell-error-banner" style="display:none;"></div>
          <div id="settings-form" style="display:none;">
            <div class="form-row">
              <div class="toggle-row">
                <label class="toggle-switch" for="setting-enabled">
                  <input type="checkbox" id="setting-enabled">
                  <span class="toggle-slider"></span>
                </label>
                <span class="form-label" style="margin:0;">Enable Abandoned Cart Emails</span>
              </div>
            </div>
            <div class="form-row">
              <label class="form-label" for="setting-delay">Delay Before Sending (hours)</label>
              <input class="form-input" type="number" id="setting-delay" min="1" max="720" style="max-width:160px;">
              <div class="form-hint">How many hours after abandonment before sending the reminder.</div>
            </div>
            <div class="form-row">
              <label class="form-label" for="setting-subject">Email Subject</label>
              <input class="form-input" type="text" id="setting-subject" placeholder="You left something behind…">
            </div>
            <div class="form-row">
              <label class="form-label" for="setting-body">Email Body (HTML)</label>
              <textarea class="form-textarea" id="setting-body" placeholder="<p>Hi {{customer_name}}, your cart is waiting…</p>"></textarea>
              <div class="form-hint">You may use HTML. Variables: <code>{{customer_name}}</code>, <code>{{cart_total}}</code>, <code>{{checkout_url}}</code>.</div>
            </div>
            <div class="limitation-banner" style="margin-top:var(--p-space-200);">
              <strong>Note:</strong> Email open/click tracking is not available via Shopify's native APIs.
              Only send-level performance metrics (sent count, send timestamp per checkout) are tracked in this app.
            </div>
            <div style="display:flex;gap:var(--p-space-300);align-items:center;">
              <button class="btn-primary" id="settings-save-btn">Save Settings</button>
              <span id="settings-save-loading" style="display:none;font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);">
                <span class="shell-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px;"></span> Saving…
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(style);

  // --- State ---
  const state = {
    sendsPage: 1,
    sendsPageSize: 20,
    sendsTotal: 0,
    sendsFilterEmail: null,
    sendsFilterDateFrom: null,
    sendsFilterDateTo: null,
    runsPage: 1,
    runsPageSize: 20,
    runsTotal: 0,
  };

  // --- Tab switching ---
  const tabBtns = container.querySelectorAll('.tab-btn');
  const tabContents = container.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.toggle('active', b === btn));
      tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${target}`));
      if (target === 'sends') loadSends();
      if (target === 'runs') loadRuns();
      if (target === 'settings') loadSettings();
    });
  });

  // --- Helpers ---
  function fmtDate(str) {
    if (!str) return '—';
    try {
      return new Date(str).toLocaleString();
    } catch (e) { return str; }
  }

  function statusBadge(status) {
    if (!status) return '<span class="badge badge-neutral">—</span>';
    const s = status.toLowerCase();
    if (s === 'sent' || s === 'success' || s === 'completed') return `<span class="badge badge-success">${status}</span>`;
    if (s === 'failed' || s === 'error') return `<span class="badge badge-error">${status}</span>`;
    if (s === 'skipped') return `<span class="badge badge-warning">${status}</span>`;
    return `<span class="badge badge-neutral">${status}</span>`;
  }

  function setVisible(id, visible) {
    const el = container.querySelector(`#${id}`);
    if (el) el.style.display = visible ? '' : 'none';
  }

  function setHTML(id, html) {
    const el = container.querySelector(`#${id}`);
    if (el) el.innerHTML = html;
  }

  function setText(id, text) {
    const el = container.querySelector(`#${id}`);
    if (el) el.textContent = text;
  }

  function setError(id, msg) {
    const el = container.querySelector(`#${id}`);
    if (el) { el.textContent = msg; el.style.display = msg ? '' : 'none'; }
  }

  // --- Dashboard / Stats ---
  async function loadStats() {
    setVisible('stats-loading', true);
    setError('stats-error', '');
    container.querySelector('#stats-row').style.opacity = '0.4';
    try {
      const data = await bridge.call('/runs/stats', {});
      setText('stat-total', data.total_sends_all_time != null ? data.total_sends_all_time.toLocaleString() : '0');
      setText('stat-30d', data.sends_last_30_days != null ? data.sends_last_30_days.toLocaleString() : '0');
      setText('stat-runs', data.total_runs != null ? data.total_runs.toLocaleString() : '0');
      const lastStatusEl = container.querySelector('#stat-last-status');
      if (lastStatusEl) lastStatusEl.innerHTML = statusBadge(data.last_run_status || '—');

      const lastRunEl = container.querySelector('#last-run-info');
      if (lastRunEl) {
        if (data.last_run_at) {
          lastRunEl.innerHTML = `Last run at: <strong>${fmtDate(data.last_run_at)}</strong> &nbsp; Status: ${statusBadge(data.last_run_status)}`;
        } else {
          lastRunEl.textContent = 'No runs recorded yet.';
        }
      }
      container.querySelector('#stats-row').style.opacity = '1';
    } catch (e) {
      setError('stats-error', 'Failed to load stats: ' + (e.message || e));
    } finally {
      setVisible('stats-loading', false);
    }
  }

  // --- Manual Run ---
  const runNowBtn = container.querySelector('#run-now-btn');
  runNowBtn.addEventListener('click', async () => {
    runNowBtn.disabled = true;
    setVisible('run-loading', true);
    setVisible('run-result', false);
    try {
      const res = await bridge.call('/run', {});
      if (res.success) {
        const resultEl = container.querySelector('#run-result');
        resultEl.textContent = `✓ Run complete — Checkouts fetched: ${res.checkouts_fetched}, Emails sent: ${res.emails_sent}, Emails skipped: ${res.emails_skipped}`;
        setVisible('run-result', true);
        bridge.notify(`Emails sent: ${res.emails_sent}, skipped: ${res.emails_skipped}`, 'success');
        loadStats();
      } else {
        bridge.notify('Run completed but returned success: false', 'error');
      }
    } catch (e) {
      bridge.notify('Run failed: ' + (e.message || e), 'error');
    } finally {
      runNowBtn.disabled = false;
      setVisible('run-loading', false);
    }
  });

  // --- Sends ---
  async function loadSends() {
    setVisible('sends-loading', true);
    setError('sends-error', '');
    const tbody = container.querySelector('#sends-tbody');
    tbody.innerHTML = '';
    setText('sends-table-meta', '');
    try {
      const res = await bridge.call('/sends/list', {
        page: state.sendsPage,
        page_size: state.sendsPageSize,
        customer_email: state.sendsFilterEmail || null,
        date_from: state.sendsFilterDateFrom || null,
        date_to: state.sendsFilterDateTo || null,
      });
      state.sendsTotal = res.total || 0;
      const totalPages = Math.max(1, Math.ceil(state.sendsTotal / state.sendsPageSize));

      setText('sends-table-meta', `Showing ${res.items.length} of ${state.sendsTotal} record(s). Page ${state.sendsPage} of ${totalPages}.`);
      setText('sends-page-info', `Page ${state.sendsPage} of ${totalPages}`);

      container.querySelector('#sends-prev-btn').disabled = state.sendsPage <= 1;
      container.querySelector('#sends-next-btn').disabled = state.sendsPage >= totalPages;

      if (!res.items.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.className = 'shell-empty';
        td.textContent = 'No email sends found.';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      res.items.forEach(item => {
        const tr = document.createElement('tr');
        let itemsSummary = '—';
        if (Array.isArray(item.line_items_json) && item.line_items_json.length > 0) {
          const names = item.line_items_json.slice(0, 2).map(li => li.title || li.name || 'Item').join(', ');
          itemsSummary = item.line_items_json.length > 2 ? `${names} +${item.line_items_json.length - 2} more` : names;
        }
        tr.innerHTML = `
          <td>${item.customer_email || '—'}</td>
          <td>${item.cart_total ? `${item.cart_total} ${item.currency || ''}` : '—'}</td>
          <td>${statusBadge(item.send_status)}</td>
          <td>${fmtDate(item.sent_at)}</td>
          <td style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);">${item.checkout_id || '—'}</td>
          <td class="line-items-cell">${itemsSummary}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch (e) {
      setError('sends-error', 'Failed to load sends: ' + (e.message || e));
    } finally {
      setVisible('sends-loading', false);
    }
  }

  container.querySelector('#sends-search-btn').addEventListener('click', () => {
    state.sendsPage = 1;
    state.sendsFilterEmail = container.querySelector('#filter-email').value.trim() || null;
    state.sendsFilterDateFrom = container.querySelector('#filter-date-from').value || null;
    state.sendsFilterDateTo = container.querySelector('#filter-date-to').value || null;
    loadSends();
  });

  container.querySelector('#sends-reset-btn').addEventListener('click', () => {
    container.querySelector('#filter-email').value = '';
    container.querySelector('#filter-date-from').value = '';
    container.querySelector('#filter-date-to').value = '';
    state.sendsPage = 1;
    state.sendsFilterEmail = null;
    state.sendsFilterDateFrom = null;
    state.sendsFilterDateTo = null;
    loadSends();
  });

  container.querySelector('#sends-prev-btn').addEventListener('click', () => {
    if (state.sendsPage > 1) { state.sendsPage--; loadSends(); }
  });
  container.querySelector('#sends-next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(state.sendsTotal / state.sendsPageSize);
    if (state.sendsPage < totalPages) { state.sendsPage++; loadSends(); }
  });

  // --- Runs ---
  async function loadRuns() {
    setVisible('runs-loading', true);
    setError('runs-error', '');
    const tbody = container.querySelector('#runs-tbody');
    tbody.innerHTML = '';
    setText('runs-table-meta', '');
    try {
      const res = await bridge.call('/runs/list', {
        page: state.runsPage,
        page_size: state.runsPageSize,
      });
      state.runsTotal = res.total || 0;
      const totalPages = Math.max(1, Math.ceil(state.runsTotal / state.runsPageSize));

      setText('runs-table-meta', `Showing ${res.items.length} of ${state.runsTotal} run(s). Page ${state.runsPage} of ${totalPages}.`);
      setText('runs-page-info', `Page ${state.runsPage} of ${totalPages}`);

      container.querySelector('#runs-prev-btn').disabled = state.runsPage <= 1;
      container.querySelector('#runs-next-btn').disabled = state.runsPage >= totalPages;

      if (!res.items.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.className = 'shell-empty';
        td.textContent = 'No cron runs recorded yet.';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      res.items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${fmtDate(item.started_at)}</td>
          <td>${fmtDate(item.finished_at)}</td>
          <td>${statusBadge(item.status)}</td>
          <td>${item.checkouts_fetched != null ? item.checkouts_fetched : '—'}</td>
          <td>${item.emails_sent != null ? item.emails_sent : '—'}</td>
          <td>${item.emails_skipped != null ? item.emails_skipped : '—'}</td>
          <td style="font-size:var(--p-font-size-300);color:var(--p-color-text-critical);max-width:200px;word-break:break-word;">
            ${item.error_message ? item.error_message : '—'}
          </td>
        `;
        tbody.appendChild(tr);
      });
    } catch (e) {
      setError('runs-error', 'Failed to load runs: ' + (e.message || e));
    } finally {
      setVisible('runs-loading', false);
    }
  }

  container.querySelector('#runs-refresh-btn').addEventListener('click', () => {
    state.runsPage = 1;
    loadRuns();
  });

  container.querySelector('#runs-prev-btn').addEventListener('click', () => {
    if (state.runsPage > 1) { state.runsPage--; loadRuns(); }
  });
  container.querySelector('#runs-next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(state.runsTotal / state.runsPageSize);
    if (state.runsPage < totalPages) { state.runsPage++; loadRuns(); }
  });

  // --- Settings ---
  async function loadSettings() {
    setVisible('settings-loading', true);
    setVisible('settings-form', false);
    setError('settings-error', '');
    try {
      const data = await bridge.call('/settings/get', {});
      container.querySelector('#setting-enabled').checked = !!data.is_enabled;
      container.querySelector('#setting-delay').value = data.delay_hours != null ? data.delay_hours : 1;
      container.querySelector('#setting-subject').value = data.email_subject || '';
      container.querySelector('#setting-body').value = data.email_body_html || '';
      setVisible('settings-form', true);
    } catch (e) {
      setError('settings-error', 'Failed to load settings: ' + (e.message || e));
    } finally {
      setVisible('settings-loading', false);
    }
  }

  container.querySelector('#settings-save-btn').addEventListener('click', async () => {
    const saveBtn = container.querySelector('#settings-save-btn');
    const delayVal = parseInt(container.querySelector('#setting-delay').value, 10);
    if (isNaN(delayVal) || delayVal < 1) {
      bridge.notify('Delay must be at least 1 hour.', 'error');
      return;
    }
    const subject = container.querySelector('#setting-subject').value.trim();
    if (!subject) {
      bridge.notify('Email subject cannot be empty.', 'error');
      return;
    }
    const body = container.querySelector('#setting-body').value;
    if (!body.trim()) {
      bridge.notify('Email body cannot be empty.', 'error');
      return;
    }

    saveBtn.disabled = true;
    setVisible('settings-save-loading', true);
    try {
      const res = await bridge.call('/settings/save', {
        is_enabled: container.querySelector('#setting-enabled').checked,
        delay_hours: delayVal,
        email_subject: subject,
        email_body_html: body,
      });
      if (res.success) {
        bridge.notify('Settings saved successfully.', 'success');
      } else {
        bridge.notify('Settings save returned success: false', 'error');
      }
    } catch (e) {
      bridge.notify('Failed to save settings: ' + (e.message || e), 'error');
    } finally {
      saveBtn.disabled = false;
      setVisible('settings-save-loading', false);
    }
  });

  // --- Initial load ---
  loadStats();
}
```

