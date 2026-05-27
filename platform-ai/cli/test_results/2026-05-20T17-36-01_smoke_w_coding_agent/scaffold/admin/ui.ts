export function mount(container: HTMLElement, bridge: any): void {
  // ─── CSS ────────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .ba-page { padding: 16px; max-width: 1100px; }
    .ba-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
    .ba-toolbar input[type="search"] { padding: 6px 10px; border: 1px solid var(--p-color-border); border-radius: 4px; min-width: 220px; }
    .ba-toolbar select { padding: 6px 10px; border: 1px solid var(--p-color-border); border-radius: 4px; }
    .ba-table { width: 100%; border-collapse: collapse; }
    .ba-table th, .ba-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--p-color-border); font-size: 0.875rem; }
    .ba-table th { font-weight: 600; background: var(--p-color-bg-surface); }
    .ba-table tr:hover td { background: var(--p-color-bg-surface-hover); }
    .ba-table .ba-actions { display: flex; gap: 6px; }
    .ba-checkbox-col { width: 36px; }
    .ba-pagination { display: flex; gap: 8px; align-items: center; margin-top: 12px; justify-content: flex-end; }
    .ba-pagination span { font-size: 0.85rem; color: var(--p-color-text-subdued); }
    .ba-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1000; display: flex; align-items: center; justify-content: center; }
    .ba-modal { background: var(--p-color-bg-surface); border-radius: 8px; padding: 24px; width: 480px; max-width: 95vw; max-height: 85vh; overflow-y: auto; }
    .ba-modal h2 { margin: 0 0 16px; font-size: 1.1rem; }
    .ba-form-row { margin-bottom: 14px; }
    .ba-form-row label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px; }
    .ba-form-row input, .ba-form-row textarea, .ba-form-row select { width: 100%; padding: 7px 10px; border: 1px solid var(--p-color-border); border-radius: 4px; font-size: 0.875rem; box-sizing: border-box; }
    .ba-form-row textarea { resize: vertical; min-height: 72px; }
    .ba-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
    .ba-tabs { display: flex; gap: 0; border-bottom: 2px solid var(--p-color-border); margin-bottom: 16px; }
    .ba-tab { padding: 8px 18px; cursor: pointer; border: none; background: none; font-size: 0.9rem; color: var(--p-color-text-subdued); border-bottom: 2px solid transparent; margin-bottom: -2px; }
    .ba-tab.active { color: #008060; border-bottom-color: #008060; font-weight: 600; }
    .ba-tier-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .ba-tier-row input { flex: 1; padding: 6px 8px; border: 1px solid var(--p-color-border); border-radius: 4px; }
    .ba-variant-list { max-height: 200px; overflow-y: auto; border: 1px solid var(--p-color-border); border-radius: 4px; padding: 8px; margin-top: 4px; }
    .ba-variant-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--p-color-border); font-size: 0.82rem; }
    .ba-variant-item:last-child { border-bottom: none; }
    .ba-health-events { max-height: 220px; overflow-y: auto; font-size: 0.82rem; }
    .ba-health-event-row { padding: 6px 0; border-bottom: 1px solid var(--p-color-border); }
    .ba-purchase-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .ba-purchase-table th, .ba-purchase-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--p-color-border); }
    .ba-error-msg { color: var(--p-color-text-critical, #d72c0d); font-size: 0.85rem; margin-top: 8px; }
    .ba-info-msg { color: var(--p-color-text-subdued); font-size: 0.85rem; margin-top: 8px; }
    .ba-select-all-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; font-size: 0.85rem; }
    .ba-bulk-bar { display: none; gap: 8px; align-items: center; background: var(--p-color-bg-surface); border: 1px solid var(--p-color-border); border-radius: 6px; padding: 8px 14px; margin-bottom: 12px; }
    .ba-bulk-bar.visible { display: flex; }
  `;
  container.appendChild(style);

  // ─── State ───────────────────────────────────────────────────────────────────
  let bundles: any[] = [];
  let nextCursor: string | null = null;
  let totalCount = 0;
  let selectedIds = new Set<string>();
  let statusFilter = "all";
  let healthFilter = "all";
  let currentModal: HTMLElement | null = null;
  let cursorStack: string[] = [];
  let currentView: "bundles" | "history" = "bundles";

  // ─── Root layout ─────────────────────────────────────────────────────────────
  const page = document.createElement("div");
  page.className = "ba-page";
  container.appendChild(page);

  const tabs = document.createElement("div");
  tabs.className = "ba-tabs";
  tabs.innerHTML = `
    <button class="ba-tab active" data-view="bundles">Bundles</button>
    <button class="ba-tab" data-view="history">Purchase History</button>
  `;
  page.appendChild(tabs);

  const mainArea = document.createElement("div");
  page.appendChild(mainArea);

  tabs.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-view]") as HTMLElement | null;
    if (!btn) return;
    const view = btn.dataset.view as "bundles" | "history";
    tabs.querySelectorAll(".ba-tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    currentView = view;
    if (view === "bundles") renderBundlesView();
    else renderHistoryView();
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function formatDiscount(basisPoints: number): string {
    return `${(basisPoints / 100).toFixed(0)}%`;
  }

  function formatMoney(minorUnits: number, currency: string): string {
    return new Intl.NumberFormat(bridge.context.locale, {
      style: "currency",
      currency,
    }).format(minorUnits / 100);
  }

  function healthBadgeClass(status: string): string {
    if (status === "healthy") return "badge badge-success";
    if (status === "warned") return "badge badge-warning";
    return "badge badge-critical";
  }

  function openModal(el: HTMLElement): void {
    currentModal = el;
    container.appendChild(el);
  }

  function closeModal(): void {
    if (currentModal) {
      currentModal.remove();
      currentModal = null;
    }
  }

  function notify(msg: string, variant: "success" | "error" = "success"): void {
    bridge.notify(msg, variant);
  }

  // ─── Bundles View ─────────────────────────────────────────────────────────────

  function renderBundlesView(): void {
    mainArea.innerHTML = "";

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "ba-toolbar";
    toolbar.innerHTML = `
      <select id="ba-status-filter">
        <option value="all">All statuses</option>
        <option value="enabled">Enabled</option>
        <option value="disabled">Disabled</option>
      </select>
      <select id="ba-health-filter">
        <option value="all">All health</option>
        <option value="healthy">Healthy</option>
        <option value="warned">Warned</option>
        <option value="auto_disabled">Auto-disabled</option>
      </select>
      <button class="btn-primary" id="ba-create-btn">+ Create Bundle</button>
    `;
    mainArea.appendChild(toolbar);

    (toolbar.querySelector("#ba-status-filter") as HTMLSelectElement).value = statusFilter;
    (toolbar.querySelector("#ba-health-filter") as HTMLSelectElement).value = healthFilter;

    toolbar.querySelector("#ba-status-filter")!.addEventListener("change", (e) => {
      statusFilter = (e.target as HTMLSelectElement).value;
      cursorStack = [];
      nextCursor = null;
      loadBundles();
    });
    toolbar.querySelector("#ba-health-filter")!.addEventListener("change", (e) => {
      healthFilter = (e.target as HTMLSelectElement).value;
      cursorStack = [];
      nextCursor = null;
      loadBundles();
    });
    toolbar.querySelector("#ba-create-btn")!.addEventListener("click", () => openCreateModal());

    // Bulk bar
    const bulkBar = document.createElement("div");
    bulkBar.className = "ba-bulk-bar";
    bulkBar.id = "ba-bulk-bar";
    bulkBar.innerHTML = `
      <span id="ba-selected-count">0 selected</span>
      <button class="btn-primary" id="ba-bulk-enable-btn">Enable</button>
      <button class="btn-secondary" id="ba-bulk-disable-btn">Disable</button>
    `;
    mainArea.appendChild(bulkBar);

    bulkBar.querySelector("#ba-bulk-enable-btn")!.addEventListener("click", () => bulkSetStatus(true));
    bulkBar.querySelector("#ba-bulk-disable-btn")!.addEventListener("click", () => bulkSetStatus(false));

    // Table container
    const tableWrap = document.createElement("div");
    tableWrap.className = "shell-card";
    tableWrap.id = "ba-table-wrap";
    mainArea.appendChild(tableWrap);

    // Pagination
    const paginationEl = document.createElement("div");
    paginationEl.className = "ba-pagination";
    paginationEl.id = "ba-pagination";
    mainArea.appendChild(paginationEl);

    loadBundles();
  }

  async function loadBundles(cursor?: string): Promise<void> {
    const tableWrap = document.getElementById("ba-table-wrap");
    if (!tableWrap) return;
    tableWrap.innerHTML = `<div class="ba-info-msg" style="padding:16px">Loading...</div>`;

    const params: any = { status_filter: statusFilter, health_filter: healthFilter, page_size: 20 };
    if (cursor) params.cursor = cursor;

    try {
      const data = await bridge.call("/admin/bundles", params);
      bundles = data.bundles;
      nextCursor = data.next_cursor;
      totalCount = data.total_count;
      renderBundleTable(tableWrap);
      renderPagination(cursor);
    } catch (err) {
      tableWrap.innerHTML = `<div class="shell-error-banner">Failed to load bundles.</div>`;
    }
  }

  function renderBundleTable(wrap: HTMLElement): void {
    if (bundles.length === 0) {
      wrap.innerHTML = `<div class="ba-info-msg" style="padding:24px;text-align:center">No bundles found. Create your first bundle.</div>`;
      return;
    }

    const table = document.createElement("table");
    table.className = "ba-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th class="ba-checkbox-col"><input type="checkbox" id="ba-select-all"></th>
          <th>Title</th>
          <th>Mode</th>
          <th>Status</th>
          <th>Health</th>
          <th>Tiers</th>
          <th>Items</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="ba-bundle-tbody"></tbody>
    `;
    wrap.innerHTML = "";
    wrap.appendChild(table);

    const tbody = table.querySelector("#ba-bundle-tbody") as HTMLTableSectionElement;
    for (const bundle of bundles) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="checkbox" class="ba-bundle-check" data-id="${bundle.id}" ${selectedIds.has(bundle.id) ? "checked" : ""}></td>
        <td>${bundle.title}</td>
        <td><span class="badge">${bundle.mode}</span></td>
        <td><span class="badge ${bundle.enabled ? "badge-success" : ""}">${bundle.enabled ? "Enabled" : "Disabled"}</span></td>
        <td><span class="${healthBadgeClass(bundle.health_status)}">${bundle.health_status}</span></td>
        <td>${bundle.tier_count}</td>
        <td>${bundle.item_count}</td>
        <td class="ba-actions">
          <button class="btn-secondary" data-action="edit" data-id="${bundle.id}">Edit</button>
          <button class="btn-secondary" data-action="items" data-id="${bundle.id}">Items</button>
          <button class="btn-secondary" data-action="tiers" data-id="${bundle.id}">Tiers</button>
          <button class="btn-secondary" data-action="clone" data-id="${bundle.id}">Clone</button>
          <button class="btn-destructive" data-action="delete" data-id="${bundle.id}">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    // Select all
    const selectAllCb = table.querySelector("#ba-select-all") as HTMLInputElement;
    selectAllCb.addEventListener("change", () => {
      bundles.forEach((b) => {
        if (selectAllCb.checked) selectedIds.add(b.id);
        else selectedIds.delete(b.id);
      });
      table.querySelectorAll(".ba-bundle-check").forEach((cb) => {
        (cb as HTMLInputElement).checked = selectAllCb.checked;
      });
      updateBulkBar();
    });

    table.querySelectorAll(".ba-bundle-check").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = (e.target as HTMLInputElement).dataset.id!;
        if ((e.target as HTMLInputElement).checked) selectedIds.add(id);
        else selectedIds.delete(id);
        updateBulkBar();
      });
    });

    tbody.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
      if (!btn) return;
      const action = btn.dataset.action!;
      const id = btn.dataset.id!;
      const bundle = bundles.find((b) => b.id === id);
      if (!bundle) return;

      if (action === "edit") openEditModal(bundle);
      else if (action === "items") openItemsModal(bundle);
      else if (action === "tiers") openTiersModal(bundle);
      else if (action === "clone") cloneBundle(id);
      else if (action === "delete") confirmDelete(id, bundle.title);
    });
  }

  function updateBulkBar(): void {
    const bar = document.getElementById("ba-bulk-bar");
    const countEl = document.getElementById("ba-selected-count");
    if (!bar || !countEl) return;
    if (selectedIds.size > 0) {
      bar.classList.add("visible");
      countEl.textContent = `${selectedIds.size} selected`;
    } else {
      bar.classList.remove("visible");
    }
  }

  function renderPagination(cursor?: string): void {
    const el = document.getElementById("ba-pagination");
    if (!el) return;
    el.innerHTML = "";

    const info = document.createElement("span");
    info.textContent = `${totalCount} total`;
    el.appendChild(info);

    if (cursorStack.length > 0) {
      const prevBtn = document.createElement("button");
      prevBtn.className = "btn-secondary";
      prevBtn.textContent = "← Prev";
      prevBtn.addEventListener("click", () => {
        cursorStack.pop();
        const prevCursor = cursorStack[cursorStack.length - 1];
        loadBundles(prevCursor);
      });
      el.appendChild(prevBtn);
    }

    if (nextCursor) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "btn-secondary";
      nextBtn.textContent = "Next →";
      nextBtn.addEventListener("click", () => {
        if (cursor) cursorStack.push(cursor);
        loadBundles(nextCursor!);
      });
      el.appendChild(nextBtn);
    }
  }

  // ─── Create Bundle Modal ──────────────────────────────────────────────────────

  function openCreateModal(): void {
    const overlay = document.createElement("div");
    overlay.className = "ba-modal-overlay";
    overlay.innerHTML = `
      <div class="ba-modal">
        <h2>Create Bundle</h2>
        <div class="ba-form-row">
          <label>Title *</label>
          <input type="text" id="ba-new-title" placeholder="e.g. Summer Bundle" />
        </div>
        <div class="ba-form-row">
          <label>Description</label>
          <textarea id="ba-new-desc" placeholder="Optional description"></textarea>
        </div>
        <div class="ba-form-row">
          <label>Mode *</label>
          <select id="ba-new-mode">
            <option value="fixed">Fixed — predefined item set</option>
            <option value="flexible">Flexible — customer picks from pool</option>
          </select>
        </div>
        <div class="ba-error-msg" id="ba-create-error"></div>
        <div class="ba-modal-actions">
          <button class="btn-secondary" id="ba-create-cancel">Cancel</button>
          <button class="btn-primary" id="ba-create-save">Create</button>
        </div>
      </div>
    `;
    overlay.querySelector("#ba-create-cancel")!.addEventListener("click", () => overlay.remove());
    overlay.querySelector("#ba-create-save")!.addEventListener("click", async () => {
      const title = (overlay.querySelector("#ba-new-title") as HTMLInputElement).value.trim();
      const desc = (overlay.querySelector("#ba-new-desc") as HTMLTextAreaElement).value.trim();
      const mode = (overlay.querySelector("#ba-new-mode") as HTMLSelectElement).value;
      const errEl = overlay.querySelector("#ba-create-error") as HTMLElement;
      errEl.textContent = "";
      if (!title) { errEl.textContent = "Title is required."; return; }
      try {
        await bridge.call("/admin/bundles/create", { title, description: desc || undefined, mode });
        notify("Bundle created successfully!");
        overlay.remove();
        loadBundles();
      } catch {
        errEl.textContent = "Failed to create bundle. Please try again.";
      }
    });
    openModal(overlay);
  }

  // ─── Edit Bundle Modal ────────────────────────────────────────────────────────

  function openEditModal(bundle: any): void {
    bridge.saveBar.show("edit-bundle");
    const overlay = document.createElement("div");
    overlay.className = "ba-modal-overlay";
    overlay.innerHTML = `
      <div class="ba-modal">
        <h2>Edit Bundle</h2>
        <div class="ba-form-row">
          <label>Title *</label>
          <input type="text" id="ba-edit-title" value="${bundle.title}" />
        </div>
        <div class="ba-form-row">
          <label>Description</label>
          <textarea id="ba-edit-desc">${bundle.description ?? ""}</textarea>
        </div>
        <div class="ba-form-row">
          <label>Mode</label>
          <select id="ba-edit-mode">
            <option value="fixed" ${bundle.mode === "fixed" ? "selected" : ""}>Fixed</option>
            <option value="flexible" ${bundle.mode === "flexible" ? "selected" : ""}>Flexible</option>
          </select>
        </div>
        <div class="ba-form-row">
          <label>
            <input type="checkbox" id="ba-edit-enabled" ${bundle.enabled ? "checked" : ""} />
            Enabled
          </label>
        </div>
        <div class="ba-error-msg" id="ba-edit-error"></div>
        <div class="ba-modal-actions">
          <button class="btn-secondary" id="ba-edit-cancel">Cancel</button>
          <button class="btn-primary" id="ba-edit-save">Save</button>
        </div>
      </div>
    `;
    overlay.querySelector("#ba-edit-cancel")!.addEventListener("click", () => {
      bridge.saveBar.hide("edit-bundle");
      overlay.remove();
    });
    overlay.querySelector("#ba-edit-save")!.addEventListener("click", async () => {
      const title = (overlay.querySelector("#ba-edit-title") as HTMLInputElement).value.trim();
      const desc = (overlay.querySelector("#ba-edit-desc") as HTMLTextAreaElement).value.trim();
      const mode = (overlay.querySelector("#ba-edit-mode") as HTMLSelectElement).value;
      const enabled = (overlay.querySelector("#ba-edit-enabled") as HTMLInputElement).checked;
      const errEl = overlay.querySelector("#ba-edit-error") as HTMLElement;
      errEl.textContent = "";
      if (!title) { errEl.textContent = "Title is required."; return; }
      try {
        const resp = await bridge.call("/admin/bundles/update", {
          bundle_id: bundle.id, title, description: desc || null, mode, enabled,
        });
        if (resp.error === "cannot_enable_auto_disabled_bundle") {
          errEl.textContent = `Cannot enable: blocking variants ${(resp.blocking_variant_ids ?? []).join(", ")}`;
          return;
        }
        notify("Bundle updated!");
        bridge.saveBar.hide("edit-bundle");
        overlay.remove();
        loadBundles();
      } catch {
        errEl.textContent = "Failed to save. Please try again.";
      }
    });
    openModal(overlay);
  }

  // ─── Items Modal ──────────────────────────────────────────────────────────────

  function openItemsModal(bundle: any): void {
    const overlay = document.createElement("div");
    overlay.className = "ba-modal-overlay";
    overlay.innerHTML = `
      <div class="ba-modal">
        <h2>Bundle Items — ${bundle.title}</h2>
        <p style="font-size:0.85rem;color:var(--p-color-text-subdued)">Select products/variants to include in this bundle.</p>
        <div class="ba-form-row">
          <button class="btn-secondary" id="ba-pick-products">Pick Products / Variants</button>
        </div>
        <div class="ba-variant-list" id="ba-variant-list"><em style="color:var(--p-color-text-subdued)">No variants selected yet.</em></div>
        <div class="ba-error-msg" id="ba-items-error"></div>
        <div class="ba-modal-actions">
          <button class="btn-secondary" id="ba-items-cancel">Cancel</button>
          <button class="btn-primary" id="ba-items-save">Save Items</button>
        </div>
      </div>
    `;

    let selectedVariants: Array<{ variant_external_id: number; product_external_id: number; title: string }> = [];

    // Load existing items
    bridge.call("/admin/bundles/items", { bundle_id: bundle.id, page_size: 200 }).then((data: any) => {
      selectedVariants = (data.items || []).map((item: any) => ({
        variant_external_id: item.variant_external_id,
        product_external_id: item.product_external_id,
        title: `Variant ${item.variant_external_id}`,
      }));
      refreshVariantList();
    }).catch(() => {});

    function refreshVariantList(): void {
      const listEl = overlay.querySelector("#ba-variant-list") as HTMLElement;
      if (selectedVariants.length === 0) {
        listEl.innerHTML = `<em style="color:var(--p-color-text-subdued)">No variants selected yet.</em>`;
        return;
      }
      listEl.innerHTML = "";
      for (const v of selectedVariants) {
        const row = document.createElement("div");
        row.className = "ba-variant-item";
        row.innerHTML = `
          <span>Variant ID: ${v.variant_external_id} (Product: ${v.product_external_id})</span>
          <button class="btn-destructive" data-vid="${v.variant_external_id}" style="padding:2px 8px;font-size:0.78rem">✕</button>
        `;
        row.querySelector("button")!.addEventListener("click", () => {
          selectedVariants = selectedVariants.filter((sv) => sv.variant_external_id !== v.variant_external_id);
          refreshVariantList();
        });
        listEl.appendChild(row);
      }
    }

    overlay.querySelector("#ba-pick-products")!.addEventListener("click", async () => {
      const picked = await bridge.pickResource({ type: "variant" });
      if (!picked || picked.length === 0) return;
      for (const p of picked) {
        // Extract numeric IDs from GIDs: gid://shopify/ProductVariant/123
        const variantMatch = /\/ProductVariant\/(\d+)/.exec(p.id);
        const productMatch = /\/Product\/(\d+)/.exec(p.id);
        const vid = variantMatch ? parseInt(variantMatch[1], 10) : null;
        const pid = productMatch ? parseInt(productMatch[1], 10) : null;
        if (vid && !selectedVariants.find((sv) => sv.variant_external_id === vid)) {
          // For product ID from variant picker, derive from admin_graphql_api_id later
          // use product_id from picker id if available
          selectedVariants.push({ variant_external_id: vid, product_external_id: pid ?? 0, title: p.title });
        }
      }
      refreshVariantList();
    });

    overlay.querySelector("#ba-items-cancel")!.addEventListener("click", () => overlay.remove());
    overlay.querySelector("#ba-items-save")!.addEventListener("click", async () => {
      const errEl = overlay.querySelector("#ba-items-error") as HTMLElement;
      errEl.textContent = "";
      try {
        const resp = await bridge.call("/admin/bundles/items/save", {
          bundle_id: bundle.id,
          variant_items: selectedVariants.map((v) => ({
            variant_external_id: v.variant_external_id,
            product_external_id: v.product_external_id,
          })),
        });
        notify(`Saved ${resp.saved_count} item(s).`);
        overlay.remove();
        loadBundles();
      } catch {
        errEl.textContent = "Failed to save items.";
      }
    });

    openModal(overlay);
  }

  // ─── Tiers Modal ──────────────────────────────────────────────────────────────

  function openTiersModal(bundle: any): void {
    const overlay = document.createElement("div");
    overlay.className = "ba-modal-overlay";
    overlay.innerHTML = `
      <div class="ba-modal">
        <h2>Discount Tiers — ${bundle.title}</h2>
        <p style="font-size:0.85rem;color:var(--p-color-text-subdued)">Each tier: minimum item count and discount %. Order determines display priority.</p>
        <div id="ba-tiers-list"></div>
        <button class="btn-secondary" id="ba-add-tier" style="margin-top:8px">+ Add Tier</button>
        <div class="ba-error-msg" id="ba-tiers-error"></div>
        <div class="ba-modal-actions">
          <button class="btn-secondary" id="ba-tiers-cancel">Cancel</button>
          <button class="btn-primary" id="ba-tiers-save">Save Tiers</button>
        </div>
      </div>
    `;

    let tiers: Array<{ minimum_item_count: number; discount_rate: number }> = [];

    bridge.call("/admin/bundles/tiers", { bundle_id: bundle.id }).then((data: any) => {
      tiers = (data.tiers || []).map((t: any) => ({
        minimum_item_count: t.minimum_item_count,
        // discount_rate is stored as basis points; show as percent to user
        discount_rate: t.discount_rate,
      }));
      renderTierRows();
    }).catch(() => {});

    function renderTierRows(): void {
      const listEl = overlay.querySelector("#ba-tiers-list") as HTMLElement;
      listEl.innerHTML = "";
      if (tiers.length === 0) {
        listEl.innerHTML = `<em style="color:var(--p-color-text-subdued);font-size:0.85rem">No tiers yet.</em>`;
        return;
      }
      tiers.forEach((tier, idx) => {
        const row = document.createElement("div");
        row.className = "ba-tier-row";
        const pct = (tier.discount_rate / 100).toFixed(0);
        row.innerHTML = `
          <span style="font-size:0.8rem;color:var(--p-color-text-subdued);min-width:24px">${idx + 1}.</span>
          <input type="number" min="1" placeholder="Min items" value="${tier.minimum_item_count}" data-field="min" data-idx="${idx}" />
          <input type="number" min="0" max="100" step="0.5" placeholder="Discount %" value="${pct}" data-field="pct" data-idx="${idx}" />
          <button class="btn-destructive" data-del="${idx}" style="padding:4px 8px">✕</button>
        `;
        row.querySelector(`[data-del="${idx}"]`)!.addEventListener("click", () => {
          tiers.splice(idx, 1);
          renderTierRows();
        });
        listEl.appendChild(row);
      });

      listEl.querySelectorAll("input[data-field='min']").forEach((input) => {
        input.addEventListener("change", (e) => {
          const idx = parseInt((e.target as HTMLInputElement).dataset.idx!);
          tiers[idx].minimum_item_count = parseInt((e.target as HTMLInputElement).value) || 1;
        });
      });
      listEl.querySelectorAll("input[data-field='pct']").forEach((input) => {
        input.addEventListener("change", (e) => {
          const idx = parseInt((e.target as HTMLInputElement).dataset.idx!);
          const pct = parseFloat((e.target as HTMLInputElement).value) || 0;
          tiers[idx].discount_rate = Math.round(pct * 100);
        });
      });
    }

    overlay.querySelector("#ba-add-tier")!.addEventListener("click", () => {
      tiers.push({ minimum_item_count: 1, discount_rate: 1000 });
      renderTierRows();
    });

    overlay.querySelector("#ba-tiers-cancel")!.addEventListener("click", () => overlay.remove());
    overlay.querySelector("#ba-tiers-save")!.addEventListener("click", async () => {
      const errEl = overlay.querySelector("#ba-tiers-error") as HTMLElement;
      errEl.textContent = "";
      if (tiers.some((t) => t.minimum_item_count < 1)) {
        errEl.textContent = "All tiers must have minimum item count ≥ 1.";
        return;
      }
      try {
        const resp = await bridge.call("/admin/bundles/tiers/save", {
          bundle_id: bundle.id,
          tiers: tiers.map((t) => ({ minimum_item_count: t.minimum_item_count, discount_rate: t.discount_rate })),
        });
        notify(`Saved ${resp.saved_count} tier(s).`);
        overlay.remove();
        loadBundles();
      } catch {
        errEl.textContent = "Failed to save tiers.";
      }
    });

    openModal(overlay);
  }

  // ─── Clone Bundle ─────────────────────────────────────────────────────────────

  async function cloneBundle(bundleId: string): Promise<void> {
    try {
      const resp = await bridge.call("/admin/bundles/clone", { source_bundle_id: bundleId });
      notify(`Bundle cloned! New bundle ID: ${resp.new_bundle_id}`);
      loadBundles();
    } catch {
      notify("Failed to clone bundle.", "error");
    }
  }

  // ─── Delete Bundle ────────────────────────────────────────────────────────────

  function confirmDelete(bundleId: string, title: string): void {
    const overlay = document.createElement("div");
    overlay.className = "ba-modal-overlay";
    overlay.innerHTML = `
      <div class="ba-modal">
        <h2>Delete Bundle</h2>
        <p>Are you sure you want to permanently delete <strong>${title}</strong>? This cannot be undone.</p>
        <div class="ba-modal-actions">
          <button class="btn-secondary" id="ba-del-cancel">Cancel</button>
          <button class="btn-destructive" id="ba-del-confirm">Delete</button>
        </div>
      </div>
    `;
    overlay.querySelector("#ba-del-cancel")!.addEventListener("click", () => overlay.remove());
    overlay.querySelector("#ba-del-confirm")!.addEventListener("click", async () => {
      try {
        await bridge.call("/admin/bundles/remove", { bundle_id: bundleId });
        notify("Bundle deleted.");
        overlay.remove();
        loadBundles();
      } catch {
        notify("Failed to delete bundle.", "error");
        overlay.remove();
      }
    });
    openModal(overlay);
  }

  // ─── Bulk status ──────────────────────────────────────────────────────────────

  async function bulkSetStatus(enabled: boolean): Promise<void> {
    if (selectedIds.size === 0) return;
    try {
      const resp = await bridge.call("/admin/bundles/bulk-status", {
        bundle_ids: Array.from(selectedIds),
        enabled,
      });
      notify(`${resp.updated_count} bundle(s) ${enabled ? "enabled" : "disabled"}. ${resp.skipped_count} skipped.`);
      selectedIds.clear();
      loadBundles();
    } catch {
      notify("Bulk status update failed.", "error");
    }
  }

  // ─── Purchase History View ────────────────────────────────────────────────────

  function renderHistoryView(): void {
    mainArea.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "ba-toolbar";
    toolbar.innerHTML = `
      <input type="date" id="ba-hist-from" placeholder="From date" />
      <input type="date" id="ba-hist-to" placeholder="To date" />
      <button class="btn-primary" id="ba-hist-search">Search</button>
    `;
    mainArea.appendChild(toolbar);

    const tableWrap = document.createElement("div");
    tableWrap.className = "shell-card";
    tableWrap.id = "ba-hist-wrap";
    mainArea.appendChild(tableWrap);

    const histPagination = document.createElement("div");
    histPagination.className = "ba-pagination";
    histPagination.id = "ba-hist-pagination";
    mainArea.appendChild(histPagination);

    let histCursorStack: string[] = [];
    let histNextCursor: string | null = null;

    async function loadHistory(cursor?: string): Promise<void> {
      const wrap = document.getElementById("ba-hist-wrap");
      if (!wrap) return;
      wrap.innerHTML = `<div class="ba-info-msg" style="padding:16px">Loading...</div>`;

      const dateFrom = (toolbar.querySelector("#ba-hist-from") as HTMLInputElement).value;
      const dateTo = (toolbar.querySelector("#ba-hist-to") as HTMLInputElement).value;
      const params: any = { page_size: 50 };
      if (dateFrom) params.date_from = new Date(dateFrom).toISOString();
      if (dateTo) params.date_to = new Date(dateTo + "T23:59:59").toISOString();
      if (cursor) params.cursor = cursor;

      try {
        const data = await bridge.call("/admin/purchase-history", params);
        histNextCursor = data.next_cursor;
        renderHistoryTable(wrap, data.records, data.total_count);
        renderHistPagination(histPagination, histCursorStack, histNextCursor, cursor, loadHistory, (s) => { histCursorStack = s; });
      } catch {
        wrap.innerHTML = `<div class="shell-error-banner">Failed to load purchase history.</div>`;
      }
    }

    toolbar.querySelector("#ba-hist-search")!.addEventListener("click", () => {
      histCursorStack = [];
      loadHistory();
    });
    loadHistory();
  }

  function renderHistoryTable(wrap: HTMLElement, records: any[], total: number): void {
    if (records.length === 0) {
      wrap.innerHTML = `<div class="ba-info-msg" style="padding:24px;text-align:center">No purchase records found.</div>`;
      return;
    }
    const table = document.createElement("table");
    table.className = "ba-purchase-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Order ID</th>
          <th>Bundle ID</th>
          <th>Order Date</th>
          <th>Items</th>
          <th>Discount</th>
          <th>Order Total</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody")!;
    for (const r of records) {
      const tr = document.createElement("tr");
      const dt = new Intl.DateTimeFormat(bridge.context.locale, {
        dateStyle: "medium", timeStyle: "short",
      }).format(new Date(r.order_placed_at));
      tr.innerHTML = `
        <td>${r.order_external_id}</td>
        <td><span style="font-family:monospace;font-size:0.78rem">${(r.bundle_id as string).slice(0, 8)}…</span></td>
        <td>${dt}</td>
        <td>${r.item_count}</td>
        <td>${(r.discount_rate_applied / 100).toFixed(0)}%</td>
        <td>${formatMoney(r.order_total, r.order_currency)}</td>
      `;
      tbody.appendChild(tr);
    }
    wrap.innerHTML = "";
    wrap.appendChild(table);
    const info = document.createElement("div");
    info.className = "ba-info-msg";
    info.style.padding = "8px 12px";
    info.textContent = `${total} total records`;
    wrap.appendChild(info);
  }

  function renderHistPagination(
    el: HTMLElement,
    stack: string[],
    next: string | null,
    currentCursor: string | undefined,
    load: (cursor?: string) => void,
    setStack: (s: string[]) => void
  ): void {
    el.innerHTML = "";
    if (stack.length > 0) {
      const prevBtn = document.createElement("button");
      prevBtn.className = "btn-secondary";
      prevBtn.textContent = "← Prev";
      prevBtn.addEventListener("click", () => {
        stack.pop();
        setStack([...stack]);
        load(stack[stack.length - 1]);
      });
      el.appendChild(prevBtn);
    }
    if (next) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "btn-secondary";
      nextBtn.textContent = "Next →";
      nextBtn.addEventListener("click", () => {
        if (currentCursor) { stack.push(currentCursor); setStack([...stack]); }
        load(next);
      });
      el.appendChild(nextBtn);
    }
  }

  // ─── Initial render ───────────────────────────────────────────────────────────
  renderBundlesView();
}
