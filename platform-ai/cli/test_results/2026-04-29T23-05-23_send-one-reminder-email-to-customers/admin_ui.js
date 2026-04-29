window.__PLATFORM_CATALOG__ = [{"path": "/settings", "method": "GET"}, {"path": "/settings", "method": "POST"}, {"path": "/stats", "method": "GET"}, {"path": "/emails", "method": "GET"}, {"path": "/run", "method": "POST"}];
export function mount(container, bridge) {
  const PAGE_SIZE = 20;

  const style = document.createElement('style');
  style.textContent = `
    .acr-toggle-row {
      display: flex;
      align-items: center;
      gap: var(--p-space-300);
    }
    .acr-toggle {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
    }
    .acr-toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .acr-toggle-track {
      position: absolute;
      inset: 0;
      border-radius: var(--p-border-radius-full);
      background: var(--p-color-border);
      cursor: pointer;
      transition: background 0.2s;
    }
    .acr-toggle input:checked + .acr-toggle-track {
      background: #008060;
    }
    .acr-toggle-track::after {
      content: '';
      position: absolute;
      width: 18px;
      height: 18px;
      left: 3px;
      top: 3px;
      border-radius: var(--p-border-radius-full);
      background: var(--p-color-bg-surface);
      transition: transform 0.2s;
    }
    .acr-toggle input:checked + .acr-toggle-track::after {
      transform: translateX(20px);
    }
    .acr-toggle-label {
      font-size: var(--p-font-size-350);
      color: var(--p-color-text);
    }
    .acr-stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: var(--p-space-400);
      margin-bottom: var(--p-space-500);
    }
    .acr-email-masked {
      font-family: monospace;
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
    }
    .acr-filter-row {
      display: flex;
      align-items: center;
      gap: var(--p-space-300);
      flex-wrap: wrap;
    }
    .acr-currency {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
    }
    .acr-reason {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-critical);
      max-width: 200px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .acr-timestamp {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      white-space: nowrap;
    }
    .acr-run-section {
      display: flex;
      align-items: center;
      gap: var(--p-space-300);
      flex-wrap: wrap;
    }
    .acr-run-msg {
      font-size: var(--p-font-size-350);
      color: var(--p-color-text-secondary);
    }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <div class="shell-title">Abandoned Cart Reminder</div>
      </div>

      <div id="acr-banner-zone"></div>

      <div class="shell-card" style="margin-bottom: var(--p-space-500);">
        <div class="shell-section-title">Settings</div>
        <div id="settings-loading" class="shell-loading"><span class="shell-spinner"></span> Loading settings…</div>
        <div id="settings-form" style="display:none;">
          <div class="acr-toggle-row" style="margin-bottom: var(--p-space-400);">
            <label class="acr-toggle">
              <input type="checkbox" id="is-enabled" />
              <span class="acr-toggle-track"></span>
            </label>
            <span class="acr-toggle-label">Enable abandoned cart reminders</span>
          </div>
          <div class="shell-field" style="max-width: 320px;">
            <label class="shell-label" for="delay-minutes">Delay before sending reminder (minutes)</label>
            <input class="shell-input" type="number" id="delay-minutes" min="1" max="10080" step="1" />
            <div class="shell-help">Minimum 1 minute. Carts abandoned at least this long will receive one email.</div>
            <div class="shell-error" id="delay-error" style="display:none;"></div>
          </div>
          <div style="margin-top: var(--p-space-400);">
            <button class="btn-primary" id="save-settings-btn">Save Settings</button>
          </div>
          <div id="settings-updated-at" style="margin-top: var(--p-space-200); font-size: var(--p-font-size-300); color: var(--p-color-text-secondary);"></div>
        </div>
      </div>

      <div class="shell-card" style="margin-bottom: var(--p-space-500);">
        <div class="shell-section-title">Statistics</div>
        <div id="stats-loading" class="shell-loading"><span class="shell-spinner"></span> Loading stats…</div>
        <div id="stats-content" style="display:none;">
          <div class="acr-stats-grid">
            <div class="shell-stat-card">
              <div class="shell-stat-label">Sent Today</div>
              <div class="shell-stat-value" id="stat-sent-today">—</div>
            </div>
            <div class="shell-stat-card">
              <div class="shell-stat-label">All-Time Sent</div>
              <div class="shell-stat-value" id="stat-total-sent">—</div>
            </div>
            <div class="shell-stat-card">
              <div class="shell-stat-label">Total Failed</div>
              <div class="shell-stat-value" id="stat-total-failed">—</div>
            </div>
            <div class="shell-stat-card">
              <div class="shell-stat-label">Total Skipped</div>
              <div class="shell-stat-value" id="stat-total-skipped">—</div>
            </div>
          </div>
        </div>
      </div>

      <div class="shell-card" style="margin-bottom: var(--p-space-500);">
        <div class="shell-section-title">Manual Trigger</div>
        <div class="acr-run-section">
          <button class="btn-secondary" id="run-now-btn">Run Now</button>
          <span class="acr-run-msg" id="run-msg"></span>
        </div>
        <div class="shell-help" style="margin-top: var(--p-space-200);">Immediately process abandoned carts matching the current delay setting. The cron runs automatically; use this to test or force a run.</div>
      </div>

      <div class="shell-card">
        <div class="shell-section-title">Recent Email Log</div>
        <div class="acr-filter-row" style="margin-bottom: var(--p-space-400);">
          <div class="shell-field" style="margin-bottom: 0; min-width: 180px;">
            <label class="shell-label" for="status-filter">Filter by status</label>
            <select class="shell-select" id="status-filter">
              <option value="">All statuses</option>
              <option value="sent">Sent</option>
              <option value="failed">Failed</option>
              <option value="pending">Pending</option>
              <option value="skipped_no_email">Skipped – No Email</option>
              <option value="skipped_completed">Skipped – Completed</option>
            </select>
          </div>
        </div>
        <div id="log-loading" class="shell-loading" style="display:none;"><span class="shell-spinner"></span> Loading log…</div>
        <div id="log-error" class="shell-error-banner" style="display:none;"></div>
        <div id="log-empty" class="shell-empty" style="display:none;">No emails found.</div>
        <div id="log-table-wrap" class="shell-table-wrap" style="display:none;">
          <table class="shell-table">
            <thead>
              <tr>
                <th>Customer Email</th>
                <th>Cart Value</th>
                <th>Status</th>
                <th>Sent At</th>
                <th>Abandoned At</th>
                <th>Failure Reason</th>
              </tr>
            </thead>
            <tbody id="log-tbody"></tbody>
          </table>
        </div>
        <div class="shell-pagination" id="log-pagination" style="display:none;">
          <span id="pagination-info" style="font-size: var(--p-font-size-300); color: var(--p-color-text-secondary);"></span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" id="prev-btn">Previous</button>
            <button class="btn-secondary" id="next-btn">Next</button>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(style);

  let currentPage = 1;
  let currentTotal = 0;
  let currentStatus = '';

  function q(sel) {
    return container.querySelector(sel);
  }

  function showBanner(message, type) {
    const zone = q('#acr-banner-zone');
    const cls = type === 'success' ? 'shell-success-banner'
               : type === 'error' ? 'shell-error-banner'
               : type === 'warning' ? 'shell-warning-banner'
               : 'shell-info-banner';
    zone.innerHTML = `<div class="${cls}" style="margin-bottom: var(--p-space-400);">${message}</div>`;
  }

  function clearBanner() {
    q('#acr-banner-zone').innerHTML = '';
  }

  function maskEmail(email) {
    if (!email) return '—';
    const at = email.indexOf('@');
    if (at <= 0) return '***';
    const local = email.slice(0, at);
    const domain = email.slice(at);
    const visible = local.slice(0, Math.min(2, local.length));
    return visible + '***' + domain;
  }

  function formatCents(cents, currency) {
    if (cents == null) return '—';
    const amount = (cents / 100).toFixed(2);
    return `${amount} ${currency || ''}`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  function statusBadge(status) {
    const map = {
      sent: 'badge-success',
      failed: 'badge-error',
      pending: 'badge-warning',
      skipped_no_email: 'badge-neutral',
      skipped_completed: 'badge-neutral',
    };
    const cls = map[status] || 'badge-neutral';
    const label = {
      sent: 'Sent',
      failed: 'Failed',
      pending: 'Pending',
      skipped_no_email: 'Skipped – No Email',
      skipped_completed: 'Skipped – Completed',
    }[status] || status;
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function loadSettings() {
    q('#settings-loading').style.display = '';
    q('#settings-form').style.display = 'none';
    bridge.call('/settings', {}).then(function(data) {
      q('#settings-loading').style.display = 'none';
      q('#settings-form').style.display = '';
      q('#is-enabled').checked = !!data.is_enabled;
      q('#delay-minutes').value = data.delay_minutes || 60;
      if (data.updated_at) {
        q('#settings-updated-at').textContent = 'Last saved: ' + formatDate(data.updated_at);
      }
    }).catch(function(err) {
      q('#settings-loading').style.display = 'none';
      showBanner('Could not load settings. Please refresh.', 'error');
    });
  }

  function loadStats() {
    q('#stats-loading').style.display = '';
    q('#stats-content').style.display = 'none';
    bridge.call('/stats', {}).then(function(data) {
      q('#stats-loading').style.display = 'none';
      q('#stats-content').style.display = '';
      q('#stat-sent-today').textContent = data.sent_today != null ? data.sent_today : '—';
      q('#stat-total-sent').textContent = data.total_sent != null ? data.total_sent : '—';
      q('#stat-total-failed').textContent = data.total_failed != null ? data.total_failed : '—';
      q('#stat-total-skipped').textContent = data.total_skipped != null ? data.total_skipped : '—';
    }).catch(function(err) {
      q('#stats-loading').style.display = 'none';
      showBanner('Could not load statistics.', 'error');
    });
  }

  function loadLog(page, status) {
    q('#log-loading').style.display = '';
    q('#log-table-wrap').style.display = 'none';
    q('#log-empty').style.display = 'none';
    q('#log-error').style.display = 'none';
    q('#log-pagination').style.display = 'none';

    const body = { page: page, page_size: PAGE_SIZE };
    if (status) body.status = status;

    bridge.call('/emails', body).then(function(data) {
      q('#log-loading').style.display = 'none';
      const items = data.items || [];
      currentTotal = data.total || 0;

      if (items.length === 0) {
        q('#log-empty').style.display = '';
        return;
      }

      const tbody = q('#log-tbody');
      tbody.innerHTML = '';
      items.forEach(function(item) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span class="acr-email-masked">${maskEmail(item.customer_email)}</span></td>
          <td>${formatCents(item.cart_subtotal_cents, item.currency)}</td>
          <td>${statusBadge(item.status)}</td>
          <td class="acr-timestamp">${formatDate(item.email_sent_at)}</td>
          <td class="acr-timestamp">${formatDate(item.abandoned_at)}</td>
          <td>${item.failure_reason ? `<span class="acr-reason" title="${item.failure_reason}">${item.failure_reason}</span>` : '—'}</td>
        `;
        tbody.appendChild(tr);
      });

      q('#log-table-wrap').style.display = '';

      const totalPages = Math.ceil(currentTotal / PAGE_SIZE);
      if (totalPages > 1) {
        const start = (page - 1) * PAGE_SIZE + 1;
        const end = Math.min(page * PAGE_SIZE, currentTotal);
        q('#pagination-info').textContent = `Showing ${start}–${end} of ${currentTotal}`;
        q('#prev-btn').disabled = page <= 1;
        q('#next-btn').disabled = page >= totalPages;
        q('#log-pagination').style.display = '';
      }
    }).catch(function(err) {
      q('#log-loading').style.display = 'none';
      const errEl = q('#log-error');
      errEl.textContent = 'Could not load email log. Please try again.';
      errEl.style.display = '';
    });
  }

  q('#save-settings-btn').addEventListener('click', function() {
    clearBanner();
    const delayEl = q('#delay-minutes');
    const delayError = q('#delay-error');
    const delayVal = parseInt(delayEl.value, 10);

    delayError.style.display = 'none';
    delayError.textContent = '';

    if (!delayVal || delayVal < 1) {
      delayError.textContent = 'Delay must be at least 1 minute.';
      delayError.style.display = '';
      return;
    }
    if (delayVal > 10080) {
      delayError.textContent = 'Delay cannot exceed 10080 minutes (7 days).';
      delayError.style.display = '';
      return;
    }

    const btn = q('#save-settings-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    bridge.call('/settings', {
      delay_minutes: delayVal,
      is_enabled: q('#is-enabled').checked
    }).then(function(data) {
      btn.disabled = false;
      btn.textContent = 'Save Settings';
      if (data.updated_at) {
        q('#settings-updated-at').textContent = 'Last saved: ' + formatDate(data.updated_at);
      }
      bridge.notify('Settings saved successfully.', 'success');
    }).catch(function(err) {
      btn.disabled = false;
      btn.textContent = 'Save Settings';
      showBanner('Failed to save settings. Please try again.', 'error');
    });
  });

  q('#run-now-btn').addEventListener('click', function() {
    const btn = q('#run-now-btn');
    const msg = q('#run-msg');
    btn.disabled = true;
    msg.textContent = 'Running…';

    bridge.call('/run', {}).then(function(data) {
      btn.disabled = false;
      msg.textContent = data.message || (data.triggered ? 'Run triggered.' : 'Run completed.');
      loadStats();
      loadLog(1, currentStatus);
    }).catch(function(err) {
      btn.disabled = false;
      msg.textContent = '';
      showBanner('Failed to trigger run. Please try again.', 'error');
    });
  });

  q('#status-filter').addEventListener('change', function() {
    currentStatus = this.value;
    currentPage = 1;
    loadLog(currentPage, currentStatus);
  });

  q('#prev-btn').addEventListener('click', function() {
    if (currentPage > 1) {
      currentPage--;
      loadLog(currentPage, currentStatus);
    }
  });

  q('#next-btn').addEventListener('click', function() {
    const totalPages = Math.ceil(currentTotal / PAGE_SIZE);
    if (currentPage < totalPages) {
      currentPage++;
      loadLog(currentPage, currentStatus);
    }
  });

  loadSettings();
  loadStats();
  loadLog(currentPage, currentStatus);
}