window.__PLATFORM_CATALOG__ = [{"path": "/bundles", "method": "GET"}, {"path": "/bundles/create", "method": "POST"}, {"path": "/bundles/update", "method": "POST"}, {"path": "/bundles/remove", "method": "POST"}, {"path": "/bundles/clone", "method": "POST"}, {"path": "/bundles/bulk-status", "method": "POST"}, {"path": "/bundles/items", "method": "GET"}, {"path": "/bundles/items/save", "method": "POST"}, {"path": "/bundles/tiers", "method": "GET"}, {"path": "/bundles/tiers/save", "method": "POST"}, {"path": "/purchase-history", "method": "GET"}];
export function mount(container, bridge) {
  // ─── helpers ────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  const ZERO_DECIMAL_CURRENCIES = new Set(["BIF","CLP","DJF","GNF","JPY","KMF","KRW","MGA","PYG","RWF","UGX","UYI","VND","VUV","XAF","XOF","XPF"]);

  function minorToMajor(minor, currency) {
    const cur = (currency || bridge.context.currency || "").toUpperCase();
    if (ZERO_DECIMAL_CURRENCIES.has(cur)) return minor || 0;
    return (minor || 0) / 100;
  }

  const fmtMoney = (minor, currency) => {
    const cur = (currency || bridge.context.currency || "USD").toUpperCase();
    return new Intl.NumberFormat(bridge.context.locale, {
      style: "currency", currency: cur,
    }).format(minorToMajor(minor, cur));
  };

  const fmtInt = (n) => new Intl.NumberFormat(bridge.context.locale).format(n || 0);

  const fmtPct = (bps) =>
    new Intl.NumberFormat(bridge.context.locale, {
      style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format((bps || 0) / 10000);

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" :
      new Intl.DateTimeFormat(bridge.context.locale, { dateStyle: "medium" }).format(d);
  };

  function formatOrderTotal(minor, currency) {
    try {
      return fmtMoney(minor, currency);
    } catch (_) {
      return String(minor || 0);
    }
  }

  function region(key) {
    return container.querySelector(`[data-region="${key}"]`);
  }

  // ─── state ───────────────────────────────────────────────────────────────────
  let activeTab = "bundles";

  let rows = [], total = 0, page = 0;
  const PAGE_SIZE = 20;
  let statusFilter = "";
  let healthFilter = "";
  let loading = false;
  let selectedIds = new Set();

  let detailBundle = null;
  let detailItems = [], detailItemsTotal = 0, detailItemsPage = 0;
  let detailTiers = [];
  let tiersDirty = false;
  let itemsDirty = false;

  let phRows = [], phTotal = 0, phPage = 0;
  let phBundleFilter = "";
  let phDateFrom = "";
  let phDateTo = "";

  let modal = null;

  // ─── styles ──────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .ba-root { font-family: var(--p-font-family-sans); color: var(--p-color-text); }
    .ba-tabs { display: flex; gap: 0; border-bottom: 2px solid var(--p-color-border); margin-bottom: var(--p-space-400); }
    .ba-tab { padding: var(--p-space-200) var(--p-space-400); cursor: pointer; background: none; border: none; border-bottom: 3px solid transparent; margin-bottom: -2px; font-size: var(--p-font-size-350); color: var(--p-color-text-secondary); font-weight: var(--p-font-weight-medium); }
    .ba-tab.active { color: var(--p-color-text); border-bottom-color: #008060; }
    .ba-tab:hover:not(.active) { color: var(--p-color-text); background: var(--p-color-bg-surface-secondary); }
    .ba-health-alert { background: var(--p-color-bg-fill-warning); border: 1px solid var(--p-color-border-emphasis); border-radius: var(--p-border-radius-200); padding: var(--p-space-300) var(--p-space-400); margin-bottom: var(--p-space-400); }
    .ba-health-alert h3 { margin: 0 0 var(--p-space-200) 0; font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-semibold); }
    .ba-health-alert-row { display: flex; align-items: center; gap: var(--p-space-300); padding: var(--p-space-100) 0; border-bottom: 1px solid var(--p-color-border); }
    .ba-health-alert-row:last-child { border-bottom: none; }
    .ba-tier-row { display: flex; align-items: center; gap: var(--p-space-300); padding: var(--p-space-200) 0; border-bottom: 1px solid var(--p-color-border); }
    .ba-tier-row:last-child { border-bottom: none; }
    .ba-tier-input { width: 80px; }
    .ba-notice { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); padding: var(--p-space-200) var(--p-space-400); background: var(--p-color-bg-surface-secondary); border-radius: var(--p-border-radius-100); margin-bottom: var(--p-space-300); }
    .ba-detail-header { display: flex; align-items: center; gap: var(--p-space-300); margin-bottom: var(--p-space-400); flex-wrap: wrap; }
    .ba-back-btn { background: none; border: none; cursor: pointer; color: #008060; font-size: var(--p-font-size-350); padding: 0; }
    .ba-back-btn:hover { text-decoration: underline; }
    .ba-sub-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--p-color-border); margin-bottom: var(--p-space-400); }
    .ba-sub-tab { padding: var(--p-space-200) var(--p-space-300); cursor: pointer; background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; font-size: var(--p-font-size-350); color: var(--p-color-text-secondary); }
    .ba-sub-tab.active { color: var(--p-color-text); border-bottom-color: #008060; }
    .ba-filter-row { display: flex; gap: var(--p-space-300); flex-wrap: wrap; align-items: center; margin-bottom: var(--p-space-300); }
    .ba-export-btn { margin-left: auto; }
    .ba-availability-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--p-color-bg-fill-warning); }
    .ba-availability-dot.available { background: var(--p-color-bg-fill-success); }
    .ba-availability-dot.out_of_stock { background: var(--p-color-bg-fill-warning); }
    .ba-availability-dot.deleted { background: var(--p-color-bg-fill-critical); }
    .ba-desc { color: var(--p-color-text-secondary); font-size: var(--p-font-size-300); margin: 0 0 var(--p-space-400) 0; }
    .ba-select-bar { display: flex; align-items: center; gap: var(--p-space-300); padding: var(--p-space-200) var(--p-space-400); background: var(--p-color-bg-surface-secondary); border-radius: var(--p-border-radius-200); margin-bottom: var(--p-space-300); }
  `;
  container.appendChild(style);

  // ─── scaffold ────────────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "ba-root shell-root";
  root.innerHTML = `
    <div class="shell-header">
      <span class="shell-title">Bundle Manager</span>
      <button class="btn-primary" data-act="new-bundle">+ New Bundle</button>
    </div>
    <div class="ba-tabs">
      <button class="ba-tab active" data-tab="bundles">Bundles</button>
      <button class="ba-tab" data-tab="history">Purchase History</button>
    </div>
    <div data-region="tab-bundles">
      <div data-region="health-alerts"></div>
      <div data-region="select-bar"></div>
      <div class="shell-card">
        <div class="ba-filter-row" data-region="toolbar"></div>
        <div data-region="list"></div>
      </div>
    </div>
    <div data-region="tab-history" style="display:none">
      <div class="shell-card">
        <div class="ba-filter-row" data-region="ph-toolbar"></div>
        <div data-region="ph-list"></div>
      </div>
    </div>
    <div data-region="detail" style="display:none"></div>
  `;
  container.appendChild(root);

  // ─── tab switching ────────────────────────────────────────────────────────────
  root.querySelectorAll(".ba-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      root.querySelectorAll(".ba-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));
      region("tab-bundles").style.display = activeTab === "bundles" ? "" : "none";
      region("tab-history").style.display = activeTab === "history" ? "" : "none";
      if (activeTab === "history" && phRows.length === 0) loadPurchaseHistory();
    });
  });

  root.querySelector('[data-act="new-bundle"]').addEventListener("click", () => openCreateModal());

  // ─── badge helpers ────────────────────────────────────────────────────────────
  function healthBadge(h) {
    const map = { healthy: "badge-success", warned: "badge-warning", auto_disabled: "badge-error" };
    const label = { healthy: "Healthy", warned: "Warned", auto_disabled: "Auto-disabled" };
    return `<span class="badge ${map[h] || "badge-neutral"}">${esc(label[h] || h || "—")}</span>`;
  }

  function modeBadge(m) {
    return `<span class="badge badge-neutral">${esc(m || "—")}</span>`;
  }

  function availBadge(a) {
    if (!a) return `<span class="badge badge-neutral">—</span>`;
    const map = { available: "badge-success", out_of_stock: "badge-warning", deleted: "badge-error" };
    const label = { available: "Available", out_of_stock: "Out of stock", deleted: "Deleted" };
    return `<span class="badge ${map[a] || "badge-neutral"}">${esc(label[a] || a)}</span>`;
  }

  // ─── BUNDLES LIST ─────────────────────────────────────────────────────────────
  async function loadBundles() {
    loading = true;
    renderToolbar();
    renderSelectBar();
    renderList();
    try {
      const res = await bridge.call("/bundles", {
        status_filter: statusFilter || null,
        health_filter: healthFilter || null,
        page,
        page_size: PAGE_SIZE,
      });
      rows = res.items || [];
      total = res.total || 0;
    } catch (_) {
      bridge.notify("Could not load bundles", "error");
      rows = [];
      total = 0;
    } finally {
      loading = false;
      renderHealthAlerts();
      renderSelectBar();
      renderList();
    }
  }

  function renderHealthAlerts() {
    const alertRegion = region("health-alerts");
    const warned = rows.filter((r) => r.health_status === "warned" || r.health_status === "auto_disabled");
    if (warned.length === 0) { alertRegion.innerHTML = ""; return; }
    let html = `<div class="ba-health-alert"><h3>⚠ Bundle Health Issues (${warned.length})</h3>`;
    warned.forEach((r) => {
      html += `<div class="ba-health-alert-row">
        ${healthBadge(r.health_status)}
        <span><strong>${esc(r.title)}</strong></span>
        <span style="color:var(--p-color-text-secondary);font-size:var(--p-font-size-300)">${r.health_status === "auto_disabled" ? "Bundle auto-disabled due to unavailable variant" : "Variant availability warning"}</span>
        <button class="btn-secondary" style="margin-left:auto;padding:var(--p-space-100) var(--p-space-300)" data-act="open-detail" data-id="${esc(r.id)}">View Bundle</button>
      </div>`;
    });
    html += `</div>`;
    alertRegion.innerHTML = html;
    alertRegion.querySelectorAll('[data-act="open-detail"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const found = rows.find((r) => r.id === btn.dataset.id);
        if (found) openDetail(found);
      });
    });
  }

  function renderToolbar() {
    const tb = region("toolbar");
    tb.innerHTML = `
      <select class="shell-select" data-act="health-filter">
        <option value="">All health</option>
        <option value="healthy"${healthFilter === "healthy" ? " selected" : ""}>Healthy</option>
        <option value="warned"${healthFilter === "warned" ? " selected" : ""}>Warned</option>
        <option value="auto_disabled"${healthFilter === "auto_disabled" ? " selected" : ""}>Auto-disabled</option>
      </select>
      <select class="shell-select" data-act="status-filter">
        <option value="">All statuses</option>
        <option value="enabled"${statusFilter === "enabled" ? " selected" : ""}>Enabled</option>
        <option value="disabled"${statusFilter === "disabled" ? " selected" : ""}>Disabled</option>
      </select>
    `;
    tb.querySelector('[data-act="health-filter"]').addEventListener("change", (e) => {
      healthFilter = e.target.value;
      page = 0;
      selectedIds.clear();
      loadBundles();
    });
    tb.querySelector('[data-act="status-filter"]').addEventListener("change", (e) => {
      statusFilter = e.target.value;
      page = 0;
      selectedIds.clear();
      loadBundles();
    });
  }

  function renderSelectBar() {
    const bar = region("select-bar");
    if (selectedIds.size === 0) { bar.innerHTML = ""; return; }
    bar.innerHTML = `<div class="ba-select-bar">
      <span>${fmtInt(selectedIds.size)} of ${fmtInt(rows.length)} selected on this page</span>
      <button class="btn-primary" data-act="bulk-enable">Enable selected</button>
      <button class="btn-secondary" data-act="bulk-disable">Disable selected</button>
      <button class="btn-secondary" data-act="clear-sel">Clear selection</button>
    </div>`;
    bar.querySelector('[data-act="bulk-enable"]').addEventListener("click", () => runBulkStatus(true));
    bar.querySelector('[data-act="bulk-disable"]').addEventListener("click", () => runBulkStatus(false));
    bar.querySelector('[data-act="clear-sel"]').addEventListener("click", () => {
      selectedIds.clear();
      renderSelectBar();
      renderList();
    });
  }

  async function runBulkStatus(enabled) {
    const ids = [...selectedIds];
    try {
      const res = await bridge.call("/bundles/bulk-status", { bundle_ids: ids, enabled });
      bridge.notify(`Updated ${res.updated_count} bundle(s)${res.skipped_count > 0 ? `, ${res.skipped_count} skipped` : ""}`, "success");
      selectedIds.clear();
      await loadBundles();
    } catch (_) {
      bridge.notify("Could not update bundles", "error");
    }
  }

  function renderList() {
    const listRegion = region("list");
    if (loading && rows.length === 0) {
      listRegion.innerHTML = `<div class="shell-table-wrap"><table class="shell-table">
        <thead><tr><th style="width:32px"></th><th>Title</th><th>Mode</th><th>Status</th><th>Health</th><th>Tiers</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${Array(5).fill(`<tr><td colspan="8"><div class="shell-loading">&nbsp;</div></td></tr>`).join("")}</tbody>
      </table></div>`;
      return;
    }
    const isFiltered = statusFilter !== "" || healthFilter !== "";
    if (rows.length === 0) {
      if (isFiltered) {
        listRegion.innerHTML = `<div class="shell-empty"><p>No bundles match the current filters.</p><button class="btn-secondary" data-act="clear-filters">Clear filters</button></div>`;
        listRegion.querySelector('[data-act="clear-filters"]').addEventListener("click", () => {
          statusFilter = ""; healthFilter = ""; page = 0;
          renderToolbar(); loadBundles();
        });
      } else {
        listRegion.innerHTML = `<div class="shell-empty">
          <h2 class="shell-section-title">No bundles yet</h2>
          <p>Create your first bundle to offer customers tiered discounts on product combinations.</p>
          <button class="btn-primary" data-act="new">Create your first bundle</button>
        </div>`;
        listRegion.querySelector('[data-act="new"]').addEventListener("click", () => openCreateModal());
      }
      return;
    }

    const allChecked = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
    let html = `<div class="shell-table-wrap"><table class="shell-table">
      <thead><tr>
        <th style="width:32px"><input type="checkbox" data-act="select-all" ${allChecked ? "checked" : ""} aria-label="Select all"></th>
        <th>Title</th><th>Mode</th><th>Enabled</th><th>Health</th><th>Tiers</th><th>Created</th><th>Actions</th>
      </tr></thead>
      <tbody>`;
    rows.forEach((r) => {
      const checked = selectedIds.has(r.id);
      html += `<tr>
        <td><input type="checkbox" data-act="select-row" data-id="${esc(r.id)}" ${checked ? "checked" : ""} aria-label="Select ${esc(r.title)}"></td>
        <td><button class="ba-back-btn" data-act="open-detail" data-id="${esc(r.id)}">${esc(r.title)}</button></td>
        <td>${modeBadge(r.mode)}</td>
        <td>${r.enabled ? `<span class="badge badge-success">Enabled</span>` : `<span class="badge badge-neutral">Disabled</span>`}</td>
        <td>${healthBadge(r.health_status)}</td>
        <td>${fmtInt(r.tier_count)}</td>
        <td>${fmtDate(r.created_at)}</td>
        <td style="white-space:nowrap">
          <button class="btn-secondary" style="margin-right:var(--p-space-100)" data-act="open-detail" data-id="${esc(r.id)}">Edit</button>
          <button class="btn-secondary" style="margin-right:var(--p-space-100)" data-act="clone" data-id="${esc(r.id)}" title="Clone bundle">⧉</button>
          <button class="btn-danger" data-act="delete" data-id="${esc(r.id)}" title="Delete bundle">✕</button>
        </td>
      </tr>`;
    });
    html += `</tbody></table></div>`;

    const totalPages = Math.ceil(total / PAGE_SIZE);
    const start = page * PAGE_SIZE + 1;
    const end = Math.min(start + PAGE_SIZE - 1, total);
    html += `<nav class="shell-pagination" aria-label="Bundles pagination">
      <span style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)">Showing ${fmtInt(start)}–${fmtInt(end)} of ${fmtInt(total)}</span>
      <div class="shell-pagination-btns">
        <button class="btn-secondary" data-act="prev" ${page === 0 ? "disabled" : ""}>← Previous</button>
        <button class="btn-secondary" data-act="next" ${page >= totalPages - 1 ? "disabled" : ""}>Next →</button>
      </div>
    </nav>`;

    listRegion.innerHTML = html;

    listRegion.querySelector('[data-act="select-all"]').addEventListener("change", (e) => {
      if (e.target.checked) rows.forEach((r) => selectedIds.add(r.id));
      else rows.forEach((r) => selectedIds.delete(r.id));
      renderSelectBar();
      renderList();
    });
    listRegion.querySelectorAll('[data-act="select-row"]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        if (e.target.checked) selectedIds.add(e.target.dataset.id);
        else selectedIds.delete(e.target.dataset.id);
        renderSelectBar();
        renderList();
      });
    });
    listRegion.querySelectorAll('[data-act="open-detail"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const found = rows.find((r) => r.id === btn.dataset.id);
        if (found) openDetail(found);
      });
    });
    listRegion.querySelectorAll('[data-act="clone"]').forEach((btn) => {
      btn.addEventListener("click", () => cloneBundle(btn.dataset.id, btn));
    });
    listRegion.querySelectorAll('[data-act="delete"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const found = rows.find((r) => r.id === btn.dataset.id);
        if (found) confirmDelete(found);
      });
    });
    listRegion.querySelector('[data-act="prev"]')?.addEventListener("click", () => {
      if (page > 0) { page--; loadBundles(); }
    });
    listRegion.querySelector('[data-act="next"]')?.addEventListener("click", () => {
      if ((page + 1) * PAGE_SIZE < total) { page++; loadBundles(); }
    });
  }

  async function cloneBundle(bundleId, btn) {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "…";
    try {
      await bridge.call("/bundles/clone", { source_bundle_id: bundleId });
      bridge.notify("Bundle cloned", "success");
      await loadBundles();
    } catch (_) {
      bridge.notify("Could not clone bundle", "error");
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  // ─── DELETE CONFIRM ───────────────────────────────────────────────────────────
  function confirmDelete(record) {
    closeModal();
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "shell-confirm-overlay";
    overlay.innerHTML = `<div class="shell-confirm-dialog" role="dialog" aria-modal="true">
      <h2 class="shell-confirm-title">Delete "${esc(record.title)}"?</h2>
      <div class="shell-confirm-body shell-warning-banner">This cannot be undone. All tiers and item associations will be permanently removed.</div>
      <div class="shell-confirm-actions">
        <button class="btn-secondary" data-act="cancel">Cancel</button>
        <button class="btn-danger" data-act="confirm">Delete bundle</button>
      </div>
    </div>`;
    container.appendChild(overlay);
    const onKey = (e) => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", onKey);
    modal = { el: overlay, onKey, previouslyFocused };
    requestAnimationFrame(() => overlay.querySelector('[data-act="cancel"]').focus());
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
    overlay.querySelector('[data-act="confirm"]').addEventListener("click", async () => {
      const btn = overlay.querySelector('[data-act="confirm"]');
      btn.disabled = true; btn.textContent = "Deleting…";
      try {
        await bridge.call("/bundles/remove", { bundle_id: record.id });
        closeModal();
        bridge.notify("Bundle deleted", "success");
        if (rows.length === 1 && page > 0) page--;
        await loadBundles();
      } catch (_) {
        btn.disabled = false; btn.textContent = "Delete bundle";
        bridge.notify("Could not delete bundle", "error");
      }
    });
  }

  function closeModal() {
    if (!modal) return;
    document.removeEventListener("keydown", modal.onKey);
    modal.el.remove();
    modal.previouslyFocused?.focus?.();
    modal = null;
  }

  // ─── CREATE MODAL ─────────────────────────────────────────────────────────────
  function openCreateModal() {
    closeModal();
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "shell-confirm-overlay";
    overlay.innerHTML = `<div class="shell-confirm-dialog" role="dialog" aria-modal="true" style="max-width:480px;width:90vw">
      <h2 class="shell-confirm-title">New Bundle</h2>
      <div class="shell-confirm-body">
        <form data-form="create">
          <div class="shell-field">
            <label class="shell-label" for="bc-title">Bundle title <span aria-hidden="true">*</span></label>
            <input class="shell-input" id="bc-title" name="title" type="text" required placeholder="e.g. Starter Pack" />
          </div>
          <div class="shell-field">
            <label class="shell-label" for="bc-mode">Mode <span aria-hidden="true">*</span></label>
            <select class="shell-select" id="bc-mode" name="mode" required>
              <option value="fixed">Fixed — specific items required</option>
              <option value="flexible">Flexible — customer picks from pool</option>
            </select>
          </div>
          <div class="shell-field">
            <label class="shell-label" for="bc-desc">Description</label>
            <textarea class="shell-textarea" id="bc-desc" name="description" rows="2" placeholder="Optional description shown on storefront"></textarea>
          </div>
        </form>
      </div>
      <div class="shell-confirm-actions">
        <button class="btn-secondary" data-act="cancel">Cancel</button>
        <button class="btn-primary" data-act="save">Create bundle</button>
      </div>
    </div>`;
    container.appendChild(overlay);
    const form = overlay.querySelector("form");
    const onKey = (e) => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", onKey);
    modal = { el: overlay, onKey, previouslyFocused };
    requestAnimationFrame(() => form.querySelector("input").focus());
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
    overlay.querySelector('[data-act="save"]').addEventListener("click", async () => {
      if (!form.reportValidity()) return;
      const btn = overlay.querySelector('[data-act="save"]');
      btn.disabled = true; btn.textContent = "Creating…";
      const title = form.querySelector('[name="title"]').value.trim();
      const mode = form.querySelector('[name="mode"]').value;
      const description = form.querySelector('[name="description"]').value.trim() || null;
      try {
        const res = await bridge.call("/bundles/create", { title, mode, description });
        closeModal();
        bridge.notify("Bundle created", "success");
        await loadBundles();
        const newRow = rows.find((r) => r.id === res.bundle_id);
        if (newRow) openDetail(newRow);
      } catch (_) {
        btn.disabled = false; btn.textContent = "Create bundle";
        bridge.notify("Could not create bundle", "error");
      }
    });
  }

  // ─── BUNDLE DETAIL ────────────────────────────────────────────────────────────
  let detailSubTab = "settings";
  let detailTiersPage = 0;
  const DETAIL_PAGE_SIZE = 20;

  function openDetail(bundle) {
    detailBundle = bundle;
    detailSubTab = "settings";
    detailItems = [];
    detailItemsTotal = 0;
    detailItemsPage = 0;
    detailTiers = [];
    tiersDirty = false;
    itemsDirty = false;
    region("tab-bundles").style.display = "none";
    region("tab-history").style.display = "none";
    region("detail").style.display = "";
    renderDetail();
    loadDetailItems();
    loadDetailTiers();
  }

  function closeDetail() {
    region("detail").style.display = "none";
    region("tab-bundles").style.display = activeTab === "bundles" ? "" : "none";
    region("tab-history").style.display = activeTab === "history" ? "" : "none";
    detailBundle = null;
    loadBundles();
  }

  function renderDetail() {
    if (!detailBundle) return;
    const b = detailBundle;
    const dr = region("detail");
    dr.innerHTML = `
      <div class="ba-detail-header">
        <button class="ba-back-btn" data-act="back">← All Bundles</button>
        <span style="color:var(--p-color-border)">|</span>
        <span class="shell-title" data-region="detail-title">${esc(b.title)}</span>
        ${healthBadge(b.health_status)}
        ${modeBadge(b.mode)}
        ${b.enabled ? `<span class="badge badge-success">Enabled</span>` : `<span class="badge badge-neutral">Disabled</span>`}
      </div>
      ${b.health_status === "auto_disabled" ? `<div class="shell-error-banner">This bundle has been auto-disabled because one or more variants are unavailable or deleted. Fix the item pool to re-enable.</div>` : ""}
      ${b.health_status === "warned" ? `<div class="shell-warning-banner">One or more variants in this bundle have availability issues. Review the Items tab.</div>` : ""}
      <div class="ba-sub-tabs">
        <button class="ba-sub-tab${detailSubTab === "settings" ? " active" : ""}" data-sub="settings">Settings</button>
        <button class="ba-sub-tab${detailSubTab === "items" ? " active" : ""}" data-sub="items">Items</button>
        <button class="ba-sub-tab${detailSubTab === "tiers" ? " active" : ""}" data-sub="tiers">Discount Tiers</button>
      </div>
      <div data-region="detail-sub"></div>
    `;
    dr.querySelector('[data-act="back"]').addEventListener("click", closeDetail);
    dr.querySelectorAll(".ba-sub-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        detailSubTab = btn.dataset.sub;
        dr.querySelectorAll(".ba-sub-tab").forEach((b2) => b2.classList.toggle("active", b2.dataset.sub === detailSubTab));
        renderDetailSub();
      });
    });
    renderDetailSub();
  }

  function renderDetailSub() {
    if (detailSubTab === "settings") renderDetailSettings();
    else if (detailSubTab === "items") renderDetailItems();
    else if (detailSubTab === "tiers") renderDetailTiers();
  }

  // ── settings sub-tab ──────────────────────────────────────────────────────────
  let settingsDirty = false;

  function renderDetailSettings() {
    const b = detailBundle;
    settingsDirty = false;
    region("detail-sub").innerHTML = `
      <div class="shell-card">
        <div class="ba-notice">Tip: Ensure matching Shopify discount rules exist for each discount rate tier you configure. Mismatched or missing discount codes will not reduce prices at checkout.</div>
        <form data-form="settings">
          <div class="shell-field">
            <label class="shell-label" for="ds-title">Bundle title</label>
            <input class="shell-input" id="ds-title" name="title" type="text" value="${esc(b.title)}" required />
          </div>
          <div class="shell-field">
            <label class="shell-label" for="ds-mode">Mode</label>
            <select class="shell-select" id="ds-mode" name="mode">
              <option value="fixed"${b.mode === "fixed" ? " selected" : ""}>Fixed — specific items required</option>
              <option value="flexible"${b.mode === "flexible" ? " selected" : ""}>Flexible — customer picks from pool</option>
            </select>
          </div>
          <div class="shell-field">
            <label class="shell-label" for="ds-enabled">Status</label>
            <select class="shell-select" id="ds-enabled" name="enabled">
              <option value="true"${b.enabled ? " selected" : ""}>Enabled</option>
              <option value="false"${!b.enabled ? " selected" : ""}>Disabled</option>
            </select>
          </div>
          <div class="shell-field">
            <label class="shell-label" for="ds-desc">Description</label>
            <textarea class="shell-textarea" id="ds-desc" name="description" rows="3">${esc(b.description || "")}</textarea>
            <div class="shell-help">Displayed on the storefront product page.</div>
          </div>
        </form>
        <div style="display:flex;gap:var(--p-space-200);margin-top:var(--p-space-400)">
          <button class="btn-primary" data-act="save-settings">Save settings</button>
          <button class="btn-secondary" data-act="discard-settings">Discard</button>
        </div>
      </div>
    `;
    const form = region("detail-sub").querySelector("form");
    const markDirty = () => { settingsDirty = true; bridge.saveBar.show("bundle-settings"); };
    form.querySelectorAll("input, select, textarea").forEach((el) => el.addEventListener("input", markDirty));

    region("detail-sub").querySelector('[data-act="save-settings"]').addEventListener("click", async () => {
      if (!form.reportValidity()) return;
      const btn = region("detail-sub").querySelector('[data-act="save-settings"]');
      btn.disabled = true; btn.textContent = "Saving…";
      const payload = { bundle_id: detailBundle.id };
      const newTitle = form.querySelector('[name="title"]').value.trim();
      const newMode = form.querySelector('[name="mode"]').value;
      const newEnabled = form.querySelector('[name="enabled"]').value === "true";
      const newDesc = form.querySelector('[name="description"]').value.trim();
      if (newTitle !== detailBundle.title) payload.title = newTitle;
      if (newMode !== detailBundle.mode) payload.mode = newMode;
      if (newEnabled !== detailBundle.enabled) payload.enabled = newEnabled;
      if (newDesc !== (detailBundle.description || "")) {
        payload.description = newDesc === "" ? null : newDesc;
      }
      try {
        await bridge.call("/bundles/update", payload);
        if (payload.title !== undefined) detailBundle.title = payload.title;
        if (payload.mode !== undefined) detailBundle.mode = payload.mode;
        if (payload.enabled !== undefined) detailBundle.enabled = payload.enabled;
        if (payload.description !== undefined) detailBundle.description = payload.description;
        bridge.saveBar.hide("bundle-settings");
        bridge.notify("Settings saved", "success");
        settingsDirty = false;
        renderDetail();
        renderDetailSettings();
      } catch (_) {
        btn.disabled = false; btn.textContent = "Save settings";
        bridge.notify("Could not save settings", "error");
      }
    });

    region("detail-sub").querySelector('[data-act="discard-settings"]').addEventListener("click", () => {
      bridge.saveBar.hide("bundle-settings");
      settingsDirty = false;
      renderDetailSettings();
    });
  }

  // ── items sub-tab ─────────────────────────────────────────────────────────────
  async function loadDetailItems() {
    try {
      const res = await bridge.call("/bundles/items", {
        bundle_id: detailBundle.id,
        page: detailItemsPage,
        page_size: DETAIL_PAGE_SIZE,
      });
      detailItems = res.items || [];
      detailItemsTotal = res.total || 0;
      if (detailSubTab === "items") renderDetailItems();
    } catch (_) {
      bridge.notify("Could not load bundle items", "error");
    }
  }

  function renderDetailItems() {
    const sub = region("detail-sub");
    if (!sub) return;

    const hasUnavailable = detailItems.some(
      (i) => i.observed_availability === "out_of_stock" || i.observed_availability === "deleted",
    );

    let html = `<div class="shell-card">
      ${hasUnavailable ? `<div class="shell-warning-banner">Some variants in this bundle are out of stock or deleted. These prevent the bundle from operating correctly.</div>` : ""}
      <div class="ba-notice">Select products below. All variants of selected products will be added to the bundle's item pool. Individual variant availability is tracked automatically.</div>
      <div style="display:flex;gap:var(--p-space-200);margin-bottom:var(--p-space-300)">
        <button class="btn-primary" data-act="pick-products">Add products</button>
      </div>`;

    if (detailItems.length === 0) {
      html += `<div class="shell-empty"><p>No items added yet. Click "Add products" to build the item pool.</p></div>`;
    } else {
      html += `<div class="shell-table-wrap"><table class="shell-table">
        <thead><tr><th>Variant ID</th><th>Product ID</th><th>Availability</th><th>Added</th></tr></thead>
        <tbody>`;
      detailItems.forEach((item) => {
        html += `<tr>
          <td>${esc(item.variant_external_id || "—")}</td>
          <td>${esc(item.product_external_id || "—")}</td>
          <td>${availBadge(item.observed_availability)}</td>
          <td>${fmtDate(item.added_at)}</td>
        </tr>`;
      });
      html += `</tbody></table></div>`;

      const totalPages = Math.ceil(detailItemsTotal / DETAIL_PAGE_SIZE);
      const start = detailItemsPage * DETAIL_PAGE_SIZE + 1;
      const end = Math.min(start + DETAIL_PAGE_SIZE - 1, detailItemsTotal);
      if (totalPages > 1) {
        html += `<nav class="shell-pagination">
          <span style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)">Showing ${fmtInt(start)}–${fmtInt(end)} of ${fmtInt(detailItemsTotal)}</span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" data-act="items-prev" ${detailItemsPage === 0 ? "disabled" : ""}>← Previous</button>
            <button class="btn-secondary" data-act="items-next" ${detailItemsPage >= totalPages - 1 ? "disabled" : ""}>Next →</button>
          </div>
        </nav>`;
      }
    }
    html += `</div>`;
    sub.innerHTML = html;

    sub.querySelector('[data-act="pick-products"]').addEventListener("click", async () => {
      // Pick at the product level. bridge.pickResource("product") returns
      // [{ id: "gid://shopify/Product/NNN", title }].
      // We send product_external_ids (decimal strings) and an empty
      // variant_external_ids array; the backend resolves all variants
      // for each product via its own Shopify API calls.
      // This avoids the structural mismatch of two independent picker
      // sessions producing arrays of different lengths.
      const existingProductGids = [];
      // Pre-seed the picker with products already in the bundle by
      // building GIDs from the known product_external_ids in detailItems.
      const seenProductIds = new Set();
      detailItems.forEach((i) => {
        if (i.product_external_id && !seenProductIds.has(i.product_external_id)) {
          seenProductIds.add(i.product_external_id);
          existingProductGids.push({ id: `gid://shopify/Product/${i.product_external_id}` });
        }
      });

      const picks = await bridge.pickResource({
        type: "product",
        multiple: true,
        selectionIds: existingProductGids,
      });
      if (!picks) return; // merchant cancelled

      // Extract decimal product ID strings from GIDs per alignment rule 5.
      const productIds = picks.map((p) => {
        const parts = p.id.split("/");
        return parts[parts.length - 1];
      });

      const btn = sub.querySelector('[data-act="pick-products"]');
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const res = await bridge.call("/bundles/items/save", {
          bundle_id: detailBundle.id,
          variant_external_ids: [],
          product_external_ids: productIds,
        });
        let msg = `${res.saved_count} item(s) saved`;
        if (res.unavailable_variants && res.unavailable_variants.length > 0) {
          msg += `. ${res.unavailable_variants.length} unavailable variant(s) skipped.`;
        }
        bridge.notify(msg, "success");
        detailItemsPage = 0;
        await loadDetailItems();
        await reloadDetailBundle();
      } catch (_) {
        bridge.notify("Could not save items", "error");
      } finally {
        btn.disabled = false; btn.textContent = "Add products";
      }
    });

    sub.querySelector('[data-act="items-prev"]')?.addEventListener("click", () => {
      if (detailItemsPage > 0) { detailItemsPage--; loadDetailItems(); }
    });
    sub.querySelector('[data-act="items-next"]')?.addEventListener("click", () => {
      if ((detailItemsPage + 1) * DETAIL_PAGE_SIZE < detailItemsTotal) { detailItemsPage++; loadDetailItems(); }
    });
  }

  async function reloadDetailBundle() {
    try {
      const res = await bridge.call("/bundles", {
        status_filter: null,
        health_filter: null,
        page: 0,
        page_size: 100,
      });
      const found = (res.items || []).find((r) => r.id === detailBundle.id);
      if (found) {
        detailBundle = found;
        renderDetail();
        renderDetailSub();
      }
    } catch (_) {
      // non-fatal
    }
  }

  // ── tiers sub-tab ─────────────────────────────────────────────────────────────
  async function loadDetailTiers() {
    try {
      const res = await bridge.call("/bundles/tiers", {
        bundle_id: detailBundle.id,
        page: 0,
        page_size: 50,
      });
      detailTiers = (res.items || []).slice().sort((a, b) => a.display_order - b.display_order);
      if (detailSubTab === "tiers") renderDetailTiers();
    } catch (_) {
      bridge.notify("Could not load tiers", "error");
    }
  }

  function renderDetailTiers() {
    const sub = region("detail-sub");
    if (!sub) return;

    let workingTiers = detailTiers.map((t) => ({
      id: t.id,
      minimum_item_count: t.minimum_item_count,
      discount_rate: t.discount_rate,
    }));

    function buildTiersHTML() {
      let html = `<div class="shell-card">
        <div class="ba-notice">Discount tiers define the minimum item count and discount percentage. Customers must meet or exceed the item count to qualify for the tier. Each discount rate must have a matching Shopify discount rule to apply at checkout.</div>
        <div data-region="tiers-list">`;
      if (workingTiers.length === 0) {
        html += `<div class="shell-empty"><p>No tiers yet. Add a tier below.</p></div>`;
      } else {
        html += `<div style="margin-bottom:var(--p-space-300)">`;
        workingTiers.forEach((t, idx) => {
          html += `<div class="ba-tier-row" data-tier-idx="${idx}">
            <label class="shell-label" style="min-width:120px;margin:0">Min. items:</label>
            <input class="shell-input ba-tier-input" type="number" min="1" step="1" name="min_count" data-idx="${idx}" value="${esc(String(t.minimum_item_count))}" aria-label="Minimum item count for tier ${idx + 1}" />
            <label class="shell-label" style="min-width:120px;margin:0">Discount %:</label>
            <input class="shell-input ba-tier-input" type="number" min="0" max="100" step="0.01" name="discount_pct" data-idx="${idx}" value="${esc(String(t.discount_rate / 100))}" aria-label="Discount percent for tier ${idx + 1}" />
            <span style="color:var(--p-color-text-secondary);font-size:var(--p-font-size-300)">${fmtPct(t.discount_rate)} off for ≥${fmtInt(t.minimum_item_count)} items</span>
            <button class="btn-danger" data-act="remove-tier" data-idx="${idx}" style="padding:var(--p-space-100) var(--p-space-200)" aria-label="Remove tier ${idx + 1}">Remove</button>
          </div>`;
        });
        html += `</div>`;
      }
      html += `</div>
        <div style="display:flex;gap:var(--p-space-200);margin-top:var(--p-space-300)">
          <button class="btn-secondary" data-act="add-tier">+ Add tier</button>
          <button class="btn-primary" data-act="save-tiers">Save tiers</button>
          <button class="btn-secondary" data-act="discard-tiers">Discard</button>
        </div>
      </div>`;
      return html;
    }

    sub.innerHTML = buildTiersHTML();

    function attachTierEvents() {
      sub.querySelectorAll('[name="min_count"]').forEach((input) => {
        input.addEventListener("input", (e) => {
          const idx = parseInt(e.target.dataset.idx, 10);
          workingTiers[idx].minimum_item_count = parseInt(e.target.value, 10) || 1;
          updatePreviewLabel(sub, idx, workingTiers);
        });
      });
      sub.querySelectorAll('[name="discount_pct"]').forEach((input) => {
        input.addEventListener("input", (e) => {
          const idx = parseInt(e.target.dataset.idx, 10);
          workingTiers[idx].discount_rate = Math.round((parseFloat(e.target.value) || 0) * 100);
          updatePreviewLabel(sub, idx, workingTiers);
        });
      });
      sub.querySelectorAll('[data-act="remove-tier"]').forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = parseInt(btn.dataset.idx, 10);
          workingTiers.splice(idx, 1);
          sub.innerHTML = buildTiersHTML();
          attachTierEvents();
        });
      });
      sub.querySelector('[data-act="add-tier"]').addEventListener("click", () => {
        workingTiers.push({ id: null, minimum_item_count: 1, discount_rate: 1000 });
        sub.innerHTML = buildTiersHTML();
        attachTierEvents();
      });
      sub.querySelector('[data-act="save-tiers"]').addEventListener("click", async () => {
        const btn = sub.querySelector('[data-act="save-tiers"]');
        btn.disabled = true; btn.textContent = "Saving…";
        const tiers = workingTiers.map((t) => ({
          minimum_item_count: t.minimum_item_count,
          discount_rate: t.discount_rate,
        }));
        try {
          const res = await bridge.call("/bundles/tiers/save", { bundle_id: detailBundle.id, tiers });
          bridge.notify(`${res.saved_count} tier(s) saved`, "success");
          await loadDetailTiers();
        } catch (_) {
          btn.disabled = false; btn.textContent = "Save tiers";
          bridge.notify("Could not save tiers", "error");
        }
      });
      sub.querySelector('[data-act="discard-tiers"]').addEventListener("click", () => {
        workingTiers = detailTiers.map((t) => ({
          id: t.id,
          minimum_item_count: t.minimum_item_count,
          discount_rate: t.discount_rate,
        }));
        sub.innerHTML = buildTiersHTML();
        attachTierEvents();
      });
    }

    attachTierEvents();
  }

  function updatePreviewLabel(sub, idx, workingTiers) {
    const row = sub.querySelector(`[data-tier-idx="${idx}"]`);
    if (!row) return;
    const preview = row.querySelector("span");
    if (!preview) return;
    const t = workingTiers[idx];
    preview.textContent = `${fmtPct(t.discount_rate)} off for ≥${fmtInt(t.minimum_item_count)} items`;
  }

  // ─── PURCHASE HISTORY ─────────────────────────────────────────────────────────
  let phLoading = false;

  async function loadPurchaseHistory() {
    phLoading = true;
    renderPHList();
    try {
      const res = await bridge.call("/purchase-history", {
        bundle_id: phBundleFilter || null,
        date_from: phDateFrom || null,
        date_to: phDateTo || null,
        page: phPage,
        page_size: PAGE_SIZE,
      });
      phRows = res.items || [];
      phTotal = res.total || 0;
    } catch (_) {
      bridge.notify("Could not load purchase history", "error");
      phRows = [];
      phTotal = 0;
    } finally {
      phLoading = false;
      renderPHList();
    }
  }

  function renderPHToolbar() {
    const tb = region("ph-toolbar");
    tb.innerHTML = `
      <div class="shell-field" style="margin:0">
        <label class="shell-label" for="ph-from">From</label>
        <input class="shell-input" id="ph-from" type="date" value="${esc(phDateFrom ? phDateFrom.slice(0, 10) : "")}" style="width:150px" />
      </div>
      <div class="shell-field" style="margin:0">
        <label class="shell-label" for="ph-to">To</label>
        <input class="shell-input" id="ph-to" type="date" value="${esc(phDateTo ? phDateTo.slice(0, 10) : "")}" style="width:150px" />
      </div>
      <button class="btn-secondary" data-act="ph-apply">Apply</button>
      <button class="btn-secondary" data-act="ph-clear">Clear</button>
      <button class="btn-secondary ba-export-btn" data-act="ph-export">Export CSV</button>
    `;
    tb.querySelector('[data-act="ph-apply"]').addEventListener("click", () => {
      const fromVal = tb.querySelector("#ph-from").value;
      const toVal = tb.querySelector("#ph-to").value;
      phDateFrom = fromVal ? `${fromVal}T00:00:00Z` : "";
      phDateTo = toVal ? `${toVal}T23:59:59Z` : "";
      phPage = 0;
      loadPurchaseHistory();
    });
    tb.querySelector('[data-act="ph-clear"]').addEventListener("click", () => {
      phDateFrom = ""; phDateTo = ""; phBundleFilter = ""; phPage = 0;
      renderPHToolbar();
      loadPurchaseHistory();
    });
    tb.querySelector('[data-act="ph-export"]').addEventListener("click", exportPHCSV);
  }

  function exportPHCSV() {
    if (phRows.length === 0) { bridge.notify("No rows to export", "error"); return; }
    const headers = ["ID", "Bundle ID", "Order ID", "Order Placed At", "Items", "Discount Rate", "Order Total", "Currency", "Recorded At"];
    const csvLines = [headers.join(",")];
    phRows.forEach((r) => {
      const orderTotalFormatted = formatOrderTotal(r.order_total_minor_units, r.order_currency);
      csvLines.push([
        r.id, r.bundle_id, r.order_external_id, r.order_placed_at,
        r.item_count, `${(r.discount_rate / 100).toFixed(2)}%`,
        orderTotalFormatted, r.order_currency, r.recorded_at,
      ].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
    });
    const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bundle-purchase-history.csv";
    container.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function renderPHList() {
    const listRegion = region("ph-list");
    if (!listRegion) return;
    if (phLoading && phRows.length === 0) {
      listRegion.innerHTML = `<div class="shell-table-wrap"><table class="shell-table">
        <thead><tr><th>Order</th><th>Bundle</th><th>Placed</th><th>Items</th><th>Discount</th><th>Total</th></tr></thead>
        <tbody>${Array(5).fill(`<tr><td colspan="6"><div class="shell-loading">&nbsp;</div></td></tr>`).join("")}</tbody>
      </table></div>`;
      return;
    }
    if (phRows.length === 0) {
      listRegion.innerHTML = `<div class="shell-empty"><p>No purchase records found${(phDateFrom || phDateTo) ? " for the selected date range" : ""}.</p></div>`;
      return;
    }
    let html = `<div class="shell-table-wrap"><table class="shell-table">
      <thead><tr><th>Order ID</th><th>Bundle ID</th><th>Placed At</th><th>Items</th><th>Discount</th><th>Total</th></tr></thead>
      <tbody>`;
    phRows.forEach((r) => {
      html += `<tr>
        <td>${esc(r.order_external_id || "—")}</td>
        <td>${esc(r.bundle_id || "—")}</td>
        <td>${fmtDate(r.order_placed_at)}</td>
        <td>${fmtInt(r.item_count)}</td>
        <td>${fmtPct(r.discount_rate)}</td>
        <td>${formatOrderTotal(r.order_total_minor_units, r.order_currency)}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;

    const totalPages = Math.ceil(phTotal / PAGE_SIZE);
    const start = phPage * PAGE_SIZE + 1;
    const end = Math.min(start + PAGE_SIZE - 1, phTotal);
    html += `<nav class="shell-pagination" aria-label="Purchase history pagination">
      <span style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)">Showing ${fmtInt(start)}–${fmtInt(end)} of ${fmtInt(phTotal)}</span>
      <div class="shell-pagination-btns">
        <button class="btn-secondary" data-act="ph-prev" ${phPage === 0 ? "disabled" : ""}>← Previous</button>
        <button class="btn-secondary" data-act="ph-next" ${phPage >= totalPages - 1 ? "disabled" : ""}>Next →</button>
      </div>
    </nav>`;

    listRegion.innerHTML = html;

    listRegion.querySelector('[data-act="ph-prev"]')?.addEventListener("click", () => {
      if (phPage > 0) { phPage--; loadPurchaseHistory(); }
    });
    listRegion.querySelector('[data-act="ph-next"]')?.addEventListener("click", () => {
      if ((phPage + 1) * PAGE_SIZE < phTotal) { phPage++; loadPurchaseHistory(); }
    });
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────────
  renderToolbar();
  renderPHToolbar();
  loadBundles();
}