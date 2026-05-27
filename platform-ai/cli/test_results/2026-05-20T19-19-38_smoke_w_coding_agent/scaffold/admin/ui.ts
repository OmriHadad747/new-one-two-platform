export function mount(container: HTMLElement, bridge: any): void {
  // ─── State ───────────────────────────────────────────────────────────────
  type BundleMode = "fixed" | "flexible";
  type BundleHealthStatus = "healthy" | "warned" | "auto_disabled";

  interface Bundle {
    id: string;
    title: string;
    description: string | null;
    mode: BundleMode;
    enabled: boolean;
    health_status: BundleHealthStatus;
    tier_count: number;
    item_count: number;
    created_at: string;
    updated_at: string;
  }

  interface BundleTier {
    id: string;
    bundle_id: string;
    minimum_item_count: number;
    discount_rate: number;
    display_order: number;
  }

  interface BundleItem {
    id: string;
    bundle_id: string;
    variant_external_id: number;
    product_external_id: number;
    observed_availability: string;
  }

  interface PurchaseRecord {
    id: string;
    bundle_id: string;
    bundle_title: string;
    order_external_id: number;
    order_placed_at: string;
    item_count: number;
    discount_rate_applied: number;
    order_total: number;
    currency_code: string;
  }

  type View = "list" | "edit_bundle" | "edit_items" | "edit_tiers" | "purchase_history";

  let currentView: View = "list";
  let bundles: Bundle[] = [];
  let selectedBundleIds: Set<string> = new Set();
  let currentBundle: Bundle | null = null;
  let bundleTiers: BundleTier[] = [];
  let bundleItems: BundleItem[] = [];
  let purchaseRecords: PurchaseRecord[] = [];
  let purchaseNextCursor: string | null = null;
  let listNextCursor: string | null = null;
  let listTotalCount = 0;
  let isDirty = false;

  // Tier editing state
  let pendingTiers: Array<{ minimum_item_count: number; discount_rate: number }> = [];

  // ─── Styles ───────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bundle-app { font-family: var(--p-font-family-sans, sans-serif); padding: 16px; }
    .bundle-app .top-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .bundle-app .top-bar h1 { margin: 0; font-size: 1.25rem; font-weight: 600; flex: 1; }
    .bundle-app .bundle-table { width: 100%; border-collapse: collapse; }
    .bundle-app .bundle-table th, .bundle-app .bundle-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--p-color-border, #e1e3e5); font-size: 0.875rem; }
    .bundle-app .bundle-table th { background: var(--p-color-bg-surface, #f6f6f7); font-weight: 600; }
    .bundle-app .bundle-table tr:hover td { background: var(--p-color-bg-surface-hover, #f1f2f3); }
    .bundle-app .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 500; }
    .bundle-app .badge-success { background: #d4edda; color: #155724; }
    .bundle-app .badge-warning { background: #fff3cd; color: #856404; }
    .bundle-app .badge-critical { background: #f8d7da; color: #721c24; }
    .bundle-app .badge-default { background: #e2e3e5; color: #383d41; }
    .bundle-app .actions { display: flex; gap: 6px; }
    .bundle-app .form-group { margin-bottom: 14px; }
    .bundle-app .form-group label { display: block; margin-bottom: 4px; font-size: 0.875rem; font-weight: 500; }
    .bundle-app .form-group input, .bundle-app .form-group select, .bundle-app .form-group textarea {
      width: 100%; padding: 8px; border: 1px solid var(--p-color-border, #c9cccf); border-radius: 4px;
      font-size: 0.875rem; box-sizing: border-box;
    }
    .bundle-app .form-group textarea { min-height: 80px; resize: vertical; }
    .bundle-app .tier-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .bundle-app .tier-row input { width: 120px; padding: 6px 8px; border: 1px solid var(--p-color-border, #c9cccf); border-radius: 4px; font-size: 0.875rem; }
    .bundle-app .section-header { display: flex; align-items: center; margin-bottom: 12px; gap: 8px; }
    .bundle-app .section-header h2 { margin: 0; font-size: 1.1rem; font-weight: 600; }
    .bundle-app .pagination { display: flex; align-items: center; gap: 10px; margin-top: 14px; font-size: 0.875rem; color: var(--p-color-text-subdued, #6d7175); }
    .bundle-app .health-events { margin-top: 16px; }
    .bundle-app .health-events table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    .bundle-app .health-events td, .bundle-app .health-events th { padding: 6px 10px; border-bottom: 1px solid var(--p-color-border, #e1e3e5); }
    .bundle-app .filter-row { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
    .bundle-app .filter-row select, .bundle-app .filter-row input { padding: 6px 8px; border: 1px solid var(--p-color-border, #c9cccf); border-radius: 4px; font-size: 0.875rem; }
    .bundle-app .bulk-bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #f0f4ff; border-radius: 4px; margin-bottom: 10px; font-size: 0.875rem; }
    @media (max-width: 600px) {
      .bundle-app .bundle-table { font-size: 0.75rem; }
      .bundle-app .bundle-table th:nth-child(3), .bundle-app .bundle-table td:nth-child(3),
      .bundle-app .bundle-table th:nth-child(5), .bundle-app .bundle-table td:nth-child(5) { display: none; }
    }
  `;
  container.appendChild(style);

  const app = document.createElement("div");
  app.className = "bundle-app";
  container.appendChild(app);

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function formatDiscount(basisPoints: number): string {
    return (basisPoints / 100).toFixed(0) + "%";
  }

  function formatMoney(minorUnits: number, currencyCode: string): string {
    return new Intl.NumberFormat(bridge.context.locale, {
      style: "currency",
      currency: currencyCode,
    }).format(minorUnits / 100);
  }

  function formatDate(iso: string): string {
    return new Intl.DateTimeFormat(bridge.context.locale, {
      dateStyle: "medium",
    }).format(new Date(iso));
  }

  function healthBadge(status: BundleHealthStatus): string {
    const cls =
      status === "healthy" ? "badge-success" :
      status === "warned" ? "badge-warning" : "badge-critical";
    const label =
      status === "healthy" ? "Healthy" :
      status === "warned" ? "Warning" : "Auto-Disabled";
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function enabledBadge(enabled: boolean): string {
    return enabled
      ? `<span class="badge badge-success">Active</span>`
      : `<span class="badge badge-default">Disabled</span>`;
  }

  function modeBadge(mode: BundleMode): string {
    return mode === "fixed"
      ? `<span class="badge badge-default">Fixed</span>`
      : `<span class="badge badge-default">Flexible</span>`;
  }

  function notify(msg: string, variant: "success" | "error" = "success"): void {
    bridge.notify(msg, variant);
  }

  function markDirty(): void {
    isDirty = true;
    bridge.saveBar.show("bundle-edit");
  }

  function markClean(): void {
    isDirty = false;
    bridge.saveBar.hide("bundle-edit");
  }

  // ─── API calls ────────────────────────────────────────────────────────────
  async function fetchBundles(cursor?: string): Promise<void> {
    const statusFilter = (app.querySelector("#status-filter") as HTMLSelectElement)?.value ?? "all";
    const healthFilter = (app.querySelector("#health-filter") as HTMLSelectElement)?.value ?? "all";
    const resp = await bridge.call("/admin/bundles", { status_filter: statusFilter, health_filter: healthFilter, cursor });
    bundles = resp.bundles;
    listNextCursor = resp.next_cursor;
    listTotalCount = resp.total_count;
  }

  async function fetchBundleTiers(bundleId: string): Promise<void> {
    const resp = await bridge.call("/admin/bundles/tiers", { bundle_id: bundleId });
    bundleTiers = resp.tiers;
  }

  async function fetchBundleItems(bundleId: string): Promise<void> {
    const resp = await bridge.call("/admin/bundles/items", { bundle_id: bundleId });
    bundleItems = resp.items;
  }

  async function fetchPurchaseHistory(cursor?: string): Promise<void> {
    const bundleId = currentBundle?.id;
    const resp = await bridge.call("/admin/purchase-history", { bundle_id: bundleId, cursor, page_size: 20 });
    purchaseRecords = cursor ? [...purchaseRecords, ...resp.records] : resp.records;
    purchaseNextCursor = resp.next_cursor;
  }

  // ─── Views ────────────────────────────────────────────────────────────────
  function renderListView(): void {
    app.innerHTML = `
      <div class="top-bar">
        <h1>Product Bundles</h1>
        <button class="btn-primary" id="create-btn">+ New Bundle</button>
        <button class="btn-secondary" id="history-btn">Purchase History</button>
      </div>
      <div class="filter-row">
        <label for="status-filter">Status:</label>
        <select id="status-filter">
          <option value="all">All</option>
          <option value="enabled">Active</option>
          <option value="disabled">Disabled</option>
        </select>
        <label for="health-filter">Health:</label>
        <select id="health-filter">
          <option value="all">All</option>
          <option value="healthy">Healthy</option>
          <option value="warned">Warning</option>
          <option value="auto_disabled">Auto-Disabled</option>
        </select>
        <button class="btn-secondary" id="apply-filter-btn">Filter</button>
      </div>
      <div id="bulk-bar" class="bulk-bar" style="display:none;">
        <span id="bulk-count">0 selected</span>
        <button class="btn-secondary" id="bulk-enable-btn">Enable</button>
        <button class="btn-secondary" id="bulk-disable-btn">Disable</button>
        <button class="btn-destructive" id="bulk-delete-btn">Delete</button>
      </div>
      <div id="list-content">Loading...</div>
    `;

    app.querySelector("#create-btn")!.addEventListener("click", () => showCreateModal());
    app.querySelector("#history-btn")!.addEventListener("click", () => {
      currentBundle = null;
      currentView = "purchase_history";
      renderPurchaseHistoryView();
    });
    app.querySelector("#apply-filter-btn")!.addEventListener("click", () => {
      fetchBundles().then(() => renderBundleTable());
    });
    app.querySelector("#bulk-enable-btn")!.addEventListener("click", () => bulkSetStatus(true));
    app.querySelector("#bulk-disable-btn")!.addEventListener("click", () => bulkSetStatus(false));
    app.querySelector("#bulk-delete-btn")!.addEventListener("click", bulkDelete);

    fetchBundles().then(() => renderBundleTable());
  }

  function renderBundleTable(): void {
    const content = app.querySelector("#list-content")!;
    if (bundles.length === 0) {
      content.innerHTML = `<div class="shell-card" style="padding:32px;text-align:center;color:var(--p-color-text-subdued);">
        No bundles yet. Click <strong>+ New Bundle</strong> to create one.
      </div>`;
      return;
    }

    const rows = bundles.map((b) => `
      <tr>
        <td><input type="checkbox" class="bundle-check" data-id="${b.id}"></td>
        <td>${escHtml(b.title)}</td>
        <td>${modeBadge(b.mode)}</td>
        <td>${enabledBadge(b.enabled)}</td>
        <td>${healthBadge(b.health_status)}</td>
        <td>${b.tier_count} tiers / ${b.item_count} items</td>
        <td>${formatDate(b.created_at)}</td>
        <td class="actions">
          <button class="btn-secondary btn-sm edit-btn" data-id="${b.id}">Edit</button>
          <button class="btn-secondary btn-sm clone-btn" data-id="${b.id}">Clone</button>
          <button class="btn-destructive btn-sm delete-btn" data-id="${b.id}">Delete</button>
        </td>
      </tr>
    `).join("");

    content.innerHTML = `
      <table class="bundle-table">
        <thead>
          <tr>
            <th><input type="checkbox" id="select-all"></th>
            <th>Title</th>
            <th>Mode</th>
            <th>Status</th>
            <th>Health</th>
            <th>Content</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pagination">
        <span>Showing ${bundles.length} of ${listTotalCount}</span>
        ${listNextCursor ? `<button class="btn-secondary" id="load-more-btn">Load more</button>` : ""}
      </div>
    `;

    // Select-all checkbox
    content.querySelector("#select-all")!.addEventListener("change", (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      content.querySelectorAll<HTMLInputElement>(".bundle-check").forEach((cb) => {
        cb.checked = checked;
        if (checked) selectedBundleIds.add(cb.dataset.id!);
        else selectedBundleIds.delete(cb.dataset.id!);
      });
      updateBulkBar();
    });

    content.querySelectorAll<HTMLInputElement>(".bundle-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selectedBundleIds.add(cb.dataset.id!);
        else selectedBundleIds.delete(cb.dataset.id!);
        updateBulkBar();
      });
    });

    content.querySelectorAll<HTMLButtonElement>(".edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const bundle = bundles.find((b) => b.id === btn.dataset.id);
        if (bundle) openBundleEditor(bundle);
      });
    });

    content.querySelectorAll<HTMLButtonElement>(".clone-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await bridge.call("/admin/bundles/clone", { source_bundle_id: btn.dataset.id });
        notify("Bundle cloned successfully");
        await fetchBundles();
        renderBundleTable();
      });
    });

    content.querySelectorAll<HTMLButtonElement>(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this bundle? This cannot be undone.")) return;
        await bridge.call("/admin/bundles/remove", { bundle_id: btn.dataset.id });
        notify("Bundle deleted");
        await fetchBundles();
        renderBundleTable();
      });
    });

    const loadMoreBtn = content.querySelector("#load-more-btn");
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", () => {
        fetchBundles(listNextCursor ?? undefined).then(() => renderBundleTable());
      });
    }
  }

  function updateBulkBar(): void {
    const bar = app.querySelector<HTMLElement>("#bulk-bar")!;
    const count = app.querySelector("#bulk-count")!;
    if (selectedBundleIds.size > 0) {
      bar.style.display = "flex";
      count.textContent = `${selectedBundleIds.size} selected`;
    } else {
      bar.style.display = "none";
    }
  }

  async function bulkSetStatus(enabled: boolean): Promise<void> {
    if (selectedBundleIds.size === 0) return;
    const resp = await bridge.call("/admin/bundles/bulk-status", {
      bundle_ids: [...selectedBundleIds],
      enabled,
    });
    notify(`${resp.updated_count} bundle(s) ${enabled ? "enabled" : "disabled"}. ${resp.skipped_count} skipped.`);
    selectedBundleIds.clear();
    await fetchBundles();
    renderBundleTable();
  }

  async function bulkDelete(): Promise<void> {
    if (selectedBundleIds.size === 0) return;
    if (!confirm(`Delete ${selectedBundleIds.size} bundle(s)? This cannot be undone.`)) return;
    for (const id of selectedBundleIds) {
      await bridge.call("/admin/bundles/remove", { bundle_id: id });
    }
    notify(`${selectedBundleIds.size} bundle(s) deleted`);
    selectedBundleIds.clear();
    await fetchBundles();
    renderBundleTable();
  }

  function showCreateModal(): void {
    const modal = document.createElement("div");
    modal.style.cssText =
      "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;";
    modal.innerHTML = `
      <div class="shell-card" style="background:#fff;padding:24px;border-radius:8px;min-width:320px;max-width:480px;width:90%;">
        <h2 style="margin:0 0 16px;">New Bundle</h2>
        <form id="create-form">
          <div class="form-group">
            <label for="new-title">Title *</label>
            <input id="new-title" type="text" required placeholder="e.g. Summer Starter Pack">
          </div>
          <div class="form-group">
            <label for="new-mode">Mode *</label>
            <select id="new-mode">
              <option value="flexible">Flexible (customer picks from pool)</option>
              <option value="fixed">Fixed (predefined set)</option>
            </select>
          </div>
          <div class="form-group">
            <label for="new-desc">Description</label>
            <textarea id="new-desc" placeholder="Optional description..."></textarea>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button type="button" class="btn-secondary" id="cancel-btn">Cancel</button>
            <button type="submit" class="btn-primary">Create Bundle</button>
          </div>
        </form>
      </div>
    `;
    container.appendChild(modal);

    modal.querySelector("#cancel-btn")!.addEventListener("click", () => modal.remove());
    modal.querySelector<HTMLFormElement>("#create-form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = (modal.querySelector("#new-title") as HTMLInputElement).value.trim();
      const mode = (modal.querySelector("#new-mode") as HTMLSelectElement).value;
      const description = (modal.querySelector("#new-desc") as HTMLTextAreaElement).value.trim();
      if (!title) return;
      const resp = await bridge.call("/admin/bundles/create", { title, mode, description: description || undefined });
      modal.remove();
      notify("Bundle created");
      await fetchBundles();
      renderBundleTable();
      // Open the new bundle for editing
      const allResp = await bridge.call("/admin/bundles", { status_filter: "all" });
      const newBundle = allResp.bundles.find((b: Bundle) => b.id === resp.bundle_id);
      if (newBundle) openBundleEditor(newBundle);
    });
  }

  function openBundleEditor(bundle: Bundle): void {
    currentBundle = bundle;
    currentView = "edit_bundle";
    renderBundleEditor();
  }

  function renderBundleEditor(): void {
    if (!currentBundle) return;
    const b = currentBundle;

    app.innerHTML = `
      <div class="top-bar">
        <button class="btn-secondary" id="back-btn">← Back</button>
        <h1>${escHtml(b.title)}</h1>
        <span style="color:var(--p-color-text-subdued);font-size:0.875rem;">${b.id}</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <button class="btn-primary" id="tab-basic" data-tab="basic">Basic Info</button>
        <button class="btn-secondary" id="tab-items" data-tab="items">Items (${b.item_count})</button>
        <button class="btn-secondary" id="tab-tiers" data-tab="tiers">Tiers (${b.tier_count})</button>
        <button class="btn-secondary" id="tab-history" data-tab="history">Purchase History</button>
      </div>
      <div id="tab-content"></div>
    `;

    app.querySelector("#back-btn")!.addEventListener("click", () => {
      markClean();
      currentView = "list";
      renderListView();
    });

    app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab as string));
    });

    switchTab("basic");
  }

  function switchTab(tab: string): void {
    app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
      btn.className = btn.dataset.tab === tab ? "btn-primary" : "btn-secondary";
    });
    const content = app.querySelector("#tab-content")!;

    if (tab === "basic") renderBasicTab(content);
    else if (tab === "items") renderItemsTab(content);
    else if (tab === "tiers") renderTiersTab(content);
    else if (tab === "history") renderHistoryTab(content);
  }

  function renderBasicTab(container: Element): void {
    if (!currentBundle) return;
    const b = currentBundle;

    container.innerHTML = `
      <div class="shell-card" style="padding:20px;">
        <form id="basic-form">
          <div class="form-group">
            <label>Title *</label>
            <input id="edit-title" type="text" value="${escHtml(b.title)}" required>
          </div>
          <div class="form-group">
            <label>Mode</label>
            <select id="edit-mode">
              <option value="flexible" ${b.mode === "flexible" ? "selected" : ""}>Flexible</option>
              <option value="fixed" ${b.mode === "fixed" ? "selected" : ""}>Fixed</option>
            </select>
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea id="edit-desc">${escHtml(b.description ?? "")}</textarea>
          </div>
          <div class="form-group">
            <label>
              <input type="checkbox" id="edit-enabled" ${b.enabled ? "checked" : ""}>
              Active (visible to customers)
            </label>
          </div>
          ${b.health_status !== "healthy" ? `
            <div class="shell-error-banner" style="margin-bottom:12px;">
              Health: ${healthBadge(b.health_status)} — ${b.health_status === "auto_disabled" ? "Bundle auto-disabled due to unavailable variants. Fix variants before enabling." : "Some variants are out of stock. Bundle is still operational but customer choices are limited."}
            </div>
          ` : ""}
          <button type="submit" class="btn-primary">Save Changes</button>
        </form>
      </div>
    `;

    const form = container.querySelector<HTMLFormElement>("#basic-form")!;
    form.querySelector("#edit-title")!.addEventListener("input", markDirty);
    form.querySelector("#edit-mode")!.addEventListener("change", markDirty);
    form.querySelector("#edit-desc")!.addEventListener("input", markDirty);
    form.querySelector("#edit-enabled")!.addEventListener("change", markDirty);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = (form.querySelector("#edit-title") as HTMLInputElement).value.trim();
      const mode = (form.querySelector("#edit-mode") as HTMLSelectElement).value;
      const description = (form.querySelector("#edit-desc") as HTMLTextAreaElement).value.trim();
      const enabled = (form.querySelector("#edit-enabled") as HTMLInputElement).checked;

      try {
        const resp = await bridge.call("/admin/bundles/update", {
          bundle_id: currentBundle!.id,
          title,
          mode,
          description: description || null,
          enabled,
        });
        currentBundle = { ...currentBundle!, title, mode: mode as BundleMode, description: description || null, enabled, updated_at: resp.updated_at };
        markClean();
        notify("Bundle saved");
        renderBundleEditor();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        notify(message || "Failed to save bundle", "error");
      }
    });
  }

  function renderItemsTab(container: Element): void {
    if (!currentBundle) return;
    fetchBundleItems(currentBundle.id).then(() => {
      const rows = bundleItems.map((item) => `
        <tr>
          <td>${item.variant_external_id}</td>
          <td>${item.product_external_id}</td>
          <td>${item.observed_availability === "available"
            ? '<span class="badge badge-success">Available</span>'
            : item.observed_availability === "out_of_stock"
            ? '<span class="badge badge-warning">Out of Stock</span>'
            : '<span class="badge badge-critical">Deleted</span>'
          }</td>
        </tr>
      `).join("");

      container.innerHTML = `
        <div class="shell-card" style="padding:20px;">
          <div class="section-header">
            <h2>Bundle Items</h2>
            <button class="btn-primary" id="pick-variants-btn">+ Add Variants</button>
          </div>
          <p style="color:var(--p-color-text-subdued);font-size:0.875rem;margin:0 0 12px;">
            ${currentBundle!.mode === "fixed" ? "Fixed bundles include all items shown below." : "Flexible bundles let customers pick from the pool below."}
          </p>
          ${bundleItems.length === 0 ? '<p style="color:var(--p-color-text-subdued);">No items yet. Add variants using the button above.</p>' : `
            <table class="bundle-table">
              <thead><tr><th>Variant ID</th><th>Product ID</th><th>Availability</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          `}
        </div>
      `;

      container.querySelector("#pick-variants-btn")!.addEventListener("click", async () => {
        const picked = await bridge.pickResource({ type: "variant" });
        if (!picked || picked.length === 0) return;

        const variantIds: number[] = picked.map((p: { id: string }) => {
          const match = p.id.match(/(\d+)$/);
          return match ? parseInt(match[1], 10) : 0;
        }).filter((id: number) => id > 0);

        // For each variant GID we need the product ID too — use the picked id which is gid://shopify/ProductVariant/123
        // product_external_id is not directly available from the resource picker
        // We'll default to 0 and let the merchant know it requires an update
        const productIds: number[] = variantIds.map(() => 0);

        const existingVariantIds = bundleItems.map((i) => i.variant_external_id);
        const allVariantIds = [...new Set([...existingVariantIds, ...variantIds])];
        const allProductIds = bundleItems.map((i) => i.product_external_id);
        variantIds.forEach((_, idx) => allProductIds.push(productIds[idx] ?? 0));

        await bridge.call("/admin/bundles/items/save", {
          bundle_id: currentBundle!.id,
          variant_external_ids: allVariantIds,
          product_external_ids: allProductIds.slice(0, allVariantIds.length),
        });
        notify("Items saved");
        await fetchBundleItems(currentBundle!.id);
        renderItemsTab(container);
      });
    });
  }

  function renderTiersTab(container: Element): void {
    if (!currentBundle) return;
    fetchBundleTiers(currentBundle.id).then(() => {
      pendingTiers = bundleTiers.map((t) => ({
        minimum_item_count: t.minimum_item_count,
        discount_rate: t.discount_rate,
      }));
      renderTiersForm(container);
    });
  }

  function renderTiersForm(container: Element): void {
    const tierRows = pendingTiers.map((t, idx) => `
      <div class="tier-row" data-idx="${idx}">
        <span style="font-size:0.875rem;color:var(--p-color-text-subdued);">Tier ${idx + 1}</span>
        <input type="number" class="tier-min" min="1" value="${t.minimum_item_count}" placeholder="Min items">
        <span style="font-size:0.875rem;">items →</span>
        <input type="number" class="tier-rate" min="0" max="10000" step="100" value="${t.discount_rate}" placeholder="Rate (bp)">
        <span style="font-size:0.875rem;color:var(--p-color-text-subdued);">(${formatDiscount(t.discount_rate)} off)</span>
        <button class="btn-destructive btn-sm remove-tier-btn" data-idx="${idx}">✕</button>
      </div>
    `).join("");

    container.innerHTML = `
      <div class="shell-card" style="padding:20px;">
        <div class="section-header">
          <h2>Discount Tiers</h2>
          <button class="btn-secondary" id="add-tier-btn">+ Add Tier</button>
        </div>
        <p style="color:var(--p-color-text-subdued);font-size:0.875rem;margin:0 0 12px;">
          Tiers are ordered by the minimum item count. The highest qualifying tier is applied automatically.
          Enter rates in basis points (e.g. 1000 = 10%, 2000 = 20%).
        </p>
        <div id="tiers-list">${tierRows}</div>
        <div style="margin-top:14px;">
          <button class="btn-primary" id="save-tiers-btn">Save Tiers</button>
        </div>
      </div>
    `;

    container.querySelector("#add-tier-btn")!.addEventListener("click", () => {
      pendingTiers.push({ minimum_item_count: 1, discount_rate: 1000 });
      renderTiersForm(container);
    });

    container.querySelectorAll<HTMLButtonElement>(".remove-tier-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx!, 10);
        pendingTiers.splice(idx, 1);
        renderTiersForm(container);
      });
    });

    container.querySelectorAll<HTMLInputElement>(".tier-min").forEach((input, idx) => {
      input.addEventListener("change", () => {
        if (pendingTiers[idx]) pendingTiers[idx].minimum_item_count = parseInt(input.value, 10) || 1;
        renderTiersForm(container);
      });
    });

    container.querySelectorAll<HTMLInputElement>(".tier-rate").forEach((input, idx) => {
      input.addEventListener("change", () => {
        if (pendingTiers[idx]) pendingTiers[idx].discount_rate = parseInt(input.value, 10) || 0;
        renderTiersForm(container);
      });
    });

    container.querySelector("#save-tiers-btn")!.addEventListener("click", async () => {
      // Read current values from inputs
      const rows = container.querySelectorAll<HTMLElement>(".tier-row");
      const tiersToSave = Array.from(rows).map((row) => ({
        minimum_item_count: parseInt((row.querySelector(".tier-min") as HTMLInputElement).value, 10) || 1,
        discount_rate: parseInt((row.querySelector(".tier-rate") as HTMLInputElement).value, 10) || 0,
      }));

      // Sort by minimum_item_count ascending before saving
      tiersToSave.sort((a, b) => a.minimum_item_count - b.minimum_item_count);

      const resp = await bridge.call("/admin/bundles/tiers/save", {
        bundle_id: currentBundle!.id,
        tiers: tiersToSave,
      });
      notify(`${resp.saved_count} tier(s) saved`);
      await fetchBundleTiers(currentBundle!.id);
      pendingTiers = bundleTiers.map((t) => ({ minimum_item_count: t.minimum_item_count, discount_rate: t.discount_rate }));
      renderTiersForm(container);
    });
  }

  function renderHistoryTab(container: Element): void {
    purchaseRecords = [];
    purchaseNextCursor = null;
    fetchPurchaseHistory().then(() => renderHistoryTable(container));
  }

  function renderHistoryTable(container: Element): void {
    const rows = purchaseRecords.map((r) => `
      <tr>
        <td>${r.order_external_id}</td>
        <td>${formatDate(r.order_placed_at)}</td>
        <td>${r.item_count}</td>
        <td>${formatDiscount(r.discount_rate_applied)}</td>
        <td>${formatMoney(r.order_total, r.currency_code)}</td>
        <td>${formatDate(r.order_placed_at)}</td>
      </tr>
    `).join("");

    container.innerHTML = `
      <div class="shell-card" style="padding:20px;">
        <div class="section-header">
          <h2>Purchase History</h2>
        </div>
        ${purchaseRecords.length === 0 ? '<p style="color:var(--p-color-text-subdued);">No purchases recorded yet.</p>' : `
          <table class="bundle-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Date</th>
                <th>Items</th>
                <th>Discount</th>
                <th>Order Total</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `}
        ${purchaseNextCursor ? `<button class="btn-secondary" id="load-more-history" style="margin-top:10px;">Load more</button>` : ""}
      </div>
    `;

    container.querySelector("#load-more-history")?.addEventListener("click", () => {
      fetchPurchaseHistory(purchaseNextCursor ?? undefined).then(() => renderHistoryTable(container));
    });
  }

  function renderPurchaseHistoryView(): void {
    app.innerHTML = `
      <div class="top-bar">
        <button class="btn-secondary" id="back-btn">← Back to Bundles</button>
        <h1>Purchase History</h1>
      </div>
      <div id="history-content">Loading...</div>
    `;
    app.querySelector("#back-btn")!.addEventListener("click", () => {
      currentView = "list";
      renderListView();
    });
    purchaseRecords = [];
    purchaseNextCursor = null;
    fetchPurchaseHistory().then(() => {
      renderHistoryTable(app.querySelector("#history-content")!);
    });
  }

  // ─── XSS helper ──────────────────────────────────────────────────────────
  function escHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  renderListView();
}
