import type { AdminBridge } from "@platform/admin-sdk";
import type {
  BundleId,
  BundleType,
  DiscountType,
  VariantMode,
  AdminBundleSummary,
  AdminListBundlesResponse,
  AdminBundleDetailResponse,
  AdminCreateBundleRequest,
  AdminCreateBundleResponse,
  AdminUpdateBundleRequest,
  AdminUpdateBundleResponse,
  AdminDeleteBundleRequest,
  AdminDeleteBundleResponse,
  AdminProductSearchResponse,
  AdminProductShape,
  AdminProductVariantShape,
  BundleItemInput,
  DiscountTierInput,
} from "../src/types/contracts.js";

// ─── State ────────────────────────────────────────────────────────────────────

interface AppState {
  view: "list" | "create" | "edit";
  bundles: AdminBundleSummary[];
  totalCount: number;
  currentPage: number;
  pageSize: number;
  editingBundle: BundleId | null;
  formState: BundleFormState;
  isLoading: boolean;
  productSearchResults: AdminProductShape[];
  productSearchPage: number;
  productSearchQuery: string;
}

interface BundleFormState {
  name: string;
  bundle_type: BundleType;
  enabled: boolean;
  required_item_count: number | null;
  discount_type: DiscountType;
  items: BundleItemInput[];
  discount_tiers: DiscountTierInput[];
  // Shopify node id (readonly, displayed but not directly edited)
  shopify_discount_external_id: string | null;
  // Discount code string (readonly, displayed)
  discount_code_string: string | null;
}

