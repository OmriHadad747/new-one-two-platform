window.__PLATFORM_CATALOG__ = [{"path": "/settings", "method": "GET"}, {"path": "/settings", "method": "POST"}, {"path": "/reminders", "method": "GET"}, {"path": "/reminders/log", "method": "GET"}, {"path": "/run", "method": "POST"}];
export function mount(container, bridge) {
  const PAGE_SIZE = 20;

  const style = document.createElement('style');
  style.textContent = `
    .ac-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--p-color-border); margin-bottom: var(--p-space-400); }
    .ac-tab { padding: var(--p-space-300) var(--p-space-500); cursor: pointer; font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); border-bottom: 2px solid transparent; margin-bottom: -1px; background: none; border-top: none; border-left: none; border-right: none; }
    .ac-tab.active { color: var(--p-color-text); border-bottom-color: var(--p-color-border-emphasis); }
    .ac-tab:hover:not(.active) { color: var(--p-color-text); background: var(--p-color-bg-surface-secondary); }
    .ac-toggle-wrap { display: flex; align-items: center; gap: var(--p-space-300); }
    .ac-toggle { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
    .ac-toggle input { opacity: 0; width: 0; height: 0; }
    .ac-toggle-slider { position: absolute; inset: 0; background: var(--p-color-border); border-radius: var(--p-border-radius-full); cursor: pointer; transition: background 0.2s; }
    .ac-toggle input:checked + .ac-toggle-slider { background: #008060; }
    .ac-toggle-slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: white; border-radius: 50%; transition: transform 0.2s; }
    .ac-toggle input:checked + .ac-toggle-slider::before { transform: translateX(20px); }
    .ac-filter-row { display: flex; gap: var(--p-space-300); flex-wrap: wrap; align-items: flex-end; margin-bottom: var(--p-space-400); }
    .ac-filter-row .shell-field { margin: 0; flex: 1; min-width: 140px; }
    .ac-filter-row .shell-input, .ac-filter-row .shell-select { min-width: 0; }
    .ac-settings-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--p-space-400); }
    @media (max-width: 600px) { .ac-settings-row { grid-template-columns: 1fr; } }
    .ac-actions-row { display: flex; gap: var(--p-space-300); justify-content: flex-end; margin-top: var(--p-space-400); }
    .ac-outcome-pill { display: inline-block; padding: 2px var(--p-space-200); border-radius: var(--p-border-radius-full); font-size: var(--p-font-size-300); font-weight: var(--p-font-weight-medium); }
    .ac-empty-state { text-align: center; padding: var(--p-space-1000) var(--p-space-400); color: var(--p-color-text-secondary); font-size: var(--p-font-size-350); }
    .ac-run-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--p-space-300); margin-bottom: var(--p-space-400); }
    .ac-run-info { font-size: var(--p-font-size-350); color: var(--p-color-text-secondary); }
    .ac-log-note { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-bottom: var(--p-space-300); }
  `;
  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <div class="shell-title">Abandoned Cart Reminders</div>
      </div>

      <div id="ac-banner-zone"></div>

      <div class="ac-tabs">
        <button class="ac-tab active" data-tab="log">Reminder Log</button>
        <button class="ac-tab" data-tab="carts">Abandoned Carts</button>
        <button class="ac-tab" data-tab="settings">Settings</button>
      </div>

      <div id="tab-log">
        <div class="shell-card">
          <div class="ac-run-row">
            <div class="ac-run-info">Reminders are swept every 30 minutes automatically.</div>
            <button class="btn-primary" id="btn-run">Run Sweep Now</button>
          </div>
          <div class="shell-section-title">Sent Reminder Log</div>
          <p class="ac-log-note">Shows all reminder email attempts — check outcome for details.</p>
          <div class="ac-filter-row" id="log-filters">
            <div class="shell-field">
              <label class="shell-label">From</label>
              <input class="shell-input" type="date" id="log-date-from" />
            </div>
            <div class="shell-field">
              <label class="shell-label">To</label>
              <input class="shell-input" type="date" id="log-date-to" />
            </div>
            <div style="display:flex;align-items:flex-end;gap:var(--p-space-200)">
              <button class="btn-secondary" id="btn-log-filter">Apply</button>
              <button class="btn-secondary" id="btn-log-reset">Reset</button>
            </div>
          </div>
          <div id="log-content"><div class="shell-loading"><span class="shell-spinner"></span> Loading…</div></div>
          <div class="shell-pagination" id="log-pagination" style="display:none">
            <span id="log-page-info" style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary)"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="log-prev">Previous</button>
              <button class="btn-secondary" id="log-next">Next</button>
            </div>
          </div>
        </div>
      </div>

      <div id="tab-carts" style="display:none">
        <div class="shell-card">
          <div class="shell-section-title">Abandoned Carts</div>
          <div class="ac-filter-row" id="carts-filters">
            <div class="shell-field">
              <label class="shell-label">Status</label>
              <select class="shell-select" id="carts-status">
                <option value="">All</option>
                <option value="pending">Pending</option>
                <option value="sent">Sent</option>
                <option value="recovered">Recovered</option>
                <option value="ineligible">Ineligible</option>
              </select>
            </div>
            <div class="shell-field">
              <label class="shell-label">From</label>
              <input class="shell-input" type="date" id="carts-date-from" />
            </div>
            <div class="shell-field">
              <label class="shell-label">To</label>
              <input class="shell-input" type="date" id="carts-date-to" />
            </div>
            <div style="display:flex;align-items:flex-end;gap:var(--p-space-200)">
              <button class="btn-secondary" id="btn-carts-filter">Apply</button>
              <button class="btn-secondary" id="btn-carts-reset">Reset</button>
            </div>
          </div>
          <div id="carts-content"><div class="shell-loading"><span class="shell-spinner"></span> Loading…</div></div>
          <div class="shell-pagination" id="carts-pagination" style="display:none">
            <span id="carts-page-info" style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary)"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="carts-prev">Previous</button>
              <button class="btn-secondary" id="carts-next">Next</button>
            </div>
          </div>
        </div>
      </div>

      <div id="tab-settings" style="display:none">
        <div class="shell-card">
          <div class="shell-section-title">Reminder Settings</div>
          <div id="settings-banner-zone"></div>
          <div id="settings-content"><div class="shell-loading"><span class="shell-spinner"></span> Loading…</div></div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(style);

  // State
  let logPage = 1;
  let logTotal = 0;
  let logDateFrom = '';
  let logDateTo = '';

  let cartsPage = 1;
  let cartsTotal = 0;
  let cartsStatus = '';
  let cartsDateFrom = '';
  let cartsDateTo = '';

  // Tab switching
  const tabs = container.querySelectorAll('.ac-tab');
  const tabPanels = { log: container.querySelector('#tab-log'), carts: container.querySelector('#tab-carts'), settings: container.querySelector('#tab-settings') };
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      Object.values(tabPanels).forEach(p => p.style.display = 'none');
      const which = tab.dataset.tab;
      tabPanels[which].style.display = '';
      if (which === 'settings') loadSettings();
      if (which === 'carts') { cartsPage = 1; loadCarts(); }
    });
  });

  // Helpers
  function formatCurrency(cents, currency) {
    const amount = cents / 100;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch {
      return `${currency} ${amount.toFixed(2)}`;
    }
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
    } catch { return iso; }
  }

  function outcomeBadge(outcome) {
    const map = {
      sent: 'badge-success',
      skipped_recovered: 'badge-warning',
      skipped_no_email: 'badge-neutral',
      failed: 'badge-error'
    };
    const cls = map[outcome] || 'badge-neutral';
    const labels = {
      sent: 'Sent',
      skipped_recovered: 'Skipped – Recovered',
      skipped_no_email: 'Skipped – No Email',
      failed: 'Failed'
    };
    return `<span class="badge ${cls}">${labels[outcome] || outcome}</span>`;
  }

  function statusBadge(status) {
    const map = { pending: 'badge-warning', sent: 'badge-success', recovered: 'badge-neutral', ineligible: 'badge-error' };
    const cls = map[status] || 'badge-neutral';
    const labels = { pending: 'Pending', sent: 'Sent', recovered: 'Recovered', ineligible: 'Ineligible' };
    return `<span class="badge ${cls}">${labels[status] || status}</span>`;
  }

  function showBanner(zone, message, type) {
    const el = container.querySelector(zone);
    if (!el) return;
    const cls = { success: 'shell-success-banner', error: 'shell-error-banner', info: 'shell-info-banner', warning: 'shell-warning-banner' }[type] || 'shell-info-banner';
    el.innerHTML = `<div class="${cls}">${message}</div>`;
  }

  function clearBanner(zone) {
    const el = container.querySelector(zone);
    if (el) el.innerHTML = '';
  }

  // Run sweep
  const btnRun = container.querySelector('#btn-run');
  btnRun.addEventListener('click', () => {
    btnRun.disabled = true;
    btnRun.textContent = 'Running…';
    clearBanner('#ac-banner-zone');
    bridge.call('/run', {}).then(res => {
      btnRun.disabled = false;
      btnRun.textContent = 'Run Sweep Now';
      showBanner('#ac-banner-zone', res.message || 'Sweep queued.', 'success');
      bridge.notify(res.message || 'Sweep queued.', 'success');
      logPage = 1;
      loadLog();
    }).catch(err => {
      btnRun.disabled = false;
      btnRun.textContent = 'Run Sweep Now';
      const msg = (err && err.message) ? err.message : 'Failed to run sweep.';
      showBanner('#ac-banner-zone', msg, 'error');
      bridge.notify(msg, 'error');
    });
  });

  // Log
  function loadLog() {
    const logContent = container.querySelector('#log-content');
    logContent.innerHTML = '<div class="shell-loading"><span class="shell-spinner"></span> Loading…</div>';
    const body = { page: logPage, page_size: PAGE_SIZE };
    if (logDateFrom) body.date_from = logDateFrom;
    if (logDateTo) body.date_to = logDateTo;
    bridge.call('/reminders/log', body).then(res => {
      logTotal = res.total;
      renderLog(res);
    }).catch(err => {
      const msg = (err && err.message) ? err.message : 'Could not load reminder log.';
      logContent.innerHTML = `<div class="shell-error-banner">${msg}</div>`;
    });
  }

  function renderLog(res) {
    const logContent = container.querySelector('#log-content');
    const pagination = container.querySelector('#log-pagination');
    const pageInfo = container.querySelector('#log-page-info');
    const prevBtn = container.querySelector('#log-prev');
    const nextBtn = container.querySelector('#log-next');

    if (!res.items || res.items.length === 0) {
      logContent.innerHTML = '<div class="ac-empty-state">No reminder log entries found.</div>';
      pagination.style.display = 'none';
      return;
    }

    let html = '<div class="shell-table-wrap"><table class="shell-table"><thead><tr><th>Customer</th><th>Email</th><th>Cart Value</th><th>Outcome</th><th>Sent At</th></tr></thead><tbody>';
    res.items.forEach(item => {
      const name = item.customer_display_name || '—';
      const value = formatCurrency(item.total_price_cents, item.currency);
      html += `<tr>
        <td>${name}</td>
        <td>${item.customer_email || '—'}</td>
        <td>${value}</td>
        <td>${outcomeBadge(item.outcome)}</td>
        <td>${formatDate(item.sent_at)}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    logContent.innerHTML = html;

    const totalPages = Math.ceil(res.total / PAGE_SIZE) || 1;
    pageInfo.textContent = `Page ${logPage} of ${totalPages} — ${res.total} total`;
    prevBtn.disabled = logPage <= 1;
    nextBtn.disabled = logPage >= totalPages;
    pagination.style.display = 'flex';
  }

  container.querySelector('#btn-log-filter').addEventListener('click', () => {
    logDateFrom = container.querySelector('#log-date-from').value;
    logDateTo = container.querySelector('#log-date-to').value;
    logPage = 1;
    loadLog();
  });

  container.querySelector('#btn-log-reset').addEventListener('click', () => {
    container.querySelector('#log-date-from').value = '';
    container.querySelector('#log-date-to').value = '';
    logDateFrom = '';
    logDateTo = '';
    logPage = 1;
    loadLog();
  });

  container.querySelector('#log-prev').addEventListener('click', () => {
    if (logPage > 1) { logPage--; loadLog(); }
  });
  container.querySelector('#log-next').addEventListener('click', () => {
    const totalPages = Math.ceil(logTotal / PAGE_SIZE) || 1;
    if (logPage < totalPages) { logPage++; loadLog(); }
  });

  // Carts
  function loadCarts() {
    const cartsContent = container.querySelector('#carts-content');
    cartsContent.innerHTML = '<div class="shell-loading"><span class="shell-spinner"></span> Loading…</div>';
    const body = { page: cartsPage, page_size: PAGE_SIZE };
    if (cartsStatus) body.status = cartsStatus;
    if (cartsDateFrom) body.date_from = cartsDateFrom;
    if (cartsDateTo) body.date_to = cartsDateTo;
    bridge.call('/reminders', body).then(res => {
      cartsTotal = res.total;
      renderCarts(res);
    }).catch(err => {
      const msg = (err && err.message) ? err.message : 'Could not load abandoned carts.';
      cartsContent.innerHTML = `<div class="shell-error-banner">${msg}</div>`;
    });
  }

  function renderCarts(res) {
    const cartsContent = container.querySelector('#carts-content');
    const pagination = container.querySelector('#carts-pagination');
    const pageInfo = container.querySelector('#carts-page-info');
    const prevBtn = container.querySelector('#carts-prev');
    const nextBtn = container.querySelector('#carts-next');

    if (!res.items || res.items.length === 0) {
      cartsContent.innerHTML = '<div class="ac-empty-state">No abandoned carts found.</div>';
      pagination.style.display = 'none';
      return;
    }

    let html = '<div class="shell-table-wrap"><table class="shell-table"><thead><tr><th>Customer</th><th>Email</th><th>Cart Value</th><th>Status</th><th>Last Activity</th><th>Reminder Sent</th></tr></thead><tbody>';
    res.items.forEach(item => {
      const name = item.customer_display_name || '—';
      const value = formatCurrency(item.total_price_cents, item.currency);
      html += `<tr>
        <td>${name}</td>
        <td>${item.customer_email || '—'}</td>
        <td>${value}</td>
        <td>${statusBadge(item.status)}</td>
        <td>${formatDate(item.last_activity_at)}</td>
        <td>${formatDate(item.reminder_sent_at)}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    cartsContent.innerHTML = html;

    const totalPages = Math.ceil(res.total / PAGE_SIZE) || 1;
    pageInfo.textContent = `Page ${cartsPage} of ${totalPages} — ${res.total} total`;
    prevBtn.disabled = cartsPage <= 1;
    nextBtn.disabled = cartsPage >= totalPages;
    pagination.style.display = 'flex';
  }

  container.querySelector('#btn-carts-filter').addEventListener('click', () => {
    cartsStatus = container.querySelector('#carts-status').value;
    cartsDateFrom = container.querySelector('#carts-date-from').value;
    cartsDateTo = container.querySelector('#carts-date-to').value;
    cartsPage = 1;
    loadCarts();
  });

  container.querySelector('#btn-carts-reset').addEventListener('click', () => {
    container.querySelector('#carts-status').value = '';
    container.querySelector('#carts-date-from').value = '';
    container.querySelector('#carts-date-to').value = '';
    cartsStatus = '';
    cartsDateFrom = '';
    cartsDateTo = '';
    cartsPage = 1;
    loadCarts();
  });

  container.querySelector('#carts-prev').addEventListener('click', () => {
    if (cartsPage > 1) { cartsPage--; loadCarts(); }
  });
  container.querySelector('#carts-next').addEventListener('click', () => {
    const totalPages = Math.ceil(cartsTotal / PAGE_SIZE) || 1;
    if (cartsPage < totalPages) { cartsPage++; loadCarts(); }
  });

  // Settings
  function loadSettings() {
    const settingsContent = container.querySelector('#settings-content');
    settingsContent.innerHTML = '<div class="shell-loading"><span class="shell-spinner"></span> Loading…</div>';
    clearBanner('#settings-banner-zone');
    bridge.call('/settings', {}).then(res => {
      renderSettings(res);
    }).catch(err => {
      const msg = (err && err.message) ? err.message : 'Could not load settings.';
      settingsContent.innerHTML = `<div class="shell-error-banner">${msg}</div>`;
    });
  }

  function renderSettings(data) {
    const settingsContent = container.querySelector('#settings-content');
    settingsContent.innerHTML = `
      <div class="ac-settings-row">
        <div class="shell-field">
          <label class="shell-label">Reminder Delay (hours)</label>
          <input class="shell-input" type="number" id="setting-delay" min="1" max="168" step="1" value="${data.delay_hours}" />
          <div class="shell-help">Reminders are sent this many hours after cart abandonment. Min 1, max 168 (7 days).</div>
        </div>
        <div class="shell-field">
          <label class="shell-label">Enable Reminders</label>
          <div class="ac-toggle-wrap">
            <label class="ac-toggle">
              <input type="checkbox" id="setting-enabled" ${data.is_enabled ? 'checked' : ''} />
              <span class="ac-toggle-slider"></span>
            </label>
            <span id="setting-enabled-label" style="font-size:var(--p-font-size-350);color:var(--p-color-text)">${data.is_enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div class="shell-help">When disabled, no reminder emails will be sent during sweeps.</div>
        </div>
      </div>
      ${data.updated_at ? `<div style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);margin-top:var(--p-space-300)">Last updated: ${formatDate(data.updated_at)}</div>` : ''}
      <div class="ac-actions-row">
        <button class="btn-primary" id="btn-save-settings">Save Settings</button>
      </div>
    `;

    const enabledCheckbox = container.querySelector('#setting-enabled');
    const enabledLabel = container.querySelector('#setting-enabled-label');
    enabledCheckbox.addEventListener('change', () => {
      enabledLabel.textContent = enabledCheckbox.checked ? 'Enabled' : 'Disabled';
    });

    container.querySelector('#btn-save-settings').addEventListener('click', () => {
      const btn = container.querySelector('#btn-save-settings');
      const delayInput = container.querySelector('#setting-delay');
      const delayVal = parseInt(delayInput.value, 10);
      clearBanner('#settings-banner-zone');

      if (isNaN(delayVal) || delayVal < 1 || delayVal > 168) {
        showBanner('#settings-banner-zone', 'Delay must be between 1 and 168 hours.', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Saving…';

      bridge.call('/settings', {
        delay_hours: delayVal,
        is_enabled: enabledCheckbox.checked
      }).then(res => {
        btn.disabled = false;
        btn.textContent = 'Save Settings';
        renderSettings(res);
        showBanner('#settings-banner-zone', 'Settings saved successfully.', 'success');
        bridge.notify('Settings saved.', 'success');
      }).catch(err => {
        btn.disabled = false;
        btn.textContent = 'Save Settings';
        const msg = (err && err.message) ? err.message : 'Could not save settings.';
        showBanner('#settings-banner-zone', msg, 'error');
        bridge.notify(msg, 'error');
      });
    });
  }

  // Initial load
  loadLog();
}