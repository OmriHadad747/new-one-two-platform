# Feature Generator — Run Result

**Date:** 2026-04-06 21:03:15  
**Status:** ✅ SUCCESS  
**Total:** 117006ms  
**Prompt:** I'm losing a lot of sales from people who add stuff to their cart and just disappear. I want to automatically follow up with them by email after they've been gone for a while. Just something simple that reminds them what they left behind and brings them back to finish the purchase.

## Pipeline

| Agent       | Status | Time       |
|-------------|--------|------------|
| Product     | ✓      | 1620ms     |
| Architect   | ✓      | 31927ms    |
| CodeSpec    | ✓      | 31098ms    |
| Handler     | ✓      | 44732ms    |
| Migration   | ✓      | 44732ms    |
| Admin UI    | ✓      | 44732ms    |
| Validator   | ✓      | 2333ms     |
| Validation  | ✓      | 16ms       |
| Explanation | ✓      | 3280ms     |

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: [],
  cronSchedule: '0 */6 * * *',
  npmPackages: [],
  handler: async function(ctx) {
    try {
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        if (ctx.adminPath === '/run') {
          await ctx.db`
            INSERT INTO abandoned_cart_run_requests (id, tenant_id, requested_at)
            VALUES (gen_random_uuid(), ${ctx.tenantId}, NOW())
          `;
          ctx.logger.info({ tenantId: ctx.tenantId }, 'admin: on-demand run requested');
          return { accepted: true };
        }

        if (ctx.adminPath === '/stats') {
          const totalRow = await ctx.db`
            SELECT COUNT(*) AS total_sent FROM abandoned_cart_emails WHERE tenant_id = ${ctx.tenantId}
          `;
          const recentRow = await ctx.db`
            SELECT COUNT(*) AS sent_last_7_days FROM abandoned_cart_emails
            WHERE tenant_id = ${ctx.tenantId} AND sent_at >= NOW() - INTERVAL '7 days'
          `;
          const rows = await ctx.db`
            SELECT id, checkout_token, customer_email, sent_at, recovery_url
            FROM abandoned_cart_emails
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY sent_at DESC LIMIT 100
          `;
          return {
            totalSent: Number(totalRow[0].total_sent),
            sentLast7Days: Number(recentRow[0].sent_last_7_days),
            rows: rows.map(r => ({
              checkoutToken: r.checkout_token,
              customerEmail: r.customer_email,
              sentAt: r.sent_at,
              recoveryUrl: r.recovery_url
            }))
          };
        }

        if (ctx.adminPath === '/config/get') {
          const configRows = await ctx.db`
            SELECT delay_minutes, email_subject, email_body_template
            FROM abandoned_cart_config
            WHERE tenant_id = ${ctx.tenantId}
          `;
          if (configRows.length === 0) {
            return {
              delayMinutes: 60,
              emailSubject: 'You left something behind!',
              emailBodyTemplate: 'Hi {{firstName}}, you left items in your cart...'
            };
          }
          return {
            delayMinutes: configRows[0].delay_minutes,
            emailSubject: configRows[0].email_subject,
            emailBodyTemplate: configRows[0].email_body_template
          };
        }

        if (ctx.adminPath === '/config/save') {
          const { delayMinutes, emailBodyTemplate, emailSubject } = ctx.adminBody;
          await ctx.db`
            INSERT INTO abandoned_cart_config (tenant_id, delay_minutes, email_subject, email_body_template)
            VALUES (${ctx.tenantId}, ${delayMinutes}, ${emailSubject}, ${emailBodyTemplate})
            ON CONFLICT (tenant_id) DO UPDATE SET
              delay_minutes = EXCLUDED.delay_minutes,
              email_subject = EXCLUDED.email_subject,
              email_body_template = EXCLUDED.email_body_template
          `;
          ctx.logger.info({ tenantId: ctx.tenantId, delayMinutes }, 'admin: config saved');
          return { saved: true };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // Cron path
      ctx.logger.info({ trigger: ctx.trigger }, 'abandoned cart cron starting');

      // Step 1: Check for pending on-demand run request
      const pendingRequest = await ctx.db`
        SELECT id FROM abandoned_cart_run_requests
        WHERE tenant_id = ${ctx.tenantId} AND fulfilled_at IS NULL
        ORDER BY requested_at ASC LIMIT 1
      `;
      const runMode = pendingRequest.length > 0 ? 'on-demand' : 'scheduled';
      ctx.logger.info({ runMode }, 'run mode determined');

      // Step 3-5: Load config
      const configRows = await ctx.db`
        SELECT delay_minutes, email_subject, email_body_template
        FROM abandoned_cart_config
        WHERE tenant_id = ${ctx.tenantId}
      `;
      let delayMinutes, emailSubject, emailBodyTemplate;
      if (configRows.length === 0) {
        delayMinutes = 60;
        emailSubject = 'You left something behind!';
        emailBodyTemplate = 'Hi {{firstName}}, you left items in your cart...';
      } else {
        delayMinutes = configRows[0].delay_minutes;
        emailSubject = configRows[0].email_subject;
        emailBodyTemplate = configRows[0].email_body_template;
      }

      // Step 6: Compute cutoff time
      const cutoffTime = new Date(Date.now() - delayMinutes * 60 * 1000);

      // Steps 7-16: Paginate abandoned checkouts
      const allCheckouts = [];
      let sinceId = 0;
      while (true) {
        const { checkouts } = await ctx.shopify.get(
          `/checkouts.json?limit=250&since_id=${sinceId}`
        );
        if (!checkouts || checkouts.length === 0) break;

        const eligibleBatch = checkouts.filter(c =>
          c.completed_at === null &&
          c.email !== null &&
          c.email !== undefined &&
          c.email !== '' &&
          new Date(c.updated_at) < cutoffTime
        );
        allCheckouts.push(...eligibleBatch);

        sinceId = checkouts[checkouts.length - 1].id;
        if (checkouts.length < 250) break;
      }

      ctx.logger.info({ count: allCheckouts.length }, 'eligible checkouts found');

      // Step 17: Early exit if none
      if (allCheckouts.length === 0) {
        ctx.logger.info('no eligible checkouts — skipping to run-mode fulfillment');
        if (runMode === 'on-demand') {
          await ctx.db`
            UPDATE abandoned_cart_run_requests SET fulfilled_at = NOW()
            WHERE id = ${pendingRequest[0].id} AND tenant_id = ${ctx.tenantId}
          `;
        }
        return;
      }

      // Steps 18-21: Filter already-sent checkouts
      const checkoutTokens = allCheckouts.map(c => c.token);
      const alreadySentRows = await ctx.db`
        SELECT checkout_token FROM abandoned_cart_emails
        WHERE tenant_id = ${ctx.tenantId} AND checkout_token = ANY(${checkoutTokens})
      `;
      const alreadySentSet = new Set(alreadySentRows.map(r => r.checkout_token));
      const pendingCheckouts = allCheckouts.filter(c => !alreadySentSet.has(c.token));

      ctx.logger.info({ count: pendingCheckouts.length }, 'pending checkouts after dedup');

      // Step 22: Early exit if none pending
      if (pendingCheckouts.length === 0) {
        ctx.logger.info('all checkouts already emailed — skipping to run-mode fulfillment');
        if (runMode === 'on-demand') {
          await ctx.db`
            UPDATE abandoned_cart_run_requests SET fulfilled_at = NOW()
            WHERE id = ${pendingRequest[0].id} AND tenant_id = ${ctx.tenantId}
          `;
        }
        return;
      }

      // Steps 23-29: Fetch customer details for distinct customer IDs
      const distinctCustomerIds = [...new Set(
        pendingCheckouts
          .filter(c => c.customer_id !== null && c.customer_id !== undefined)
          .map(c => c.customer_id)
      )];

      const customerMap = new Map();
      for (const customerId of distinctCustomerIds) {
        try {
          const response = await ctx.shopify.graphql(
            `query GetCustomer($id: ID!) {
              customer(id: $id) {
                id
                firstName
                lastName
                email
              }
            }`,
            { id: `gid://shopify/Customer/${customerId}` }
          );
          if (response.customer !== null) {
            customerMap.set(String(customerId), {
              firstName: response.customer.firstName,
              lastName: response.customer.lastName,
              email: response.customer.email
            });
          }
        } catch (err) {
          ctx.logger.warn({ customerId, error: err.message }, 'failed to fetch customer');
        }
        await new Promise(r => setTimeout(r, 200));
      }

      // Steps 30-42: Send emails and record them
      let sentCount = 0;
      for (const checkout of pendingCheckouts) {
        try {
          const customerEmail = checkout.email;
          let firstName = 'there';
          const customerId = checkout.customer_id ?? null;
          if (customerId !== null && customerMap.has(String(customerId))) {
            firstName = customerMap.get(String(customerId)).firstName ?? 'there';
          }
          const recoveryUrl = checkout.abandoned_checkout_url;
          const lineItems = checkout.line_items || [];
          const personalizedBody = emailBodyTemplate.replace('{{firstName}}', firstName);

          // Idempotency guard — atomic insert
          const claimed = await ctx.db`
            INSERT INTO abandoned_cart_emails
              (id, tenant_id, checkout_token, customer_email, customer_id, sent_at, recovery_url)
            VALUES
              (gen_random_uuid(), ${ctx.tenantId}, ${checkout.token}, ${customerEmail}, ${customerId}, NOW(), ${recoveryUrl})
            ON CONFLICT (tenant_id, checkout_token) DO NOTHING
            RETURNING id
          `;

          if (claimed.length === 0) {
            ctx.logger.info({ checkoutToken: checkout.token }, 'already sent — skipping');
            continue;
          }

          await ctx.services.email.send({
            to: customerEmail,
            subject: emailSubject,
            body: personalizedBody,
            data: { recoveryUrl, lineItems, firstName }
          });

          sentCount++;
          await new Promise(r => setTimeout(r, 200));
        } catch (err) {
          ctx.logger.error({ checkoutToken: checkout.token, error: err.message }, 'failed to send email');
        }
      }

      ctx.logger.info({ sentCount }, 'abandoned cart emails sent');

      // Step 43: Fulfill on-demand request if applicable
      if (runMode === 'on-demand') {
        await ctx.db`
          UPDATE abandoned_cart_run_requests SET fulfilled_at = NOW()
          WHERE id = ${pendingRequest[0].id} AND tenant_id = ${ctx.tenantId}
        `;
        ctx.logger.info({ requestId: pendingRequest[0].id }, 'on-demand request fulfilled');
      }

    } catch (err) {
      ctx.logger.error({ error: err.message }, 'handler error');
      throw err;
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE abandoned_cart_config (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL UNIQUE,
  delay_minutes       INTEGER NOT NULL DEFAULT 60,
  email_subject       TEXT,
  email_body_template TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE abandoned_cart_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_config_tenant_isolation ON abandoned_cart_config
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE abandoned_cart_emails (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  checkout_token TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_id    BIGINT,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recovery_url   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_abandoned_cart_emails_tenant_token UNIQUE (tenant_id, checkout_token)
);

ALTER TABLE abandoned_cart_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_emails_tenant_isolation ON abandoned_cart_emails
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_abandoned_cart_emails_tenant_sent_at ON abandoned_cart_emails (tenant_id, sent_at DESC);

CREATE TABLE abandoned_cart_run_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fulfilled_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE abandoned_cart_run_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY abandoned_cart_run_requests_tenant_isolation ON abandoned_cart_run_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_abandoned_cart_run_requests_tenant_fulfilled ON abandoned_cart_run_requests (tenant_id, requested_at ASC) WHERE fulfilled_at IS NULL;
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  const style = document.createElement('style');
  style.textContent = `
    .ac-tabs {
      display: flex;
      gap: var(--p-space-100);
      border-bottom: 1px solid var(--p-color-border);
      margin-bottom: var(--p-space-400);
    }
    .ac-tab {
      padding: var(--p-space-200) var(--p-space-400);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text-secondary);
      margin-bottom: -1px;
    }
    .ac-tab.active {
      color: var(--p-color-text);
      border-bottom-color: #008060;
    }
    .ac-tab:hover:not(.active) {
      color: var(--p-color-text);
      background: var(--p-color-bg-fill);
      border-radius: var(--p-border-radius-100) var(--p-border-radius-100) 0 0;
    }
    .ac-panel { display: none; }
    .ac-panel.active { display: block; }
    .ac-form-row {
      display: flex;
      flex-direction: column;
      gap: var(--p-space-100);
      margin-bottom: var(--p-space-400);
    }
    .ac-form-row label {
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text);
    }
    .ac-form-row .ac-hint {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
    }
    .ac-input, .ac-textarea {
      padding: var(--p-space-200) var(--p-space-300);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      color: var(--p-color-text);
      background: var(--p-color-bg-surface);
      width: 100%;
      box-sizing: border-box;
    }
    .ac-input:focus, .ac-textarea:focus {
      outline: none;
      border-color: var(--p-color-border-emphasis);
      box-shadow: 0 0 0 2px rgba(0,128,96,0.2);
    }
    .ac-textarea {
      resize: vertical;
      min-height: 120px;
    }
    .ac-input-narrow {
      max-width: 160px;
    }
    .ac-run-card {
      display: flex;
      align-items: flex-start;
      gap: var(--p-space-400);
      flex-wrap: wrap;
    }
    .ac-run-desc {
      flex: 1;
      font-size: var(--p-font-size-350);
      color: var(--p-color-text-secondary);
      line-height: 1.5;
    }
    .ac-recovery-link {
      color: #008060;
      text-decoration: none;
      font-size: var(--p-font-size-300);
    }
    .ac-recovery-link:hover {
      text-decoration: underline;
    }
    .ac-table-email {
      font-weight: var(--p-font-weight-medium);
    }
    .ac-token {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      font-family: monospace;
    }
    .ac-save-row {
      display: flex;
      align-items: center;
      gap: var(--p-space-300);
    }
    .ac-pagination-info {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
    }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Abandoned Cart Reminders</span>
      </div>

      <div class="ac-tabs">
        <button class="ac-tab active" data-tab="stats">Email Log</button>
        <button class="ac-tab" data-tab="config">Configuration</button>
        <button class="ac-tab" data-tab="run">Manual Run</button>
      </div>

      <!-- STATS PANEL -->
      <div class="ac-panel active" id="ac-panel-stats">
        <div id="stats-content">
          <div class="shell-loading"><div class="shell-spinner"></div> Loading stats…</div>
        </div>
      </div>

      <!-- CONFIG PANEL -->
      <div class="ac-panel" id="ac-panel-config">
        <div id="config-content">
          <div class="shell-loading"><div class="shell-spinner"></div> Loading configuration…</div>
        </div>
      </div>

      <!-- RUN PANEL -->
      <div class="ac-panel" id="ac-panel-run">
        <div class="shell-card">
          <div class="shell-section-title">Trigger Manual Run</div>
          <div class="ac-run-card">
            <p class="ac-run-desc">
              Manually trigger the abandoned cart email job. The system will immediately check for
              eligible carts that have been inactive longer than your configured delay and send
              reminder emails to those customers.
            </p>
            <button class="btn-primary" id="run-btn">Run Now</button>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(style);

  // Tab switching
  const tabs = container.querySelectorAll('.ac-tab');
  const panels = container.querySelectorAll('.ac-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = 'ac-panel-' + tab.dataset.tab;
      container.getElementById
        ? container.getElementById(panelId)
        : container.querySelector('#' + panelId);
      const panel = container.querySelector('#' + panelId);
      if (panel) panel.classList.add('active');

      if (tab.dataset.tab === 'stats') loadStats();
      if (tab.dataset.tab === 'config') loadConfig();
    });
  });

  // ─── STATS ────────────────────────────────────────────────────────────────
  let statsPage = 0;
  const PAGE_SIZE = 50;
  let allRows = [];

  function loadStats() {
    const statsContent = container.querySelector('#stats-content');
    statsContent.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div> Loading stats…</div>';

    bridge.call('/stats').then(data => {
      allRows = data.rows || [];
      statsPage = 0;
      renderStats(statsContent, data.totalSent, data.sentLast7Days);
    }).catch(err => {
      statsContent.innerHTML = `<div class="shell-error-banner">Failed to load stats: ${err && err.message ? err.message : 'Unknown error'}</div>`;
    });
  }

  function renderStats(statsContent, totalSent, sentLast7Days) {
    const pageRows = allRows.slice(statsPage * PAGE_SIZE, (statsPage + 1) * PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE));

    statsContent.innerHTML = `
      <div class="shell-stats-row">
        <div class="shell-stat-card">
          <div class="shell-stat-label">Total Emails Sent</div>
          <div class="shell-stat-value">${totalSent}</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Sent (Last 7 Days)</div>
          <div class="shell-stat-value">${sentLast7Days}</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Total Records</div>
          <div class="shell-stat-value">${allRows.length}</div>
        </div>
      </div>

      <div class="shell-card" style="margin-top: var(--p-space-400);">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:var(--p-space-300);">
          <span class="shell-section-title" style="margin-bottom:0;">Email Log</span>
          <button class="btn-secondary" id="refresh-btn" style="font-size:var(--p-font-size-300);">↺ Refresh</button>
        </div>
        ${allRows.length === 0 ? '<div class="shell-empty">No abandoned cart emails have been sent yet.</div>' : `
        <div class="shell-table-wrap">
          <table class="shell-table">
            <thead>
              <tr>
                <th>Customer Email</th>
                <th>Checkout Token</th>
                <th>Sent At</th>
                <th>Recovery Link</th>
              </tr>
            </thead>
            <tbody>
              ${pageRows.map(row => `
                <tr>
                  <td class="ac-table-email">${escapeHtml(row.customerEmail)}</td>
                  <td><span class="ac-token">${escapeHtml(row.checkoutToken)}</span></td>
                  <td>${formatDate(row.sentAt)}</td>
                  <td>
                    ${row.recoveryUrl
                      ? `<a class="ac-recovery-link" href="${escapeHtml(row.recoveryUrl)}" target="_blank" rel="noopener">Open Cart ↗</a>`
                      : '<span style="color:var(--p-color-text-secondary)">—</span>'
                    }
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="shell-pagination">
          <span class="ac-pagination-info">Page ${statsPage + 1} of ${totalPages} (${allRows.length} records)</span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" id="prev-page" ${statsPage === 0 ? 'disabled' : ''}>← Prev</button>
            <button class="btn-secondary" id="next-page" ${statsPage >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
          </div>
        </div>
        `}
      </div>
    `;

    const refreshBtn = statsContent.querySelector('#refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadStats);

    const prevBtn = statsContent.querySelector('#prev-page');
    const nextBtn = statsContent.querySelector('#next-page');
    if (prevBtn) prevBtn.addEventListener('click', () => {
      if (statsPage > 0) {
        statsPage--;
        renderStats(statsContent, totalSent, sentLast7Days);
      }
    });
    if (nextBtn) nextBtn.addEventListener('click', () => {
      if (statsPage < totalPages - 1) {
        statsPage++;
        renderStats(statsContent, totalSent, sentLast7Days);
      }
    });
  }

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  function loadConfig() {
    const configContent = container.querySelector('#config-content');
    configContent.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div> Loading configuration…</div>';

    bridge.call('/config/get').then(config => {
      renderConfig(configContent, config);
    }).catch(err => {
      configContent.innerHTML = `<div class="shell-error-banner">Failed to load configuration: ${err && err.message ? err.message : 'Unknown error'}</div>`;
    });
  }

  function renderConfig(configContent, config) {
    configContent.innerHTML = `
      <div class="shell-card">
        <div class="shell-section-title">Email Settings</div>
        <div class="ac-form-row">
          <label for="delay-minutes">Delay Before Sending (minutes)</label>
          <span class="ac-hint">How long to wait after cart abandonment before sending the reminder email.</span>
          <input
            class="ac-input ac-input-narrow"
            type="number"
            id="delay-minutes"
            min="1"
            max="10080"
            value="${escapeHtml(String(config.delayMinutes))}"
          />
        </div>
        <div class="ac-form-row">
          <label for="email-subject">Email Subject</label>
          <input
            class="ac-input"
            type="text"
            id="email-subject"
            value="${escapeHtml(config.emailSubject)}"
            placeholder="e.g. You left something behind!"
          />
        </div>
        <div class="ac-form-row">
          <label for="email-body">Email Body Template</label>
          <span class="ac-hint">Use <code>{{firstName}}</code>, <code>{{cartUrl}}</code> as placeholders.</span>
          <textarea
            class="ac-textarea"
            id="email-body"
            placeholder="Hi {{firstName}}, you left items in your cart..."
          >${escapeHtml(config.emailBodyTemplate)}</textarea>
        </div>
        <div class="ac-save-row">
          <button class="btn-primary" id="save-config-btn">Save Configuration</button>
          <span id="save-status" style="font-size:var(--p-font-size-300); color:var(--p-color-text-secondary);"></span>
        </div>
      </div>
    `;

    const saveBtn = configContent.querySelector('#save-config-btn');
    const saveStatus = configContent.querySelector('#save-status');

    saveBtn.addEventListener('click', () => {
      const delayInput = configContent.querySelector('#delay-minutes');
      const subjectInput = configContent.querySelector('#email-subject');
      const bodyInput = configContent.querySelector('#email-body');

      const delayMinutes = parseInt(delayInput.value, 10);
      const emailSubject = subjectInput.value.trim();
      const emailBodyTemplate = bodyInput.value;

      if (isNaN(delayMinutes) || delayMinutes < 1) {
        bridge.notify('Delay must be at least 1 minute.', 'error');
        return;
      }
      if (!emailSubject) {
        bridge.notify('Email subject cannot be empty.', 'error');
        return;
      }
      if (!emailBodyTemplate.trim()) {
        bridge.notify('Email body cannot be empty.', 'error');
        return;
      }

      saveBtn.disabled = true;
      saveStatus.textContent = 'Saving…';

      bridge.call('/config/save', { delayMinutes, emailSubject, emailBodyTemplate }).then(result => {
        saveBtn.disabled = false;
        saveStatus.textContent = '';
        if (result && result.saved) {
          bridge.notify('Configuration saved successfully.', 'success');
        } else {
          bridge.notify('Save completed but no confirmation received.', 'info');
        }
      }).catch(err => {
        saveBtn.disabled = false;
        saveStatus.textContent = '';
        bridge.notify('Failed to save: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
      });
    });
  }

  // ─── RUN ──────────────────────────────────────────────────────────────────
  const runBtn = container.querySelector('#run-btn');
  runBtn.addEventListener('click', () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Running…';

    bridge.call('/run').then(result => {
      runBtn.disabled = false;
      runBtn.textContent = 'Run Now';
      if (result && result.accepted) {
        bridge.notify('Abandoned cart job has been triggered successfully.', 'success');
      } else {
        bridge.notify('Run request submitted.', 'info');
      }
    }).catch(err => {
      runBtn.disabled = false;
      runBtn.textContent = 'Run Now';
      bridge.notify('Failed to trigger run: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
    });
  });

  // ─── HELPERS ──────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(isoString) {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return isoString;
    }
  }

  // Initial load
  loadStats();
}
```


## Explanation

Your Shopify store can now automatically reach out to customers who've started checkout but haven't completed their purchase. Every 6 hours, the app checks for carts that have been abandoned longer than the time period you set (for example, 2 hours or 24 hours—you decide). When it finds one with a customer email address, it automatically sends them a friendly reminder email with a direct link back to their cart, along with what items they left behind.

You control everything from your Shopify Admin dashboard. You can set how long to wait before sending the first reminder, customize the email message, and choose whether to personalize it with the customer's name. The app keeps track of which carts have already received emails, so customers won't get spammed with repeated reminders. You can also manually trigger a send right away if you'd like, without waiting for the next automatic check.