function emptyForm(): BundleFormState {
  return {
    name: "",
    bundle_type: "fixed",
    enabled: true,
    required_item_count: null,
    discount_type: "percentage",
    items: [],
    discount_tiers: [{ min_item_count: 2, discount_ratio: "0.10" }],
    shopify_discount_external_id: null,
    discount_code_string: null,
  };
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mount(container: HTMLElement, bridge: AdminBridge): void {
  const state: AppState = {
    view: "list",
    bundles: [],
    totalCount: 0,
    currentPage: 1,
    pageSize: 20,
    editingBundle: null,
    formState: emptyForm(),
    isLoading: false,
    productSearchResults: [],
    productSearchPage: 1,
    productSearchQuery: "",
  };

  // ── CSS ──────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bundle-app { padding: 16px; font-family: var(--p-font-family-sans); }
    .bundle-app h1 { font-size: 20px; margin: 0 0 16px; }
    .bundle-app h2 { font-size: 16px; margin: 0 0 12px; }
    .bundle-app table { width: 100%; border-collapse: collapse; }
    .bundle-app th, .bundle-app td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--p-color-border); }
    .bundle-app th { color: var(--p-color-text-subdued); font-size: 13px; font-weight: 600; }
    .bundle-app .actions { display: flex; gap: 8px; }
    .bundle-app .form-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    .bundle-app label { font-size: 13px; font-weight: 600; }
    .bundle-app input[type="text"], .bundle-app input[type="number"], .bundle-app select {
      padding: 8px; border: 1px solid var(--p-color-border); border-radius: 4px;
      font-size: 14px; width: 100%; box-sizing: border-box;
    }
    .bundle-app .tier-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .bundle-app .tier-row input { width: 100px; }
    .bundle-app .item-card { border: 1px solid var(--p-color-border); border-radius: 6px; padding: 10px; margin-bottom: 8px; }
    .bundle-app .pagination { display: flex; gap: 8px; margin-top: 16px; align-items: center; }
    .bundle-app .readonly-field { background: var(--p-color-bg-surface); padding: 8px; border-radius: 4px; font-size: 13px; color: var(--p-color-text-subdued); font-family: monospace; word-break: break-all; }
    .bundle-app .search-result { display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid var(--p-color-border); cursor: pointer; }
    .bundle-app .search-result:hover { background: var(--p-color-bg-surface-hover); }
  `;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = "bundle-app";
  container.appendChild(root);

  // ── Render dispatch ───────────────────────────────────────────────────────
  function render(): void {
    root.innerHTML = "";
    if (state.view === "list") renderList();
    else renderForm();
  }

  // ── List view ─────────────────────────────────────────────────────────────
  async function loadBundles(): Promise<void> {
    state.isLoading = true;
    render();
    const resp = (await bridge.call("/admin/bundles", {
      page: state.currentPage,
      page_size: state.pageSize,
    })) as AdminListBundlesResponse;
    state.bundles = resp.bundles;
    state.totalCount = resp.total;
    state.isLoading = false;
    render();
  }

  function renderList(): void {
    const h1 = document.createElement("h1");
    h1.textContent = `Bundles (${state.totalCount})`;
    root.appendChild(h1);

    const createBtn = document.createElement("button");
    createBtn.className = "btn-primary";
    createBtn.textContent = "Create Bundle";
    createBtn.addEventListener("click", () => {
      state.view = "create";
      state.editingBundle = null;
      state.formState = emptyForm();
      bridge.saveBar.show("bundle-form");
      render();
    });
    root.appendChild(createBtn);

    if (state.isLoading) {
      const p = document.createElement("p");
      p.textContent = "Loading…";
      root.appendChild(p);
      return;
    }

    if (state.bundles.length === 0) {
      const p = document.createElement("p");
      p.style.color = "var(--p-color-text-subdued)";
      p.textContent = "No bundles yet. Create your first bundle above.";
      root.appendChild(p);
    } else {
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr>
        <th>Name</th><th>Type</th><th>Status</th><th>Purchases</th><th>Actions</th>
      </tr>`;
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const bundle of state.bundles) {
        const tr = document.createElement("tr");

        const nameTd = document.createElement("td");
        nameTd.textContent = bundle.name;
        tr.appendChild(nameTd);

        const typeTd = document.createElement("td");
        typeTd.textContent = bundle.bundle_type === "fixed" ? "Fixed" : "Flexible";
        tr.appendChild(typeTd);

        const statusTd = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = bundle.enabled
          ? "badge badge-success"
          : "badge badge-warning";
        badge.textContent = bundle.enabled ? "Enabled" : "Disabled";
        statusTd.appendChild(badge);
        tr.appendChild(statusTd);

        const countTd = document.createElement("td");
        countTd.textContent = String(bundle.purchase_count);
        tr.appendChild(countTd);

        const actionsTd = document.createElement("td");
        actionsTd.className = "actions";

        const editBtn = document.createElement("button");
        editBtn.className = "btn-secondary";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => handleEditClick(bundle.id));
        actionsTd.appendChild(editBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn-destructive";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => handleDeleteClick(bundle.id, bundle.name));
        actionsTd.appendChild(deleteBtn);

        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      root.appendChild(table);
    }

    // Pagination
    const pag = document.createElement("div");
    pag.className = "pagination";

    const totalPages = Math.ceil(state.totalCount / state.pageSize) || 1;

    const prevBtn = document.createElement("button");
    prevBtn.className = "btn-secondary";
    prevBtn.textContent = "← Prev";
    prevBtn.disabled = state.currentPage <= 1;
    prevBtn.addEventListener("click", () => {
      if (state.currentPage > 1) {
        state.currentPage -= 1;
        loadBundles();
      }
    });
    pag.appendChild(prevBtn);

    const pageInfo = document.createElement("span");
    pageInfo.style.fontSize = "13px";
    pageInfo.style.color = "var(--p-color-text-subdued)";
    pageInfo.textContent = `Page ${state.currentPage} of ${totalPages} (${state.totalCount} total)`;
    pag.appendChild(pageInfo);

    const nextBtn = document.createElement("button");
    nextBtn.className = "btn-secondary";
    nextBtn.textContent = "Next →";
    nextBtn.disabled = state.currentPage >= totalPages;
    nextBtn.addEventListener("click", () => {
      if (state.currentPage < totalPages) {
        state.currentPage += 1;
        loadBundles();
      }
    });
    pag.appendChild(nextBtn);

    root.appendChild(pag);

    // Initial load
    if (!state.isLoading && state.bundles.length === 0 && state.totalCount === 0) {
      loadBundles();
    }
  }

  async function handleEditClick(bundleId: BundleId): Promise<void> {
    // Fetch full bundle detail (including discount_type and discount_tiers).
    try {
      const resp = (await bridge.call("/admin/bundles/detail", {
        bundle_id: bundleId,
      })) as AdminBundleDetailResponse;

      const bundle = resp.bundle;
      if (!bundle) {
        bridge.notify("Could not load bundle details", "error");
        return;
      }

      state.view = "edit";
      state.editingBundle = bundleId;
      state.formState = {
        name: bundle.name,
        bundle_type: bundle.bundle_type,
        enabled: bundle.enabled,
        required_item_count: bundle.required_item_count ?? null,
        discount_type: bundle.discount_type,
        items: bundle.items.map((item) => ({
          product_external_id: item.product_external_id,
          variant_mode: item.variant_mode,
          variant_external_ids: item.variants.map((v) => v.variant_external_id),
          variant_gids: item.variants.map((v) => v.live_variant_gid),
        })),
        discount_tiers: bundle.discount_tiers.map((t) => ({
          min_item_count: t.min_item_count,
          discount_ratio: t.discount_ratio ?? undefined,
          discount_amount:
            t.discount_amount !== null
              ? parseInt(t.discount_amount, 10)
              : undefined,
          is_bxgy: t.is_bxgy,
        })),
        shopify_discount_external_id: bundle.shopify_discount_external_id ?? null,
        discount_code_string: bundle.discount_code_string ?? null,
      };
      bridge.saveBar.show("bundle-form");
      render();
    } catch {
      bridge.notify("Failed to load bundle details", "error");
    }
  }

  async function handleDeleteClick(bundleId: BundleId, name: string): Promise<void> {
    if (!confirm(`Delete bundle "${name}"? This cannot be undone.`)) return;
    try {
      await bridge.call("/admin/bundles/delete", { bundle_id: bundleId } satisfies AdminDeleteBundleRequest);
      bridge.notify("Bundle deleted", "success");
      await loadBundles();
    } catch (err: unknown) {
      bridge.notify("Failed to delete bundle", "error");
    }
  }

  // ── Form view (create / edit) ─────────────────────────────────────────────
  function renderForm(): void {
    const isEdit = state.view === "edit";
    const h1 = document.createElement("h1");
    h1.textContent = isEdit ? "Edit Bundle" : "Create Bundle";
    root.appendChild(h1);

    // Name
    appendFormRow(root, "Bundle Name", (wrapper) => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = state.formState.name;
      input.placeholder = "e.g. Summer Starter Pack";
      input.addEventListener("input", () => {
        state.formState.name = input.value;
      });
      wrapper.appendChild(input);
    });

    // Bundle type
    appendFormRow(root, "Bundle Type", (wrapper) => {
      const select = document.createElement("select");
      (["fixed", "flexible"] as BundleType[]).forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t === "fixed" ? "Fixed (exact items)" : "Flexible (customer picks)";
        opt.selected = state.formState.bundle_type === t;
        select.appendChild(opt);
      });
      select.addEventListener("change", () => {
        state.formState.bundle_type = select.value as BundleType;
        renderForm();
        render();
      });
      wrapper.appendChild(select);
    });

    // Required item count (flexible only)
    if (state.formState.bundle_type === "flexible") {
      appendFormRow(root, "Required Item Count (how many the customer must pick)", (wrapper) => {
        const input = document.createElement("input");
        input.type = "number";
        input.min = "1";
        input.value = String(state.formState.required_item_count ?? 3);
        input.addEventListener("input", () => {
          state.formState.required_item_count = parseInt(input.value, 10) || null;
        });
        wrapper.appendChild(input);
      });
    }

    // Enabled toggle
    appendFormRow(root, "Status", (wrapper) => {
      const label = document.createElement("label");
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = "8px";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.formState.enabled;
      checkbox.addEventListener("change", () => {
        state.formState.enabled = checkbox.checked;
      });
      label.appendChild(checkbox);
      const text = document.createElement("span");
      text.textContent = "Enabled";
      label.appendChild(text);
      wrapper.appendChild(label);
    });

    // Discount type
    appendFormRow(root, "Discount Type", (wrapper) => {
      const select = document.createElement("select");
      ([
        ["percentage", "Percentage off"],
        ["flat", "Flat amount off"],
        ["bxgy", "Buy X Get Y Free"],
      ] as [DiscountType, string][]).forEach(([val, label]) => {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = label;
        opt.selected = state.formState.discount_type === val;
        select.appendChild(opt);
      });
      select.addEventListener("change", () => {
        state.formState.discount_type = select.value as DiscountType;
        render();
      });
      wrapper.appendChild(select);
    });

    // Shopify discount node id (read-only display when editing)
    if (isEdit && state.formState.shopify_discount_external_id) {
      appendFormRow(root, "Shopify Discount Node ID (read-only)", (wrapper) => {
        const div = document.createElement("div");
        div.className = "readonly-field";
        div.textContent = state.formState.shopify_discount_external_id ?? "";
        wrapper.appendChild(div);
      });
    }

    // Discount code string (read-only display when editing)
    if (isEdit && state.formState.discount_code_string) {
      appendFormRow(root, "Discount Code (read-only)", (wrapper) => {
        const div = document.createElement("div");
        div.className = "readonly-field";
        div.textContent = state.formState.discount_code_string ?? "";
        wrapper.appendChild(div);
      });
    }

    // Discount tiers section
    const tiersSection = document.createElement("div");
    tiersSection.className = "shell-section";
    const tiersH2 = document.createElement("h2");
    tiersH2.textContent = "Discount Tiers";
    tiersSection.appendChild(tiersH2);

    const tiersNote = document.createElement("p");
    tiersNote.style.fontSize = "13px";
    tiersNote.style.color = "var(--p-color-text-subdued)";
    tiersNote.textContent =
      state.formState.discount_type === "percentage"
        ? "Set a ratio (e.g. 0.10 = 10% off) per minimum item count."
        : state.formState.discount_type === "flat"
        ? "Set a flat amount in cents (e.g. 500 = $5.00) per minimum item count."
        : "Set minimum items to buy (X) per tier. The customer gets 1 item free.";
    tiersSection.appendChild(tiersNote);

    for (let i = 0; i < state.formState.discount_tiers.length; i++) {
      const tier = state.formState.discount_tiers[i];
      if (!tier) continue;
      const tierRow = document.createElement("div");
      tierRow.className = "tier-row";

      const minLabel = document.createElement("label");
      minLabel.textContent = "Min items:";
      tierRow.appendChild(minLabel);

      const minInput = document.createElement("input");
      minInput.type = "number";
      minInput.min = "1";
      minInput.value = String(tier.min_item_count);
      const tierIdx = i;
      minInput.addEventListener("input", () => {
        const t = state.formState.discount_tiers[tierIdx];
        if (t) t.min_item_count = parseInt(minInput.value, 10) || 1;
      });
      tierRow.appendChild(minInput);

      if (state.formState.discount_type === "percentage") {
        const ratioLabel = document.createElement("label");
        ratioLabel.textContent = "Ratio (0–1):";
        tierRow.appendChild(ratioLabel);

        const ratioInput = document.createElement("input");
        ratioInput.type = "text";
        ratioInput.value = tier.discount_ratio ?? "0.10";
        ratioInput.placeholder = "e.g. 0.10";
        ratioInput.addEventListener("input", () => {
          const t = state.formState.discount_tiers[tierIdx];
          if (t) t.discount_ratio = ratioInput.value;
        });
        tierRow.appendChild(ratioInput);
      } else if (state.formState.discount_type === "flat") {
        const amtLabel = document.createElement("label");
        amtLabel.textContent = "Amount (cents):";
        tierRow.appendChild(amtLabel);

        const amtInput = document.createElement("input");
        amtInput.type = "number";
        amtInput.min = "0";
        amtInput.value = String(tier.discount_amount ?? 500);
        amtInput.addEventListener("input", () => {
          const t = state.formState.discount_tiers[tierIdx];
          if (t) t.discount_amount = parseInt(amtInput.value, 10) || 0;
        });
        tierRow.appendChild(amtInput);
      } else {
        // bxgy — the tier represents buy X get 1 free
        const bxgyLabel = document.createElement("span");
        bxgyLabel.style.fontSize = "13px";
        bxgyLabel.textContent = "Buy X, get 1 free";
        tierRow.appendChild(bxgyLabel);

        const t = state.formState.discount_tiers[tierIdx];
        if (t) t.is_bxgy = true;
      }

      const removeBtn = document.createElement("button");
      removeBtn.className = "btn-secondary";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        state.formState.discount_tiers.splice(tierIdx, 1);
        render();
      });
      tierRow.appendChild(removeBtn);

      tiersSection.appendChild(tierRow);
    }

    const addTierBtn = document.createElement("button");
    addTierBtn.className = "btn-secondary";
    addTierBtn.textContent = "+ Add Tier";
    addTierBtn.addEventListener("click", () => {
      const lastTier = state.formState.discount_tiers[state.formState.discount_tiers.length - 1];
      const nextMin = lastTier ? lastTier.min_item_count + 1 : 2;
      state.formState.discount_tiers.push({
        min_item_count: nextMin,
        discount_ratio:
          state.formState.discount_type === "percentage" ? "0.10" : undefined,
        discount_amount:
          state.formState.discount_type === "flat" ? 500 : undefined,
        is_bxgy: state.formState.discount_type === "bxgy",
      });
      render();
    });
    tiersSection.appendChild(addTierBtn);
    root.appendChild(tiersSection);

    // Items section
    const itemsSection = document.createElement("div");
    itemsSection.className = "shell-section";
    const itemsH2 = document.createElement("h2");
    itemsH2.textContent = "Bundle Items";
    itemsSection.appendChild(itemsH2);

    for (let i = 0; i < state.formState.items.length; i++) {
      const item = state.formState.items[i];
      if (!item) continue;
      const card = document.createElement("div");
      card.className = "item-card";

      const productLabel = document.createElement("div");
      productLabel.style.fontWeight = "600";
      productLabel.textContent = `Product ID: ${item.product_external_id}`;
      card.appendChild(productLabel);

      const modeRow = document.createElement("div");
      modeRow.className = "form-row";
      const modeLabel = document.createElement("label");
      modeLabel.textContent = "Variant Mode:";
      modeRow.appendChild(modeLabel);

      const modeSelect = document.createElement("select");
      (["all", "specific"] as VariantMode[]).forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent =
          m === "all" ? "All variants" : "Specific variants";
        opt.selected = item.variant_mode === m;
        modeSelect.appendChild(opt);
      });
      const itemIdx = i;
      modeSelect.addEventListener("change", () => {
        const it = state.formState.items[itemIdx];
        if (it) {
          it.variant_mode = modeSelect.value as VariantMode;
          if (modeSelect.value === "all") it.variant_external_ids = [];
        }
        render();
      });
      modeRow.appendChild(modeSelect);
      card.appendChild(modeRow);

      // variant_external_ids display (specific mode)
      if (item.variant_mode === "specific") {
        const variantsLabel = document.createElement("label");
        variantsLabel.textContent = "Selected variant IDs:";
        card.appendChild(variantsLabel);
        const variantsList = document.createElement("div");
        variantsList.style.fontSize = "13px";
        variantsList.style.color = "var(--p-color-text-subdued)";
        variantsList.textContent = (item.variant_external_ids ?? []).join(", ") || "(none)";
        card.appendChild(variantsList);

        // Button to pick variants via resource picker
        const pickVariantsBtn = document.createElement("button");
        pickVariantsBtn.className = "btn-secondary";
        pickVariantsBtn.textContent = "Pick Variants";
        pickVariantsBtn.addEventListener("click", async () => {
          const picked = await bridge.pickResource({ type: "variant" });
          if (!picked) return;
          const it = state.formState.items[itemIdx];
          if (!it) return;
          // variant id from picker: "gid://shopify/ProductVariant/123"
          // Store both numeric ids AND full GIDs so the backend can persist them.
          it.variant_gids = picked.map((p) => p.id);
          it.variant_external_ids = picked.map((p) => {
            // Extract numeric id from GID
            const parts = p.id.split("/");
            return parts[parts.length - 1] ?? p.id;
          });
          render();
        });
        card.appendChild(pickVariantsBtn);
      }

      const removeItemBtn = document.createElement("button");
      removeItemBtn.className = "btn-destructive";
      removeItemBtn.style.marginTop = "8px";
      removeItemBtn.textContent = "Remove Item";
      removeItemBtn.addEventListener("click", () => {
        state.formState.items.splice(itemIdx, 1);
        render();
      });
      card.appendChild(removeItemBtn);
      itemsSection.appendChild(card);
    }

    // Add product via resource picker
    const addProductBtn = document.createElement("button");
    addProductBtn.className = "btn-secondary";
    addProductBtn.textContent = "+ Add Product";
    addProductBtn.addEventListener("click", async () => {
      const picked = await bridge.pickResource({ type: "product" });
      if (!picked) return;
      for (const p of picked) {
        // Extract numeric product id from GID: "gid://shopify/Product/123"
        const parts = p.id.split("/");
        const numericId = parts[parts.length - 1] ?? p.id;
        if (!numericId) continue;
        // Check not already added
        if (state.formState.items.some((it) => it.product_external_id === numericId)) {
          continue;
        }
        state.formState.items.push({
          product_external_id: numericId,
          variant_mode: "all",
          variant_external_ids: [],
        });
      }
      render();
    });
    itemsSection.appendChild(addProductBtn);
    root.appendChild(itemsSection);

    // Form action buttons
    const btnRow = document.createElement("div");
    btnRow.className = "actions";
    btnRow.style.marginTop = "20px";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-primary";
    saveBtn.textContent = isEdit ? "Save Changes" : "Create Bundle";
    saveBtn.addEventListener("click", () => handleFormSave());
    btnRow.appendChild(saveBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      bridge.saveBar.hide("bundle-form");
      state.view = "list";
      state.editingBundle = null;
      render();
      loadBundles();
    });
    btnRow.appendChild(cancelBtn);

    root.appendChild(btnRow);
  }

  async function handleFormSave(): Promise<void> {
    const form = state.formState;
    if (!form.name.trim()) {
      bridge.notify("Bundle name is required", "error");
      return;
    }
    if (form.items.length === 0) {
      bridge.notify("At least one product item is required", "error");
      return;
    }
    if (form.discount_tiers.length === 0) {
      bridge.notify("At least one discount tier is required", "error");
      return;
    }

    const isEdit = state.view === "edit";

    try {
      if (isEdit && state.editingBundle) {
        const reqBody: AdminUpdateBundleRequest = {
          bundle_id: state.editingBundle,
          name: form.name.trim(),
          bundle_type: form.bundle_type,
          enabled: form.enabled,
          required_item_count:
            form.bundle_type === "flexible" && form.required_item_count !== null
              ? form.required_item_count
              : undefined,
          items: form.items,
          discount_type: form.discount_type,
          discount_tiers: form.discount_tiers,
        };
        const resp = (await bridge.call(
          "/admin/bundles/update",
          reqBody
        )) as AdminUpdateBundleResponse;
        if (resp.status !== "ok") {
          bridge.notify(resp.error ?? "Update failed", "error");
          return;
        }
        bridge.notify("Bundle updated", "success");
      } else {
        const reqBody: AdminCreateBundleRequest = {
          name: form.name.trim(),
          bundle_type: form.bundle_type,
          enabled: form.enabled,
          required_item_count:
            form.bundle_type === "flexible" && form.required_item_count !== null
              ? form.required_item_count
              : undefined,
          items: form.items,
          discount_type: form.discount_type,
          discount_tiers: form.discount_tiers,
        };
        const resp = (await bridge.call(
          "/admin/bundles/create",
          reqBody
        )) as AdminCreateBundleResponse;
        if (resp.status !== "ok") {
          bridge.notify(resp.error ?? "Create failed", "error");
          return;
        }
        bridge.notify("Bundle created", "success");
      }

      bridge.saveBar.hide("bundle-form");
      state.view = "list";
      state.editingBundle = null;
      await loadBundles();
    } catch (err: unknown) {
      bridge.notify("An error occurred", "error");
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function appendFormRow(
    parent: HTMLElement,
    labelText: string,
    buildInput: (wrapper: HTMLDivElement) => void
  ): void {
    const row = document.createElement("div");
    row.className = "form-row";
    const label = document.createElement("label");
    label.textContent = labelText;
    row.appendChild(label);
    const wrapper = document.createElement("div");
    buildInput(wrapper);
    row.appendChild(wrapper);
    parent.appendChild(row);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  render();
  loadBundles();
}
