# Feature Generator — Run Result

**Date:** 2026-04-06 19:53:14  
**Status:** ✅ SUCCESS  
**Total:** 120795ms  
**Prompt:** I'm losing a lot of sales from people who add stuff to their cart and just disappear. I want to automatically follow up with them by email after they've been gone for a while. Just something simple that reminds them what they left behind and brings them back to finish the purchase.

## Pipeline

| Agent       | Status | Time       |
|-------------|--------|------------|
| Product     | ✓      | 3016ms     |
| Architect   | ✓      | 25599ms    |
| CodeSpec    | ✓      | 37406ms    |
| Handler     | ✓      | 44692ms    |
| Migration   | ✓      | 44692ms    |
| Admin UI    | ✓      | 44692ms    |
| Validation  | ✓      | 17ms       |
| Explanation | ✓      | 3126ms     |

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: [],
  cronSchedule: '0 */6 * * *',
  npmPackages: [],
  handler: async function(ctx) {
    try {
      // Helper: build customer map from array of customer ID strings
      async function buildCustomerMap(customerIds) {
        const customerMap = new Map();
        if (customerIds.length === 0) return customerMap;
        const uniqueIds = [...new Set(customerIds)];
        const CHUNK_SIZE = 250;
        for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
          const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
          try {
            const response = await ctx.shopify.get(
              `/customers.json?ids=${chunk.join(',')}&fields=id,email,first_name`
            );
            if (!response.customers) continue;
            for (const customer of response.customers) {
              customerMap.set(String(customer.id), {
                email: customer.email ?? '',
                firstName: customer.first_name ?? ''
              });
            }
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'buildCustomerMap: failed to fetch customers chunk');
          }
        }
        return customerMap;
      }

      // ── ADMIN path ────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        if (ctx.adminPath === '/stats') {
          const rows = await ctx.db`
            SELECT
              COUNT(*)::int AS total_abandoned,
              COUNT(reminder_sent_at)::int AS total_reminders_sent,
              COUNT(*) FILTER (WHERE reminder_sent_at IS NULL)::int AS pending_reminders,
              MAX(reminder_sent_at) AS last_run_at
            FROM abandoned_cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
          `;
          const row = rows[0];
          return {
            totalAbandoned: row.total_abandoned ?? 0,
            totalRemindersSent: row.total_reminders_sent ?? 0,
            pendingReminders: row.pending_reminders ?? 0,
            lastRunAt: row.last_run_at ?? null
          };
        }

        if (ctx.adminPath === '/config/get') {
          const configRows = await ctx.db`
            SELECT delay_minutes, max_reminders
            FROM abandoned_cart_config
            WHERE tenant_id = ${ctx.tenantId}
          `;
          if (configRows.length === 0) {
            return { delayMinutes: 60, maxReminders: 1 };
          }
          return {
            delayMinutes: configRows[0].delay_minutes,
            maxReminders: configRows[0].max_reminders
          };
        }

        if (ctx.adminPath === '/config/save') {
          const { delayMinutes, maxReminders } = ctx.adminBody;
          if (!delayMinutes || !maxReminders || delayMinutes < 1 || maxReminders < 1) {
            return { error: 'delayMinutes and maxReminders must be >= 1' };
          }
          await ctx.db`
            INSERT INTO abandoned_cart_config (tenant_id, delay_minutes, max_reminders, updated_at)
            VALUES (${ctx.tenantId}, ${delayMinutes}, ${maxReminders}, NOW())
            ON CONFLICT (tenant_id)
            DO UPDATE SET
              delay_minutes = EXCLUDED.delay_minutes,
              max_reminders = EXCLUDED.max_reminders,
              updated_at = NOW()
          `;
          ctx.logger.info({ delayMinutes, maxReminders }, 'config saved');
          return { saved: true };
        }

        if (ctx.adminPath === '/reminders') {
          const reminderRows = await ctx.db`
            SELECT checkout_token, customer_email, abandoned_at, reminder_sent_at, line_items_json, cart_url
            FROM abandoned_cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY abandoned_at DESC
            LIMIT 100
          `;
          const totalRows = await ctx.db`
            SELECT COUNT(*)::int AS cnt
            FROM abandoned_cart_reminders
            WHERE tenant_id = ${ctx.tenantId}
          `;
          const mappedRows = reminderRows.map(row => {
            let lineItemCount = 0;
            try {
              lineItemCount = JSON.parse(row.line_items_json ?? '[]').length;
            } catch (_) {}
            return {
              checkoutToken: row.checkout_token,
              customerEmail: row.customer_email,
              abandonedAt: row.abandoned_at,
              reminderSentAt: row.reminder_sent_at,
              lineItemCount,
              cartUrl: row.cart_url
            };
          });
          return {
            rows: mappedRows,
            total: totalRows[0]?.cnt ?? 0
          };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ── CRON path ─────────────────────────────────────────────
      if (ctx.trigger === 'cron') {
        ctx.logger.info({ trigger: ctx.trigger }, 'abandoned cart cron started');

        // Step 1-3: Load config
        const configRows = await ctx.db`
          SELECT delay_minutes, max_reminders
          FROM abandoned_cart_config
          WHERE tenant_id = ${ctx.tenantId}
        `;
        let delayMinutes = 60;
        let maxReminders = 1;
        if (configRows.length > 0) {
          delayMinutes = configRows[0].delay_minutes;
          maxReminders = configRows[0].max_reminders;
        }

        // Step 4: Compute threshold
        const thresholdTime = new Date(Date.now() - delayMinutes * 60 * 1000).toISOString();

        // Steps 5-10: Fetch abandoned checkouts via cursor pagination
        let sinceId = 0;
        const allCheckouts = [];

        while (true) {
          let checkoutsResponse;
          try {
            checkoutsResponse = await ctx.shopify.get(
              `/checkouts.json?limit=250&since_id=${sinceId}`
            );
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'Failed to fetch checkouts');
            break;
          }

          const checkouts = checkoutsResponse.checkouts ?? [];
          if (checkouts.length === 0) break;

          // Step 7: Filter checkouts
          const filtered = checkouts.filter(c =>
            c.completed_at === null &&
            c.abandoned_checkout_url != null &&
            c.created_at < thresholdTime &&
            (c.email != null || c.customer_id != null)
          );

          allCheckouts.push(...filtered);

          sinceId = checkouts[checkouts.length - 1].id;
          if (checkouts.length < 250) break;
        }

        // Step 11
        if (allCheckouts.length === 0) {
          ctx.logger.info('No abandoned checkouts to process');
          return;
        }

        ctx.logger.info({ count: allCheckouts.length }, 'abandoned checkouts found');

        // Steps 12-14: Check which tokens already have reminders sent
        const tokenList = allCheckouts.map(c => c.token);
        const sentRows = await ctx.db`
          SELECT checkout_token, reminder_sent_at
          FROM abandoned_cart_reminders
          WHERE tenant_id = ${ctx.tenantId}
            AND checkout_token = ANY(${tokenList})
        `;
        const sentMap = new Map();
        for (const row of sentRows) {
          sentMap.set(row.checkout_token, row.reminder_sent_at);
        }

        // Step 15: Filter to eligible checkouts (no reminder sent yet)
        const eligibleCheckouts = allCheckouts.filter(c => {
          const sentAt = sentMap.get(c.token);
          return sentAt === undefined || sentAt === null;
        });

        if (eligibleCheckouts.length === 0) {
          ctx.logger.info('All abandoned checkouts already reminded');
          return;
        }

        ctx.logger.info({ count: eligibleCheckouts.length }, 'eligible checkouts for reminder');

        // Steps 16-18: Pre-fetch customer data
        const customerIds = [...new Set(
          eligibleCheckouts
            .filter(c => c.customer_id != null)
            .map(c => String(c.customer_id))
        )];

        const customerMap = await buildCustomerMap(customerIds);

        // Step 19: Build upsert rows
        const upsertRows = eligibleCheckouts.map(c => {
          const customerInfo = c.customer_id ? customerMap.get(String(c.customer_id)) : null;
          const email = customerInfo?.email ?? c.email ?? null;
          if (!email) return null;
          return {
            tenant_id: ctx.tenantId,
            checkout_token: c.token,
            customer_id: c.customer_id ?? null,
            customer_email: email,
            cart_url: c.abandoned_checkout_url,
            line_items_json: JSON.stringify(c.line_items ?? []),
            abandoned_at: c.created_at
          };
        }).filter(r => r !== null);

        // Step 20
        if (upsertRows.length === 0) {
          ctx.logger.info('No eligible rows with a valid email');
          return;
        }

        // Step 21: Upsert records without overwriting existing reminder_sent_at
        for (const row of upsertRows) {
          try {
            await ctx.db`
              INSERT INTO abandoned_cart_reminders
                (id, tenant_id, checkout_token, customer_id, customer_email, cart_url, line_items_json, abandoned_at, reminder_sent_at, created_at)
              VALUES
                (gen_random_uuid(), ${row.tenant_id}, ${row.checkout_token}, ${row.customer_id}, ${row.customer_email}, ${row.cart_url}, ${row.line_items_json}, ${row.abandoned_at}, NULL, NOW())
              ON CONFLICT (tenant_id, checkout_token) DO NOTHING
            `;
          } catch (err) {
            ctx.logger.error({ err: err.message, token: row.checkout_token }, 'Failed to upsert reminder row');
          }
        }

        // Steps 22-28: Claim and send reminders
        for (const row of upsertRows) {
          try {
            // Step 22: Atomically claim
            const claimed = await ctx.db`
              UPDATE abandoned_cart_reminders
              SET reminder_sent_at = NOW()
              WHERE tenant_id = ${ctx.tenantId}
                AND checkout_token = ${row.checkout_token}
                AND reminder_sent_at IS NULL
              RETURNING id, customer_email, cart_url, line_items_json, abandoned_at, checkout_token
            `;

            // Step 23: Skip if already claimed
            if (claimed.length === 0) {
              ctx.logger.info({ token: row.checkout_token }, 'reminder already sent by concurrent run — skip');
              await new Promise(r => setTimeout(r, 200));
              continue;
            }

            // Step 24: Resolve customer first name
            const claimedRow = claimed[0];
            const matchingCheckout = eligibleCheckouts.find(c => c.token === claimedRow.checkout_token);
            let customerFirstName = '';
            if (matchingCheckout && matchingCheckout.customer_id) {
              const info = customerMap.get(String(matchingCheckout.customer_id));
              if (info) customerFirstName = info.firstName ?? '';
            }

            // Step 25: Send email
            await ctx.services.email.send({
              to: claimedRow.customer_email,
              subject: 'You left something behind!',
              data: {
                checkoutToken: claimedRow.checkout_token,
                cartUrl: claimedRow.cart_url,
                lineItemsJson: claimedRow.line_items_json,
                abandonedAt: claimedRow.abandoned_at,
                firstName: customerFirstName
              }
            });

            ctx.logger.info({ token: claimedRow.checkout_token, email: claimedRow.customer_email }, 'reminder email sent');
          } catch (err) {
            ctx.logger.error({ err: err.message, token: row.checkout_token }, 'Failed to process reminder for checkout');
          }

          // Step 26: Rate-limit guard
          await new Promise(r => setTimeout(r, 200));
        }

        // Step 27: Update last-run marker (silent if no row)
        try {
          await ctx.db`
            UPDATE abandoned_cart_config
            SET updated_at = NOW()
            WHERE tenant_id = ${ctx.tenantId}
          `;
        } catch (_) {}

        ctx.logger.info('abandoned cart cron completed');
        return;
      }

    } catch (err) {
      ctx.logger.error({ err: err.message }, 'Handler error');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE abandoned_cart_config (
  tenant_id UUID PRIMARY KEY,
  delay_minutes INT NOT NULL DEFAULT 60,
  max_reminders INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE abandoned_cart_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_config_tenant_isolation ON abandoned_cart_config
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE abandoned_cart_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  checkout_token TEXT NOT NULL,
  customer_id BIGINT,
  customer_email TEXT NOT NULL,
  cart_url TEXT,
  line_items_json JSONB,
  abandoned_at TIMESTAMPTZ NOT NULL,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_acr_tenant_token UNIQUE (tenant_id, checkout_token)
);

ALTER TABLE abandoned_cart_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_reminders_tenant_isolation ON abandoned_cart_reminders
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_abandoned_cart_reminders_tenant_sent ON abandoned_cart_reminders (tenant_id, reminder_sent_at);
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  // App-specific styles
  const style = document.createElement('style');
  style.textContent = `
    .acr-tabs {
      display: flex;
      gap: var(--p-space-100);
      border-bottom: 1px solid var(--p-color-border);
      margin-bottom: var(--p-space-400);
    }
    .acr-tab {
      padding: var(--p-space-200) var(--p-space-400);
      cursor: pointer;
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text-secondary);
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      background: none;
      border-top: none;
      border-left: none;
      border-right: none;
      font-family: var(--p-font-family-sans);
    }
    .acr-tab.active {
      color: var(--p-color-text);
      border-bottom-color: #008060;
    }
    .acr-tab:hover:not(.active) {
      color: var(--p-color-text);
      background: var(--p-color-bg-surface-secondary);
      border-radius: var(--p-border-radius-100) var(--p-border-radius-100) 0 0;
    }
    .acr-panel { display: none; }
    .acr-panel.active { display: block; }
    .acr-form-row {
      display: flex;
      flex-direction: column;
      gap: var(--p-space-100);
      margin-bottom: var(--p-space-400);
    }
    .acr-label {
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text);
      font-family: var(--p-font-family-sans);
    }
    .acr-hint {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
    }
    .acr-input {
      padding: var(--p-space-200) var(--p-space-300);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      color: var(--p-color-text);
      background: var(--p-color-bg-surface);
      width: 100%;
      max-width: 200px;
      box-sizing: border-box;
    }
    .acr-input:focus {
      outline: 2px solid #008060;
      outline-offset: 1px;
      border-color: #008060;
    }
    .acr-form-actions {
      display: flex;
      gap: var(--p-space-200);
      align-items: center;
      padding-top: var(--p-space-200);
      border-top: 1px solid var(--p-color-border);
    }
    .acr-save-status {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
    }
    .acr-table-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--p-space-300);
      flex-wrap: wrap;
      gap: var(--p-space-200);
    }
    .acr-total-label {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
    }
    .acr-link {
      color: #008060;
      text-decoration: none;
      font-size: var(--p-font-size-300);
    }
    .acr-link:hover {
      text-decoration: underline;
    }
    .acr-email {
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
    }
    .acr-last-run {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
      margin-top: var(--p-space-100);
    }
    .acr-section-desc {
      font-size: var(--p-font-size-350);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
      margin-bottom: var(--p-space-400);
    }
    .acr-truncate {
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }
  `;
  container.appendChild(style);

  // Root structure
  container.innerHTML += `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Abandoned Cart Reminders</span>
        <button class="btn-secondary" id="acr-refresh-btn">Refresh</button>
      </div>

      <div class="acr-tabs">
        <button class="acr-tab active" data-tab="overview">Overview</button>
        <button class="acr-tab" data-tab="reminders">Reminders</button>
        <button class="acr-tab" data-tab="config">Configuration</button>
      </div>

      <!-- Overview Panel -->
      <div class="acr-panel active" id="acr-panel-overview">
        <div id="acr-stats-container"></div>
      </div>

      <!-- Reminders Panel -->
      <div class="acr-panel" id="acr-panel-reminders">
        <div class="shell-card">
          <div class="shell-section-title">Abandoned Cart Log</div>
          <p class="acr-section-desc">Recent abandoned carts tracked for this store. Showing up to 100 most recent.</p>
          <div id="acr-reminders-container"></div>
        </div>
      </div>

      <!-- Config Panel -->
      <div class="acr-panel" id="acr-panel-config">
        <div class="shell-card">
          <div class="shell-section-title">Reminder Settings</div>
          <p class="acr-section-desc">Configure how and when abandoned cart reminder emails are sent.</p>
          <div id="acr-config-container"></div>
        </div>
      </div>
    </div>
  `;

  // Tab switching
  const tabs = container.querySelectorAll('.acr-tab');
  const panels = container.querySelectorAll('.acr-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = 'acr-panel-' + tab.dataset.tab;
      const panel = container.querySelector('#' + panelId);
      if (panel) panel.classList.add('active');
    });
  });

  // Refresh button
  container.querySelector('#acr-refresh-btn').addEventListener('click', () => {
    loadStats();
    loadReminders();
  });

  // ---- Stats / Overview ----
  function loadStats() {
    const el = container.querySelector('#acr-stats-container');
    el.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;

    bridge.call('/stats').then(data => {
      const lastRun = data.lastRunAt
        ? new Date(data.lastRunAt).toLocaleString()
        : 'Never';

      el.innerHTML = `
        <div class="shell-stats-row">
          <div class="shell-stat-card">
            <div class="shell-stat-label">Total Abandoned Carts</div>
            <div class="shell-stat-value">${data.totalAbandoned}</div>
          </div>
          <div class="shell-stat-card">
            <div class="shell-stat-label">Reminders Sent</div>
            <div class="shell-stat-value">${data.totalRemindersSent}</div>
          </div>
          <div class="shell-stat-card">
            <div class="shell-stat-label">Pending Reminders</div>
            <div class="shell-stat-value">${data.pendingReminders}</div>
          </div>
        </div>
        <div class="acr-last-run">Last reminder sent at: <strong>${lastRun}</strong></div>
      `;
    }).catch(err => {
      el.innerHTML = `<div class="shell-error-banner">Failed to load stats. Please try again.</div>`;
    });
  }

  // ---- Reminders Table ----
  function loadReminders() {
    const el = container.querySelector('#acr-reminders-container');
    el.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;

    bridge.call('/reminders').then(data => {
      const rows = data.rows || [];
      const total = data.total || 0;

      if (rows.length === 0) {
        el.innerHTML = `<div class="shell-empty">No abandoned carts found for this store.</div>`;
        return;
      }

      let html = `
        <div class="acr-table-meta">
          <span class="acr-total-label">Showing ${rows.length} of ${total} total records</span>
        </div>
        <div class="shell-table-wrap">
          <table class="shell-table">
            <thead>
              <tr>
                <th>Customer Email</th>
                <th>Abandoned At</th>
                <th>Reminder Sent At</th>
                <th>Items</th>
                <th>Status</th>
                <th>Cart Link</th>
              </tr>
            </thead>
            <tbody>
      `;

      rows.forEach(row => {
        const abandonedAt = row.abandonedAt ? new Date(row.abandonedAt).toLocaleString() : '—';
        const reminderSentAt = row.reminderSentAt ? new Date(row.reminderSentAt).toLocaleString() : '—';
        const statusBadge = row.reminderSentAt
          ? `<span class="badge badge-success">Sent</span>`
          : `<span class="badge badge-warning">Pending</span>`;
        const cartLink = row.cartUrl
          ? `<a class="acr-link" href="${escapeHtml(row.cartUrl)}" target="_blank" rel="noopener">Recover Cart</a>`
          : '—';

        html += `
          <tr>
            <td><span class="acr-email acr-truncate">${escapeHtml(row.customerEmail || '—')}</span></td>
            <td>${abandonedAt}</td>
            <td>${reminderSentAt}</td>
            <td>${row.lineItemCount != null ? row.lineItemCount : '—'}</td>
            <td>${statusBadge}</td>
            <td>${cartLink}</td>
          </tr>
        `;
      });

      html += `</tbody></table></div>`;
      el.innerHTML = html;
    }).catch(err => {
      el.innerHTML = `<div class="shell-error-banner">Failed to load reminders. Please try again.</div>`;
    });
  }

  // ---- Config Form ----
  function loadConfig() {
    const el = container.querySelector('#acr-config-container');
    el.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;

    bridge.call('/config/get').then(data => {
      el.innerHTML = `
        <div class="acr-form-row">
          <label class="acr-label" for="acr-delay-minutes">Delay Before Sending Reminder (minutes)</label>
          <span class="acr-hint">How long after a cart is abandoned should the reminder email be sent? Minimum: 1 minute.</span>
          <input class="acr-input" type="number" id="acr-delay-minutes" min="1" value="${data.delayMinutes}" />
        </div>
        <div class="acr-form-row">
          <label class="acr-label" for="acr-max-reminders">Max Reminders per Cart</label>
          <span class="acr-hint">Maximum number of reminder emails to send per abandoned cart. Minimum: 1.</span>
          <input class="acr-input" type="number" id="acr-max-reminders" min="1" value="${data.maxReminders}" />
        </div>
        <div class="acr-form-actions">
          <button class="btn-primary" id="acr-save-btn">Save Settings</button>
          <span class="acr-save-status" id="acr-save-status"></span>
        </div>
      `;

      const saveBtn = container.querySelector('#acr-save-btn');
      const saveStatus = container.querySelector('#acr-save-status');

      saveBtn.addEventListener('click', () => {
        const delayInput = container.querySelector('#acr-delay-minutes');
        const maxInput = container.querySelector('#acr-max-reminders');

        const delayMinutes = parseInt(delayInput.value, 10);
        const maxReminders = parseInt(maxInput.value, 10);

        // Validate
        if (!delayMinutes || delayMinutes < 1) {
          bridge.notify('Delay must be at least 1 minute.', 'error');
          delayInput.focus();
          return;
        }
        if (!maxReminders || maxReminders < 1) {
          bridge.notify('Max reminders must be at least 1.', 'error');
          maxInput.focus();
          return;
        }

        saveBtn.disabled = true;
        saveStatus.textContent = 'Saving…';

        bridge.call('/config/save', { delayMinutes, maxReminders }).then(result => {
          if (result && result.saved) {
            saveStatus.textContent = 'Settings saved.';
            bridge.notify('Settings saved successfully.', 'success');
          } else {
            saveStatus.textContent = '';
            bridge.notify('Unexpected response from server.', 'error');
          }
        }).catch(err => {
          saveStatus.textContent = '';
          bridge.notify('Failed to save settings. Please try again.', 'error');
        }).finally(() => {
          saveBtn.disabled = false;
          setTimeout(() => { saveStatus.textContent = ''; }, 3000);
        });
      });

    }).catch(err => {
      el.innerHTML = `<div class="shell-error-banner">Failed to load configuration. Please try again.</div>`;
    });
  }

  // ---- Helpers ----
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- Initial load ----
  loadStats();
  loadReminders();
  loadConfig();
}
```


## Explanation

This app automatically finds customers who have started checkout but haven't completed their purchase, and sends them a friendly reminder email to come back and finish buying. You can set how long to wait before sending the reminder (the default is 1 hour of inactivity), and the app checks for abandoned carts every 6 hours around the clock. Each customer gets the reminder email only once per abandoned cart, so they won't be spammed with repeated messages. From your Shopify Admin dashboard, you can adjust the wait time before reminders go out and see a log of which carts have received reminders.
