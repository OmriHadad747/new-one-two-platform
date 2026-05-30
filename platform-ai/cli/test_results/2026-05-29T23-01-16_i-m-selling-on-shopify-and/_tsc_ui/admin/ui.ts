import type { AdminBridge } from "@platform/admin-sdk";
import type {
  BundleId,
  BundleType,
  DiscountKind,
  BundleListItem,
  BundleRow,
  BundleMemberRow,
  BundleDiscountTierRow,
  MemberInput,
  TierInput,
  AdminListBundlesResponse,
  AdminBundleDetailResponse,
  AdminCreateBundleResponse,
  AdminUpdateBundleResponse,
} from "../src/types/contracts.js";

export function mount(container: HTMLElement, bridge: AdminBridge): void {
  // ─── State ─────────────────────────────────────────────────────────────────
  let currentView: "list" | "create" | "edit" = "list";
  let currentBundleId: BundleId | null = null;
  let listPage = 1;
  const LIST_PAGE_SIZE = 20;
  let listStatusFilter = "all";

  // ─── CSS ───────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bundles-app { font-family: var(--p-font-family-sans); }
    .bundles-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .bundles-table { width: 100%; border-collapse: collapse; }
    .bundles-table th, .bundles-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--p-color-border); }
    .bundles-table th { font-weight: 600; color: var(--p-color-text-subdued); }
    .bundles-pagination { display: flex; gap: 8px; align-items: center; margin-top: 16px; justify-content: flex-end; }
    .form-field { margin-bottom: 16px; }
    .form-field label { display: block; font-weight: 600; margin-bottom: 4px; }
    .form-field input[type="text"],
    .form-field input[type="number"],
    .form-field select { width: 100%; padding: 8px; border: 1px solid var(--p-color-border); border-radius: 4px; box-sizing: border-box; }
    .tier-row { display: grid; grid-template-columns: 1fr 1fr 40px; gap: 8px; align-items: center; margin-bottom: 8px; }
    .tier-row input { padding: 6px; border: 1px solid var(--p-color-border); border-radius: 4px; width: 100%; box-sizing: border-box; }
    .member-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border: 1px solid var(--p-color-border); border-radius: 4px; margin-bottom: 8px; }
    .member-row-info { flex: 1; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .unavailable-note { color: var(--p-color-text-critical); font-size: 12px; margin-left: 8px; }
    .errors-list { color: var(--p-color-text-critical); margin-bottom: 12px; padding: 8px 12px; background: #fff2f2; border-radius: 4px; border-left: 3px solid var(--p-color-text-critical); }
    .back-link { cursor: pointer; color: #008060; background: none; border: none; font-size: 14px; padding: 0; margin-bottom: 16px; display: inline-block; text-decoration: underline; }
    .form-actions { display: flex; gap: 8px; margin-top: 20px; }
    .section-divider { border: none; border-top: 1px solid var(--p-color-border); margin: 20px 0; }
    .td-actions { display: flex; gap: 6px; }
  `;
  container.appendChild(style);

  const app = document.createElement("div");
  app.className = "bundles-app";
  container.appendChild(app);

  // ─── Render dispatcher ─────────────────────────────────────────────────────
  function render(): void {
    if (currentView === "list") void renderList();
    else if (currentView === "create") void renderForm(null);
    else if (currentView === "edit" && currentBundleId) void renderForm(currentBundleId);
  }

  // ─── List view ─────────────────────────────────────────────────────────────
  async function renderList(): Promise<void> {
    app.innerHTML = "";

    const header = document.createElement("div");
    header.className = "bundles-header shell-section";

    const headerTitle = document.createElement("h2");
    headerTitle.textContent = "Product Bundles";
    headerTitle.style.cssText = "margin:0;font-size:20px;";
    header.appendChild(headerTitle);

    const headerActions = document.createElement("div");
    headerActions.style.cssText = "display:flex;gap:8px;align-items:center;";

    const filterSelect = document.createElement("select");
    filterSelect.innerHTML = `
      <option value="all">All</option>
      <option value="enabled">Enabled</option>
      <option value="disabled">Disabled</option>
    `;
    filterSelect.value = listStatusFilter;
    filterSelect.addEventListener("change", () => {
      listStatusFilter = filterSelect.value;
      listPage = 1;
      void renderList();
    });
    headerActions.appendChild(filterSelect);

    const createBtn = document.createElement("button");
    createBtn.className = "btn-primary";
    createBtn.textContent = "+ Create Bundle";
    createBtn.addEventListener("click", () => {
      currentView = "create";
      render();
    });
    headerActions.appendChild(createBtn);
    header.appendChild(headerActions);
    app.appendChild(header);

    const loadingEl = document.createElement("p");
    loadingEl.textContent = "Loading...";
    app.appendChild(loadingEl);

    let data: AdminListBundlesResponse;
    try {
      data = (await bridge.call("/admin/bundles", {
        page: listPage,
        page_size: LIST_PAGE_SIZE,
        status_filter: listStatusFilter,
      })) as AdminListBundlesResponse;
    } catch {
      loadingEl.remove();
      const errBanner = document.createElement("div");
      errBanner.className = "shell-error-banner";
      errBanner.textContent = "Failed to load bundles. Please refresh.";
      app.appendChild(errBanner);
      return;
    }

    loadingEl.remove();

    const card = document.createElement("div");
    card.className = "shell-card";

    if (data.items.length === 0) {
      const empty = document.createElement("p");
      empty.style.cssText = "color:var(--p-color-text-subdued);text-align:center;padding:32px;";
      empty.textContent = "No bundles yet. Create your first bundle!";
      card.appendChild(empty);
    } else {
      const table = document.createElement("table");
      table.className = "bundles-table";

      const thead = document.createElement("thead");
      const theadRow = document.createElement("tr");
      for (const heading of ["Title", "Type", "Discount", "Status", "Purchases", "Created", "Actions"]) {
        const th = document.createElement("th");
        th.textContent = heading;
        theadRow.appendChild(th);
      }
      thead.appendChild(theadRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const bundle of data.items) {
        const tr = document.createElement("tr");

        const tdTitle = document.createElement("td");
        const strong = document.createElement("strong");
        strong.textContent = bundle.title;
        tdTitle.appendChild(strong);
        tr.appendChild(tdTitle);

        const tdType = document.createElement("td");
        tdType.textContent = bundle.bundle_type;
        tr.appendChild(tdType);

        const tdDiscount = document.createElement("td");
        tdDiscount.textContent = bundle.discount_kind;
        tr.appendChild(tdDiscount);

        const tdStatus = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = bundle.enabled ? "badge badge-success" : "badge";
        badge.textContent = bundle.enabled ? "Enabled" : "Disabled";
        tdStatus.appendChild(badge);
        tr.appendChild(tdStatus);

        const tdPurchases = document.createElement("td");
        tdPurchases.textContent = String(bundle.purchase_count);
        tr.appendChild(tdPurchases);

        const tdCreated = document.createElement("td");
        tdCreated.textContent = new Intl.DateTimeFormat(bridge.context.locale, {
          dateStyle: "medium",
        }).format(new Date(bundle.created_at));
        tr.appendChild(tdCreated);

        const tdActions = document.createElement("td");
        tdActions.className = "td-actions";

        const editBtn = document.createElement("button");
        editBtn.className = "btn-secondary";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => {
          currentBundleId = bundle.id;
          currentView = "edit";
          render();
        });
        tdActions.appendChild(editBtn);

        const toggleBtn = document.createElement("button");
        toggleBtn.className = bundle.enabled ? "btn-destructive" : "btn-primary";
        toggleBtn.textContent = bundle.enabled ? "Disable" : "Enable";
        toggleBtn.addEventListener("click", async () => {
          toggleBtn.disabled = true;
          try {
            await bridge.call("/admin/bundles/toggle", {
              bundle_id: bundle.id,
              enabled: !bundle.enabled,
            });
            bridge.notify(`Bundle ${!bundle.enabled ? "enabled" : "disabled"}`, "success");
            void renderList();
          } catch {
            bridge.notify("Failed to toggle bundle", "error");
            toggleBtn.disabled = false;
          }
        });
        tdActions.appendChild(toggleBtn);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      card.appendChild(table);
    }

    app.appendChild(card);

    // Pagination
    const totalPages = Math.ceil(data.total / data.page_size);
    if (totalPages > 1) {
      const pagination = document.createElement("div");
      pagination.className = "bundles-pagination";

      const pageInfo = document.createElement("span");
      pageInfo.style.color = "var(--p-color-text-subdued)";
      pageInfo.textContent = `Page ${data.page} of ${totalPages} (${data.total} total)`;
      pagination.appendChild(pageInfo);

      const prevBtn = document.createElement("button");
      prevBtn.className = "btn-secondary";
      prevBtn.textContent = "← Prev";
      prevBtn.disabled = data.page <= 1;
      prevBtn.addEventListener("click", () => {
        if (listPage > 1) { listPage--; void renderList(); }
      });
      pagination.appendChild(prevBtn);

      const nextBtn = document.createElement("button");
      nextBtn.className = "btn-secondary";
      nextBtn.textContent = "Next →";
      nextBtn.disabled = data.page >= totalPages;
      nextBtn.addEventListener("click", () => {
        if (listPage < totalPages) { listPage++; void renderList(); }
      });
      pagination.appendChild(nextBtn);
      app.appendChild(pagination);
    }
  }

  // ─── Create / Edit form ───────────────────────────────────────────────────
  async function renderForm(bundleId: BundleId | null): Promise<void> {
    app.innerHTML = "";

    const isEdit = bundleId !== null;
    let existingDetail: AdminBundleDetailResponse | null = null;
    // members: each entry has product_external_id (required), variant_external_id (null for product-level)
    let members: MemberInput[] = [];
    let tiers: TierInput[] = [{ min_item_count: 2, discount_value: "0.10", position: 0 }];
    let discountKind: DiscountKind = "percentage";
    let bundleType: BundleType = "fixed";
    let requiredCount = 3;
    let titleValue = "";
    let enabledValue = true;

    if (isEdit && bundleId) {
      const loading = document.createElement("p");
      loading.textContent = "Loading bundle...";
      app.appendChild(loading);
      try {
        existingDetail = (await bridge.call("/admin/bundles/detail", {
          bundle_id: bundleId,
        })) as AdminBundleDetailResponse;
        loading.remove();
        titleValue = existingDetail.bundle.title;
        discountKind = existingDetail.bundle.discount_kind;
        bundleType = existingDetail.bundle.bundle_type;
        requiredCount = existingDetail.bundle.required_selection_count;
        enabledValue = existingDetail.bundle.enabled;
        members = existingDetail.members.map((m: BundleMemberRow) => ({
          product_external_id: m.product_external_id,
          variant_external_id: m.variant_external_id ?? null,
          position: m.position,
        }));
        tiers = existingDetail.tiers.map((t: BundleDiscountTierRow) => ({
          min_item_count: t.min_item_count,
          discount_value: t.discount_value ?? null,
          discount_amount: t.discount_amount != null ? parseInt(t.discount_amount, 10) : null,
          discount_currency: t.discount_currency ?? null,
          free_item_count: t.free_item_count ?? null,
          position: t.position,
        }));
      } catch {
        loading.remove();
        const errBanner = document.createElement("div");
        errBanner.className = "shell-error-banner";
        errBanner.textContent = "Failed to load bundle details.";
        app.appendChild(errBanner);
        return;
      }
    }

    // Back button
    const backBtn = document.createElement("button");
    backBtn.className = "back-link";
    backBtn.textContent = "← Back to bundles";
    backBtn.addEventListener("click", () => {
      bridge.saveBar.hide();
      currentView = "list";
      render();
    });
    app.appendChild(backBtn);

    const card = document.createElement("div");
    card.className = "shell-card";

    const formTitle = document.createElement("h2");
    formTitle.textContent = isEdit ? "Edit Bundle" : "Create Bundle";
    formTitle.style.marginTop = "0";
    card.appendChild(formTitle);

    // Error container
    const errorsEl = document.createElement("div");
    errorsEl.className = "errors-list";
    errorsEl.style.display = "none";
    card.appendChild(errorsEl);

    // ─── Title field ─────────────────────────────────────────────────────
    const titleField = createTextField("Bundle Title", titleValue, "Enter bundle title");
    titleField.input.addEventListener("input", () => bridge.saveBar.show());
    card.appendChild(titleField.wrap);

    // ─── Bundle type ──────────────────────────────────────────────────────
    const typeWrap = document.createElement("div");
    typeWrap.className = "form-field";
    const typeLabel = document.createElement("label");
    typeLabel.textContent = "Bundle Type";
    const typeSelect = document.createElement("select");
    typeSelect.innerHTML = `
      <option value="fixed">Fixed (all items required)</option>
      <option value="flexible">Flexible (customer picks)</option>
    `;
    typeSelect.value = bundleType;
    typeSelect.addEventListener("change", () => {
      bundleType = typeSelect.value as BundleType;
      requiredCountWrap.style.display = bundleType === "flexible" ? "" : "none";
      bridge.saveBar.show();
    });
    typeWrap.appendChild(typeLabel);
    typeWrap.appendChild(typeSelect);
    card.appendChild(typeWrap);

    // ─── Required count (flexible only) ───────────────────────────────────
    const requiredCountField = createNumberField("Required Items Count", requiredCount, 1);
    const requiredCountWrap = requiredCountField.wrap;
    requiredCountWrap.style.display = bundleType === "flexible" ? "" : "none";
    requiredCountField.input.addEventListener("input", () => bridge.saveBar.show());
    card.appendChild(requiredCountWrap);

    // ─── Discount kind ────────────────────────────────────────────────────
    const discountKindWrap = document.createElement("div");
    discountKindWrap.className = "form-field";
    const discountKindLabel = document.createElement("label");
    discountKindLabel.textContent = "Discount Type";
    const discountKindSelect = document.createElement("select");
    discountKindSelect.innerHTML = `
      <option value="percentage">Percentage off</option>
      <option value="flat_amount">Flat amount off</option>
      <option value="bxgy">Buy X Get Y Free</option>
    `;
    discountKindSelect.value = discountKind;
    discountKindSelect.addEventListener("change", () => {
      discountKind = discountKindSelect.value as DiscountKind;
      renderTiers();
      bridge.saveBar.show();
    });
    discountKindWrap.appendChild(discountKindLabel);
    discountKindWrap.appendChild(discountKindSelect);
    card.appendChild(discountKindWrap);

    // ─── Enabled toggle ───────────────────────────────────────────────────
    const enabledWrap = document.createElement("div");
    enabledWrap.className = "form-field";
    const enabledLabel = document.createElement("label");
    const enabledCheckbox = document.createElement("input");
    enabledCheckbox.type = "checkbox";
    enabledCheckbox.checked = enabledValue;
    enabledCheckbox.style.marginRight = "6px";
    enabledCheckbox.addEventListener("change", () => bridge.saveBar.show());
    enabledLabel.appendChild(enabledCheckbox);
    enabledLabel.appendChild(document.createTextNode("Bundle enabled"));
    enabledWrap.appendChild(enabledLabel);
    card.appendChild(enabledWrap);

    const divider1 = document.createElement("hr");
    divider1.className = "section-divider";
    card.appendChild(divider1);

    // ─── Members section ──────────────────────────────────────────────────
    // Members use product-level picks. The merchant picks a product;
    // customers can choose any variant of that product in the widget.
    // For specific variant pinning, merchants pick a product and the
    // backend stores variant_external_id when available.
    const membersHeader = document.createElement("div");
    membersHeader.className = "section-header";
    const membersTitle = document.createElement("strong");
    membersTitle.textContent = "Bundle Members";
    membersHeader.appendChild(membersTitle);

    const addProductBtn = document.createElement("button");
    addProductBtn.className = "btn-secondary";
    addProductBtn.textContent = "+ Add Product";
    addProductBtn.addEventListener("click", async () => {
      // Pick a product — product GID: gid://shopify/Product/123456789
      const picked = await bridge.pickResource({ type: "product" });
      if (!picked || picked.length === 0) return;
      for (const resource of picked) {
        // Extract numeric product id from GID
        const gidParts = resource.id.split("/");
        const productExternalId = gidParts[gidParts.length - 1] ?? "";
        if (!productExternalId || !/^\d+$/.test(productExternalId)) continue;
        // Check for duplicate
        const alreadyAdded = members.some((m) => m.product_external_id === productExternalId && !m.variant_external_id);
        if (alreadyAdded) {
          bridge.notify(`"${resource.title}" is already in this bundle`, "error");
          continue;
        }
        members.push({
          product_external_id: productExternalId,
          variant_external_id: null, // product-level member: customer picks any variant
          position: members.length,
        });
        bridge.saveBar.show();
        renderMembers();
      }
    });
    membersHeader.appendChild(addProductBtn);
    card.appendChild(membersHeader);

    const membersHint = document.createElement("p");
    membersHint.style.cssText = "color:var(--p-color-text-subdued);font-size:13px;margin:0 0 12px;";
    membersHint.textContent = "Add products to this bundle. Customers will be able to choose from any available variant of each product.";
    card.appendChild(membersHint);

    const membersContainer = document.createElement("div");
    card.appendChild(membersContainer);

    function renderMembers(): void {
      membersContainer.innerHTML = "";
      if (members.length === 0) {
        const empty = document.createElement("p");
        empty.style.color = "var(--p-color-text-subdued)";
        empty.textContent = "No members added yet. Use the button above to add products.";
        membersContainer.appendChild(empty);
        return;
      }
      members.forEach((m, idx) => {
        const row = document.createElement("div");
        row.className = "member-row";

        const infoDiv = document.createElement("div");
        infoDiv.className = "member-row-info";

        const nameSpan = document.createElement("span");
        nameSpan.textContent = m.variant_external_id
          ? `Variant ID: ${m.variant_external_id} (Product: ${m.product_external_id})`
          : `Product ID: ${m.product_external_id}`;
        infoDiv.appendChild(nameSpan);

        // Show unavailability warning in edit mode
        if (isEdit && existingDetail) {
          const existingMember = existingDetail.members[idx];
          if (existingMember && !existingMember.available) {
            const unavailNote = document.createElement("span");
            unavailNote.className = "unavailable-note";
            unavailNote.textContent = " ⚠ Unavailable";
            infoDiv.appendChild(unavailNote);
          }
        }

        row.appendChild(infoDiv);

        const removeBtn = document.createElement("button");
        removeBtn.className = "btn-destructive";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
          members.splice(idx, 1);
          members.forEach((mem, i) => { mem.position = i; });
          bridge.saveBar.show();
          renderMembers();
        });
        row.appendChild(removeBtn);
        membersContainer.appendChild(row);
      });
    }

    renderMembers();

    const divider2 = document.createElement("hr");
    divider2.className = "section-divider";
    card.appendChild(divider2);

    // ─── Tiers section ────────────────────────────────────────────────────
    const tiersHeaderDiv = document.createElement("div");
    tiersHeaderDiv.className = "section-header";
    const tiersTitleEl = document.createElement("strong");
    tiersTitleEl.textContent = "Discount Tiers";
    tiersHeaderDiv.appendChild(tiersTitleEl);

    const addTierBtn = document.createElement("button");
    addTierBtn.className = "btn-secondary";
    addTierBtn.textContent = "+ Add Tier";
    addTierBtn.addEventListener("click", () => {
      const lastTier = tiers[tiers.length - 1];
      tiers.push({
        min_item_count: lastTier ? lastTier.min_item_count + 1 : 2,
        discount_value: "0.10",
        position: tiers.length,
      });
      bridge.saveBar.show();
      renderTiers();
    });
    tiersHeaderDiv.appendChild(addTierBtn);
    card.appendChild(tiersHeaderDiv);

    const tiersHint = document.createElement("p");
    tiersHint.style.cssText = "color:var(--p-color-text-subdued);font-size:13px;margin:0 0 12px;";
    tiersHint.textContent = "Set a minimum item count and discount per tier. Customers get the best matching tier automatically.";
    card.appendChild(tiersHint);

    const tiersContainer = document.createElement("div");
    card.appendChild(tiersContainer);

    function renderTiers(): void {
      tiersContainer.innerHTML = "";

      // Column headers
      const headerRow = document.createElement("div");
      headerRow.className = "tier-row";
      const col1 = document.createElement("strong");
      col1.textContent = "Min Items";
      const col2 = document.createElement("strong");
      if (discountKind === "percentage") {
        col2.textContent = "% Off (0–100)";
      } else if (discountKind === "flat_amount") {
        col2.textContent = `Amount Off (${bridge.context.currency})`;
      } else {
        col2.textContent = "Free Items Count";
      }
      headerRow.appendChild(col1);
      headerRow.appendChild(col2);
      headerRow.appendChild(document.createElement("span"));
      tiersContainer.appendChild(headerRow);

      tiers.forEach((tier, idx) => {
        const row = document.createElement("div");
        row.className = "tier-row";

        const minInput = document.createElement("input");
        minInput.type = "number";
        minInput.min = "1";
        minInput.value = String(tier.min_item_count);
        minInput.addEventListener("change", () => {
          tier.min_item_count = parseInt(minInput.value, 10) || 1;
          bridge.saveBar.show();
        });

        const valueInput = document.createElement("input");
        if (discountKind === "percentage") {
          valueInput.type = "number";
          valueInput.min = "0";
          valueInput.max = "100";
          valueInput.step = "0.1";
          const pctDisplay = tier.discount_value
            ? Math.round(parseFloat(tier.discount_value) * 100)
            : 10;
          valueInput.value = String(pctDisplay);
          valueInput.addEventListener("change", () => {
            tier.discount_value = String(parseFloat(valueInput.value) / 100);
            bridge.saveBar.show();
          });
        } else if (discountKind === "flat_amount") {
          valueInput.type = "number";
          valueInput.min = "0";
          valueInput.step = "0.01";
          const majorAmount = tier.discount_amount != null ? tier.discount_amount / 100 : 0;
          valueInput.value = String(majorAmount.toFixed(2));
          valueInput.addEventListener("change", () => {
            tier.discount_amount = Math.round(parseFloat(valueInput.value) * 100);
            tier.discount_currency = bridge.context.currency;
            bridge.saveBar.show();
          });
        } else {
          // bxgy
          valueInput.type = "number";
          valueInput.min = "1";
          valueInput.value = String(tier.free_item_count ?? 1);
          valueInput.addEventListener("change", () => {
            tier.free_item_count = parseInt(valueInput.value, 10) || 1;
            bridge.saveBar.show();
          });
        }

        const removeBtn = document.createElement("button");
        removeBtn.className = "btn-destructive";
        removeBtn.textContent = "✕";
        removeBtn.style.cssText = "padding:4px 8px;";
        removeBtn.addEventListener("click", () => {
          tiers.splice(idx, 1);
          tiers.forEach((t, i) => { t.position = i; });
          bridge.saveBar.show();
          renderTiers();
        });

        row.appendChild(minInput);
        row.appendChild(valueInput);
        row.appendChild(removeBtn);
        tiersContainer.appendChild(row);
      });
    }

    renderTiers();

    // ─── Purchase count (edit only) ────────────────────────────────────────
    if (isEdit && existingDetail) {
      const divider3 = document.createElement("hr");
      divider3.className = "section-divider";
      card.appendChild(divider3);

      const purchaseInfo = document.createElement("p");
      purchaseInfo.style.color = "var(--p-color-text-subdued)";
      purchaseInfo.textContent = `Total purchases recorded: ${existingDetail.purchase_count}`;
      card.appendChild(purchaseInfo);
    }

    // ─── Form actions ─────────────────────────────────────────────────────
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "form-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      bridge.saveBar.hide();
      currentView = "list";
      render();
    });
    actionsDiv.appendChild(cancelBtn);

    const submitBtn = document.createElement("button");
    submitBtn.className = "btn-primary";
    submitBtn.textContent = isEdit ? "Save Changes" : "Create Bundle";

    submitBtn.addEventListener("click", async () => {
      errorsEl.style.display = "none";
      errorsEl.innerHTML = "";

      const newTitle = (titleField.input as HTMLInputElement).value.trim();
      const newEnabled = enabledCheckbox.checked;
      const newRequiredCount = parseInt((requiredCountField.input as HTMLInputElement).value, 10) || 0;

      const validationErrors: string[] = [];
      if (!newTitle) validationErrors.push("Title is required");
      if (members.length === 0) validationErrors.push("At least one member is required");
      if (tiers.length === 0) validationErrors.push("At least one tier is required");
      if (bundleType === "flexible" && newRequiredCount < 1) {
        validationErrors.push("Required count must be ≥ 1 for flexible bundles");
      }
      if (bundleType === "flexible" && newRequiredCount > members.length) {
        validationErrors.push(`Required count (${newRequiredCount}) cannot exceed the number of members (${members.length})`);
      }

      if (validationErrors.length > 0) {
        showErrors(validationErrors);
        return;
      }

      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = isEdit ? "Saving..." : "Creating...";

      try {
        if (isEdit && bundleId) {
          const resp = (await bridge.call("/admin/bundles/update", {
            bundle_id: bundleId,
            title: newTitle,
            discount_kind: discountKind,
            required_selection_count: newRequiredCount,
            members,
            tiers,
            enabled: newEnabled,
          })) as AdminUpdateBundleResponse;

          if (resp.errors && resp.errors.length > 0) {
            showErrors(resp.errors);
          } else {
            bridge.notify("Bundle updated successfully", "success");
            bridge.saveBar.hide();
            currentView = "list";
            render();
          }
        } else {
          const resp = (await bridge.call("/admin/bundles/create", {
            title: newTitle,
            bundle_type: bundleType,
            discount_kind: discountKind,
            required_selection_count: newRequiredCount,
            members,
            tiers,
            enabled: newEnabled,
          })) as AdminCreateBundleResponse;

          if (resp.errors && resp.errors.length > 0) {
            showErrors(resp.errors);
          } else {
            bridge.notify("Bundle created successfully", "success");
            bridge.saveBar.hide();
            currentView = "list";
            render();
          }
        }
      } catch {
        bridge.notify("An unexpected error occurred", "error");
      } finally {
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = isEdit ? "Save Changes" : "Create Bundle";
      }
    });

    actionsDiv.appendChild(submitBtn);
    card.appendChild(actionsDiv);
    app.appendChild(card);

    function showErrors(errs: string[]): void {
      errorsEl.innerHTML = "";
      const ul = document.createElement("ul");
      ul.style.margin = "0";
      ul.style.paddingLeft = "20px";
      for (const e of errs) {
        const li = document.createElement("li");
        li.textContent = e;
        ul.appendChild(li);
      }
      errorsEl.appendChild(ul);
      errorsEl.style.display = "";
    }
  }

  // ─── DOM helpers ───────────────────────────────────────────────────────────
  function createTextField(
    labelText: string,
    value: string,
    placeholder: string
  ): { wrap: HTMLDivElement; input: HTMLInputElement } {
    const wrap = document.createElement("div");
    wrap.className = "form-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    wrap.appendChild(label);
    wrap.appendChild(input);
    return { wrap, input };
  }

  function createNumberField(
    labelText: string,
    value: number,
    min: number
  ): { wrap: HTMLDivElement; input: HTMLInputElement } {
    const wrap = document.createElement("div");
    wrap.className = "form-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.min = String(min);
    wrap.appendChild(label);
    wrap.appendChild(input);
    return { wrap, input };
  }

  // ─── Initial render ────────────────────────────────────────────────────────
  render();
}
