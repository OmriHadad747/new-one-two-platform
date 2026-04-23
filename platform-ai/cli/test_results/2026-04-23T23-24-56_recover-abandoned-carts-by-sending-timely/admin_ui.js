export function mount(container, bridge) {
  const PAGE_SIZE = 20;

  const style = document.createElement('style');
  style.textContent = `
    .acr-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--p-color-border); margin-bottom: var(--p-space-400); }
    .acr-tab { padding: var(--p-space-300) var(--p-space-400); cursor: pointer; font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); border-bottom: 2px solid transparent; margin-bottom: -1px; background: none; border-top: none; border-left: none; border-right: none; }
    .acr-tab.active { color: var(--p-color-text); border-bottom-color: var(--p-color-border-emphasis); }
    .acr-tab:hover:not(.active) { color: var(--p-color-text); background: var(--p-color-bg-surface-secondary); }
    .acr-toggle-row { display: flex; align-items: center; gap: var(--p-space-300); }
    .acr-toggle { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
    .acr-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .acr-toggle-slider { position: absolute; inset: 0; background: var(--p-color-border); border-radius: var(--p-border-radius-full); cursor: pointer; transition: background 0.2s; }
    .acr-toggle-slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform 0.2s; }
    .acr-toggle input:checked + .acr-toggle-slider { background: #008060; }
    .acr-toggle input:checked + .acr-toggle-slider::before { transform: translateX(20px); }
    .acr-field-row { display: flex; flex-direction: column; gap: var(--p-space-100); margin-bottom: var(--p-space-400); }
    .acr-label { font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text); }
    .acr-sublabel { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
    .acr-input { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); font-size: var(--p-font-size-350); color: var(--p-color-text); background: var(--p-color-bg-surface); width: 160px; }
    .acr-input:focus { outline: 2px solid var(--p-color-border-emphasis); outline-offset: 1px; border-color: var(--p-color-border-emphasis); }
    .acr-settings-actions { display: flex; align-items: center; gap: var(--p-space-300); margin-top: var(--p-space-400); flex-wrap: wrap; }
    .acr-divider { height: 1px; background: var(--p-color-border); margin: var(--p-space-400) 0; }
    .acr-status-row { display: flex; align-items: center; gap: var(--p-space-200); padding: var(--p-space-300) var(--p-space-400); background: var(--p-color-bg-surface-secondary); border-radius: var(--p-border-radius-100); font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
    .acr-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .acr-dot-green { background: #008060; }
    .acr-dot-gray { background: var(--p-color-border-emphasis); }
    .acr-table-meta { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-bottom: var(--p-space-300); }
    .acr-failed-reason { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .acr-info-banner { background: var(--p-color-bg-surface-secondary); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); padding: var(--p-space-300) var(--p-space-400); font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-bottom: var(--p-space-400); display: flex; gap: var(--p-space-200); align-items: flex-start; }
    .acr-tab-panels > .acr-panel { display: none; }
    .acr-tab-panels > .acr-panel.active { display: block; }
    .acr-filter-row { display: flex; gap: var(--p-space-200); margin-bottom: var(--p-space-300); flex-wrap: wrap; }
    .acr-filter-btn { padding: var(--p-space-100) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-full); font-size: var(--p-font-size-300); cursor: pointer; background: var(--p-color-bg-surface); color: var(--p-color-text-secondary); }
    .acr-filter-btn.active { background: var(--p-color-bg-fill); color: var(--p-color-text); border-color: var(--p-color-border-emphasis); font-weight: var(--p-font-weight-medium); }
    .acr-filter-btn:hover:not(.active) { background: var(--p-color-bg-surface-secondary); }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Abandoned Cart Recovery</span>
      </div>

      <div class="shell-card" id="acr-settings-card">
        <div class="shell-section-title">Recovery Settings</div>
        <div id="acr-settings-loading" class="shell-loading"><span class="shell-spinner"></span> Loading settings…</div>
        <div id="acr-settings-form" style="display:none;">
          <div class="acr-field-row">
            <div class="acr-toggle-row">
              <label class="acr-toggle">
                <input type="checkbox" id="acr-enabled-toggle">
                <span class="acr-toggle-slider"></span>
              </label>
              <div>
                <div class="acr-label">Enable abandoned cart emails</div>
                <div class="acr-sublabel">When enabled, reminder emails are sent automatically after the configured delay.</div>
              </div>
            </div>
          </div>
          <div class="acr-divider"></div>
          <div class="acr-field-row">
            <label class="acr-label" for="acr-delay-input">Abandonment delay (minutes)</label>
            <div class="acr-sublabel">How long after a cart is abandoned before sending a reminder. Minimum: 15 minutes.</div>
            <input type="number" id="acr-delay-input" class="acr-input" min="15" max="10080" placeholder="60">
          </div>
          <div class="acr-settings-actions">
            <button class="btn-primary" id="acr-save-btn">Save settings</button>
            <button class="btn-secondary" id="acr-run-btn">Run detection now</button>
          </div>
          <div id="acr-settings-error" class="shell-error-banner" style="display:none; margin-top:var(--p-space-300);"></div>
        </div>
      </div>

      <div class="shell-card">
        <div class="acr-info-banner">
          <span>ℹ️</span>
          <span>Open and click tracking are not available for platform transactional emails. The send log shows <strong>sent</strong> and <strong>failed</strong> delivery status only. Cart state is polled every 20 minutes via the Shopify Abandoned Checkouts API.</span>
        </div>
        <div class="acr-tabs" id="acr-tabs">
          <button class="acr-tab active" data-tab="send-log">Send Log</button>
          <button class="acr-tab" data-tab="queue">Recovery Queue</button>
        </div>
        <div class="acr-tab-panels">
          <div class="acr-panel active" id="panel-send-log">
            <div id="log-meta" class="acr-table-meta"></div>
            <div id="log-loading" class="shell-loading" style="display:none;"><span class="shell-spinner"></span> Loading…</div>
            <div id="log-error" class="shell-error-banner" style="display:none;"></div>
            <div id="log-empty" class="shell-empty" style="display:none;">No emails have been sent yet.</div>
            <div id="log-table-wrap" class="shell-table-wrap" style="display:none;">
              <table class="shell-table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Checkout ID</th>
                    <th>Cart Value</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th>Sent At</th>
                  </tr>
                </thead>
                <tbody id="log-tbody"></tbody>
              </table>
            </div>
            <div class="shell-pagination" id="log-pagination" style="display:none;">
              <span id="log-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);"></span>
              <div class="shell-pagination-btns">
                <button class="btn-secondary" id="log-prev-btn">← Prev</button>
                <button class="btn-secondary" id="log-next-btn">Next →</button>
              </div>
            </div>
          </div>

          <div class="acr-panel" id="panel-queue">
            <div class="acr-filter-row" id="queue-filters">
              <button class="acr-filter-btn active" data-status="">All</button>
              <button class="acr-filter-btn" data-status="pending">Pending</button>
              <button class="acr-filter-btn" data-status="sent">Sent</button>
              <button class="acr-filter-btn" data-status="failed">Failed</button>
              <button class="acr-filter-btn" data-status="converted">Converted</button>
              <button class="acr-filter-btn" data-status="skipped">Skipped</button>
            </div>
            <div id="queue-meta" class="acr-table-meta"></div>
            <div id="queue-loading" class="shell-loading" style="display:none;"><span class="shell-spinner"></span> Loading…</div>
            <div id="queue-error" class="shell-error-banner" style="display:none;"></div>
            <div id="queue-empty" class="shell-empty" style="display:none;">No items in the recovery queue.</div>
            <div id="queue-table-wrap" class="shell-table-wrap" style="display:none;">
              <table class="shell-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Checkout ID</th>
                    <th>Cart Value</th>
                    <th>Status</th>
                    <th>Abandoned At</th>
                    <th>Sent At</th>
                  </tr>
                </thead>
                <tbody id="queue-tbody"></tbody>
              </table>
            </div>
            <div class="shell-pagination" id="queue-pagination" style="display:none;">
              <span id="queue-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);"></span>
              <div class="shell-pagination-btns">
                <button class="btn-secondary" id="queue-prev-btn">← Prev</button>
                <button class="btn-secondary" id="queue-next-btn">Next →</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(style);

  // State
  let logPage = 1;
  let logTotal = 0;
  let queuePage = 1;
  let queueTotal = 0;
  let queueStatus = null;
  let activeTab = 'send-log';

  // Helpers
  function formatDate(str) {
    if (!str) return '—';
    try {
      return new Date(str).toLocaleString();
    } catch (e) {
      return str;
    }
  }

  function statusBadge(status) {
    const map = {
      sent: 'badge-success',
      failed: 'badge-error',
      pending: 'badge-warning',
      converted: 'badge-success',
      skipped: 'badge-neutral',
    };
    const cls = map[status] || 'badge-neutral';
    return `<span class="badge ${cls}">${status || '—'}</span>`;
  }

  function showEl(el) { el.style.display = ''; }
  function hideEl(el) { el.style.display = 'none'; }

  // Elements
  const settingsLoading = container.querySelector('#acr-settings-loading');
  const settingsForm = container.querySelector('#acr-settings-form');
  const enabledToggle = container.querySelector('#acr-enabled-toggle');
  const delayInput = container.querySelector('#acr-delay-input');
  const saveBtn = container.querySelector('#acr-save-btn');
  const runBtn = container.querySelector('#acr-run-btn');
  const settingsError = container.querySelector('#acr-settings-error');

  const logLoading = container.querySelector('#log-loading');
  const logError = container.querySelector('#log-error');
  const logEmpty = container.querySelector('#log-empty');
  const logTableWrap = container.querySelector('#log-table-wrap');
  const logTbody = container.querySelector('#log-tbody');
  const logPagination = container.querySelector('#log-pagination');
  const logPageInfo = container.querySelector('#log-page-info');
  const logPrevBtn = container.querySelector('#log-prev-btn');
  const logNextBtn = container.querySelector('#log-next-btn');
  const logMeta = container.querySelector('#log-meta');

  const queueLoading = container.querySelector('#queue-loading');
  const queueError = container.querySelector('#queue-error');
  const queueEmpty = container.querySelector('#queue-empty');
  const queueTableWrap = container.querySelector('#queue-table-wrap');
  const queueTbody = container.querySelector('#queue-tbody');
  const queuePagination = container.querySelector('#queue-pagination');
  const queuePageInfo = container.querySelector('#queue-page-info');
  const queuePrevBtn = container.querySelector('#queue-prev-btn');
  const queueNextBtn = container.querySelector('#queue-next-btn');
  const queueMeta = container.querySelector('#queue-meta');

  // Load settings
  function loadSettings() {
    showEl(settingsLoading);
    hideEl(settingsForm);
    hideEl(settingsError);

    bridge.call('/settings/get', {})
      .then(function(data) {
        hideEl(settingsLoading);
        showEl(settingsForm);
        enabledToggle.checked = !!data.is_enabled;
        delayInput.value = data.abandonment_delay_minutes || 60;
      })
      .catch(function(err) {
        hideEl(settingsLoading);
        showEl(settingsForm);
        settingsError.textContent = 'Failed to load settings: ' + (err && err.message ? err.message : 'Unknown error');
        showEl(settingsError);
      });
  }

  // Save settings
  saveBtn.addEventListener('click', function() {
    const delay = parseInt(delayInput.value, 10);
    if (isNaN(delay) || delay < 15) {
      settingsError.textContent = 'Abandonment delay must be at least 15 minutes.';
      showEl(settingsError);
      return;
    }
    hideEl(settingsError);
    saveBtn.disabled = true;

    bridge.call('/settings/save', {
      abandonment_delay_minutes: delay,
      is_enabled: enabledToggle.checked,
    })
      .then(function(data) {
        saveBtn.disabled = false;
        if (data.success) {
          bridge.notify('Settings saved successfully.', 'success');
        } else {
          bridge.notify('Save returned unsuccessful.', 'error');
        }
      })
      .catch(function(err) {
        saveBtn.disabled = false;
        settingsError.textContent = 'Failed to save settings: ' + (err && err.message ? err.message : 'Unknown error');
        showEl(settingsError);
        bridge.notify('Failed to save settings.', 'error');
      });
  });

  // Run detection
  runBtn.addEventListener('click', function() {
    runBtn.disabled = true;
    bridge.call('/run', {})
      .then(function(data) {
        runBtn.disabled = false;
        bridge.notify(data.message || 'Detection triggered.', data.triggered ? 'success' : 'info');
        if (activeTab === 'send-log') {
          logPage = 1;
          loadLog();
        } else {
          queuePage = 1;
          loadQueue();
        }
      })
      .catch(function(err) {
        runBtn.disabled = false;
        bridge.notify('Failed to trigger detection: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
      });
  });

  // Load send log
  function loadLog() {
    showEl(logLoading);
    hideEl(logError);
    hideEl(logEmpty);
    hideEl(logTableWrap);
    hideEl(logPagination);
    logMeta.textContent = '';

    bridge.call('/send-log/list', { page: logPage, page_size: PAGE_SIZE })
      .then(function(data) {
        hideEl(logLoading);
        logTotal = data.total || 0;
        const items = data.items || [];

        const totalPages = Math.ceil(logTotal / PAGE_SIZE) || 1;
        logMeta.textContent = logTotal + ' total email' + (logTotal !== 1 ? 's' : '') + ' sent';

        if (items.length === 0) {
          showEl(logEmpty);
          return;
        }

        logTbody.innerHTML = items.map(function(item) {
          return '<tr>' +
            '<td>' + (item.customer_email || '—') + '</td>' +
            '<td>' + (item.checkout_id || '—') + '</td>' +
            '<td>' + (item.cart_total_price || '—') + '</td>' +
            '<td>' + statusBadge(item.status) + '</td>' +
            '<td><span class="acr-failed-reason" title="' + (item.failed_reason || '') + '">' + (item.failed_reason || '—') + '</span></td>' +
            '<td>' + formatDate(item.sent_at) + '</td>' +
            '</tr>';
        }).join('');

        showEl(logTableWrap);

        logPageInfo.textContent = 'Page ' + logPage + ' of ' + totalPages;
        logPrevBtn.disabled = logPage <= 1;
        logNextBtn.disabled = logPage >= totalPages;
        showEl(logPagination);
      })
      .catch(function(err) {
        hideEl(logLoading);
        logError.textContent = 'Failed to load send log: ' + (err && err.message ? err.message : 'Unknown error');
        showEl(logError);
      });
  }

  logPrevBtn.addEventListener('click', function() {
    if (logPage > 1) {
      logPage--;
      loadLog();
    }
  });

  logNextBtn.addEventListener('click', function() {
    const totalPages = Math.ceil(logTotal / PAGE_SIZE) || 1;
    if (logPage < totalPages) {
      logPage++;
      loadLog();
    }
  });

  // Load queue
  function loadQueue() {
    showEl(queueLoading);
    hideEl(queueError);
    hideEl(queueEmpty);
    hideEl(queueTableWrap);
    hideEl(queuePagination);
    queueMeta.textContent = '';

    bridge.call('/queue/list', { page: queuePage, page_size: PAGE_SIZE, status: queueStatus })
      .then(function(data) {
        hideEl(queueLoading);
        queueTotal = data.total || 0;
        const items = data.items || [];
        const totalPages = Math.ceil(queueTotal / PAGE_SIZE) || 1;

        queueMeta.textContent = queueTotal + ' total item' + (queueTotal !== 1 ? 's' : '') + ' in queue';

        if (items.length === 0) {
          showEl(queueEmpty);
          return;
        }

        queueTbody.innerHTML = items.map(function(item) {
          const name = item.customer_first_name ? item.customer_first_name + ' &lt;' + item.customer_email + '&gt;' : (item.customer_email || '—');
          const price = item.cart_total_price ? item.cart_total_price + ' ' + (item.cart_currency || '') : '—';
          return '<tr>' +
            '<td>' + name + '</td>' +
            '<td>' + (item.checkout_id || '—') + '</td>' +
            '<td>' + price + '</td>' +
            '<td>' + statusBadge(item.status) + '</td>' +
            '<td>' + formatDate(item.abandoned_at) + '</td>' +
            '<td>' + formatDate(item.sent_at) + '</td>' +
            '</tr>';
        }).join('');

        showEl(queueTableWrap);
        queuePageInfo.textContent = 'Page ' + queuePage + ' of ' + totalPages;
        queuePrevBtn.disabled = queuePage <= 1;
        queueNextBtn.disabled = queuePage >= totalPages;
        showEl(queuePagination);
      })
      .catch(function(err) {
        hideEl(queueLoading);
        queueError.textContent = 'Failed to load queue: ' + (err && err.message ? err.message : 'Unknown error');
        showEl(queueError);
      });
  }

  queuePrevBtn.addEventListener('click', function() {
    if (queuePage > 1) {
      queuePage--;
      loadQueue();
    }
  });

  queueNextBtn.addEventListener('click', function() {
    const totalPages = Math.ceil(queueTotal / PAGE_SIZE) || 1;
    if (queuePage < totalPages) {
      queuePage++;
      loadQueue();
    }
  });

  // Queue filter
  const queueFilters = container.querySelector('#queue-filters');
  queueFilters.addEventListener('click', function(e) {
    const btn = e.target.closest('.acr-filter-btn');
    if (!btn) return;
    queueFilters.querySelectorAll('.acr-filter-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    queueStatus = btn.dataset.status || null;
    queuePage = 1;
    loadQueue();
  });

  // Tabs
  const tabsEl = container.querySelector('#acr-tabs');
  tabsEl.addEventListener('click', function(e) {
    const btn = e.target.closest('.acr-tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === activeTab) return;
    activeTab = tab;

    tabsEl.querySelectorAll('.acr-tab').forEach(function(t) { t.classList.remove('active'); });
    btn.classList.add('active');

    container.querySelectorAll('.acr-panel').forEach(function(p) { p.classList.remove('active'); });
    container.querySelector('#panel-' + tab).classList.add('active');

    if (tab === 'send-log') {
      logPage = 1;
      loadLog();
    } else if (tab === 'queue') {
      queuePage = 1;
      loadQueue();
    }
  });

  // Initial loads
  loadSettings();
  loadLog();
}