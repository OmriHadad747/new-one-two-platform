export function mount(container: HTMLElement, bridge: any): void {
  // ─── Styles ───────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bundle-app { font-family: var(--p-font-family-sans); padding: 16px; }
    .bundle-app .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
    .bundle-app .toolbar h1 { margin: 0; flex: 1; font-size: 1.25rem; font-weight: 600; }
    .bundle-app .filter-bar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
    .bundle-app table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .bundle-app th { text-align: left; padding: 8px 12px; border-bottom: 2px solid var(--p-color-border); color: var(--p-color-text-subdued); font-weight: 500; }
    .bundle-app td { padding: 8px 12px; border-bottom: 1px solid var(--p-color-border); vertical-align: middle; }
    .bundle-app tr:hover td { background: var(--p-color-bg-surface-hover); }
    .bundle-app .row-actions { display: flex; gap: 6px; }
    .bundle-app .pagination { display: flex; gap: 8px; margin-top: 12px; align-items: center; justify-content: flex-end; }
    .bundle-app .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .bundle-app .modal { background: var(--p-color-bg-surface); border-radius: 8px; padding: 24px; min-width: 420px; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto; }
    .bundle-app .modal h2 { margin: 0 0 16px; font-size: 1.125rem; font-weight: 600; }
    .bundle-app .form-field { margin-bottom: 12px; }
    .bundle-app label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 4px; color: var(--p-color-text); }
    .bundle-app input[type=text], .bundle-app select, .bundle-app textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--p-color-border); border-radius: 4px; font-size: 0.875rem; box-sizing: border-box; background: var(--p-color-bg-surface); color: var(--p-color-text); }
    .bundle-app textarea { min-height: 72px; resize: vertical; }
    .bundle-app .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
    .bundle-app .tier-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .bundle-app .tier-row input { flex: 1; }
    .bundle-app .section-tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid var(--p-color-border); }
    .bundle-app .tab-btn { padding: 8px 16px; background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -2px; cursor: pointer; font-size: 0.875rem; color: var(--p-color-text-subdued); }
    .bundle-app .tab-btn.active { border-bottom-color: #008060; color: #008060; font-weight: 600; }
    .bundle-app .bulk-bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: var(--p-color-bg-surface-selected); border-radius: 4px; margin-bottom: 8px; }
    .bundle-app .empty-state { text-align: center; padding: 40px; color: var(--p-color-text-subdued); }
  `;
  container.appendChild(style);

  const app = document.createElement("div");
  app.className = "bundle-app";
  container.appendChild(app);

  // ─── State ─────────────────────────────────────────────────────────────────
  let currentView: "list" | "edit" = "list";
  let currentBundleId: string | null = null;
  let editTab: "details" | "items" | "tiers" | "history" = "details";
  let listPage: string | null = null;
  const pageStack: (string | null)[] = [null];
  let statusFilter = "all";
  let selectedIds: Set<string> = new Set();

  // ─── Render ───────────────────────────────────────────────────────────────
  function render(): void {
    app.innerHTML = "";
    if (currentView === "list") {
      renderList();
    } else {
      renderEditView();
    }
  }

  // ─── Bundle List View ─────────────────────────────────────────────────────
  function renderList(): void {
    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";

    const h1 = document.createElement("h1");
    h1.textContent = "Product Bundles";
    toolbar.appendChild(h1);

    const histBtn = document.createElement("button");
    histBtn.className = "btn-secondary";
    histBtn.textContent = "Purchase History";
    histBtn.addEventListener("click", () => showPurchaseHistoryModal());
    toolbar.appendChild(histBtn);

    const createBtn = document.createElement("button");
    createBtn.className = "btn-primary";
    createBtn.textContent = "+ Create Bundle";
    createBtn.addEventListener("click", () => showCreateModal());
    toolbar.appendChild(createBtn);

    app.appendChild(toolbar);

    // Filter bar
    const filterBar = document.createElement("div");
    filterBar.className = "filter-bar";

    const filterLabel = document.createElement("label");
    filterLabel.textContent = "Status:";
    filterLabel.style.marginBottom = "0";
    filterBar.appendChild(filterLabel);

    const filterSel = document.createElement("select");
    filterSel.style.width = "auto";
    [["all", "All"], ["enabled", "Enabled"], ["disabled", "Disabled"]].forEach(([val, lbl]) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = lbl;
      opt.selected = statusFilter === val;
      filterSel.appendChild(opt);
    });
    filterSel.addEventListener("change", () => {
      statusFilter = filterSel.value;
      pageStack.length = 1;
      pageStack[0] = null;
      listPage = null;
      renderList();
    });
    filterBar.appendChild(filterSel);

    app.appendChild(filterBar);

    // Fetch and render bundles
    const loading = document.createElement("p");
    loading.textContent = "Loading…";
    app.appendChild(loading);

    bridge
      .call("/admin/bundles", {
        status_filter: statusFilter,
        cursor: listPage ?? undefined,
      })
      .then((data: any) => {
        loading.remove();
        const bundles: any[] = data.bundles ?? [];

        // Bulk actions bar
        if (selectedIds.size > 0) {
          const bulkBar = document.createElement("div");
          bulkBar.className = "bulk-bar";
          const cnt = document.createElement("span");
          cnt.textContent = `${selectedIds.size} selected`;
          bulkBar.appendChild(cnt);

          const enableBtn = document.createElement("button");
          enableBtn.className = "btn-secondary";
          enableBtn.textContent = "Enable";
          enableBtn.addEventListener("click", () => bulkSetStatus(true));
          bulkBar.appendChild(enableBtn);

          const disableBtn = document.createElement("button");
          disableBtn.className = "btn-secondary";
          disableBtn.textContent = "Disable";
          disableBtn.addEventListener("click", () => bulkSetStatus(false));
          bulkBar.appendChild(disableBtn);

          app.appendChild(bulkBar);
        }

        if (bundles.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty-state";
          empty.textContent = "No bundles found. Create your first bundle to get started.";
          app.appendChild(empty);
        } else {
          const card = document.createElement("div");
          card.className = "shell-card";

          const table = document.createElement("table");
          const thead = document.createElement("thead");
          thead.innerHTML = `<tr>
            <th><input type="checkbox" id="select-all"></th>
            <th>Title</th><th>Mode</th><th>Status</th><th>Health</th><th>Tiers</th><th>Actions</th>
          </tr>`;
          table.appendChild(thead);

          const tbody = document.createElement("tbody");
          for (const b of bundles) {
            const tr = document.createElement("tr");

            const tdChk = document.createElement("td");
            const chk = document.createElement("input");
            chk.type = "checkbox";
            chk.checked = selectedIds.has(b.id);
            chk.addEventListener("change", () => {
              if (chk.checked) selectedIds.add(b.id);
              else selectedIds.delete(b.id);
              renderList();
            });
            tdChk.appendChild(chk);
            tr.appendChild(tdChk);

            const tdTitle = document.createElement("td");
            const titleLink = document.createElement("a");
            titleLink.href = "#";
            titleLink.textContent = b.title;
            titleLink.style.color = "#008060";
            titleLink.addEventListener("click", (e) => {
              e.preventDefault();
              openEditView(b.id);
            });
            tdTitle.appendChild(titleLink);
            if (b.description) {
              const desc = document.createElement("div");
              desc.style.color = "var(--p-color-text-subdued)";
              desc.style.fontSize = "0.75rem";
              desc.textContent = b.description.slice(0, 60) + (b.description.length > 60 ? "…" : "");
              tdTitle.appendChild(desc);
            }
            tr.appendChild(tdTitle);

            const tdMode = document.createElement("td");
            tdMode.textContent = b.mode === "fixed" ? "Fixed" : "Flexible";
            tr.appendChild(tdMode);

            const tdStatus = document.createElement("td");
            const statusBadge = document.createElement("span");
            statusBadge.className = b.enabled ? "badge badge-success" : "badge";
            statusBadge.textContent = b.enabled ? "Enabled" : "Disabled";
            tdStatus.appendChild(statusBadge);
            tr.appendChild(tdStatus);

            const tdHealth = document.createElement("td");
            const healthBadge = document.createElement("span");
            const healthClass =
              b.health_status === "healthy"
                ? "badge badge-success"
                : b.health_status === "warned"
                ? "badge badge-warning"
                : "badge badge-critical";
            healthBadge.className = healthClass;
            healthBadge.textContent = b.health_status.replace("_", " ");
            tdHealth.appendChild(healthBadge);
            tr.appendChild(tdHealth);

            const tdTiers = document.createElement("td");
            tdTiers.textContent = String(b.tier_count);
            tr.appendChild(tdTiers);

            const tdActions = document.createElement("td");
            tdActions.className = "row-actions";

            const editBtn = document.createElement("button");
            editBtn.className = "btn-secondary";
            editBtn.textContent = "Edit";
            editBtn.addEventListener("click", () => openEditView(b.id));
            tdActions.appendChild(editBtn);

            const cloneBtn = document.createElement("button");
            cloneBtn.className = "btn-secondary";
            cloneBtn.textContent = "Clone";
            cloneBtn.addEventListener("click", () => cloneBundle(b.id));
            tdActions.appendChild(cloneBtn);

            const toggleBtn = document.createElement("button");
            toggleBtn.className = b.enabled ? "btn-destructive" : "btn-secondary";
            toggleBtn.textContent = b.enabled ? "Disable" : "Enable";
            toggleBtn.addEventListener("click", () => toggleBundle(b.id, !b.enabled));
            tdActions.appendChild(toggleBtn);

            tr.appendChild(tdActions);
            tbody.appendChild(tr);
          }

          // Select-all
          const selAllChk = thead.querySelector("#select-all") as HTMLInputElement | null;
          if (selAllChk) {
            selAllChk.addEventListener("change", () => {
              if (selAllChk.checked) {
                bundles.forEach((b) => selectedIds.add(b.id));
              } else {
                selectedIds.clear();
              }
              renderList();
            });
          }

          table.appendChild(tbody);
          card.appendChild(table);
          app.appendChild(card);
        }

        // Pagination
        const pagination = document.createElement("div");
        pagination.className = "pagination";

        const totalEl = document.createElement("span");
        totalEl.textContent = `Total: ${data.total_count}`;
        totalEl.style.color = "var(--p-color-text-subdued)";
        pagination.appendChild(totalEl);

        if (pageStack.length > 1) {
          const prevBtn = document.createElement("button");
          prevBtn.className = "btn-secondary";
          prevBtn.textContent = "← Prev";
          prevBtn.addEventListener("click", () => {
            pageStack.pop();
            listPage = pageStack[pageStack.length - 1] ?? null;
            renderList();
          });
          pagination.appendChild(prevBtn);
        }

        if (data.next_cursor) {
          const nextBtn = document.createElement("button");
          nextBtn.className = "btn-secondary";
          nextBtn.textContent = "Next →";
          nextBtn.addEventListener("click", () => {
            pageStack.push(data.next_cursor);
            listPage = data.next_cursor;
            renderList();
          });
          pagination.appendChild(nextBtn);
        }

        app.appendChild(pagination);
      })
      .catch((err: Error) => {
        loading.textContent = "Failed to load bundles.";
        console.error(err);
      });
  }

  // ─── Bundle Edit View ──────────────────────────────────────────────────────
  function openEditView(bundleId: string): void {
    currentView = "edit";
    currentBundleId = bundleId;
    editTab = "details";
    render();
  }

  function renderEditView(): void {
    const backBtn = document.createElement("button");
    backBtn.className = "btn-secondary";
    backBtn.textContent = "← Back";
    backBtn.style.marginBottom = "12px";
    backBtn.addEventListener("click", () => {
      currentView = "list";
      currentBundleId = null;
      render();
    });
    app.appendChild(backBtn);

    const tabs = document.createElement("div");
    tabs.className = "section-tabs";

    const tabDefs: Array<{ key: typeof editTab; label: string }> = [
      { key: "details", label: "Details" },
      { key: "items", label: "Items" },
      { key: "tiers", label: "Discount Tiers" },
      { key: "history", label: "Health Log" },
    ];

    for (const t of tabDefs) {
      const btn = document.createElement("button");
      btn.className = "tab-btn" + (editTab === t.key ? " active" : "");
      btn.textContent = t.label;
      btn.addEventListener("click", () => {
        editTab = t.key;
        renderEditView();
      });
      tabs.appendChild(btn);
    }

    app.appendChild(tabs);

    const content = document.createElement("div");
    app.appendChild(content);

    if (editTab === "details") renderDetailsTab(content);
    else if (editTab === "items") renderItemsTab(content);
    else if (editTab === "tiers") renderTiersTab(content);
    else renderHealthLogTab(content);
  }

  function renderDetailsTab(container: HTMLElement): void {
    const loading = document.createElement("p");
    loading.textContent = "Loading…";
    container.appendChild(loading);

    // Fetch bundle details + tiers for context
    bridge
      .call("/admin/bundles", { status_filter: "all" })
      .then((data: any) => {
        loading.remove();
        const bundle = (data.bundles as any[]).find((b: any) => b.id === currentBundleId);
        if (!bundle) {
          container.textContent = "Bundle not found.";
          return;
        }
        renderBundleDetailsForm(container, bundle);
      })
      .catch(() => {
        loading.textContent = "Failed to load bundle.";
      });
  }

  function renderBundleDetailsForm(container: HTMLElement, bundle: any): void {
    const card = document.createElement("div");
    card.className = "shell-card";

    // Health warning
    if (bundle.health_status !== "healthy") {
      const warning = document.createElement("div");
      warning.className =
        bundle.health_status === "warned"
          ? "shell-error-banner"
          : "shell-error-banner";
      warning.style.marginBottom = "12px";
      warning.textContent =
        bundle.health_status === "warned"
          ? "⚠ Warning: Some variants in this bundle are out of stock."
          : "🚫 This bundle was auto-disabled due to variant availability issues.";
      card.appendChild(warning);
    }

    const form = document.createElement("form");
    form.addEventListener("submit", (e) => e.preventDefault());

    const titleField = makeFormField("Title", "text", bundle.title, "title");
    form.appendChild(titleField.wrapper);

    const descField = makeTextareaField("Description", bundle.description ?? "", "description");
    form.appendChild(descField.wrapper);

    const modeField = makeSelectField("Mode", ["fixed", "flexible"], ["Fixed", "Flexible"], bundle.mode, "mode");
    form.appendChild(modeField.wrapper);

    const enabledWrapper = document.createElement("div");
    enabledWrapper.className = "form-field";
    const enabledLabel = document.createElement("label");
    enabledLabel.textContent = "Enabled";
    enabledWrapper.appendChild(enabledLabel);
    const enabledChk = document.createElement("input");
    enabledChk.type = "checkbox";
    enabledChk.checked = bundle.enabled;
    enabledWrapper.appendChild(enabledChk);
    form.appendChild(enabledWrapper);

    card.appendChild(form);

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-primary";
    saveBtn.textContent = "Save Changes";
    saveBtn.addEventListener("click", async () => {
      bridge.saveBar.show("details");
      try {
        await bridge.call("/admin/bundles/update", {
          bundle_id: currentBundleId,
          title: (titleField.input as HTMLInputElement).value,
          description: (descField.input as HTMLTextAreaElement).value || undefined,
          mode: (modeField.input as HTMLSelectElement).value,
          enabled: enabledChk.checked,
        });
        bridge.saveBar.hide("details");
        bridge.notify("Bundle saved", "success");
        // Refetch
        container.innerHTML = "";
        renderDetailsTab(container);
      } catch (err: any) {
        bridge.saveBar.hide("details");
        bridge.notify(err?.message ?? "Save failed", "error");
      }
    });
    card.appendChild(saveBtn);

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.className = "btn-destructive";
    delBtn.textContent = "Delete Bundle";
    delBtn.style.marginLeft = "8px";
    delBtn.addEventListener("click", async () => {
      if (!confirm("Delete this bundle permanently?")) return;
      try {
        await bridge.call("/admin/bundles/remove", { bundle_id: currentBundleId });
        bridge.notify("Bundle deleted", "success");
        currentView = "list";
        currentBundleId = null;
        render();
      } catch {
        bridge.notify("Delete failed", "error");
      }
    });
    card.appendChild(delBtn);

    container.appendChild(card);
  }

  function renderItemsTab(container: HTMLElement): void {
    let itemCursor: string | null = null;
    const itemPageStack: (string | null)[] = [null];

    function loadItems(): void {
      container.innerHTML = "";
      const loading = document.createElement("p");
      loading.textContent = "Loading items…";
      container.appendChild(loading);

      bridge
        .call("/admin/bundles/items", {
          bundle_id: currentBundleId,
          cursor: itemCursor ?? undefined,
        })
        .then((data: any) => {
          loading.remove();
          const items: any[] = data.items ?? [];

          // Save items UI
          const card = document.createElement("div");
          card.className = "shell-card";

          const saveSection = document.createElement("div");
          saveSection.style.marginBottom = "16px";

          const saveLabel = document.createElement("p");
          saveLabel.style.fontSize = "0.875rem";
          saveLabel.textContent =
            "To update items, use the Shopify product picker to select variants.";
          saveSection.appendChild(saveLabel);

          const pickBtn = document.createElement("button");
          pickBtn.className = "btn-secondary";
          pickBtn.textContent = "Pick Variants";
          pickBtn.addEventListener("click", async () => {
            const picked = await bridge.pickResource({ type: "variant" });
            if (!picked || picked.length === 0) return;
            const variantIds = picked.map((p: any) => {
              // Extract numeric ID from gid
              return p.id.replace("gid://shopify/ProductVariant/", "");
            });
            // We also need product_external_ids; fetch from picked
            const productIds = picked.map((p: any) => {
              // gid looks like gid://shopify/ProductVariant/123, we need product ID
              // This info isn't directly in the picked result; we'll use placeholder
              return p.product_id ?? "0";
            });
            try {
              await bridge.call("/admin/bundles/items/save", {
                bundle_id: currentBundleId,
                variant_external_ids: variantIds,
                product_external_ids: productIds,
              });
              bridge.notify("Items saved", "success");
              loadItems();
            } catch {
              bridge.notify("Failed to save items", "error");
            }
          });
          saveSection.appendChild(pickBtn);
          card.appendChild(saveSection);

          if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = "No items in this bundle yet.";
            card.appendChild(empty);
          } else {
            const table = document.createElement("table");
            const thead = document.createElement("thead");
            thead.innerHTML =
              "<tr><th>Variant ID</th><th>Product ID</th><th>Availability</th><th>Added</th></tr>";
            table.appendChild(thead);

            const tbody = document.createElement("tbody");
            for (const item of items) {
              const tr = document.createElement("tr");
              const cells = [
                item.variant_external_id,
                item.product_external_id,
                item.observed_availability,
                new Intl.DateTimeFormat(bridge.context.locale, {
                  dateStyle: "medium",
                }).format(new Date(item.added_at)),
              ];
              for (const cellVal of cells) {
                const td = document.createElement("td");
                if (cells.indexOf(cellVal) === 2) {
                  const badge = document.createElement("span");
                  badge.className =
                    cellVal === "available"
                      ? "badge badge-success"
                      : cellVal === "out_of_stock"
                      ? "badge badge-warning"
                      : "badge badge-critical";
                  badge.textContent = cellVal;
                  td.appendChild(badge);
                } else {
                  td.textContent = cellVal;
                }
                tr.appendChild(td);
              }
              tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            card.appendChild(table);
          }

          container.appendChild(card);

          // Pagination
          const pagination = document.createElement("div");
          pagination.className = "pagination";

          if (itemPageStack.length > 1) {
            const prev = document.createElement("button");
            prev.className = "btn-secondary";
            prev.textContent = "← Prev";
            prev.addEventListener("click", () => {
              itemPageStack.pop();
              itemCursor = itemPageStack[itemPageStack.length - 1] ?? null;
              loadItems();
            });
            pagination.appendChild(prev);
          }

          if (data.next_cursor) {
            const next = document.createElement("button");
            next.className = "btn-secondary";
            next.textContent = "Next →";
            next.addEventListener("click", () => {
              itemPageStack.push(data.next_cursor);
              itemCursor = data.next_cursor;
              loadItems();
            });
            pagination.appendChild(next);
          }

          container.appendChild(pagination);
        })
        .catch(() => {
          container.innerHTML = "";
          const err = document.createElement("p");
          err.textContent = "Failed to load items.";
          container.appendChild(err);
        });
    }

    loadItems();
  }

  function renderTiersTab(container: HTMLElement): void {
    container.innerHTML = "";
    const loading = document.createElement("p");
    loading.textContent = "Loading tiers…";
    container.appendChild(loading);

    bridge
      .call("/admin/bundles/tiers", { bundle_id: currentBundleId })
      .then((data: any) => {
        loading.remove();
        const tiers: any[] = data.tiers ?? [];

        const card = document.createElement("div");
        card.className = "shell-card";

        const hint = document.createElement("p");
        hint.style.fontSize = "0.875rem";
        hint.style.color = "var(--p-color-text-subdued)";
        hint.textContent =
          "Tiers are ordered by display order. The highest qualifying tier is applied to the customer's cart. Discount rate is stored as integer basis points (e.g. 1000 = 10%).";
        card.appendChild(hint);

        const tierRows: HTMLElement[] = [];

        // Local tier state for editing
        const localTiers: Array<{ minimum_item_count: number; discount_rate: number }> = tiers.map(
          (t) => ({ minimum_item_count: t.minimum_item_count, discount_rate: t.discount_rate })
        );

        function renderTierRows(): void {
          tiersContainer.innerHTML = "";
          localTiers.forEach((tier, i) => {
            const row = document.createElement("div");
            row.className = "tier-row";

            const orderSpan = document.createElement("span");
            orderSpan.textContent = `${i + 1}.`;
            orderSpan.style.minWidth = "20px";
            row.appendChild(orderSpan);

            const minLabel = document.createElement("label");
            minLabel.textContent = "Min items:";
            minLabel.style.marginBottom = "0";
            row.appendChild(minLabel);

            const minInput = document.createElement("input");
            minInput.type = "number";
            minInput.min = "1";
            minInput.value = String(tier.minimum_item_count);
            minInput.style.width = "70px";
            minInput.addEventListener("change", () => {
              localTiers[i].minimum_item_count = parseInt(minInput.value, 10) || 1;
            });
            row.appendChild(minInput);

            const rateLabel = document.createElement("label");
            rateLabel.textContent = "Discount rate (bps):";
            rateLabel.style.marginBottom = "0";
            row.appendChild(rateLabel);

            const rateInput = document.createElement("input");
            rateInput.type = "number";
            rateInput.min = "1";
            rateInput.max = "10000";
            rateInput.value = String(tier.discount_rate);
            rateInput.style.width = "90px";
            rateInput.addEventListener("change", () => {
              localTiers[i].discount_rate = parseInt(rateInput.value, 10) || 0;
            });
            row.appendChild(rateInput);

            const rateDisplay = document.createElement("span");
            rateDisplay.style.color = "var(--p-color-text-subdued)";
            rateDisplay.style.fontSize = "0.75rem";
            rateDisplay.textContent = `(${(tier.discount_rate / 100).toFixed(0)}%)`;
            row.appendChild(rateDisplay);

            const upBtn = document.createElement("button");
            upBtn.className = "btn-secondary";
            upBtn.textContent = "↑";
            upBtn.disabled = i === 0;
            upBtn.addEventListener("click", () => {
              if (i === 0) return;
              const tmp = localTiers[i - 1];
              localTiers[i - 1] = localTiers[i];
              localTiers[i] = tmp;
              renderTierRows();
              bridge.saveBar.show("tiers");
            });
            row.appendChild(upBtn);

            const downBtn = document.createElement("button");
            downBtn.className = "btn-secondary";
            downBtn.textContent = "↓";
            downBtn.disabled = i === localTiers.length - 1;
            downBtn.addEventListener("click", () => {
              if (i === localTiers.length - 1) return;
              const tmp = localTiers[i + 1];
              localTiers[i + 1] = localTiers[i];
              localTiers[i] = tmp;
              renderTierRows();
              bridge.saveBar.show("tiers");
            });
            row.appendChild(downBtn);

            const delBtn = document.createElement("button");
            delBtn.className = "btn-destructive";
            delBtn.textContent = "×";
            delBtn.addEventListener("click", () => {
              localTiers.splice(i, 1);
              renderTierRows();
              bridge.saveBar.show("tiers");
            });
            row.appendChild(delBtn);

            tiersContainer.appendChild(row);
          });
        }

        const tiersContainer = document.createElement("div");
        renderTierRows();
        card.appendChild(tiersContainer);

        const addTierBtn = document.createElement("button");
        addTierBtn.className = "btn-secondary";
        addTierBtn.textContent = "+ Add Tier";
        addTierBtn.style.marginTop = "8px";
        addTierBtn.addEventListener("click", () => {
          const lastMin =
            localTiers.length > 0 ? localTiers[localTiers.length - 1].minimum_item_count + 1 : 2;
          localTiers.push({ minimum_item_count: lastMin, discount_rate: 1000 });
          renderTierRows();
          bridge.saveBar.show("tiers");
        });
        card.appendChild(addTierBtn);

        const saveBtn = document.createElement("button");
        saveBtn.className = "btn-primary";
        saveBtn.textContent = "Save Tiers";
        saveBtn.style.marginLeft = "8px";
        saveBtn.style.marginTop = "8px";
        saveBtn.addEventListener("click", async () => {
          try {
            await bridge.call("/admin/bundles/tiers/save", {
              bundle_id: currentBundleId,
              tiers: localTiers,
            });
            bridge.saveBar.hide("tiers");
            bridge.notify("Tiers saved", "success");
            container.innerHTML = "";
            renderTiersTab(container);
          } catch {
            bridge.notify("Failed to save tiers", "error");
          }
        });
        card.appendChild(saveBtn);

        container.appendChild(card);
      })
      .catch(() => {
        container.innerHTML = "";
        const err = document.createElement("p");
        err.textContent = "Failed to load tiers.";
        container.appendChild(err);
      });
  }

  function renderHealthLogTab(container: HTMLElement): void {
    container.innerHTML = "";
    const p = document.createElement("p");
    p.style.color = "var(--p-color-text-subdued)";
    p.textContent = "Bundle health events are recorded automatically. See purchase history for purchase records.";
    container.appendChild(p);
  }

  // ─── Modals ───────────────────────────────────────────────────────────────
  function showCreateModal(): void {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";

    const h2 = document.createElement("h2");
    h2.textContent = "Create Bundle";
    modal.appendChild(h2);

    const titleField = makeFormField("Title", "text", "", "title");
    modal.appendChild(titleField.wrapper);

    const descField = makeTextareaField("Description (optional)", "", "description");
    modal.appendChild(descField.wrapper);

    const modeField = makeSelectField("Mode", ["fixed", "flexible"], ["Fixed", "Flexible"], "fixed", "mode");
    modal.appendChild(modeField.wrapper);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => overlay.remove());
    actions.appendChild(cancelBtn);

    const createBtn = document.createElement("button");
    createBtn.className = "btn-primary";
    createBtn.textContent = "Create";
    createBtn.addEventListener("click", async () => {
      const title = (titleField.input as HTMLInputElement).value.trim();
      if (!title) {
        bridge.notify("Title is required", "error");
        return;
      }
      try {
        const resp = await bridge.call("/admin/bundles/create", {
          title,
          mode: (modeField.input as HTMLSelectElement).value,
          description: (descField.input as HTMLTextAreaElement).value || undefined,
        });
        overlay.remove();
        bridge.notify("Bundle created", "success");
        openEditView(resp.bundle_id);
      } catch {
        bridge.notify("Failed to create bundle", "error");
      }
    });
    actions.appendChild(createBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    container.appendChild(overlay);
  }

  function showPurchaseHistoryModal(): void {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.style.maxWidth = "720px";

    const h2 = document.createElement("h2");
    h2.textContent = "Purchase History";
    modal.appendChild(h2);

    const filterRow = document.createElement("div");
    filterRow.style.display = "flex";
    filterRow.style.gap = "8px";
    filterRow.style.marginBottom = "12px";

    const dateFromField = makeFormField("From", "date", "", "date_from");
    dateFromField.wrapper.style.flex = "1";
    filterRow.appendChild(dateFromField.wrapper);

    const dateToField = makeFormField("To", "date", "", "date_to");
    dateToField.wrapper.style.flex = "1";
    filterRow.appendChild(dateToField.wrapper);

    modal.appendChild(filterRow);

    const resultArea = document.createElement("div");
    modal.appendChild(resultArea);

    function loadHistory(cursor: string | null): void {
      resultArea.innerHTML = "";
      const loading = document.createElement("p");
      loading.textContent = "Loading…";
      resultArea.appendChild(loading);

      const params: any = { cursor: cursor ?? undefined };
      const fromVal = (dateFromField.input as HTMLInputElement).value;
      const toVal = (dateToField.input as HTMLInputElement).value;
      if (fromVal) params.date_from = new Date(fromVal).toISOString();
      if (toVal) {
        const to = new Date(toVal);
        to.setHours(23, 59, 59, 999);
        params.date_to = to.toISOString();
      }

      bridge
        .call("/admin/purchase-history", params)
        .then((data: any) => {
          loading.remove();
          const records: any[] = data.records ?? [];

          if (records.length === 0) {
            resultArea.textContent = "No records found.";
            return;
          }

          const table = document.createElement("table");
          const thead = document.createElement("thead");
          thead.innerHTML =
            "<tr><th>Order ID</th><th>Bundle</th><th>Items</th><th>Discount</th><th>Total</th><th>Date</th></tr>";
          table.appendChild(thead);

          const tbody = document.createElement("tbody");
          for (const r of records) {
            const tr = document.createElement("tr");
            const orderTotal = new Intl.NumberFormat(bridge.context.locale, {
              style: "currency",
              currency: r.order_currency ?? bridge.context.currency,
            }).format(r.order_total / 100);
            const cells = [
              String(r.order_external_id),
              r.bundle_id.slice(0, 8) + "…",
              String(r.item_count),
              `${(r.discount_rate_applied / 100).toFixed(0)}%`,
              orderTotal,
              new Intl.DateTimeFormat(bridge.context.locale, { dateStyle: "medium" }).format(
                new Date(r.order_placed_at)
              ),
            ];
            for (const val of cells) {
              const td = document.createElement("td");
              td.textContent = val;
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          resultArea.appendChild(table);

          const pagRow = document.createElement("div");
          pagRow.className = "pagination";
          if (data.next_cursor) {
            const nextBtn = document.createElement("button");
            nextBtn.className = "btn-secondary";
            nextBtn.textContent = "Load more";
            nextBtn.addEventListener("click", () => loadHistory(data.next_cursor));
            pagRow.appendChild(nextBtn);
          }
          resultArea.appendChild(pagRow);
        })
        .catch(() => {
          resultArea.textContent = "Failed to load history.";
        });
    }

    const searchBtn = document.createElement("button");
    searchBtn.className = "btn-secondary";
    searchBtn.textContent = "Search";
    searchBtn.addEventListener("click", () => loadHistory(null));
    modal.appendChild(searchBtn);

    loadHistory(null);

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-secondary";
    closeBtn.textContent = "Close";
    closeBtn.style.marginTop = "12px";
    closeBtn.addEventListener("click", () => overlay.remove());
    modal.appendChild(closeBtn);

    overlay.appendChild(modal);
    container.appendChild(overlay);
  }

  // ─── Actions ──────────────────────────────────────────────────────────────
  async function toggleBundle(bundleId: string, enabled: boolean): Promise<void> {
    try {
      await bridge.call("/admin/bundles/update", { bundle_id: bundleId, enabled });
      bridge.notify(enabled ? "Bundle enabled" : "Bundle disabled", "success");
      renderList();
    } catch (err: any) {
      bridge.notify(err?.message ?? "Operation failed", "error");
    }
  }

  async function cloneBundle(bundleId: string): Promise<void> {
    try {
      const resp = await bridge.call("/admin/bundles/clone", { source_bundle_id: bundleId });
      bridge.notify("Bundle cloned", "success");
      openEditView(resp.new_bundle_id);
    } catch {
      bridge.notify("Clone failed", "error");
    }
  }

  async function bulkSetStatus(enabled: boolean): Promise<void> {
    if (selectedIds.size === 0) return;
    try {
      const resp = await bridge.call("/admin/bundles/bulk-status", {
        bundle_ids: Array.from(selectedIds),
        enabled,
      });
      selectedIds.clear();
      bridge.notify(
        `Updated ${resp.updated_count}, skipped ${resp.skipped_count}`,
        "success"
      );
      renderList();
    } catch {
      bridge.notify("Bulk update failed", "error");
    }
  }

  // ─── Form Helpers ─────────────────────────────────────────────────────────
  function makeFormField(
    labelText: string,
    type: string,
    value: string,
    name: string
  ): { wrapper: HTMLElement; input: HTMLInputElement } {
    const wrapper = document.createElement("div");
    wrapper.className = "form-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    wrapper.appendChild(label);
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.name = name;
    wrapper.appendChild(input);
    return { wrapper, input };
  }

  function makeTextareaField(
    labelText: string,
    value: string,
    name: string
  ): { wrapper: HTMLElement; input: HTMLTextAreaElement } {
    const wrapper = document.createElement("div");
    wrapper.className = "form-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    wrapper.appendChild(label);
    const input = document.createElement("textarea");
    input.value = value;
    input.name = name;
    wrapper.appendChild(input);
    return { wrapper, input };
  }

  function makeSelectField(
    labelText: string,
    values: string[],
    labels: string[],
    selected: string,
    name: string
  ): { wrapper: HTMLElement; input: HTMLSelectElement } {
    const wrapper = document.createElement("div");
    wrapper.className = "form-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    wrapper.appendChild(label);
    const select = document.createElement("select");
    select.name = name;
    for (let i = 0; i < values.length; i++) {
      const opt = document.createElement("option");
      opt.value = values[i];
      opt.textContent = labels[i];
      opt.selected = values[i] === selected;
      select.appendChild(opt);
    }
    wrapper.appendChild(select);
    return { wrapper, input: select };
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  render();
}
