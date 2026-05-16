window.__PLATFORM_CATALOG__ = [];
export function mount(container, bridge) {
  // ── helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" :
      new Intl.DateTimeFormat(bridge.context.locale, { dateStyle: "medium" }).format(d);
  };

  const fmtPct = (basisPoints) => {
    const ratio = (basisPoints || 0) / 10000;
    return new Intl.NumberFormat(bridge.context.locale, {
      style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1,
    }).format(ratio);
  };

  const fmtMoneyAs = (minor, currency) => new Intl.NumberFormat(bridge.context.locale, {
    style: "currency",
    currency: currency || bridge.context.currency,
  }).format((minor || 0) / 100);

  const fmtInt = (n) => new Intl.NumberFormat(bridge.context.locale).format(n || 0);

  function region(name) {
    return container.querySelector(`[data-region="${name}"]`);
  }

  // ── styles ───────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bnd-tab-bar { display:flex; gap:0; border-bottom:1px solid var(--p-color-border); margin-bottom:var(--p-space-400); }
    .bnd-tab { padding:var(--p-space-300) var(--p-space-400); cursor:pointer; border:none; background:none; font-size:var(--p-font-size-350); color:var(--p-color-text-secondary); border-bottom:2px solid transparent; margin-bottom:-1px; }
    .bnd-tab.active { color:var(--p-color-text); border-bottom-color:#008060; font-weight:var(--p-font-weight-semibold); }
    .bnd-tab:hover:not(.active) { color:var(--p-color-text); background:var(--p-color-bg-surface-secondary); }
    .bnd-tier-row { display:flex; gap:var(--p-space-300); align-items:center; margin-bottom:var(--p-space-200); }
    .bnd-tier-row .shell-input { width:100px; }
    .bnd-chips { display:flex; flex-wrap:wrap; gap:var(--p-space-200); margin-top:var(--p-space-200); }
    .bnd-chip { display:inline-flex; align-items:center; gap:var(--p-space-100); padding:var(--p-space-100) var(--p-space-200); background:var(--p-color-bg-surface-secondary); border-radius:var(--p-border-radius-full); font-size:var(--p-font-size-300); }
    .bnd-chip button { border:none; background:none; cursor:pointer; color:var(--p-color-text-secondary); font-size:var(--p-font-size-400); line-height:1; padding:0; }
    .bnd-discount-preview { background:var(--p-color-bg-surface-secondary); border-radius:var(--p-border-radius-200); padding:var(--p-space-300); margin-top:var(--p-space-300); }
    .bnd-discount-preview h4 { margin:0 0 var(--p-space-200); font-size:var(--p-font-size-300); color:var(--p-color-text-secondary); }
    .bnd-discount-row { display:flex; justify-content:space-between; font-size:var(--p-font-size-350); padding:var(--p-space-100) 0; border-bottom:1px solid var(--p-color-border); }
    .bnd-discount-row:last-child { border-bottom:none; }
    .bnd-actions-bar { display:flex; align-items:center; gap:var(--p-space-300); padding:var(--p-space-300); background:var(--p-color-bg-surface-secondary); border-radius:var(--p-border-radius-200); margin-bottom:var(--p-space-300); }
    .bnd-setup-notice { padding:var(--p-space-400); background:var(--p-color-bg-fill-warning); border-radius:var(--p-border-radius-200); margin-bottom:var(--p-space-400); font-size:var(--p-font-size-350); }
    .bnd-health-tooltip { position:relative; display:inline-block; }
    .bnd-health-tooltip:hover .bnd-tooltip-text { display:block; }
    .bnd-tooltip-text { display:none; position:absolute; z-index:10; background:var(--p-color-bg-surface); border:1px solid var(--p-color-border); border-radius:var(--p-border-radius-100); padding:var(--p-space-200); white-space:nowrap; font-size:var(--p-font-size-300); bottom:120%; left:50%; transform:translateX(-50%); box-shadow:var(--p-shadow-200); }
    .bnd-pair { display:flex; gap:var(--p-space-300); }
    .bnd-pair .shell-field { flex:1; }
    @media(max-width:600px) { .bnd-pair { flex-direction:column; } }
    .bnd-row-actions { display:flex; gap:var(--p-space-200); }
    .bnd-select-col { width:40px; }
    .bnd-section-hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:var(--p-space-300); }
  `;
  container.appendChild(style);

  // ── state ────────────────────────────────────────────────────────────────
  const PAGE_SIZE = 20;
  const BUNDLE_PAGE_SIZE = 20;
  const HISTORY_PAGE_SIZE = 20;

  // bundles list
  let bundles = [], bundlesTotal = 0, bundlesPage = 0;
  let bundleStatusFilter = "", bundleHealthFilter = "";
  let bundlesLoading = false;
  let selectedBundleIds = new Set();

  // active tab
  let activeTab = "bundles"; // "bundles" | "history"

  // purchase history
  let historyRows = [], historyTotal = 0, historyPage = 0;
  let historyBundleFilter = "", historyDateFrom = "", historyDateTo = "";
  let historyLoading = false;

  // modal state
  let modal = null;

  // ── scaffold ─────────────────────────────────────────────────────────────
  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <h1 class="shell-title">Product Bundles</h1>
        <button class="btn-primary" data-act="new-bundle">+ New Bundle</button>
      </div>
      <div class="bnd-setup-notice" role="status">
        <strong>Setup required:</strong> Each discount tier needs a matching Shopify discount code created in <em>Shopify Admin → Discounts</em> before activating a bundle.
        Discount codes must map to the percentage for each tier threshold you configure.
      </div>
      <div class="bnd-tab-bar">
        <button class="bnd-tab active" data-tab="bundles">Bundles</button>
        <button class="bnd-tab" data-tab="history">Purchase History</button>
      </div>
      <div data-region="tab-bundles">
        <div data-region="bundles-toolbar"></div>
        <div data-region="bundles-actions"></div>
        <div class="shell-card">
          <div data-region="bundles-list"></div>
        </div>
      </div>
      <div data-region="tab-history" style="display:none">
        <div data-region="history-toolbar"></div>
        <div class="shell-card">
          <div data-region="history-list"></div>
        </div>
      </div>
    </div>`;

  // ── tab navigation ────────────────────────────────────────────────────────
  container.querySelectorAll(".bnd-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      container.querySelectorAll(".bnd-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      region("tab-bundles").style.display = activeTab === "bundles" ? "" : "none";
      region("tab-history").style.display = activeTab === "history" ? "" : "none";
      if (activeTab === "history" && historyRows.length === 0 && !historyLoading) {
        renderHistoryToolbar();
        loadHistory();
      }
    });
  });

  container.querySelector('[data-act="new-bundle"]').addEventListener("click", () => openBundleEditor(null));

  // ── bundles list ──────────────────────────────────────────────────────────
  function healthBadge(health, tooltipText) {
    const variantMap = { healthy: "badge-success", warned: "badge-warning", auto_disabled: "badge-error" };
    const labelMap = { healthy: "Healthy", warned: "Warned", auto_disabled: "Auto-disabled" };
    const cls = variantMap[health] || "badge-neutral";
    const label = labelMap[health] || esc(health);
    if (tooltipText) {
      return `<span class="bnd-health-tooltip"><span class="badge ${cls}">${label}</span><span class="bnd-tooltip-text">${esc(tooltipText)}</span></span>`;
    }
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function renderBundlesToolbar() {
    region("bundles-toolbar").innerHTML = `
      <div class="shell-toolbar" style="margin-bottom:var(--p-space-300)">
        <select class="shell-select" data-act="health-filter">
          <option value="">All health statuses</option>
          <option value="healthy">Healthy</option>
          <option value="warned">Warned</option>
          <option value="auto_disabled">Auto-disabled</option>
        </select>
        <select class="shell-select" data-act="status-filter">
          <option value="">All statuses</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>`;
    const hf = region("bundles-toolbar").querySelector('[data-act="health-filter"]');
    const sf = region("bundles-toolbar").querySelector('[data-act="status-filter"]');
    if (bundleHealthFilter) hf.value = bundleHealthFilter;
    if (bundleStatusFilter) sf.value = bundleStatusFilter;
    hf.addEventListener("change", (e) => {
      bundleHealthFilter = e.target.value;
      bundlesPage = 0; selectedBundleIds.clear();
      loadBundles();
    });
    sf.addEventListener("change", (e) => {
      bundleStatusFilter = e.target.value;
      bundlesPage = 0; selectedBundleIds.clear();
      loadBundles();
    });
  }

  function renderBundlesActionBar() {
    const bar = region("bundles-actions");
    if (selectedBundleIds.size === 0) { bar.innerHTML = ""; return; }
    bar.innerHTML = `
      <div class="bnd-actions-bar">
        <span>${fmtInt(selectedBundleIds.size)} bundle${selectedBundleIds.size !== 1 ? "s" : ""} selected</span>
        <button class="btn-primary" data-act="bulk-enable">Enable selected</button>
        <button class="btn-secondary" data-act="bulk-disable">Disable selected</button>
        <button class="btn-secondary" data-act="bulk-clear">Clear selection</button>
      </div>`;
    bar.querySelector('[data-act="bulk-enable"]').addEventListener("click", () => runBulkStatus(true));
    bar.querySelector('[data-act="bulk-disable"]').addEventListener("click", () => runBulkStatus(false));
    bar.querySelector('[data-act="bulk-clear"]').addEventListener("click", () => {
      selectedBundleIds.clear(); renderBundlesActionBar(); renderBundlesList();
    });
  }

  async function runBulkStatus(enabled) {
    const btn = region("bundles-actions").querySelector(enabled ? '[data-act="bulk-enable"]' : '[data-act="bulk-disable"]');
    if (btn) { btn.disabled = true; btn.textContent = enabled ? "Enabling…" : "Disabling…"; }
    try {
      const res = await bridge.call("/bundles/bulk-status", {
        bundle_ids: [...selectedBundleIds],
        enabled,
      });
      bridge.notify(`Updated ${fmtInt(res.updated_count)} bundle${res.updated_count !== 1 ? "s" : ""}${res.skipped_count ? ` (${fmtInt(res.skipped_count)} skipped)` : ""}`, "success");
      selectedBundleIds.clear();
      await loadBundles();
    } catch (_) {
      if (btn) { btn.disabled = false; btn.textContent = enabled ? "Enable selected" : "Disable selected"; }
      bridge.notify("Could not update bundles", "error");
    }
  }

  async function loadBundles() {
    bundlesLoading = true;
    renderBundlesList();
    try {
      const params = {
        page: bundlesPage,
        page_size: BUNDLE_PAGE_SIZE,
        status_filter: bundleStatusFilter || null,
        health_filter: bundleHealthFilter || null,
      };
      const res = await bridge.call("/bundles", params);
      bundles = res.items || [];
      bundlesTotal = res.total || 0;
    } catch (_) {
      bundlesLoading = false;
      region("bundles-list").innerHTML = `<div class="shell-error-banner">Could not load bundles. Refresh to try again.</div>`;
      return;
    }
    bundlesLoading = false;
    renderBundlesList();
    renderBundlesActionBar();
  }

  function renderBundlesList() {
    const list = region("bundles-list");
    if (bundlesLoading && bundles.length === 0) {
      list.innerHTML = `
        <div class="shell-table-wrap"><table class="shell-table">
          <thead><tr><th class="bnd-select-col"></th><th>Title</th><th>Mode</th><th>Health</th><th>Tiers</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>${Array(5).fill(`<tr><td colspan="7"><div class="shell-loading">&nbsp;</div></td></tr>`).join("")}</tbody>
        </table></div>`;
      return;
    }
    if (!bundlesLoading && bundles.length === 0) {
      const isFiltered = bundleStatusFilter !== "" || bundleHealthFilter !== "";
      list.innerHTML = `
        <div class="shell-empty">
          ${isFiltered
            ? `<p>No bundles match the current filters.</p><button class="btn-secondary" data-act="clear-filters">Clear filters</button>`
            : `<h2 class="shell-section-title">No bundles yet</h2>
               <p>Create your first bundle to offer customers grouped product discounts.</p>
               <button class="btn-primary" data-act="new-bundle-empty">+ New Bundle</button>`}
        </div>`;
      if (isFiltered) {
        list.querySelector('[data-act="clear-filters"]').addEventListener("click", () => {
          bundleStatusFilter = ""; bundleHealthFilter = "";
          bundlesPage = 0;
          renderBundlesToolbar();
          loadBundles();
        });
      } else {
        list.querySelector('[data-act="new-bundle-empty"]')?.addEventListener("click", () => openBundleEditor(null));
      }
      return;
    }

    const allChecked = bundles.length > 0 && bundles.every((b) => selectedBundleIds.has(b.id));
    const modeLabel = (m) => m === "fixed" ? "Fixed" : m === "flexible" ? "Flexible" : esc(m);

    list.innerHTML = `
      <div class="shell-table-wrap"><table class="shell-table">
        <thead><tr>
          <th class="bnd-select-col"><input type="checkbox" data-act="select-all" ${allChecked ? "checked" : ""} aria-label="Select all" /></th>
          <th>Title</th><th>Mode</th><th>Health</th><th>Status</th><th>Tiers</th><th>Created</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${bundles.map((b) => `
            <tr data-id="${esc(b.id)}">
              <td><input type="checkbox" data-act="select-row" data-id="${esc(b.id)}" ${selectedBundleIds.has(b.id) ? "checked" : ""} aria-label="Select ${esc(b.title)}" /></td>
              <td><strong>${esc(b.title)}</strong></td>
              <td><span class="badge badge-neutral">${modeLabel(b.mode)}</span></td>
              <td>${healthBadge(b.health_status, b.health_status === "auto_disabled" ? "Bundle auto-disabled due to variant issues. Open bundle to see details." : "")}</td>
              <td><span class="badge ${b.enabled ? "badge-success" : "badge-neutral"}">${b.enabled ? "Enabled" : "Disabled"}</span></td>
              <td>${fmtInt(b.tier_count)}</td>
              <td>${fmtDate(b.created_at)}</td>
              <td>
                <div class="bnd-row-actions">
                  <button class="btn-secondary" data-act="edit" data-id="${esc(b.id)}" data-title="${esc(b.title)}">Edit</button>
                  <button class="btn-secondary" data-act="clone" data-id="${esc(b.id)}">Clone</button>
                  <button class="btn-danger" data-act="delete" data-id="${esc(b.id)}" data-title="${esc(b.title)}">Delete</button>
                </div>
              </td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      <nav class="shell-pagination">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--p-space-300) 0;">
          <span style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)">
            Showing ${fmtInt(bundlesPage * BUNDLE_PAGE_SIZE + 1)}–${fmtInt(Math.min((bundlesPage + 1) * BUNDLE_PAGE_SIZE, bundlesTotal))} of ${fmtInt(bundlesTotal)}
          </span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" data-act="prev-page" ${bundlesPage === 0 ? "disabled" : ""}>← Previous</button>
            <button class="btn-secondary" data-act="next-page" ${(bundlesPage + 1) * BUNDLE_PAGE_SIZE >= bundlesTotal ? "disabled" : ""}>Next →</button>
          </div>
        </div>
      </nav>`;

    list.querySelector('[data-act="select-all"]').addEventListener("change", (e) => {
      if (e.target.checked) bundles.forEach((b) => selectedBundleIds.add(b.id));
      else bundles.forEach((b) => selectedBundleIds.delete(b.id));
      renderBundlesActionBar();
      renderBundlesList();
    });

    list.querySelectorAll('[data-act="select-row"]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        if (e.target.checked) selectedBundleIds.add(e.target.dataset.id);
        else selectedBundleIds.delete(e.target.dataset.id);
        renderBundlesActionBar();
        renderBundlesList();
      });
    });

    list.querySelectorAll('[data-act="edit"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const b = bundles.find((x) => x.id === btn.dataset.id);
        if (b) openBundleEditor(b);
      });
    });

    list.querySelectorAll('[data-act="clone"]').forEach((btn) => {
      btn.addEventListener("click", () => cloneBundle(btn.dataset.id, btn));
    });

    list.querySelectorAll('[data-act="delete"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const b = bundles.find((x) => x.id === btn.dataset.id);
        if (b) confirmDeleteBundle(b);
      });
    });

    list.querySelector('[data-act="prev-page"]')?.addEventListener("click", () => {
      if (bundlesPage > 0) { bundlesPage--; loadBundles(); }
    });

    list.querySelector('[data-act="next-page"]')?.addEventListener("click", () => {
      if ((bundlesPage + 1) * BUNDLE_PAGE_SIZE < bundlesTotal) { bundlesPage++; loadBundles(); }
    });
  }

  async function cloneBundle(bundleId, btn) {
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = "Cloning…";
    try {
      await bridge.call("/bundles/clone", { source_bundle_id: bundleId });
      bridge.notify("Bundle cloned", "success");
      await loadBundles();
    } catch (_) {
      bridge.notify("Could not clone bundle", "error");
    } finally {
      btn.disabled = false; btn.textContent = prev;
    }
  }

  // ── delete confirm ────────────────────────────────────────────────────────
  function confirmDeleteBundle(bundle) {
    closeModal();
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "shell-confirm-overlay";
    overlay.innerHTML = `
      <div class="shell-confirm-dialog" role="dialog" aria-modal="true">
        <h2 class="shell-confirm-title">Delete "${esc(bundle.title)}"?</h2>
        <div class="shell-confirm-body shell-warning-banner">This will permanently delete the bundle and all its tiers. This cannot be undone.</div>
        <div class="shell-confirm-actions">
          <button class="btn-secondary" data-act="cancel" autofocus>Cancel</button>
          <button class="btn-danger" data-act="confirm">Delete</button>
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
        await bridge.call("/bundles/remove", { bundle_id: bundle.id });
        closeModal();
        bridge.notify("Bundle deleted", "success");
        if (bundles.length === 1 && bundlesPage > 0) bundlesPage--;
        await loadBundles();
      } catch (_) {
        btn.disabled = false; btn.textContent = "Delete";
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

  // ── bundle editor modal ───────────────────────────────────────────────────
  function openBundleEditor(bundle) {
    closeModal();
    const isEdit = bundle !== null;
    const previouslyFocused = document.activeElement;

    // editor-level state
    let editorTiers = []; // [{minimum_item_count, discount_rate}] (discount_rate in basis pts)
    let editorItemsMap = new Map(); // variantExternalId → {variantExternalId, productExternalId, label}
    let editorItemsLoading = false;
    let editorTiersLoading = false;
    let editorItemsPage = 0, editorItemsTotal = 0;
    let editorItemRows = [];
    let activeEditorTab = "details";

    const overlay = document.createElement("div");
    overlay.className = "shell-confirm-overlay";
    overlay.style.cssText = "overflow-y:auto;align-items:flex-start;padding:var(--p-space-400) 0;";
    overlay.innerHTML = `
      <div class="shell-confirm-dialog" role="dialog" aria-modal="true" style="max-width:700px;width:95%;max-height:90vh;overflow-y:auto;">
        <h2 class="shell-confirm-title">${isEdit ? `Edit: ${esc(bundle.title)}` : "New Bundle"}</h2>
        <div class="bnd-tab-bar" style="margin:0 0 var(--p-space-300)">
          <button class="bnd-tab active" data-editor-tab="details">Details</button>
          <button class="bnd-tab" data-editor-tab="items">Products / Variants</button>
          <button class="bnd-tab" data-editor-tab="tiers">Discount Tiers</button>
        </div>
        <div class="shell-confirm-body" style="padding:0">
          <div data-editor-region="details">
            <div class="shell-field">
              <label class="shell-label" for="bnd-title">Bundle Title *</label>
              <input class="shell-input" id="bnd-title" type="text" required value="${isEdit ? esc(bundle.title) : ""}" />
            </div>
            <div class="shell-field">
              <label class="shell-label" for="bnd-desc">Description</label>
              <textarea class="shell-textarea" id="bnd-desc" rows="3">${isEdit ? esc(bundle.description || "") : ""}</textarea>
            </div>
            <div class="shell-field">
              <label class="shell-label" for="bnd-mode">Bundle Mode *</label>
              <select class="shell-select" id="bnd-mode" ${isEdit ? "disabled" : ""}>
                <option value="fixed" ${(!isEdit || bundle.mode === "fixed") ? "selected" : ""}>Fixed — pre-defined product set</option>
                <option value="flexible" ${(isEdit && bundle.mode === "flexible") ? "selected" : ""}>Flexible — customer selects items</option>
              </select>
              ${isEdit ? `<div class="shell-help">Mode cannot be changed after creation.</div>` : ""}
            </div>
            ${isEdit ? `
            <div class="shell-field">
              <label class="shell-label">Enabled</label>
              <label style="display:flex;gap:var(--p-space-200);align-items:center;cursor:pointer;">
                <input type="checkbox" id="bnd-enabled" ${bundle.enabled ? "checked" : ""} />
                <span>Bundle is active and visible to customers</span>
              </label>
            </div>
            <div class="shell-field">
              <label class="shell-label">Health Status</label>
              <div>${healthBadge(bundle.health_status, "")}</div>
              ${bundle.health_status === "auto_disabled" ? `<div class="shell-error" role="alert">This bundle was auto-disabled due to variant availability issues. Review the Products / Variants tab for details.</div>` : ""}
            </div>` : ""}
          </div>
          <div data-editor-region="items" style="display:none">
            <div data-editor-subregion="items-content"></div>
          </div>
          <div data-editor-region="tiers" style="display:none">
            <div data-editor-subregion="tiers-content"></div>
          </div>
        </div>
        <div class="shell-confirm-actions">
          <button class="btn-secondary" data-act="cancel">Cancel</button>
          <button class="btn-primary" data-act="save">${isEdit ? "Save Changes" : "Create Bundle"}</button>
        </div>
      </div>`;

    container.appendChild(overlay);
    const onKey = (e) => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", onKey);
    modal = { el: overlay, onKey, previouslyFocused };

    function editorRegion(name) { return overlay.querySelector(`[data-editor-region="${name}"]`); }
    function editorSubRegion(name) { return overlay.querySelector(`[data-editor-subregion="${name}"]`); }

    // tab switching
    overlay.querySelectorAll("[data-editor-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        activeEditorTab = tab.dataset.editorTab;
        overlay.querySelectorAll("[data-editor-tab]").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        ["details", "items", "tiers"].forEach((r) => {
          editorRegion(r).style.display = r === activeEditorTab ? "" : "none";
        });
        if (activeEditorTab === "items" && isEdit && editorItemRows.length === 0 && !editorItemsLoading) {
          loadEditorItems();
        }
        if (activeEditorTab === "tiers" && isEdit && editorTiers.length === 0 && !editorTiersLoading) {
          loadEditorTiers();
        }
        if (activeEditorTab === "tiers" && !isEdit) {
          renderEditorTiers();
        }
        if (activeEditorTab === "items" && !isEdit) {
          renderEditorItems();
        }
      });
    });

    // items tab
    function renderEditorItems() {
      const content = editorSubRegion("items-content");

      // selected variants chips
      const chipsHtml = editorItemsMap.size > 0
        ? `<div class="bnd-chips">${[...editorItemsMap.values()].map((v) =>
            `<span class="bnd-chip">${esc(v.label)}<button data-rm="${esc(v.variantExternalId)}" aria-label="Remove ${esc(v.label)}">×</button></span>`
          ).join("")}</div>`
        : `<p style="color:var(--p-color-text-secondary);font-size:var(--p-font-size-300)">No variants selected yet.</p>`;

      content.innerHTML = `
        <div style="margin-bottom:var(--p-space-300)">
          <div class="bnd-section-hdr">
            <span class="shell-section-title">Selected Variants</span>
            <button class="btn-secondary" data-act="pick-products">+ Add Products / Variants</button>
          </div>
          <div data-subregion="chips">${chipsHtml}</div>
        </div>
        ${isEdit ? `
        <div>
          <div class="bnd-section-hdr">
            <span class="shell-section-title">Saved Items</span>
            <div></div>
          </div>
          <div data-subregion="saved-items">${editorItemsLoading
            ? Array(3).fill(`<div class="shell-loading" style="margin-bottom:4px">&nbsp;</div>`).join("")
            : renderSavedItemsHtml()
          }</div>
        </div>` : ""}`;

      content.querySelector('[data-act="pick-products"]').addEventListener("click", async () => {
        const picks = await bridge.pickResource({
          type: "variant",
          multiple: 50,
          selectionIds: [...editorItemsMap.keys()].map((id) => ({ id })),
        });
        if (!picks) return;
        picks.forEach((p) => {
          // id is gid, use as opaque string
          editorItemsMap.set(p.id, {
            variantExternalId: p.id,
            productExternalId: p.id, // gid — bridge returns variant gid
            label: p.title || p.id,
          });
        });
        renderEditorItems();
      });

      content.querySelectorAll("[data-rm]").forEach((btn) => {
        btn.addEventListener("click", () => {
          editorItemsMap.delete(btn.dataset.rm);
          renderEditorItems();
        });
      });
    }

    function renderSavedItemsHtml() {
      if (editorItemRows.length === 0) {
        return `<div class="shell-empty"><p>No items saved yet. Add variants above and save.</p></div>`;
      }
      const availBadge = (avail) => {
        if (avail === null || avail === undefined) return `<span class="badge badge-neutral">—</span>`;
        const map = { available: "badge-success", out_of_stock: "badge-warning", deleted: "badge-error" };
        const labels = { available: "Available", out_of_stock: "Out of stock", deleted: "Deleted" };
        return `<span class="badge ${map[avail] || "badge-neutral"}">${labels[avail] || esc(avail)}</span>`;
      };
      return `
        <div class="shell-table-wrap"><table class="shell-table">
          <thead><tr><th>Variant ID</th><th>Product ID</th><th>Availability</th><th>Added</th></tr></thead>
          <tbody>
            ${editorItemRows.map((item) => `
              <tr>
                <td style="font-size:var(--p-font-size-300)">${esc(item.variant_external_id)}</td>
                <td style="font-size:var(--p-font-size-300)">${esc(item.product_external_id)}</td>
                <td>${availBadge(item.observed_availability)}</td>
                <td>${fmtDate(item.added_at)}</td>
              </tr>`).join("")}
          </tbody>
        </table></div>
        <nav class="shell-pagination">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--p-space-200) 0;">
            <span style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)">
              Showing ${fmtInt(editorItemsPage * PAGE_SIZE + 1)}–${fmtInt(Math.min((editorItemsPage + 1) * PAGE_SIZE, editorItemsTotal))} of ${fmtInt(editorItemsTotal)}
            </span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" data-act="items-prev" ${editorItemsPage === 0 ? "disabled" : ""}>← Previous</button>
              <button class="btn-secondary" data-act="items-next" ${(editorItemsPage + 1) * PAGE_SIZE >= editorItemsTotal ? "disabled" : ""}>Next →</button>
            </div>
          </div>
        </nav>`;
    }

    async function loadEditorItems() {
      editorItemsLoading = true;
      if (editorSubRegion("items-content")) renderEditorItems();
      try {
        const res = await bridge.call("/bundles/items", {
          bundle_id: bundle.id,
          page: editorItemsPage,
          page_size: PAGE_SIZE,
        });
        editorItemRows = res.items || [];
        editorItemsTotal = res.total || 0;
      } catch (_) {
        bridge.notify("Could not load bundle items", "error");
      } finally {
        editorItemsLoading = false;
        if (editorSubRegion("items-content")) renderEditorItems();
      }
    }

    // tiers tab
    function renderEditorTiers() {
      const content = editorSubRegion("tiers-content");
      content.innerHTML = `
        <div class="bnd-section-hdr">
          <span class="shell-section-title">Discount Tiers</span>
          <button class="btn-secondary" data-act="add-tier">+ Add Tier</button>
        </div>
        ${editorTiersLoading ? `<div class="shell-loading">&nbsp;</div>` : ""}
        <div data-subregion="tiers-list">
          ${editorTiers.length === 0 && !editorTiersLoading
            ? `<div class="shell-empty"><p>No tiers yet. Add a tier to define discount thresholds.</p></div>`
            : editorTiers.map((tier, idx) => `
              <div class="bnd-tier-row" data-tier-idx="${idx}">
                <div class="shell-field" style="margin:0">
                  <label class="shell-label" for="bnd-tier-qty-${idx}">Min items</label>
                  <input class="shell-input" id="bnd-tier-qty-${idx}" type="number" min="1" value="${esc(tier.minimum_item_count)}" data-tier-field="minimum_item_count" data-tier-idx="${idx}" style="width:90px" />
                </div>
                <div class="shell-field" style="margin:0">
                  <label class="shell-label" for="bnd-tier-pct-${idx}">Discount %</label>
                  <input class="shell-input" id="bnd-tier-pct-${idx}" type="number" min="0" max="100" step="0.01" value="${esc((tier.discount_rate / 100).toFixed(2))}" data-tier-field="discount_pct" data-tier-idx="${idx}" style="width:90px" />
                </div>
                <button class="btn-danger" data-act="remove-tier" data-tier-idx="${idx}" style="align-self:flex-end;margin-bottom:2px">Remove</button>
              </div>`).join("")}
        </div>
        ${editorTiers.length > 0 ? `
        <div class="bnd-discount-preview">
          <h4>Discount Ladder Preview</h4>
          ${[...editorTiers].sort((a, b) => a.minimum_item_count - b.minimum_item_count).map((tier) =>
            `<div class="bnd-discount-row">
              <span>${fmtInt(tier.minimum_item_count)}+ items</span>
              <span style="color:var(--p-color-text-success);font-weight:var(--p-font-weight-semibold)">${fmtPct(tier.discount_rate)} off</span>
            </div>`).join("")}
        </div>` : ""}
        <div class="shell-help" style="margin-top:var(--p-space-300)">
          Each tier requires a matching Shopify discount code. Create discount codes in <strong>Shopify Admin → Discounts</strong> before activating this bundle.
        </div>`;

      content.querySelector('[data-act="add-tier"]').addEventListener("click", () => {
        editorTiers.push({ minimum_item_count: 2, discount_rate: 1000 });
        renderEditorTiers();
      });

      content.querySelectorAll('[data-act="remove-tier"]').forEach((btn) => {
        btn.addEventListener("click", () => {
          editorTiers.splice(Number(btn.dataset.tierIdx), 1);
          renderEditorTiers();
        });
      });

      content.querySelectorAll('[data-tier-field]').forEach((input) => {
        input.addEventListener("change", (e) => {
          const idx = Number(e.target.dataset.tierIdx);
          const field = e.target.dataset.tierField;
          if (field === "minimum_item_count") {
            editorTiers[idx].minimum_item_count = Math.max(1, parseInt(e.target.value, 10) || 1);
          } else if (field === "discount_pct") {
            const pct = parseFloat(e.target.value) || 0;
            editorTiers[idx].discount_rate = Math.round(Math.min(100, Math.max(0, pct)) * 100);
          }
          renderEditorTiers();
        });
      });
    }

    async function loadEditorTiers() {
      editorTiersLoading = true;
      renderEditorTiers();
      try {
        const res = await bridge.call("/bundles/tiers", {
          bundle_id: bundle.id,
          page: 0,
          page_size: 100,
        });
        editorTiers = (res.items || []).map((t) => ({
          minimum_item_count: t.minimum_item_count,
          discount_rate: t.discount_rate, // stored as basis points
        }));
      } catch (_) {
        bridge.notify("Could not load tiers", "error");
      } finally {
        editorTiersLoading = false;
        renderEditorTiers();
      }
    }

    overlay.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);

    overlay.querySelector('[data-act="save"]').addEventListener("click", async () => {
      const saveBtn = overlay.querySelector('[data-act="save"]');
      const titleInput = overlay.querySelector('#bnd-title');
      const descInput = overlay.querySelector('#bnd-desc');
      const modeSelect = overlay.querySelector('#bnd-mode');
      const enabledCb = overlay.querySelector('#bnd-enabled');

      if (!titleInput.value.trim()) {
        titleInput.focus();
        bridge.notify("Bundle title is required", "error");
        return;
      }

      saveBtn.disabled = true; saveBtn.textContent = "Saving…";

      try {
        let bundleId = isEdit ? bundle.id : null;

        if (!isEdit) {
          const res = await bridge.call("/bundles/create", {
            title: titleInput.value.trim(),
            mode: modeSelect.value,
            description: descInput.value.trim() || null,
          });
          bundleId = res.bundle_id;
        } else {
          const descValue = descInput.value.trim();
          const descProvided = true; // we always send description from edit
          await bridge.call("/bundles/update", {
            bundle_id: bundleId,
            title: titleInput.value.trim(),
            description: descValue || null,
            description_provided: descProvided,
            mode: null,
            enabled: enabledCb ? enabledCb.checked : null,
          });
        }

        // save items if any selected
        if (editorItemsMap.size > 0) {
          const variantIds = [...editorItemsMap.values()].map((v) => v.variantExternalId);
          const productIds = [...editorItemsMap.values()].map((v) => v.productExternalId);
          const itemsRes = await bridge.call("/bundles/items/save", {
            bundle_id: bundleId,
            variant_external_ids: variantIds,
            product_external_ids: productIds,
          });
          if (itemsRes.unavailable_variants && itemsRes.unavailable_variants.length > 0) {
            bridge.notify(`Saved. ${itemsRes.unavailable_variants.length} variant(s) unavailable: ${itemsRes.unavailable_variants.slice(0, 3).join(", ")}${itemsRes.unavailable_variants.length > 3 ? "…" : ""}`, "error");
          }
        }

        // save tiers if any
        if (editorTiers.length > 0) {
          await bridge.call("/bundles/tiers/save", {
            bundle_id: bundleId,
            tiers: editorTiers.map((t) => ({
              minimum_item_count: t.minimum_item_count,
              discount_rate: t.discount_rate, // basis points
            })),
          });
        }

        closeModal();
        bridge.notify(isEdit ? "Bundle updated" : "Bundle created", "success");
        await loadBundles();
      } catch (_) {
        saveBtn.disabled = false; saveBtn.textContent = isEdit ? "Save Changes" : "Create Bundle";
        bridge.notify("Could not save bundle", "error");
      }
    });

    // wire saved items pagination
    overlay.addEventListener("click", (e) => {
      if (e.target.dataset.act === "items-prev" && editorItemsPage > 0) {
        editorItemsPage--; loadEditorItems();
      }
      if (e.target.dataset.act === "items-next" && (editorItemsPage + 1) * PAGE_SIZE < editorItemsTotal) {
        editorItemsPage++; loadEditorItems();
      }
    });

    requestAnimationFrame(() => {
      const first = overlay.querySelector("input, textarea, select");
      if (first) first.focus();
    });

    // initial tab render
    renderEditorTiers();
    renderEditorItems();
  }

  // ── purchase history ──────────────────────────────────────────────────────
  function renderHistoryToolbar() {
    region("history-toolbar").innerHTML = `
      <div class="shell-toolbar" style="margin-bottom:var(--p-space-300);flex-wrap:wrap;gap:var(--p-space-200)">
        <div class="shell-field" style="margin:0">
          <label class="shell-label" for="hist-bundle">Bundle ID</label>
          <input class="shell-input" id="hist-bundle" type="text" placeholder="UUID or blank for all" value="${esc(historyBundleFilter)}" style="width:260px" />
        </div>
        <div class="shell-field" style="margin:0">
          <label class="shell-label" for="hist-from">From date</label>
          <input class="shell-input" id="hist-from" type="date" value="${esc(historyDateFrom)}" />
        </div>
        <div class="shell-field" style="margin:0">
          <label class="shell-label" for="hist-to">To date</label>
          <input class="shell-input" id="hist-to" type="date" value="${esc(historyDateTo)}" />
        </div>
        <button class="btn-primary" data-act="apply-hist-filter" style="align-self:flex-end">Apply</button>
        <button class="btn-secondary" data-act="export-hist" style="align-self:flex-end">Export CSV</button>
      </div>`;

    region("history-toolbar").querySelector('[data-act="apply-hist-filter"]').addEventListener("click", () => {
      historyBundleFilter = region("history-toolbar").querySelector('#hist-bundle').value.trim();
      historyDateFrom = region("history-toolbar").querySelector('#hist-from').value;
      historyDateTo = region("history-toolbar").querySelector('#hist-to').value;
      historyPage = 0;
      loadHistory();
    });

    region("history-toolbar").querySelector('[data-act="export-hist"]').addEventListener("click", exportHistoryCSV);
  }

  async function loadHistory() {
    historyLoading = true;
    renderHistoryList();

    const dateFromISO = historyDateFrom
      ? new Date(historyDateFrom).toISOString()
      : null;
    const dateToISO = historyDateTo
      ? new Date(historyDateTo + "T23:59:59Z").toISOString()
      : null;

    try {
      const res = await bridge.call("/purchase-history", {
        bundle_id: historyBundleFilter || null,
        date_from: dateFromISO,
        date_to: dateToISO,
        page: historyPage,
        page_size: HISTORY_PAGE_SIZE,
      });
      historyRows = res.items || [];
      historyTotal = res.total || 0;
    } catch (_) {
      historyLoading = false;
      region("history-list").innerHTML = `<div class="shell-error-banner">Could not load purchase history. Refresh to try again.</div>`;
      return;
    }
    historyLoading = false;
    renderHistoryList();
  }

  function renderHistoryList() {
    const list = region("history-list");
    if (historyLoading && historyRows.length === 0) {
      list.innerHTML = `
        <div class="shell-table-wrap"><table class="shell-table">
          <thead><tr><th>Order</th><th>Bundle</th><th>Items</th><th>Discount</th><th>Total</th><th>Placed</th><th>Recorded</th></tr></thead>
          <tbody>${Array(5).fill(`<tr><td colspan="7"><div class="shell-loading">&nbsp;</div></td></tr>`).join("")}</tbody>
        </table></div>`;
      return;
    }
    if (!historyLoading && historyRows.length === 0) {
      list.innerHTML = `<div class="shell-empty"><p>No purchase history found for the selected filters.</p></div>`;
      return;
    }

    list.innerHTML = `
      <div class="shell-table-wrap"><table class="shell-table">
        <thead><tr>
          <th>Order ID</th><th>Bundle ID</th><th>Items</th><th>Discount Applied</th><th>Order Total</th><th>Order Placed</th><th>Recorded</th>
        </tr></thead>
        <tbody>
          ${historyRows.map((row) => `
            <tr>
              <td style="font-size:var(--p-font-size-300)">${esc(row.order_external_id)}</td>
              <td style="font-size:var(--p-font-size-300)">${esc(row.bundle_id)}</td>
              <td>${fmtInt(row.item_count)}</td>
              <td style="color:var(--p-color-text-success)">${fmtPct(row.discount_rate_applied)}</td>
              <td>${fmtMoneyAs(row.order_total_minor_units, row.order_currency)}</td>
              <td>${fmtDate(row.order_placed_at)}</td>
              <td>${fmtDate(row.recorded_at)}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      <nav class="shell-pagination">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--p-space-300) 0;">
          <span style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)">
            Showing ${fmtInt(historyPage * HISTORY_PAGE_SIZE + 1)}–${fmtInt(Math.min((historyPage + 1) * HISTORY_PAGE_SIZE, historyTotal))} of ${fmtInt(historyTotal)}
          </span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" data-act="hist-prev" ${historyPage === 0 ? "disabled" : ""}>← Previous</button>
            <button class="btn-secondary" data-act="hist-next" ${(historyPage + 1) * HISTORY_PAGE_SIZE >= historyTotal ? "disabled" : ""}>Next →</button>
          </div>
        </div>
      </nav>`;

    list.querySelector('[data-act="hist-prev"]')?.addEventListener("click", () => {
      if (historyPage > 0) { historyPage--; loadHistory(); }
    });
    list.querySelector('[data-act="hist-next"]')?.addEventListener("click", () => {
      if ((historyPage + 1) * HISTORY_PAGE_SIZE < historyTotal) { historyPage++; loadHistory(); }
    });
  }

  async function exportHistoryCSV() {
    const btn = region("history-toolbar")?.querySelector('[data-act="export-hist"]');
    if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }

    const dateFromISO = historyDateFrom ? new Date(historyDateFrom).toISOString() : null;
    const dateToISO = historyDateTo ? new Date(historyDateTo + "T23:59:59Z").toISOString() : null;

    try {
      // fetch up to 1000 rows for export
      const res = await bridge.call("/purchase-history", {
        bundle_id: historyBundleFilter || null,
        date_from: dateFromISO,
        date_to: dateToISO,
        page: 0,
        page_size: 1000,
      });
      const rows = res.items || [];
      const header = ["Order ID", "Bundle ID", "Item Count", "Discount Applied %", "Order Total", "Currency", "Order Placed", "Recorded At"];
      const csvRows = [header, ...rows.map((r) => [
        r.order_external_id,
        r.bundle_id,
        r.item_count,
        (r.discount_rate_applied / 100).toFixed(2),
        (r.order_total_minor_units / 100).toFixed(2),
        r.order_currency,
        r.order_placed_at,
        r.recorded_at,
      ])];
      const csv = csvRows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bundle-purchase-history-${new Date().toISOString().slice(0, 10)}.csv`;
      container.appendChild(a);
      a.click();
      container.removeChild(a);
      URL.revokeObjectURL(url);
      bridge.notify("Export downloaded", "success");
    } catch (_) {
      bridge.notify("Could not export history", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Export CSV"; }
    }
  }

  // ── initial load ──────────────────────────────────────────────────────────
  renderBundlesToolbar();
  renderBundlesList(); // show skeleton immediately
  loadBundles();
}