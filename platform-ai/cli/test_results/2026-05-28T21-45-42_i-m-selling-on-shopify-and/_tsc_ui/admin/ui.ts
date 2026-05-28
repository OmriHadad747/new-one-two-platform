import type { AdminBridge } from "@platform/admin-sdk";

// ─── Inline types (mirrors contracts.ts shapes) ───────────────────────────────

type BundleId = string & { __brand: "BundleId" };
type BundleType = "fixed" | "flexible";
type DiscountKind = "percentage" | "flat_amount" | "buy_x_get_y";
type AvailabilityStatus = "active" | "degraded" | "suspended";

interface TierRuleInput {
  min_quantity: number;
  discount_value: number;
  position: number;
}

interface ComponentInput {
  product_external_id: number;
  variant_external_id?: number | null;
  position: number;
}

interface BundleSummary {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  discount_kind: DiscountKind;
  enabled: boolean;
  availability_status: AvailabilityStatus;
  purchase_count: number;
  created_at: string;
  updated_at: string;
}

interface AdminListBundlesResponse {
  items: BundleSummary[];
  total: number;
  page: number;
  page_size: number;
}

interface AdminCreateBundleResponse {
  bundle_id: BundleId | null;
  validation_errors: string[];
}

interface AdminUpdateBundleResponse {
  success: boolean;
  validation_errors: string[];
}

interface AdminToggleBundleResponse {
  success: boolean;
}

