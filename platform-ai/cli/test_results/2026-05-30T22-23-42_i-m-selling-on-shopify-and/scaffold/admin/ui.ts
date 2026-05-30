import type { AdminBridge } from "@platform/admin-sdk";
import type {
  BundleId,
  BundleType,
  DiscountKind,
  AdminBundleSummary,
  AdminBundleDetail,
  AdminListBundlesResponse,
  AdminCreateBundleRequest,
  AdminCreateBundleResponse,
  AdminUpdateBundleRequest,
  AdminUpdateBundleResponse,
  AdminToggleBundleResponse,
  AdminBundleDetailResponse,
  BundleComponentInput,
  BundleTierInput,
  ShopifyProductExternalId,
  ShopifyVariantExternalId,
} from "../src/types/contracts.js";

// ─── State ────────────────────────────────────────────────────────────────────

interface AppState {
  view: "list" | "create" | "edit";
  bundles: AdminBundleSummary[];
  nextCursor: string | null;
  pageCursor: string | null;          // cursor for current fetch
  cursorStack: string[];              // stack for Prev navigation
  totalCount: number;
  statusFilter: "all" | "enabled" | "disabled" | "degraded";
  editingBundleId: BundleId | null;
  editingDetail: AdminBundleDetail | null;
  editingPurchaseCount: number;
  selectedBundleIds: Set<BundleId>;
  loading: boolean;
  error: string | null;
}

const state: AppState = {
  view: "list",
  bundles: [],
  nextCursor: null,
  pageCursor: null,
  cursorStack: [],
  totalCount: 0,
  statusFilter: "all",
  editingBundleId: null,
  editingDetail: null,
  editingPurchaseCount: 0,
  selectedBundleIds: new Set(),
  loading: false,
  error: null,
};

// ─── mount ────────────────────────────────────────────────────────────────────

export function mount(container: HTMLElement, bridge: AdminBridge): void {
  // Inject panel styles
  const style = document.createElement("style");
  style.textContent = `
    .bundle-panel { padding: 16px; }
    .bundle-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    .bundle-table th, .bundle-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--p-color-bg-surface); font-size: 14px; }
    .bundle-table th { font-weight: 600; color: var(--p-color-text-subdued); }
    .bundle-table tr:hover { background: var(--p-color-bg-surface); }
    .actions-row { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
    .filter-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .pagination-row { display: flex; gap: 8px; margin-top: 16px; align-items: center; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 14px; }
    .form-group input, .form-group select { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; box-sizing: border-box; }
    .tier-row, .component-row { display: flex; gap: 8px; align-items: flex-end; margin-bottom: 8px; flex-wrap: wrap; }
    .tier-row input, .component-row input { width: 130px; }
    .tier-row label, .component-row label { font-size: 12px; color: var(--p-color-text-subdued); display: block; margin-bottom: 2px; }
    .tier-field { display: flex; flex-direction: column; }
    .section-title { font-size: 16px; font-weight: 700; margin: 20px 0 8px; }
    .warning-list { background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 8px 12px; margin-top: 8px; }
    .warning-list li { font-size: 13px; color: #856404; }
    .checkbox-col { width: 32px; }
    .scroll-area { overflow-x: auto; }
  `;
  container.appendChild(style);

  const panel = document.createElement("div");
  panel.className = "bundle-panel";
  container.appendChild(panel);

  render(panel, bridge);
}

// ─── Render dispatcher ────────────────────────────────────────────────────────

function render(panel: HTMLElement, bridge: AdminBridge): void {
  panel.innerHTML = "";
  if (state.view === "list") renderList(panel, bridge);
  else if (state.view === "create") renderForm(panel, bridge, null);
  else if (state.view === "edit" && state.editingDetail) renderForm(panel, bridge, state.editingDetail);
}

// ─── List view ────────────────────────────────────────────────────────────────

