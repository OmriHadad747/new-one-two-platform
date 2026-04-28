window.__PLATFORM_CATALOG__ = [{"path": "/settings", "method": "GET"}, {"path": "/settings", "method": "POST"}, {"path": "/runs", "method": "GET"}, {"path": "/runs/items", "method": "GET"}, {"path": "/run", "method": "POST"}];
export function mount(container, bridge) {
  const PAGE_SIZE = 10;
  const ITEMS_PAGE_SIZE = 10;

  const style = document.createElement('style');
  style.textContent = `
    .oi-tabs { display: flex; gap: var(--p-space-200); border-bottom: 1px solid var(--p-color-border); margin-bottom: var(--p-space-400); }
    .oi-tab { padding: var(--p-space-200) var(--p-space-400); cursor: pointer; font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); border: none; background: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .oi-tab.active { color: var(--p-color-text); border-bottom-color: #008060; }
    .oi-stat-row { display: flex; gap: var(--p-space-300); flex-wrap: wrap; margin-bottom: var(--p-space-400); }
    .oi-stat { flex: 1; min-width: 120px; background: var(--p-color-bg-surface); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-400); text-align: center; }
    .oi-stat-val { font-size: var(--p-font-size-500); font-weight: var(--p-font-weight-bold); color: var(--p-color-text); }
    .oi-stat-lbl { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-top: var(--p-space-100); }
    .oi-run-actions { display: flex; align-items: center; gap: var(--p-space-300); margin-bottom: var(--p-space-400); }
    .oi-drill-btn { background: none; border: none; cursor: pointer; color: #008060; font-size: var(--p-font-size-350); text-decoration: underline; padding: 0; }
    .oi-back-btn { display: inline-flex; align-items: center; gap: var(--p-space-100); background: none; border: none; cursor: pointer; color: var(--p-color-text-secondary); font-size: var(--p-font-size-350); margin-bottom: var(--p-space-400); padding: 0; }
    .oi-back-btn:hover { color: var(--p-color-text); }
    .oi-section { margin-bottom: var(--p-space-600); }
    .oi-toggle-row { display: flex; align-items: center; gap: var(--p-space-300); margin-bottom: var(--p-space-400); }
    .oi-toggle { position: relative; width: 44px; height: 24px; }
    .oi-toggle input { opacity: 0; width: 0; height: 0; }
    .oi-toggle-slider { position: absolute; inset: 0; background: var(--p-color-border); border-radius: var(--p-border-radius-full); cursor: pointer; transition: background 0.2s; }
    .oi-toggle input:checked + .oi-toggle-slider { background: #008060; }
    .oi-toggle-slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: var(--p-color-bg-surface); border-radius: 50%; transition: transform 0.2s; }
    .oi-toggle input:checked + .oi-toggle-slider::before { transform: translateX(20px); }
    .oi-url-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
    .oi-settings-row { display: flex; gap: var(--p-space-400); flex-wrap: wrap; }
    .oi-settings-row .shell-field { flex: 1; min-width: 160px; }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Image Optimizer</span>
      </div>
      <div class="oi-tabs">
        <button class="oi-tab active" data-tab="dashboard">Dashboard</button>
        <button class="oi-tab" data-tab="log">Run Log</button>
        <button class="oi-tab" data-tab="settings">Settings</button>
      </div>
      <div id="oi-panel-dashboard"></div>
      <div id="oi-panel-log" style="display:none"></div>
      <div id="oi-panel-settings" style="display:none"></div>
    </div>
  `;
  container.appendChild(style);

  const tabDashboard = container.querySelector('[data-tab="dashboard"]');
  const tabLog = container.querySelector('[data-tab="log"]');
  const tabSettings = container.querySelector('[data-tab="settings"]');
  const panelDashboard = container.querySelector('#oi-panel-dashboard');
  const panelLog = container.querySelector('#oi-panel-log');
  const panelSettings = container.querySelector('#oi-panel-settings');

  let activeTab = 'dashboard';

  function switchTab(name) {
    activeTab = name;
    [tabDashboard, tabLog, tabSettings].forEach(t => t.classList.remove('active'));
    container.querySelector(`[data-tab="${name}"]`).classList.add('active');
    panelDashboard.style.display = name === 'dashboard' ? '' : 'none';
    panelLog.style.display = name === 'log' ? '' : 'none';
    panelSettings.style.display = name === 'settings' ? '' : 'none';
    if (name === 'dashboard') loadDashboard();
    if (name === 'log') loadRunLog(1);
    if (name === 'settings') loadSettings();
  }

  tabDashboard.addEventListener('click', () => switchTab('dashboard'));
  tabLog.addEventListener('click', () => switchTab('log'));
  tabSettings.addEventListener('click', () => switchTab('settings'));

  // ─── DASHBOARD ──────────────────────────────────────────────────────────────

  function outcomeColor(outcome) {
    if (outcome === 'succeeded') return 'badge-success';
    if (outcome === 'failed') return 'badge-error';
    if (outcome === 'skipped') return 'badge-warning';
    return 'badge-neutral';
  }

  function statusBadge(status) {
    if (status === 'completed') return 'badge-success';
    if (status === 'failed') return 'badge-error';
    if (status === 'in_progress') return 'badge-warning';
    return 'badge-neutral';
  }

  function fmtDate(str) {
    if (!str) return '—';
    const d = new Date(str);
    return d.toLocaleString();
  }

  async function loadDashboard() {
    panelDashboard.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';
    let runs;
    try {
      runs = await bridge.call('/runs', { page: 1, page_size: 1 });
    } catch (e) {
      panelDashboard.innerHTML = '<div class="shell-error-banner">Failed to load dashboard. Please try again.</div>';
      return;
    }

    const last = runs.items && runs.items[0];
    const hasLast = !!last;

    panelDashboard.innerHTML = '';

    const runActionsDiv = document.createElement('div');
    runActionsDiv.className = 'oi-run-actions';
    const runBtn = document.createElement('button');
    runBtn.className = 'btn-primary';
    runBtn.textContent = 'Run Now';
    const runStatus = document.createElement('span');
    runStatus.style.color = 'var(--p-color-text-secondary)';
    runStatus.style.fontSize = 'var(--p-font-size-350)';
    runActionsDiv.appendChild(runBtn);
    runActionsDiv.appendChild(runStatus);
    panelDashboard.appendChild(runActionsDiv);

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runStatus.textContent = 'Starting optimization run…';
      let result;
      try {
        result = await bridge.call('/run', {});
        bridge.notify('Optimization run started.', 'success');
        runStatus.textContent = `Run started (ID: ${result.run_id}). Status: ${result.status}`;
        loadDashboard();
      } catch (e) {
        runStatus.textContent = '';
        bridge.notify('Failed to start run. Please try again.', 'error');
        runBtn.disabled = false;
      }
    });

    if (hasLast) {
      const summaryTitle = document.createElement('div');
      summaryTitle.className = 'shell-section-title';
      summaryTitle.textContent = 'Last Run Summary';
      panelDashboard.appendChild(summaryTitle);

      const metaDiv = document.createElement('div');
      metaDiv.style.marginBottom = 'var(--p-space-300)';
      metaDiv.style.fontSize = 'var(--p-font-size-350)';
      metaDiv.style.color = 'var(--p-color-text-secondary)';
      const trig = last.trigger === 'manual' ? 'Manual' : 'Scheduled';
      metaDiv.innerHTML = `<span class="badge ${statusBadge(last.status)}">${last.status.replace('_', ' ')}</span>&nbsp; Triggered: <strong>${trig}</strong> &nbsp;|&nbsp; Started: <strong>${fmtDate(last.started_at)}</strong>${last.completed_at ? ` &nbsp;|&nbsp; Completed: <strong>${fmtDate(last.completed_at)}</strong>` : ''}`;
      panelDashboard.appendChild(metaDiv);

      const statRow = document.createElement('div');
      statRow.className = 'oi-stat-row';
      const stats = [
        { label: 'Total Images', val: last.total_images },
        { label: 'Succeeded', val: last.succeeded_count },
        { label: 'Skipped', val: last.skipped_count },
        { label: 'Failed', val: last.failed_count },
      ];
      stats.forEach(s => {
        const card = document.createElement('div');
        card.className = 'oi-stat';
        card.innerHTML = `<div class="oi-stat-val">${s.val}</div><div class="oi-stat-lbl">${s.label}</div>`;
        statRow.appendChild(card);
      });
      panelDashboard.appendChild(statRow);

      const viewLogBtn = document.createElement('button');
      viewLogBtn.className = 'btn-secondary';
      viewLogBtn.textContent = 'View Full Run Log';
      viewLogBtn.addEventListener('click', () => switchTab('log'));
      panelDashboard.appendChild(viewLogBtn);

    } else {
      const empty = document.createElement('div');
      empty.className = 'shell-empty';
      empty.textContent = 'No optimization runs yet. Click Run Now to start.';
      panelDashboard.appendChild(empty);
    }
  }

  // ─── RUN LOG ────────────────────────────────────────────────────────────────

  let logPage = 1;
  let logTotal = 0;
  let drillRunId = null;
  let drillPage = 1;
  let drillTotal = 0;

  async function loadRunLog(page) {
    logPage = page;
    drillRunId = null;
    panelLog.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';
    let data;
    try {
      data = await bridge.call('/runs', { page, page_size: PAGE_SIZE });
    } catch (e) {
      panelLog.innerHTML = '<div class="shell-error-banner">Failed to load run log. Please try again.</div>';
      return;
    }
    logTotal = data.total;
    renderRunLog(data.items);
  }

  function renderRunLog(items) {
    panelLog.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'shell-section-title';
    title.textContent = 'Optimization Runs';
    panelLog.appendChild(title);

    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'shell-empty';
      empty.textContent = 'No runs found.';
      panelLog.appendChild(empty);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'shell-table-wrap';
    const table = document.createElement('table');
    table.className = 'shell-table';
    table.innerHTML = `
      <thead><tr>
        <th>Started</th>
        <th>Trigger</th>
        <th>Status</th>
        <th>Total</th>
        <th>Succeeded</th>
        <th>Skipped</th>
        <th>Failed</th>
        <th>Details</th>
      </tr></thead>
    `;
    const tbody = document.createElement('tbody');
    items.forEach(run => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtDate(run.started_at)}</td>
        <td>${run.trigger === 'manual' ? 'Manual' : 'Scheduled'}</td>
        <td><span class="badge ${statusBadge(run.status)}">${run.status.replace('_', ' ')}</span></td>
        <td>${run.total_images}</td>
        <td>${run.succeeded_count}</td>
        <td>${run.skipped_count}</td>
        <td>${run.failed_count}</td>
        <td></td>
      `;
      const drillTd = tr.querySelector('td:last-child');
      const drillBtn = document.createElement('button');
      drillBtn.className = 'oi-drill-btn';
      drillBtn.textContent = 'View Images';
      drillBtn.addEventListener('click', () => loadDrilldown(run.id, 1));
      drillTd.appendChild(drillBtn);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    panelLog.appendChild(wrap);

    renderLogPagination();
  }

  function renderLogPagination() {
    const totalPages = Math.ceil(logTotal / PAGE_SIZE);
    if (totalPages <= 1) return;
    const pag = document.createElement('div');
    pag.className = 'shell-pagination';
    pag.innerHTML = `<span style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary)">Page ${logPage} of ${totalPages}</span>`;
    const btns = document.createElement('div');
    btns.className = 'shell-pagination-btns';
    const prev = document.createElement('button');
    prev.className = 'btn-secondary';
    prev.textContent = 'Previous';
    prev.disabled = logPage <= 1;
    prev.addEventListener('click', () => loadRunLog(logPage - 1));
    const next = document.createElement('button');
    next.className = 'btn-secondary';
    next.textContent = 'Next';
    next.disabled = logPage >= totalPages;
    next.addEventListener('click', () => loadRunLog(logPage + 1));
    btns.appendChild(prev);
    btns.appendChild(next);
    pag.appendChild(btns);
    panelLog.appendChild(pag);
  }

  async function loadDrilldown(runId, page) {
    drillRunId = runId;
    drillPage = page;
    panelLog.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';
    let data;
    try {
      data = await bridge.call('/runs/items', { run_id: runId, page, page_size: ITEMS_PAGE_SIZE });
    } catch (e) {
      panelLog.innerHTML = '<div class="shell-error-banner">Failed to load image details. Please try again.</div>';
      return;
    }
    drillTotal = data.total;
    renderDrilldown(data.items, runId);
  }

  function renderDrilldown(items, runId) {
    panelLog.innerHTML = '';

    const backBtn = document.createElement('button');
    backBtn.className = 'oi-back-btn';
    backBtn.innerHTML = '&#8592; Back to Run Log';
    backBtn.addEventListener('click', () => loadRunLog(logPage));
    panelLog.appendChild(backBtn);

    const title = document.createElement('div');
    title.className = 'shell-section-title';
    title.textContent = 'Image Results';
    panelLog.appendChild(title);

    const info = document.createElement('div');
    info.style.fontSize = 'var(--p-font-size-300)';
    info.style.color = 'var(--p-color-text-secondary)';
    info.style.marginBottom = 'var(--p-space-300)';
    info.textContent = `Run ID: ${runId} — ${drillTotal} image(s) total`;
    panelLog.appendChild(info);

    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'shell-empty';
      empty.textContent = 'No image results for this run.';
      panelLog.appendChild(empty);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'shell-table-wrap';
    const table = document.createElement('table');
    table.className = 'shell-table';
    table.innerHTML = `
      <thead><tr>
        <th>Product</th>
        <th>Source Size</th>
        <th>Outcome</th>
        <th>Reason / URL</th>
        <th>Processed</th>
      </tr></thead>
    `;
    const tbody = document.createElement('tbody');
    items.forEach(item => {
      const tr = document.createElement('tr');
      const dims = (item.source_width && item.source_height) ? `${item.source_width}×${item.source_height}` : '—';
      const reasonOrUrl = item.outcome === 'failed'
        ? (item.failure_reason || '—')
        : (item.optimized_url ? `<span class="oi-url-cell" title="${item.optimized_url}">${item.optimized_url}</span>` : '—');
      tr.innerHTML = `
        <td>${item.product_title || `Product #${item.product_id}`}</td>
        <td>${dims}</td>
        <td><span class="badge ${outcomeColor(item.outcome)}">${item.outcome}</span></td>
        <td>${reasonOrUrl}</td>
        <td>${fmtDate(item.processed_at)}</td>
      `;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    panelLog.appendChild(wrap);

    renderDrillPagination(runId);
  }

  function renderDrillPagination(runId) {
    const totalPages = Math.ceil(drillTotal / ITEMS_PAGE_SIZE);
    if (totalPages <= 1) return;
    const pag = document.createElement('div');
    pag.className = 'shell-pagination';
    pag.innerHTML = `<span style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary)">Page ${drillPage} of ${totalPages}</span>`;
    const btns = document.createElement('div');
    btns.className = 'shell-pagination-btns';
    const prev = document.createElement('button');
    prev.className = 'btn-secondary';
    prev.textContent = 'Previous';
    prev.disabled = drillPage <= 1;
    prev.addEventListener('click', () => loadDrilldown(runId, drillPage - 1));
    const next = document.createElement('button');
    next.className = 'btn-secondary';
    next.textContent = 'Next';
    next.disabled = drillPage >= totalPages;
    next.addEventListener('click', () => loadDrilldown(runId, drillPage + 1));
    btns.appendChild(prev);
    btns.appendChild(next);
    pag.appendChild(btns);
    panelLog.appendChild(pag);
  }

  // ─── SETTINGS ───────────────────────────────────────────────────────────────

  async function loadSettings() {
    panelSettings.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div></div>';
    let data;
    try {
      data = await bridge.call('/settings', {});
    } catch (e) {
      panelSettings.innerHTML = '<div class="shell-error-banner">Failed to load settings. Please try again.</div>';
      return;
    }
    renderSettings(data);
  }

  function renderSettings(data) {
    panelSettings.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'shell-section-title';
    title.textContent = 'Optimization Schedule';
    panelSettings.appendChild(title);

    const card = document.createElement('div');
    card.className = 'shell-card';

    // Enabled toggle
    const toggleRow = document.createElement('div');
    toggleRow.className = 'oi-toggle-row';
    const toggleLabel = document.createElement('label');
    toggleLabel.style.fontWeight = 'var(--p-font-weight-medium)';
    toggleLabel.style.fontSize = 'var(--p-font-size-350)';
    toggleLabel.textContent = 'Enable scheduled optimization';
    const toggleWrap = document.createElement('label');
    toggleWrap.className = 'oi-toggle';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = !!data.is_enabled;
    const toggleSlider = document.createElement('span');
    toggleSlider.className = 'oi-toggle-slider';
    toggleWrap.appendChild(toggleInput);
    toggleWrap.appendChild(toggleSlider);
    toggleRow.appendChild(toggleLabel);
    toggleRow.appendChild(toggleWrap);
    card.appendChild(toggleRow);

    // Frequency & time row
    const settingsRow = document.createElement('div');
    settingsRow.className = 'oi-settings-row';

    // Frequency
    const freqField = document.createElement('div');
    freqField.className = 'shell-field';
    const freqLabel = document.createElement('label');
    freqLabel.className = 'shell-label';
    freqLabel.textContent = 'How often';
    const freqSelect = document.createElement('select');
    freqSelect.className = 'shell-select';
    [
      { value: 'daily', label: 'Every day' },
      { value: 'weekly', label: 'Once a week' },
      { value: 'custom', label: 'Custom interval' },
    ].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (data.schedule_frequency === opt.value) o.selected = true;
      freqSelect.appendChild(o);
    });
    const freqHelp = document.createElement('div');
    freqHelp.className = 'shell-help';
    freqHelp.textContent = 'Choose how frequently the optimizer runs automatically.';
    freqField.appendChild(freqLabel);
    freqField.appendChild(freqSelect);
    freqField.appendChild(freqHelp);
    settingsRow.appendChild(freqField);

    // Time of day
    const hourField = document.createElement('div');
    hourField.className = 'shell-field';
    const hourLabel = document.createElement('label');
    hourLabel.className = 'shell-label';
    hourLabel.textContent = 'Time of day (UTC)';
    const hourSelect = document.createElement('select');
    hourSelect.className = 'shell-select';
    for (let h = 0; h < 24; h++) {
      const o = document.createElement('option');
      o.value = String(h);
      const ampm = h < 12 ? 'AM' : 'PM';
      const display = h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`;
      o.textContent = display;
      if (data.schedule_hour_utc === h) o.selected = true;
      hourSelect.appendChild(o);
    }
    const hourHelp = document.createElement('div');
    hourHelp.className = 'shell-help';
    hourHelp.textContent = 'The optimizer will start at this hour (UTC). Off-peak times reduce API contention.';
    hourField.appendChild(hourLabel);
    hourField.appendChild(hourSelect);
    hourField.appendChild(hourHelp);
    settingsRow.appendChild(hourField);

    // Day of week (shown only for weekly)
    const dowField = document.createElement('div');
    dowField.className = 'shell-field';
    const dowLabel = document.createElement('label');
    dowLabel.className = 'shell-label';
    dowLabel.textContent = 'Day of week';
    const dowSelect = document.createElement('select');
    dowSelect.className = 'shell-select';
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    dayNames.forEach((name, idx) => {
      const o = document.createElement('option');
      o.value = String(idx);
      o.textContent = name;
      if ((data.schedule_day_of_week ?? 1) === idx) o.selected = true;
      dowSelect.appendChild(o);
    });
    const dowHelp = document.createElement('div');
    dowHelp.className = 'shell-help';
    dowHelp.textContent = 'Which day the weekly optimization runs.';
    dowField.appendChild(dowLabel);
    dowField.appendChild(dowSelect);
    dowField.appendChild(dowHelp);
    dowField.style.display = data.schedule_frequency === 'weekly' ? '' : 'none';
    settingsRow.appendChild(dowField);

    freqSelect.addEventListener('change', () => {
      dowField.style.display = freqSelect.value === 'weekly' ? '' : 'none';
    });

    card.appendChild(settingsRow);

    // Info banner about rate limits
    const info = document.createElement('div');
    info.className = 'shell-info-banner';
    info.textContent = 'Note: Images already at or above 400×400 are skipped automatically. The optimizer respects Shopify API rate limits and processes images in efficient batches.';
    card.appendChild(info);

    // Save button
    const saveRow = document.createElement('div');
    saveRow.style.marginTop = 'var(--p-space-400)';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary';
    saveBtn.textContent = 'Save Settings';
    saveRow.appendChild(saveBtn);
    card.appendChild(saveRow);

    panelSettings.appendChild(card);

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      const body = {
        schedule_frequency: freqSelect.value,
        schedule_hour_utc: parseInt(hourSelect.value, 10),
        schedule_day_of_week: freqSelect.value === 'weekly' ? parseInt(dowSelect.value, 10) : null,
        is_enabled: toggleInput.checked,
      };
      try {
        const result = await bridge.call('/settings', body);
        if (result.ok) {
          bridge.notify('Settings saved.', 'success');
        } else {
          bridge.notify('Settings could not be saved.', 'error');
        }
      } catch (e) {
        bridge.notify('Failed to save settings. Please try again.', 'error');
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // ─── INIT ────────────────────────────────────────────────────────────────────

  loadDashboard();
}