interface AdminDeleteBundleResponse {
  success: boolean;
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mount(container: HTMLElement, bridge: AdminBridge): void {
  // ─── State ────────────────────────────────────────────────────────────────
  let currentPage = 1;
  const pageSize = 20;
  let totalBundles = 0;
  let editingBundleId: BundleId | null = null;
  let isDirty = false;

  // ─── CSS Injection ─────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bundle-app { padding: 16px; }
    .bundle-app table { width: 100%; border-collapse: collapse; }
    .bundle-app th, .bundle-app td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--p-color-bg-surface-secondary, #f1f2f3); }
    .bundle-app th { font-weight: 600; color: var(--p-color-text-subdued, #637381); font-size: 13px; }
    .bundle-app .form-row { margin-bottom: 16px; }
    .bundle-app label { display: block; font-weight: 500; margin-bottom: 4px; font-size: 14px; }
    .bundle-app input[type=text], .bundle-app input[type=number], .bundle-app select {
      width: 100%; padding: 8px; border: 1px solid #c9cccf; border-radius: 4px; font-size: 14px; box-sizing: border-box;
    }
    .bundle-app .tier-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .bundle-app .tier-row input { width: 120px; }
    .bundle-app .actions { display: flex; gap: 8px; margin-top: 8px; }
    .bundle-app .pagination { display: flex; gap: 8px; align-items: center; margin-top: 16px; justify-content: flex-end; }
    .bundle-app .section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
    .bundle-app .component-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; padding: 6px; background: var(--p-color-bg-surface-secondary, #f1f2f3); border-radius: 4px; }
    .bundle-app .validation-errors { color: #d72c0d; font-size: 13px; margin-bottom: 12px; }
    .bundle-app .validation-errors li { margin-bottom: 4px; }
    .bundle-app .empty-state { text-align: center; padding: 32px; color: var(--p-color-text-subdued, #637381); }
  `;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = "bundle-app";
  container.appendChild(root);

  // ─── Utilities ────────────────────────────────────────────────────────────

  function formatDate(iso: string): string {
    return new Intl.DateTimeFormat(bridge.context.locale, {
      dateStyle: "medium",
    }).format(new Date(iso));
  }

  function badgeClass(status: AvailabilityStatus): string {
    switch (status) {
      case "active": return "badge badge-success";
      case "degraded": return "badge badge-warning";
      case "suspended": return "badge badge-critical";
    }
  }

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setDirty(): void {
    if (!isDirty) {
      isDirty = true;
      bridge.saveBar.show("bundle-form");
    }
  }

  // ─── Bundle List ──────────────────────────────────────────────────────────

  async function renderList(): Promise<void> {
    isDirty = false;

    const res = (await bridge.call("/admin/bundles", {
      page: currentPage,
      page_size: pageSize,
    })) as AdminListBundlesResponse;

    totalBundles = res.total;
    const bundles = res.items;

    root.innerHTML = "";

    // Header
    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;";

    const titleEl = document.createElement("h1");
    titleEl.className = "section-title";
    titleEl.style.margin = "0";
    titleEl.textContent = "Product Bundles";
    header.appendChild(titleEl);

    const createBtn = document.createElement("button");
    createBtn.className = "btn-primary";
    createBtn.textContent = "Create Bundle";
    createBtn.addEventListener("click", () => { renderCreateForm(); });
    header.appendChild(createBtn);

    root.appendChild(header);

    if (bundles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "shell-card empty-state";
      const p1 = document.createElement("p");
      p1.textContent = "No bundles yet.";
      const p2 = document.createElement("p");
      p2.textContent = "Create your first bundle to start lifting average order value.";
      empty.appendChild(p1);
      empty.appendChild(p2);
      root.appendChild(empty);
    } else {
      const card = document.createElement("div");
      card.className = "shell-card";

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr>
        <th>Title</th><th>Type</th><th>Discount</th><th>Status</th>
        <th>Enabled</th><th>Purchases</th><th>Created</th><th>Actions</th>
      </tr>`;
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const bundle of bundles) {
        const tr = document.createElement("tr");

        const cells: string[] = [
          `<strong>${escapeHtml(bundle.title)}</strong>`,
          bundle.bundle_type,
          bundle.discount_kind.replace(/_/g, " "),
          `<span class="${badgeClass(bundle.availability_status)}">${bundle.availability_status}</span>`,
          bundle.enabled ? "✓" : "✗",
          String(bundle.purchase_count),
          formatDate(bundle.created_at),
        ];

        for (const cellHtml of cells) {
          const td = document.createElement("td");
          td.innerHTML = cellHtml;
          tr.appendChild(td);
        }

        const actionsTd = document.createElement("td");

        const editBtn = document.createElement("button");
        editBtn.className = "btn-secondary";
        editBtn.style.marginRight = "6px";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => { renderEditForm(bundle); });
        actionsTd.appendChild(editBtn);

        const toggleBtn = document.createElement("button");
        toggleBtn.className = bundle.enabled ? "btn-secondary" : "btn-primary";
        toggleBtn.textContent = bundle.enabled ? "Disable" : "Enable";
        toggleBtn.style.marginRight = "6px";
        toggleBtn.addEventListener("click", () => { void toggleBundle(bundle.id, !bundle.enabled); });
        actionsTd.appendChild(toggleBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn-destructive";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => { void deleteBundle(bundle.id, bundle.title); });
        actionsTd.appendChild(deleteBtn);

        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
      card.appendChild(table);
      root.appendChild(card);
    }

    // Pagination
    if (totalBundles > pageSize) {
      const totalPages = Math.ceil(totalBundles / pageSize);
      const pagination = document.createElement("div");
      pagination.className = "pagination";

      const info = document.createElement("span");
      info.style.color = "var(--p-color-text-subdued, #637381)";
      info.textContent = `Page ${currentPage} of ${totalPages} (${totalBundles} bundles)`;
      pagination.appendChild(info);

      if (currentPage > 1) {
        const prevBtn = document.createElement("button");
        prevBtn.className = "btn-secondary";
        prevBtn.textContent = "← Prev";
        prevBtn.addEventListener("click", () => { currentPage--; void renderList(); });
        pagination.appendChild(prevBtn);
      }

      if (currentPage < totalPages) {
        const nextBtn = document.createElement("button");
        nextBtn.className = "btn-secondary";
        nextBtn.textContent = "Next →";
        nextBtn.addEventListener("click", () => { currentPage++; void renderList(); });
        pagination.appendChild(nextBtn);
      }

      root.appendChild(pagination);
    }
  }

  // ─── Toggle / Delete ──────────────────────────────────────────────────────

  async function toggleBundle(bundleId: BundleId, enabled: boolean): Promise<void> {
    const res = (await bridge.call("/admin/bundles/toggle", {
      bundle_id: bundleId,
      enabled,
    })) as AdminToggleBundleResponse;

    if (res.success) {
      bridge.notify(`Bundle ${enabled ? "enabled" : "disabled"}.`, "success");
    } else {
      bridge.notify("Toggle failed. Please try again.", "error");
    }
    await renderList();
  }

  async function deleteBundle(bundleId: BundleId, title: string): Promise<void> {
    if (!confirm(`Delete bundle "${title}"? This cannot be undone.`)) return;

    const res = (await bridge.call("/admin/bundles/delete", {
      bundle_id: bundleId,
    })) as AdminDeleteBundleResponse;

    if (res.success) {
      bridge.notify("Bundle deleted.", "success");
      const remainingOnPage = totalBundles % pageSize;
      if (remainingOnPage === 1 && currentPage > 1) {
        currentPage--;
      }
    } else {
      bridge.notify("Delete failed. Please try again.", "error");
    }
    await renderList();
  }

  // ─── Bundle Form ──────────────────────────────────────────────────────────

  interface BundleFormState {
    title: string;
    bundle_type: BundleType;
    required_count: number | null;
    discount_kind: DiscountKind;
    discount_value: number | null;
    discount_currency: string | null;
    enabled: boolean;
    tier_rules: TierRuleInput[];
    components: ComponentInput[];
  }

  function renderBundleForm(
    initial: Partial<BundleFormState>,
    formTitle: string,
    onSubmit: (state: BundleFormState) => Promise<void>
  ): void {
    root.innerHTML = "";
    isDirty = false;

    const state: BundleFormState = {
      title: initial.title ?? "",
      bundle_type: initial.bundle_type ?? "fixed",
      required_count: initial.required_count ?? null,
      discount_kind: initial.discount_kind ?? "percentage",
      discount_value: initial.discount_value ?? null,
      discount_currency: initial.discount_currency ?? bridge.context.currency,
      enabled: initial.enabled !== undefined ? initial.enabled : true,
      tier_rules: initial.tier_rules ? [...initial.tier_rules] : [],
      components: initial.components ? [...initial.components] : [],
    };

    // Back header
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:12px;margin-bottom:20px;";

    const backBtn = document.createElement("button");
    backBtn.className = "btn-secondary";
    backBtn.textContent = "← Back";
    backBtn.addEventListener("click", () => {
      if (isDirty && !confirm("You have unsaved changes. Discard them?")) return;
      bridge.saveBar.hide("bundle-form");
      void renderList();
    });
    header.appendChild(backBtn);

    const h1 = document.createElement("h1");
    h1.className = "section-title";
    h1.style.margin = "0";
    h1.textContent = formTitle;
    header.appendChild(h1);
    root.appendChild(header);

    const card = document.createElement("div");
    card.className = "shell-card";
    root.appendChild(card);

    // Validation errors
    const errorsDiv = document.createElement("div");
    errorsDiv.className = "validation-errors";
    errorsDiv.style.display = "none";
    card.appendChild(errorsDiv);

    function showErrors(errors: string[]): void {
      if (errors.length === 0) {
        errorsDiv.style.display = "none";
        errorsDiv.innerHTML = "";
        return;
      }
      errorsDiv.style.display = "block";
      errorsDiv.innerHTML = "";
      const ul = document.createElement("ul");
      for (const e of errors) {
        const li = document.createElement("li");
        li.textContent = e;
        ul.appendChild(li);
      }
      errorsDiv.appendChild(ul);
    }

    // Title field
    addFormField(card, "Bundle Title *", (row) => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = state.title;
      input.placeholder = "e.g. Starter Pack";
      input.addEventListener("input", () => { state.title = input.value; setDirty(); });
      row.appendChild(input);
    });

    // Bundle type
    const typeSelect = document.createElement("select");
    typeSelect.innerHTML = `<option value="fixed">Fixed (customer buys all items)</option><option value="flexible">Flexible (customer picks from pool)</option>`;
    typeSelect.value = state.bundle_type;
    addFormField(card, "Bundle Type *", (row) => { row.appendChild(typeSelect); });

    // Required count
    const reqCountRow = document.createElement("div");
    reqCountRow.className = "form-row";
    const reqCountLabel = document.createElement("label");
    reqCountLabel.textContent = "Required Item Count (flexible only)";
    reqCountRow.appendChild(reqCountLabel);
    const reqCountInput = document.createElement("input");
    reqCountInput.type = "number";
    reqCountInput.min = "1";
    reqCountInput.value = state.required_count != null ? String(state.required_count) : "";
    reqCountInput.placeholder = "e.g. 3";
    reqCountInput.addEventListener("input", () => {
      const v = parseInt(reqCountInput.value, 10);
      state.required_count = isNaN(v) ? null : v;
      setDirty();
    });
    reqCountRow.appendChild(reqCountInput);
    card.appendChild(reqCountRow);

    function updateReqCountVisibility(): void {
      reqCountRow.style.display = state.bundle_type === "flexible" ? "block" : "none";
    }

    typeSelect.addEventListener("change", () => {
      state.bundle_type = typeSelect.value as BundleType;
      setDirty();
      updateReqCountVisibility();
    });
    updateReqCountVisibility();

    // Discount kind
    const dkSelect = document.createElement("select");
    dkSelect.innerHTML = `
      <option value="percentage">Percentage Off</option>
      <option value="flat_amount">Flat Amount Off</option>
      <option value="buy_x_get_y">Buy X Get Y Free</option>
    `;
    dkSelect.value = state.discount_kind;
    dkSelect.addEventListener("change", () => { state.discount_kind = dkSelect.value as DiscountKind; setDirty(); });
    addFormField(card, "Discount Kind *", (row) => { row.appendChild(dkSelect); });

    // Discount value
    addFormField(card, "Base Discount Value", (row) => {
      const hint = document.createElement("small");
      hint.style.color = "var(--p-color-text-subdued)";
      hint.textContent = "Percentage (0-100) or flat amount; overridden by tiers if configured.";
      row.appendChild(hint);
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.value = state.discount_value != null ? String(state.discount_value) : "";
      input.placeholder = "e.g. 10";
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        state.discount_value = isNaN(v) ? null : v;
        setDirty();
      });
      row.appendChild(input);
    });

    // Enabled
    const enabledRow = document.createElement("div");
    enabledRow.className = "form-row";
    enabledRow.style.cssText = "display:flex;align-items:center;gap:8px;";
    const enabledCheck = document.createElement("input");
    enabledCheck.type = "checkbox";
    enabledCheck.id = "bundle-enabled-chk";
    enabledCheck.checked = state.enabled;
    enabledCheck.addEventListener("change", () => { state.enabled = enabledCheck.checked; setDirty(); });
    const enabledLabel = document.createElement("label");
    enabledLabel.htmlFor = "bundle-enabled-chk";
    enabledLabel.textContent = "Enable this bundle";
    enabledLabel.style.marginBottom = "0";
    enabledRow.appendChild(enabledCheck);
    enabledRow.appendChild(enabledLabel);
    card.appendChild(enabledRow);

    // ── Components ───────────────────────────────────────────────────────────
    const compSection = document.createElement("div");
    compSection.className = "shell-section";
    compSection.style.marginTop = "24px";

    const compHeaderDiv = document.createElement("div");
    compHeaderDiv.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;";
    const compH2 = document.createElement("h2");
    compH2.style.cssText = "font-size:14px;font-weight:600;margin:0;";
    compH2.textContent = "Bundle Components";
    compHeaderDiv.appendChild(compH2);

    const addProdBtn = document.createElement("button");
    addProdBtn.className = "btn-secondary";
    addProdBtn.textContent = "+ Add Products";
    addProdBtn.addEventListener("click", () => {
      void (async () => {
        const picked = await bridge.pickResource({ type: "product" });
        if (!picked) return;
        for (const p of picked) {
          const numericId = p.id.split("/").pop();
          if (!numericId) continue;
          const alreadyAdded = state.components.some(
            (c) => String(c.product_external_id) === numericId && c.variant_external_id == null
          );
          if (!alreadyAdded) {
            state.components.push({
              product_external_id: parseInt(numericId, 10),
              variant_external_id: null,
              position: state.components.length,
            });
          }
        }
        setDirty();
        renderComponents();
      })();
    });
    compHeaderDiv.appendChild(addProdBtn);

    const addVarBtn = document.createElement("button");
    addVarBtn.className = "btn-secondary";
    addVarBtn.style.marginLeft = "8px";
    addVarBtn.textContent = "+ Add Variants";
    addVarBtn.addEventListener("click", () => {
      void (async () => {
        const picked = await bridge.pickResource({ type: "variant" });
        if (!picked) return;
        for (const v of picked) {
          const variantNumericId = v.id.split("/").pop();
          if (!variantNumericId) continue;
          state.components.push({
            product_external_id: 0,
            variant_external_id: parseInt(variantNumericId, 10),
            position: state.components.length,
          });
        }
        setDirty();
        renderComponents();
      })();
    });
    compHeaderDiv.appendChild(addVarBtn);

    compSection.appendChild(compHeaderDiv);

    const compList = document.createElement("div");
    compSection.appendChild(compList);
    card.appendChild(compSection);

    function renderComponents(): void {
      compList.innerHTML = "";
      if (state.components.length === 0) {
        const noComp = document.createElement("p");
        noComp.style.cssText = "color:var(--p-color-text-subdued,#637381);font-size:13px;";
        noComp.textContent = "No components added. Use the buttons above to add products or variants.";
        compList.appendChild(noComp);
        return;
      }
      state.components.forEach((comp, idx) => {
        const row = document.createElement("div");
        row.className = "component-row";

        const label = document.createElement("span");
        label.textContent = comp.variant_external_id != null
          ? `Variant ID: ${comp.variant_external_id}`
          : `Product ID: ${comp.product_external_id}`;
        row.appendChild(label);

        const removeBtn = document.createElement("button");
        removeBtn.className = "btn-destructive";
        removeBtn.style.marginLeft = "auto";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
          state.components.splice(idx, 1);
          state.components.forEach((c, i) => { c.position = i; });
          setDirty();
          renderComponents();
        });
        row.appendChild(removeBtn);
        compList.appendChild(row);
      });
    }
    renderComponents();

    // ── Tiers ────────────────────────────────────────────────────────────────
    const tierSection = document.createElement("div");
    tierSection.className = "shell-section";
    tierSection.style.marginTop = "24px";

    const tierHeaderDiv = document.createElement("div");
    tierHeaderDiv.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;";
    const tierH2 = document.createElement("h2");
    tierH2.style.cssText = "font-size:14px;font-weight:600;margin:0;";
    tierH2.textContent = "Tiered Discounts (optional)";
    tierHeaderDiv.appendChild(tierH2);

    const addTierBtn = document.createElement("button");
    addTierBtn.className = "btn-secondary";
    addTierBtn.textContent = "+ Add Tier";
    addTierBtn.addEventListener("click", () => {
      const lastTier = state.tier_rules[state.tier_rules.length - 1];
      state.tier_rules.push({
        min_quantity: lastTier != null ? lastTier.min_quantity + 1 : 2,
        discount_value: 0,
        position: state.tier_rules.length,
      });
      setDirty();
      renderTiers();
    });
    tierHeaderDiv.appendChild(addTierBtn);
    tierSection.appendChild(tierHeaderDiv);

    const tierList = document.createElement("div");
    tierSection.appendChild(tierList);
    card.appendChild(tierSection);

    function renderTiers(): void {
      tierList.innerHTML = "";
      if (state.tier_rules.length === 0) {
        const noTier = document.createElement("p");
        noTier.style.cssText = "color:var(--p-color-text-subdued,#637381);font-size:13px;";
        noTier.textContent = "No tiers configured. The base discount value will apply.";
        tierList.appendChild(noTier);
        return;
      }
      state.tier_rules.forEach((tier, idx) => {
        const row = document.createElement("div");
        row.className = "tier-row";

        const qtyLabel = document.createElement("label");
        qtyLabel.textContent = "Min qty:";
        qtyLabel.style.cssText = "margin:0;width:70px;";
        row.appendChild(qtyLabel);

        const qtyInput = document.createElement("input");
        qtyInput.type = "number";
        qtyInput.min = "1";
        qtyInput.style.width = "80px";
        qtyInput.value = String(tier.min_quantity);
        qtyInput.addEventListener("input", () => {
          const v = parseInt(qtyInput.value, 10);
          tier.min_quantity = isNaN(v) ? 1 : v;
          setDirty();
        });
        row.appendChild(qtyInput);

        const valLabel = document.createElement("label");
        valLabel.textContent = "Discount:";
        valLabel.style.cssText = "margin:0;width:70px;";
        row.appendChild(valLabel);

        const valInput = document.createElement("input");
        valInput.type = "number";
        valInput.min = "0";
        valInput.step = "0.01";
        valInput.style.width = "80px";
        valInput.value = String(tier.discount_value);
        valInput.addEventListener("input", () => {
          const v = parseFloat(valInput.value);
          tier.discount_value = isNaN(v) ? 0 : v;
          setDirty();
        });
        row.appendChild(valInput);

        const removeBtn = document.createElement("button");
        removeBtn.className = "btn-destructive";
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", () => {
          state.tier_rules.splice(idx, 1);
          state.tier_rules.forEach((t, i) => { t.position = i; });
          setDirty();
          renderTiers();
        });
        row.appendChild(removeBtn);
        tierList.appendChild(row);
      });
    }
    renderTiers();

    // ── Actions ──────────────────────────────────────────────────────────────
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "actions";
    actionsDiv.style.marginTop = "24px";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      if (isDirty && !confirm("You have unsaved changes. Discard them?")) return;
      bridge.saveBar.hide("bundle-form");
      void renderList();
    });
    actionsDiv.appendChild(cancelBtn);

    const submitBtn = document.createElement("button");
    submitBtn.className = "btn-primary";
    submitBtn.textContent = formTitle;
    submitBtn.addEventListener("click", () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
      showErrors([]);
      void (async () => {
        try {
          await onSubmit(state);
        } catch {
          bridge.notify("An unexpected error occurred.", "error");
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = formTitle;
        }
      })();
    });
    actionsDiv.appendChild(submitBtn);
    card.appendChild(actionsDiv);

    // Store showErrors for submit handler
    (card as HTMLElement & { _showErrors?: (e: string[]) => void })._showErrors = showErrors;
  }

  function addFormField(
    parent: HTMLElement,
    labelText: string,
    buildInput: (row: HTMLElement) => void
  ): void {
    const row = document.createElement("div");
    row.className = "form-row";
    const lbl = document.createElement("label");
    lbl.textContent = labelText;
    row.appendChild(lbl);
    buildInput(row);
    parent.appendChild(row);
  }

  // ─── Create Form ──────────────────────────────────────────────────────────

  function renderCreateForm(): void {
    renderBundleForm({}, "Create Bundle", async (state) => {
      const res = (await bridge.call("/admin/bundles/create", {
        title: state.title,
        bundle_type: state.bundle_type,
        required_count: state.required_count,
        discount_kind: state.discount_kind,
        discount_value: state.discount_value,
        discount_currency: state.discount_currency,
        tier_rules: state.tier_rules,
        components: state.components,
        enabled: state.enabled,
      })) as AdminCreateBundleResponse;

      const card = root.querySelector(".shell-card") as (HTMLElement & { _showErrors?: (e: string[]) => void }) | null;
      const showErrsFn = card?._showErrors;

      if (res.validation_errors && res.validation_errors.length > 0) {
        if (showErrsFn) showErrsFn(res.validation_errors);
        return;
      }

      bridge.saveBar.hide("bundle-form");
      isDirty = false;
      bridge.notify("Bundle created successfully!", "success");
      currentPage = 1;
      await renderList();
    });
  }

  // ─── Edit Form ────────────────────────────────────────────────────────────

  function renderEditForm(bundle: BundleSummary): void {
    editingBundleId = bundle.id;
    renderBundleForm(
      {
        title: bundle.title,
        bundle_type: bundle.bundle_type,
        discount_kind: bundle.discount_kind,
        enabled: bundle.enabled,
      },
      "Save Changes",
      async (state) => {
        if (!editingBundleId) return;

        const res = (await bridge.call("/admin/bundles/update", {
          bundle_id: editingBundleId,
          title: state.title,
          bundle_type: state.bundle_type,
          required_count: state.required_count,
          discount_kind: state.discount_kind,
          discount_value: state.discount_value,
          discount_currency: state.discount_currency,
          tier_rules: state.tier_rules,
          components: state.components,
          enabled: state.enabled,
        })) as AdminUpdateBundleResponse;

        const card = root.querySelector(".shell-card") as (HTMLElement & { _showErrors?: (e: string[]) => void }) | null;
        const showErrsFn = card?._showErrors;

        if (res.validation_errors && res.validation_errors.length > 0) {
          if (showErrsFn) showErrsFn(res.validation_errors);
          return;
        }

        bridge.saveBar.hide("bundle-form");
        isDirty = false;
        bridge.notify("Bundle updated successfully!", "success");
        await renderList();
      }
    );
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  void renderList();
}