function renderList(panel: HTMLElement, bridge: AdminBridge): void {
  // Header
  const header = document.createElement("div");
  header.className = "actions-row";
  header.innerHTML = `
    <h2 style="margin:0;font-size:20px;font-weight:700;flex:1">Product Bundles</h2>
    <button class="btn-primary" id="btn-create-bundle">+ Create Bundle</button>
  `;
  panel.appendChild(header);

  // Filter row
  const filterRow = document.createElement("div");
  filterRow.className = "filter-row";
  filterRow.innerHTML = `
    <label for="status-filter" style="font-size:14px;font-weight:600;">Filter:</label>
    <select id="status-filter" style="padding:6px 10px;border:1px solid #ccc;border-radius:4px;font-size:14px;">
      <option value="all" ${state.statusFilter === "all" ? "selected" : ""}>All</option>
      <option value="enabled" ${state.statusFilter === "enabled" ? "selected" : ""}>Enabled</option>
      <option value="disabled" ${state.statusFilter === "disabled" ? "selected" : ""}>Disabled</option>
      <option value="degraded" ${state.statusFilter === "degraded" ? "selected" : ""}>Degraded</option>
    </select>
    <span style="font-size:13px;color:var(--p-color-text-subdued);margin-left:8px;">Total: ${state.totalCount}</span>
  `;
  panel.appendChild(filterRow);

  // Bulk actions
  if (state.selectedBundleIds.size > 0) {
    const bulkRow = document.createElement("div");
    bulkRow.className = "actions-row";
    bulkRow.innerHTML = `
      <span style="font-size:13px;">${state.selectedBundleIds.size} selected</span>
      <button class="btn-secondary" id="btn-bulk-enable">Enable Selected</button>
      <button class="btn-secondary" id="btn-bulk-disable">Disable Selected</button>
    `;
    panel.appendChild(bulkRow);
  }

  // Error banner
  if (state.error) {
    const errBanner = document.createElement("div");
    errBanner.className = "shell-error-banner";
    errBanner.textContent = state.error;
    panel.appendChild(errBanner);
  }

  // Loading
  if (state.loading) {
    const loading = document.createElement("p");
    loading.textContent = "Loading…";
    loading.style.color = "var(--p-color-text-subdued)";
    panel.appendChild(loading);
  }

  // Table
  const scrollArea = document.createElement("div");
  scrollArea.className = "scroll-area";

  const table = document.createElement("table");
  table.className = "bundle-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th class="checkbox-col"><input type="checkbox" id="chk-all" ${state.bundles.length > 0 && state.selectedBundleIds.size === state.bundles.length ? "checked" : ""}></th>
        <th>Title</th>
        <th>Type</th>
        <th>Discount</th>
        <th>Status</th>
        <th>Health</th>
        <th>Purchases</th>
        <th>Created</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="bundle-table-body">
    </tbody>
  `;
  scrollArea.appendChild(table);
  panel.appendChild(scrollArea);

  const tbody = table.querySelector("#bundle-table-body") as HTMLTableSectionElement;
  for (const bundle of state.bundles) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="chk-row" data-id="${bundle.id}" ${state.selectedBundleIds.has(bundle.id) ? "checked" : ""}></td>
      <td><strong>${escHtml(bundle.title)}</strong></td>
      <td><span class="badge">${escHtml(bundle.bundle_type)}</span></td>
      <td><span class="badge">${escHtml(bundle.discount_kind)}</span></td>
      <td>
        ${bundle.enabled
          ? '<span class="badge badge-success">Enabled</span>'
          : '<span class="badge">Disabled</span>'}
      </td>
      <td>
        ${bundle.health_status === "ok"
          ? '<span class="badge badge-success">OK</span>'
          : '<span class="badge badge-critical">Degraded</span>'}
      </td>
      <td>${bundle.purchase_count}</td>
      <td>${formatDate(bridge, bundle.created_at)}</td>
      <td>
        <button class="btn-secondary btn-edit" data-id="${bundle.id}" style="margin-right:4px;">Edit</button>
        <button class="btn-secondary btn-toggle" data-id="${bundle.id}" data-enabled="${bundle.enabled}">
          ${bundle.enabled ? "Disable" : "Enable"}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Pagination
  const paginationRow = document.createElement("div");
  paginationRow.className = "pagination-row";
  const prevDisabled = state.cursorStack.length === 0 ? "disabled" : "";
  const nextDisabled = !state.nextCursor ? "disabled" : "";
  paginationRow.innerHTML = `
    <button class="btn-secondary" id="btn-prev" ${prevDisabled}>← Prev</button>
    <button class="btn-secondary" id="btn-next" ${nextDisabled}>Next →</button>
  `;
  panel.appendChild(paginationRow);

  // ── Event listeners ─────────────────────────────────────────────────────────

  panel.querySelector("#btn-create-bundle")?.addEventListener("click", () => {
    state.view = "create";
    state.editingBundleId = null;
    state.editingDetail = null;
    render(panel, bridge);
  });

  (panel.querySelector("#status-filter") as HTMLSelectElement)?.addEventListener("change", (e) => {
    state.statusFilter = (e.target as HTMLSelectElement).value as AppState["statusFilter"];
    state.pageCursor = null;
    state.cursorStack = [];
    state.nextCursor = null;
    fetchBundles(panel, bridge);
  });

  panel.querySelector("#btn-prev")?.addEventListener("click", () => {
    const prev = state.cursorStack.pop() ?? null;
    state.pageCursor = prev;
    fetchBundles(panel, bridge);
  });

  panel.querySelector("#btn-next")?.addEventListener("click", () => {
    if (state.pageCursor !== null) {
      state.cursorStack.push(state.pageCursor);
    }
    state.pageCursor = state.nextCursor;
    fetchBundles(panel, bridge);
  });

  panel.querySelector("#chk-all")?.addEventListener("change", (e) => {
    if ((e.target as HTMLInputElement).checked) {
      state.bundles.forEach((b) => state.selectedBundleIds.add(b.id));
    } else {
      state.selectedBundleIds.clear();
    }
    render(panel, bridge);
  });

  panel.querySelectorAll(".chk-row").forEach((el) => {
    el.addEventListener("change", (e) => {
      const id = (e.target as HTMLInputElement).dataset["id"] as BundleId;
      if ((e.target as HTMLInputElement).checked) {
        state.selectedBundleIds.add(id);
      } else {
        state.selectedBundleIds.delete(id);
      }
      render(panel, bridge);
    });
  });

  panel.querySelectorAll(".btn-edit").forEach((el) => {
    el.addEventListener("click", async (e) => {
      const id = (e.target as HTMLButtonElement).dataset["id"] as BundleId;
      await loadBundleDetail(id, panel, bridge);
    });
  });

  panel.querySelectorAll(".btn-toggle").forEach((el) => {
    el.addEventListener("click", async (e) => {
      const btn = e.target as HTMLButtonElement;
      const id = btn.dataset["id"] as BundleId;
      const currentEnabled = btn.dataset["enabled"] === "true";
      await toggleBundles([id], !currentEnabled, panel, bridge);
    });
  });

  panel.querySelector("#btn-bulk-enable")?.addEventListener("click", async () => {
    await toggleBundles([...state.selectedBundleIds], true, panel, bridge);
    state.selectedBundleIds.clear();
  });

  panel.querySelector("#btn-bulk-disable")?.addEventListener("click", async () => {
    await toggleBundles([...state.selectedBundleIds], false, panel, bridge);
    state.selectedBundleIds.clear();
  });

  // Initial load if no data
  if (state.bundles.length === 0 && !state.loading) {
    fetchBundles(panel, bridge);
  }
}

// ─── Fetch bundles from backend ───────────────────────────────────────────────

async function fetchBundles(panel: HTMLElement, bridge: AdminBridge): Promise<void> {
  state.loading = true;
  state.error = null;
  render(panel, bridge);

  try {
    const params: Record<string, string> = { status_filter: state.statusFilter };
    if (state.pageCursor) params["cursor"] = state.pageCursor;

    const resp = await bridge.call("/admin/bundles", params) as AdminListBundlesResponse;
    state.bundles = resp.bundles;
    state.nextCursor = resp.next_cursor;
    state.totalCount = resp.total_count;
  } catch (err) {
    state.error = `Failed to load bundles: ${String(err)}`;
  } finally {
    state.loading = false;
    render(panel, bridge);
  }
}

// ─── Load bundle detail for editing ──────────────────────────────────────────

async function loadBundleDetail(
  bundleId: BundleId,
  panel: HTMLElement,
  bridge: AdminBridge,
): Promise<void> {
  state.loading = true;
  render(panel, bridge);

  try {
    const resp = await bridge.call("/admin/bundles/detail", { bundle_id: bundleId }) as AdminBundleDetailResponse;
    state.editingDetail = resp.bundle;
    state.editingBundleId = bundleId;
    state.editingPurchaseCount = resp.purchase_count;
    state.view = "edit";
  } catch (err) {
    state.error = `Failed to load bundle: ${String(err)}`;
  } finally {
    state.loading = false;
    render(panel, bridge);
  }
}

// ─── Toggle bundle(s) enabled state ──────────────────────────────────────────

async function toggleBundles(
  ids: BundleId[],
  enabled: boolean,
  panel: HTMLElement,
  bridge: AdminBridge,
): Promise<void> {
  try {
    const resp = await bridge.call("/admin/bundles/toggle", { bundle_ids: ids, enabled }) as AdminToggleBundleResponse;
    if (resp.errors.length > 0) {
      bridge.notify(`Toggle had errors: ${resp.errors.join("; ")}`, "error");
    } else {
      bridge.notify(`${resp.updated_count} bundle(s) ${enabled ? "enabled" : "disabled"}`, "success");
    }
    // Refetch to show updated state
    await fetchBundles(panel, bridge);
  } catch (err) {
    bridge.notify(`Toggle failed: ${String(err)}`, "error");
  }
}

// ─── Form view (create / edit) ────────────────────────────────────────────────

interface FormTierEntry {
  min_item_count: number;
  discount_value: number | null;
  discount_amount: number | null;
  free_item_count: number | null;
}

interface FormComponentEntry {
  product_external_id: ShopifyProductExternalId;
  variant_external_id: ShopifyVariantExternalId | null;
  quantity: number;
  position: number;
  label: string;   // display label from picker
}

function renderForm(
  panel: HTMLElement,
  bridge: AdminBridge,
  detail: AdminBundleDetail | null,
): void {
  const isEdit = detail !== null;
  const title = isEdit ? `Edit Bundle: ${detail.title}` : "Create New Bundle";

  // Form state
  let formTitle = detail?.title ?? "";
  let formBundleType: BundleType = detail?.bundle_type ?? "fixed";
  let formFlexiblePickCount: number | null = detail?.flexible_pick_count ?? null;
  let formDiscountKind: DiscountKind = detail?.discount_kind ?? "percentage";
  let formEnabled: boolean = detail?.enabled ?? true;

  const formComponents: FormComponentEntry[] = (detail?.components ?? []).map((c) => ({
    product_external_id: c.product_external_id as ShopifyProductExternalId,
    variant_external_id: c.variant_external_id as ShopifyVariantExternalId | null,
    quantity: c.quantity,
    position: c.position,
    label: `Product ${c.product_external_id}${c.variant_external_id ? ` / Variant ${c.variant_external_id}` : ""}`,
  }));

  const formTiers: FormTierEntry[] = (detail?.tiers ?? []).map((t) => ({
    min_item_count: t.min_item_count,
    discount_value: t.discount_value != null ? parseInt(t.discount_value, 10) : null,
    discount_amount: t.discount_amount != null ? parseInt(t.discount_amount, 10) : null,
    free_item_count: t.free_item_count,
  }));

  // If no tiers, add a default one
  if (formTiers.length === 0) {
    formTiers.push({ min_item_count: 2, discount_value: 1000, discount_amount: null, free_item_count: null });
  }

  let warnings: string[] = [];
  let dirty = false;

  function renderFormBody(): void {
    panel.innerHTML = "";

    // Back button + title
    const headerRow = document.createElement("div");
    headerRow.className = "actions-row";
    headerRow.innerHTML = `
      <button class="btn-secondary" id="btn-back">← Back</button>
      <h2 style="margin:0;font-size:18px;font-weight:700;flex:1;">${escHtml(title)}</h2>
      ${isEdit ? `<span style="font-size:13px;color:var(--p-color-text-subdued);">Purchases: ${state.editingPurchaseCount}</span>` : ""}
    `;
    panel.appendChild(headerRow);

    if (state.error) {
      const err = document.createElement("div");
      err.className = "shell-error-banner";
      err.textContent = state.error;
      panel.appendChild(err);
    }

    if (warnings.length > 0) {
      const warnEl = document.createElement("div");
      warnEl.className = "warning-list";
      warnEl.innerHTML = `<ul>${warnings.map((w) => `<li>${escHtml(w)}</li>`).join("")}</ul>`;
      panel.appendChild(warnEl);
    }

    const card = document.createElement("div");
    card.className = "shell-card";

    // ── Title field ──────────────────────────────────────────────────────────
    card.appendChild(makeField("Bundle Title", `
      <input type="text" id="f-title" value="${escAttr(formTitle)}" placeholder="e.g. Summer Starter Pack">
    `));

    // ── Bundle type ──────────────────────────────────────────────────────────
    card.appendChild(makeField("Bundle Type", `
      <select id="f-bundle-type">
        <option value="fixed" ${formBundleType === "fixed" ? "selected" : ""}>Fixed (exact products)</option>
        <option value="flexible" ${formBundleType === "flexible" ? "selected" : ""}>Flexible (customer picks)</option>
      </select>
    `));

    // ── Flexible pick count (nullable-with-purpose: show for flexible) ───────
    const flexDiv = document.createElement("div");
    flexDiv.id = "flex-pick-section";
    flexDiv.style.display = formBundleType === "flexible" ? "block" : "none";
    flexDiv.appendChild(makeField(
      "Items Customer Must Pick",
      `<input type="number" id="f-flex-count" min="1" value="${formFlexiblePickCount ?? 2}" placeholder="e.g. 3">`,
    ));
    card.appendChild(flexDiv);

    // ── Enabled toggle (edit only) ───────────────────────────────────────────
    if (isEdit) {
      card.appendChild(makeField("Enabled", `
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
          <input type="checkbox" id="f-enabled" ${formEnabled ? "checked" : ""}>
          Show this bundle to customers
        </label>
      `));
    }

    // ── Discount kind ────────────────────────────────────────────────────────
    card.appendChild(makeField("Discount Type", `
      <select id="f-discount-kind">
        <option value="percentage" ${formDiscountKind === "percentage" ? "selected" : ""}>Percentage off</option>
        <option value="flat-amount" ${formDiscountKind === "flat-amount" ? "selected" : ""}>Flat amount off</option>
        <option value="buy-x-get-y" ${formDiscountKind === "buy-x-get-y" ? "selected" : ""}>Buy X get Y free</option>
      </select>
    `));

    // ── Shopify bundle product external id (read-only display if set) ────────
    if (isEdit && detail?.shopify_bundle_product_external_id) {
      const infoDiv = document.createElement("div");
      infoDiv.className = "form-group";
      infoDiv.innerHTML = `
        <label>Shopify Bundle Product ID</label>
        <p style="font-size:13px;color:var(--p-color-text-subdued);margin:4px 0;">${escHtml(detail.shopify_bundle_product_external_id)} <em>(set automatically)</em></p>
      `;
      card.appendChild(infoDiv);
    }

    // ── Components section ───────────────────────────────────────────────────
    const compSection = document.createElement("div");
    compSection.innerHTML = `<div class="section-title">Bundle Components</div>`;
    compSection.id = "components-section";

    const compList = document.createElement("div");
    compList.id = "comp-list";

    function renderComponents(): void {
      compList.innerHTML = "";
      formComponents.forEach((comp, idx) => {
        const row = document.createElement("div");
        row.className = "component-row";
        row.innerHTML = `
          <div class="tier-field">
            <label>Product / Variant</label>
            <span style="font-size:13px;padding:6px 8px;background:var(--p-color-bg-surface);border-radius:4px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(comp.label)}</span>
          </div>
          <div class="tier-field">
            <label>Qty</label>
            <input type="number" min="1" value="${comp.quantity}" data-comp-qty="${idx}" style="width:70px;">
          </div>
          <div class="tier-field">
            <label>Position</label>
            <input type="number" min="0" value="${comp.position}" data-comp-pos="${idx}" style="width:70px;">
          </div>
          <button class="btn-destructive" data-remove-comp="${idx}" style="align-self:flex-end;">Remove</button>
        `;
        compList.appendChild(row);
      });
    }

    renderComponents();
    compSection.appendChild(compList);

    // Add component buttons
    const addCompRow = document.createElement("div");
    addCompRow.className = "actions-row";
    addCompRow.innerHTML = `
      <button class="btn-secondary" id="btn-add-product">+ Add Product</button>
      <button class="btn-secondary" id="btn-add-variant">+ Add Specific Variant</button>
    `;
    compSection.appendChild(addCompRow);
    card.appendChild(compSection);

    // ── Tiers section ────────────────────────────────────────────────────────
    const tierSection = document.createElement("div");
    tierSection.innerHTML = `<div class="section-title">Discount Tiers</div>`;

    const tierList = document.createElement("div");
    tierList.id = "tier-list";

    function renderTiers(): void {
      tierList.innerHTML = "";
      formTiers.forEach((tier, idx) => {
        const row = document.createElement("div");
        row.className = "tier-row";

        // min_item_count
        let html = `
          <div class="tier-field">
            <label>Min Items</label>
            <input type="number" min="1" value="${tier.min_item_count}" data-tier-min="${idx}" style="width:90px;">
          </div>
        `;

        // discount_value — nullable-with-purpose: show for percentage kind
        html += `
          <div class="tier-field" id="tv-${idx}" style="display:${formDiscountKind === "percentage" ? "flex" : "none"};flex-direction:column;">
            <label>Discount % (basis pts, e.g. 2000=20%)</label>
            <input type="number" min="0" max="10000" value="${tier.discount_value ?? ""}" data-tier-val="${idx}" placeholder="e.g. 2000" style="width:180px;">
          </div>
        `;

        // discount_amount — nullable-with-purpose: show for flat-amount kind
        html += `
          <div class="tier-field" id="ta-${idx}" style="display:${formDiscountKind === "flat-amount" ? "flex" : "none"};flex-direction:column;">
            <label>Flat Amount (minor units, e.g. 500=$5)</label>
            <input type="number" min="0" value="${tier.discount_amount ?? ""}" data-tier-amt="${idx}" placeholder="e.g. 500" style="width:200px;">
          </div>
        `;

        // free_item_count — nullable-with-purpose: show for buy-x-get-y kind
        html += `
          <div class="tier-field" id="tf-${idx}" style="display:${formDiscountKind === "buy-x-get-y" ? "flex" : "none"};flex-direction:column;">
            <label>Free Item Count</label>
            <input type="number" min="1" value="${tier.free_item_count ?? ""}" data-tier-free="${idx}" placeholder="e.g. 1" style="width:130px;">
          </div>
        `;

        html += `<button class="btn-destructive" data-remove-tier="${idx}" style="align-self:flex-end;">Remove</button>`;
        row.innerHTML = html;
        tierList.appendChild(row);
      });
    }

    renderTiers();
    tierSection.appendChild(tierList);

    const addTierRow = document.createElement("div");
    addTierRow.innerHTML = `<button class="btn-secondary" id="btn-add-tier">+ Add Tier</button>`;
    tierSection.appendChild(addTierRow);
    card.appendChild(tierSection);

    // ── Save / Cancel ────────────────────────────────────────────────────────
    const saveRow = document.createElement("div");
    saveRow.className = "actions-row";
    saveRow.style.marginTop = "24px";
    saveRow.innerHTML = `
      <button class="btn-primary" id="btn-save">${isEdit ? "Save Changes" : "Create Bundle"}</button>
      <button class="btn-secondary" id="btn-cancel">Cancel</button>
    `;
    card.appendChild(saveRow);

    panel.appendChild(card);

    // ── Attach listeners ─────────────────────────────────────────────────────

    panel.querySelector("#btn-back")?.addEventListener("click", () => {
      state.view = "list";
      if (dirty) bridge.saveBar.hide();
      render(panel, bridge);
    });

    panel.querySelector("#btn-cancel")?.addEventListener("click", () => {
      state.view = "list";
      if (dirty) bridge.saveBar.hide();
      render(panel, bridge);
    });

    // Title
    (panel.querySelector("#f-title") as HTMLInputElement)?.addEventListener("input", (e) => {
      formTitle = (e.target as HTMLInputElement).value;
      markDirty();
    });

    // Bundle type
    (panel.querySelector("#f-bundle-type") as HTMLSelectElement)?.addEventListener("change", (e) => {
      formBundleType = (e.target as HTMLSelectElement).value as BundleType;
      const flexEl = panel.querySelector("#flex-pick-section") as HTMLElement;
      if (flexEl) flexEl.style.display = formBundleType === "flexible" ? "block" : "none";
      markDirty();
    });

    // Flexible pick count
    (panel.querySelector("#f-flex-count") as HTMLInputElement)?.addEventListener("input", (e) => {
      formFlexiblePickCount = parseInt((e.target as HTMLInputElement).value, 10) || null;
      markDirty();
    });

    // Enabled
    (panel.querySelector("#f-enabled") as HTMLInputElement)?.addEventListener("change", (e) => {
      formEnabled = (e.target as HTMLInputElement).checked;
      markDirty();
    });

    // Discount kind — show/hide tier fields
    (panel.querySelector("#f-discount-kind") as HTMLSelectElement)?.addEventListener("change", (e) => {
      formDiscountKind = (e.target as HTMLSelectElement).value as DiscountKind;
      // Update visibility of tier discount fields
      formTiers.forEach((_, idx) => {
        const tvEl = panel.querySelector(`#tv-${idx}`) as HTMLElement | null;
        const taEl = panel.querySelector(`#ta-${idx}`) as HTMLElement | null;
        const tfEl = panel.querySelector(`#tf-${idx}`) as HTMLElement | null;
        if (tvEl) tvEl.style.display = formDiscountKind === "percentage" ? "flex" : "none";
        if (taEl) taEl.style.display = formDiscountKind === "flat-amount" ? "flex" : "none";
        if (tfEl) tfEl.style.display = formDiscountKind === "buy-x-get-y" ? "flex" : "none";
      });
      markDirty();
    });

    // Component qty / position
    panel.querySelectorAll("[data-comp-qty]").forEach((el) => {
      el.addEventListener("input", (e) => {
        const idx = parseInt((e.target as HTMLInputElement).dataset["compQty"] ?? "0", 10);
        const comp = formComponents[idx];
        if (comp) comp.quantity = parseInt((e.target as HTMLInputElement).value, 10) || 1;
        markDirty();
      });
    });
    panel.querySelectorAll("[data-comp-pos]").forEach((el) => {
      el.addEventListener("input", (e) => {
        const idx = parseInt((e.target as HTMLInputElement).dataset["compPos"] ?? "0", 10);
        const comp = formComponents[idx];
        if (comp) comp.position = parseInt((e.target as HTMLInputElement).value, 10) || 0;
        markDirty();
      });
    });
    panel.querySelectorAll("[data-remove-comp]").forEach((el) => {
      el.addEventListener("click", (e) => {
        const idx = parseInt((e.target as HTMLButtonElement).dataset["removeComp"] ?? "0", 10);
        formComponents.splice(idx, 1);
        // Re-assign positions
        formComponents.forEach((c, i) => { c.position = i; });
        renderComponents();
        markDirty();
      });
    });

    // Add product
    panel.querySelector("#btn-add-product")?.addEventListener("click", async () => {
      const picked = await bridge.pickResource({ type: "product" });
      if (!picked || picked.length === 0) return;
      for (const p of picked) {
        // p.id is the GID: gid://shopify/Product/<numeric_id>
        const numericId = p.id.split("/").pop() ?? "";
        if (!numericId) continue;
        formComponents.push({
          product_external_id: numericId as ShopifyProductExternalId,
          variant_external_id: null,
          quantity: 1,
          position: formComponents.length,
          label: p.title ?? `Product ${numericId}`,
        });
      }
      renderComponents();
      markDirty();
    });

    // Add specific variant
    panel.querySelector("#btn-add-variant")?.addEventListener("click", async () => {
      const picked = await bridge.pickResource({ type: "variant" });
      if (!picked || picked.length === 0) return;
      for (const p of picked) {
        // p.id is gid://shopify/ProductVariant/<numeric_id>
        // We need both variant id and product id
        // The PickedResource provides id as a variant GID; title includes product title
        const variantNumericId = p.id.split("/").pop() ?? "";
        if (!variantNumericId) continue;
        // We also need the product_external_id; it is not available on PickedResource
        // from bridge.pickResource({type:"variant"}) directly, but the variant GID
        // carries the variant id. The product_id must be separately resolved — we prompt
        // the merchant to also pick the product, or we require a product pick first.
        // For a production implementation we would query the backend to resolve
        // product_external_id from variant_external_id. For this scaffold, we require
        // the merchant to first add the product and then specify the variant pinning.
        // Enforce: always pair a variant with its product.
        const productPicked = await bridge.pickResource({ type: "product" });
        if (!productPicked || productPicked.length === 0) continue;
        const productNumericId = productPicked[0]?.id.split("/").pop() ?? "";
        if (!productNumericId) continue;

        formComponents.push({
          product_external_id: productNumericId as ShopifyProductExternalId,
          variant_external_id: variantNumericId as ShopifyVariantExternalId,
          quantity: 1,
          position: formComponents.length,
          label: `${productPicked[0]?.title ?? ""} / ${p.title}`,
        });
      }
      renderComponents();
      markDirty();
    });

    // Tier fields
    panel.querySelectorAll("[data-tier-min]").forEach((el) => {
      el.addEventListener("input", (e) => {
        const idx = parseInt((e.target as HTMLInputElement).dataset["tierMin"] ?? "0", 10);
        const tier = formTiers[idx];
        if (tier) tier.min_item_count = parseInt((e.target as HTMLInputElement).value, 10) || 1;
        markDirty();
      });
    });
    panel.querySelectorAll("[data-tier-val]").forEach((el) => {
      el.addEventListener("input", (e) => {
        const idx = parseInt((e.target as HTMLInputElement).dataset["tierVal"] ?? "0", 10);
        const tier = formTiers[idx];
        if (tier) tier.discount_value = parseInt((e.target as HTMLInputElement).value, 10) || null;
        markDirty();
      });
    });
    panel.querySelectorAll("[data-tier-amt]").forEach((el) => {
      el.addEventListener("input", (e) => {
        const idx = parseInt((e.target as HTMLInputElement).dataset["tierAmt"] ?? "0", 10);
        const tier = formTiers[idx];
        if (tier) tier.discount_amount = parseInt((e.target as HTMLInputElement).value, 10) || null;
        markDirty();
      });
    });
    panel.querySelectorAll("[data-tier-free]").forEach((el) => {
      el.addEventListener("input", (e) => {
        const idx = parseInt((e.target as HTMLInputElement).dataset["tierFree"] ?? "0", 10);
        const tier = formTiers[idx];
        if (tier) tier.free_item_count = parseInt((e.target as HTMLInputElement).value, 10) || null;
        markDirty();
      });
    });
    panel.querySelectorAll("[data-remove-tier]").forEach((el) => {
      el.addEventListener("click", (e) => {
        const idx = parseInt((e.target as HTMLButtonElement).dataset["removeTier"] ?? "0", 10);
        formTiers.splice(idx, 1);
        renderTiers();
        markDirty();
      });
    });

    panel.querySelector("#btn-add-tier")?.addEventListener("click", () => {
      formTiers.push({ min_item_count: (formTiers[formTiers.length - 1]?.min_item_count ?? 1) + 1, discount_value: null, discount_amount: null, free_item_count: null });
      renderTiers();
      markDirty();
    });

    // Save
    panel.querySelector("#btn-save")?.addEventListener("click", async () => {
      await handleSave();
    });

    function markDirty(): void {
      if (!dirty) {
        dirty = true;
        bridge.saveBar.show();
      }
    }

    async function handleSave(): Promise<void> {
      // Validate
      if (!formTitle.trim()) {
        bridge.notify("Bundle title is required", "error");
        return;
      }
      if (formBundleType === "flexible" && (formFlexiblePickCount == null || formFlexiblePickCount < 1)) {
        bridge.notify("Flexible bundles require a pick count ≥ 1", "error");
        return;
      }
      if (formComponents.length === 0) {
        bridge.notify("At least one component is required", "error");
        return;
      }
      if (formTiers.length === 0) {
        bridge.notify("At least one discount tier is required", "error");
        return;
      }

      const components: BundleComponentInput[] = formComponents.map((c) => ({
        product_external_id: c.product_external_id,
        variant_external_id: c.variant_external_id,
        quantity: c.quantity,
        position: c.position,
      }));

      const tiers: BundleTierInput[] = formTiers.map((t) => ({
        min_item_count: t.min_item_count,
        discount_value: t.discount_value,
        discount_amount: t.discount_amount,
        free_item_count: t.free_item_count,
      }));

      if (isEdit && state.editingBundleId) {
        const updateReq: AdminUpdateBundleRequest = {
          bundle_id: state.editingBundleId,
          title: formTitle.trim(),
          bundle_type: formBundleType,
          flexible_pick_count: formBundleType === "flexible" ? formFlexiblePickCount : null,
          discount_kind: formDiscountKind,
          components,
          tiers,
          enabled: formEnabled,
        };
        try {
          const resp = await bridge.call("/admin/bundles/update", updateReq) as AdminUpdateBundleResponse;
          if (resp.status === "error") {
            state.error = `Update failed: ${resp.warnings.join("; ")}`;
            warnings = resp.warnings;
            renderFormBody();
            return;
          }
          warnings = resp.warnings;
          bridge.saveBar.hide();
          dirty = false;
          bridge.notify("Bundle updated", "success");
          // Refetch the detail to stay on the same page with fresh data
          await loadBundleDetail(state.editingBundleId, panel, bridge);
        } catch (err) {
          state.error = `Update failed: ${String(err)}`;
          renderFormBody();
        }
      } else {
        const createReq: AdminCreateBundleRequest = {
          title: formTitle.trim(),
          bundle_type: formBundleType,
          flexible_pick_count: formBundleType === "flexible" ? formFlexiblePickCount : null,
          discount_kind: formDiscountKind,
          components,
          tiers,
        };
        try {
          const resp = await bridge.call("/admin/bundles/create", createReq) as AdminCreateBundleResponse;
          if (resp.status === "error") {
            state.error = `Create failed: ${resp.warnings.join("; ")}`;
            warnings = resp.warnings;
            renderFormBody();
            return;
          }
          warnings = resp.warnings;
          bridge.saveBar.hide();
          dirty = false;
          bridge.notify("Bundle created", "success");
          state.view = "list";
          state.pageCursor = null;
          state.cursorStack = [];
          await fetchBundles(panel, bridge);
        } catch (err) {
          state.error = `Create failed: ${String(err)}`;
          renderFormBody();
        }
      }
    }
  }

  renderFormBody();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escAttr(s: string): string {
  return escHtml(s);
}

function formatDate(bridge: AdminBridge, iso: string): string {
  return new Intl.DateTimeFormat(bridge.context.locale, {
    dateStyle: "medium",
  }).format(new Date(iso));
}

function makeField(labelText: string, inputHtml: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "form-group";
  div.innerHTML = `<label>${escHtml(labelText)}</label>${inputHtml}`;
  return div;
}
