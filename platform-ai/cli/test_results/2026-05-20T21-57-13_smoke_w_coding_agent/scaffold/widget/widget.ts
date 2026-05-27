export function mount(container: HTMLElement, host: any): void {
  // ─── Styles ───────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bundle-widget { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; max-width: 100%; box-sizing: border-box; }
    .bundle-widget h2 { margin: 0 0 4px; font-size: 1.1rem; font-weight: 700; }
    .bundle-widget .bundle-desc { color: #6b7280; font-size: 0.875rem; margin: 0 0 12px; }
    .bundle-widget .tiers-list { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .bundle-widget .tier-chip { padding: 6px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; border: 2px solid transparent; cursor: default; background: #f3f4f6; color: #374151; }
    .bundle-widget .tier-chip.earned { background: #d1fae5; color: #065f46; border-color: #059669; }
    .bundle-widget .tier-chip.next { background: #eff6ff; color: #1d4ed8; border-color: #3b82f6; }
    .bundle-widget .items-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .bundle-widget .item-card { border: 2px solid #e5e7eb; border-radius: 6px; padding: 10px 8px; cursor: pointer; user-select: none; transition: border-color 0.15s; background: #fff; text-align: center; position: relative; }
    .bundle-widget .item-card.selected { border-color: #059669; background: #f0fdf4; }
    .bundle-widget .item-card.unavailable { opacity: 0.5; cursor: not-allowed; background: #f9fafb; }
    .bundle-widget .item-card .variant-id { font-size: 0.75rem; color: #6b7280; word-break: break-all; }
    .bundle-widget .item-card .avail-badge { display: inline-block; font-size: 0.7rem; border-radius: 4px; padding: 2px 6px; margin-top: 4px; }
    .bundle-widget .item-card .avail-badge.available { background: #d1fae5; color: #065f46; }
    .bundle-widget .item-card .avail-badge.out_of_stock { background: #fef3c7; color: #92400e; }
    .bundle-widget .item-card .avail-badge.deleted { background: #fee2e2; color: #991b1b; }
    .bundle-widget .item-card .check-mark { position: absolute; top: 6px; right: 6px; width: 18px; height: 18px; border-radius: 50%; background: #059669; color: #fff; font-size: 0.65rem; display: flex; align-items: center; justify-content: center; }
    .bundle-widget .discount-bar { padding: 10px 14px; border-radius: 6px; background: #f0fdf4; border: 1px solid #bbf7d0; font-size: 0.875rem; margin-bottom: 12px; display: none; }
    .bundle-widget .discount-bar.visible { display: block; }
    .bundle-widget .discount-bar strong { color: #059669; }
    .bundle-widget .validation-errors { color: #dc2626; font-size: 0.8rem; margin-bottom: 10px; padding: 8px 12px; background: #fef2f2; border-radius: 6px; border: 1px solid #fecaca; }
    .bundle-widget .validation-errors ul { margin: 4px 0; padding-left: 16px; }
    .bundle-widget .add-btn { width: 100%; padding: 12px; background: #059669; color: #fff; border: none; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    .bundle-widget .add-btn:hover:not(:disabled) { background: #047857; }
    .bundle-widget .add-btn:disabled { background: #9ca3af; cursor: not-allowed; }
    .bundle-widget .add-btn.adding { background: #047857; }
    .bundle-widget .selection-count { font-size: 0.875rem; color: #374151; margin-bottom: 10px; }
    .bundle-widget .error-state { padding: 16px; color: #6b7280; text-align: center; }
    .bundle-widget .mode-badge { display: inline-block; font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #e0e7ff; color: #3730a3; margin-bottom: 10px; }
    @media (max-width: 480px) {
      .bundle-widget .items-grid { grid-template-columns: repeat(2, 1fr); }
      .bundle-widget .tiers-list { gap: 6px; }
    }
  `;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = "bundle-widget";
  container.appendChild(root);

  // ─── Read bundle_id from URL query string ─────────────────────────────────
  const searchParams = new URLSearchParams(location.search);
  const bundleId = searchParams.get("bundle_id");

  if (!bundleId) {
    const err = document.createElement("div");
    err.className = "error-state";
    err.textContent = "No bundle ID specified.";
    root.appendChild(err);
    return;
  }

  // ─── State ─────────────────────────────────────────────────────────────────
  let selectedVariantIds: Set<string> = new Set();
  let bundleData: any = null;
  let validationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let earnedTier: any = null;
  let validationErrors: string[] = [];
  let isAdding = false;

  // ─── Initial Load ─────────────────────────────────────────────────────────
  function loadBundle(): void {
    root.innerHTML = "";
    root.appendChild(style);

    const loadingEl = document.createElement("div");
    loadingEl.className = "error-state";
    loadingEl.textContent = "Loading bundle…";
    root.appendChild(loadingEl);

    host
      .call("/widget/bundle", { bundle_id: bundleId })
      .then((data: any) => {
        loadingEl.remove();
        bundleData = data;
        renderBundle();
      })
      .catch(() => {
        loadingEl.textContent = "This bundle is currently unavailable.";
      });
  }

  // ─── Render Bundle ─────────────────────────────────────────────────────────
  function renderBundle(): void {
    const bundle = bundleData.bundle;
    const tiers: any[] = bundleData.tiers ?? [];
    const items: any[] = bundleData.items ?? [];

    // Title
    const h2 = document.createElement("h2");
    h2.textContent = bundle.title;
    root.appendChild(h2);

    // Mode badge
    const modeBadge = document.createElement("span");
    modeBadge.className = "mode-badge";
    modeBadge.textContent = bundle.mode === "fixed" ? "Fixed Bundle" : "Flexible Bundle";
    root.appendChild(modeBadge);

    // Description
    if (bundle.description) {
      const desc = document.createElement("p");
      desc.className = "bundle-desc";
      desc.textContent = bundle.description;
      root.appendChild(desc);
    }

    // Tiers
    if (tiers.length > 0) {
      const tiersSection = document.createElement("div");

      const tiersLabel = document.createElement("p");
      tiersLabel.style.fontSize = "0.8rem";
      tiersLabel.style.fontWeight = "600";
      tiersLabel.style.marginBottom = "6px";
      tiersLabel.textContent = "Discount tiers:";
      tiersSection.appendChild(tiersLabel);

      const tiersList = document.createElement("div");
      tiersList.className = "tiers-list";
      tiersList.id = "bundle-tiers-list";

      for (const tier of tiers) {
        const chip = document.createElement("span");
        chip.className = "tier-chip";
        chip.dataset.minItems = String(tier.minimum_item_count);
        chip.dataset.discountRate = String(tier.discount_rate);

        const pct = (tier.discount_rate / 100).toFixed(0);
        chip.textContent = `${tier.minimum_item_count}+ items → ${pct}% off`;
        tiersList.appendChild(chip);
      }

      tiersSection.appendChild(tiersList);
      root.appendChild(tiersSection);
    }

    // Discount bar
    const discountBar = document.createElement("div");
    discountBar.className = "discount-bar";
    discountBar.id = "discount-bar";
    root.appendChild(discountBar);

    // Validation errors
    const errorsDiv = document.createElement("div");
    errorsDiv.className = "validation-errors";
    errorsDiv.style.display = "none";
    errorsDiv.id = "validation-errors";
    root.appendChild(errorsDiv);

    // Selection count
    const selCountEl = document.createElement("div");
    selCountEl.className = "selection-count";
    selCountEl.id = "selection-count";
    root.appendChild(selCountEl);
    updateSelectionCount(selCountEl, tiers);

    // Items grid
    const itemsSection = document.createElement("div");
    const itemsLabel = document.createElement("p");
    itemsLabel.style.fontSize = "0.8rem";
    itemsLabel.style.fontWeight = "600";
    itemsLabel.style.marginBottom = "6px";
    itemsLabel.textContent =
      bundle.mode === "fixed" ? "Included items:" : "Choose your items:";
    itemsSection.appendChild(itemsLabel);

    const grid = document.createElement("div");
    grid.className = "items-grid";

    for (const item of items) {
      const card = buildItemCard(item, bundle.mode === "fixed");
      grid.appendChild(card);
    }

    itemsSection.appendChild(grid);
    root.appendChild(itemsSection);

    // For fixed bundles, auto-select all available items
    if (bundle.mode === "fixed") {
      for (const item of items) {
        if (item.observed_availability === "available") {
          selectedVariantIds.add(String(item.variant_external_id));
        }
      }
      updateSelectionCount(selCountEl, tiers);
      scheduleValidation();
    }

    // Add to cart button
    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.id = "add-to-cart-btn";
    addBtn.textContent =
      bundle.mode === "fixed" ? "Add Bundle to Cart" : "Add Selected to Cart";
    addBtn.disabled = true;
    addBtn.addEventListener("click", handleAddToCart);
    root.appendChild(addBtn);
  }

  function buildItemCard(item: any, isFixed: boolean): HTMLElement {
    const card = document.createElement("div");
    card.className = "item-card";
    const isUnavailable = item.observed_availability !== "available";
    if (isUnavailable) card.classList.add("unavailable");

    // Variant label
    const varLabel = document.createElement("div");
    varLabel.className = "variant-id";
    varLabel.textContent = `Variant #${item.variant_external_id}`;
    card.appendChild(varLabel);

    // Availability badge
    const availBadge = document.createElement("span");
    availBadge.className = `avail-badge ${item.observed_availability}`;
    availBadge.textContent =
      item.observed_availability === "available"
        ? "In Stock"
        : item.observed_availability === "out_of_stock"
        ? "Out of Stock"
        : "Unavailable";
    card.appendChild(availBadge);

    // Check mark (shown when selected)
    const checkMark = document.createElement("div");
    checkMark.className = "check-mark";
    checkMark.style.display = "none";
    checkMark.textContent = "✓";
    card.appendChild(checkMark);

    const variantIdStr = String(item.variant_external_id);

    if (!isFixed && !isUnavailable) {
      card.addEventListener("click", () => {
        if (selectedVariantIds.has(variantIdStr)) {
          selectedVariantIds.delete(variantIdStr);
          card.classList.remove("selected");
          checkMark.style.display = "none";
        } else {
          selectedVariantIds.add(variantIdStr);
          card.classList.add("selected");
          checkMark.style.display = "flex";
        }

        // Update selection count
        const selCountEl = document.getElementById("selection-count");
        if (selCountEl) updateSelectionCount(selCountEl, bundleData.tiers ?? []);

        scheduleValidation();
      });
    }

    return card;
  }

  function updateSelectionCount(el: HTMLElement, tiers: any[]): void {
    const count = selectedVariantIds.size;
    const sortedTiers = [...tiers].sort((a, b) => a.minimum_item_count - b.minimum_item_count);
    const lowestMin = sortedTiers.length > 0 ? sortedTiers[0].minimum_item_count : 0;
    const needed = Math.max(0, lowestMin - count);

    if (count === 0) {
      el.textContent =
        lowestMin > 0
          ? `Select at least ${lowestMin} item${lowestMin > 1 ? "s" : ""} to unlock a discount`
          : "";
    } else if (needed > 0) {
      el.textContent = `${count} selected — add ${needed} more to unlock the lowest tier discount`;
    } else {
      el.textContent = `${count} item${count > 1 ? "s" : ""} selected`;
    }

    // Update tier chips
    const tierChips = document.querySelectorAll(".tier-chip");
    tierChips.forEach((chip: Element) => {
      const htmlChip = chip as HTMLElement;
      const minItems = parseInt(htmlChip.dataset.minItems ?? "0", 10);
      htmlChip.classList.remove("earned", "next");
      if (count >= minItems) {
        htmlChip.classList.add("earned");
      } else {
        // Find the first tier we haven't reached yet
        const isNextTier =
          sortedTiers.findIndex((t) => t.minimum_item_count === minItems) ===
          sortedTiers.findIndex((t) => t.minimum_item_count > count);
        if (isNextTier) htmlChip.classList.add("next");
      }
    });
  }

  function scheduleValidation(): void {
    if (validationDebounceTimer !== null) {
      clearTimeout(validationDebounceTimer);
    }
    // Debounce 300ms
    validationDebounceTimer = setTimeout(() => {
      validationDebounceTimer = null;
      validateSelection();
    }, 300);
  }

  function validateSelection(): void {
    const count = selectedVariantIds.size;
    const addBtn = document.getElementById("add-to-cart-btn") as HTMLButtonElement | null;
    const discountBar = document.getElementById("discount-bar");
    const errorsDiv = document.getElementById("validation-errors");

    if (count === 0) {
      earnedTier = null;
      validationErrors = [];
      if (addBtn) addBtn.disabled = true;
      if (discountBar) {
        discountBar.classList.remove("visible");
        discountBar.textContent = "";
      }
      if (errorsDiv) errorsDiv.style.display = "none";
      return;
    }

    host
      .call("/widget/bundle/validate", {
        bundle_id: bundleId,
        selected_variant_ids: Array.from(selectedVariantIds),
      })
      .then((result: any) => {
        earnedTier = result.earned_tier;
        validationErrors = result.validation_errors ?? [];

        if (addBtn) addBtn.disabled = !result.valid;

        if (discountBar) {
          if (result.earned_tier && result.valid) {
            discountBar.classList.add("visible");
            discountBar.innerHTML = "";
            const msg = document.createElement("span");
            const pct = (result.discount_rate / 100).toFixed(0);
            msg.appendChild(document.createTextNode("🎉 You've earned a "));
            const strong = document.createElement("strong");
            strong.textContent = `${pct}% discount`;
            msg.appendChild(strong);
            msg.appendChild(document.createTextNode(` on this bundle!`));
            discountBar.appendChild(msg);
          } else {
            discountBar.classList.remove("visible");
          }
        }

        if (errorsDiv) {
          if (validationErrors.length > 0) {
            errorsDiv.style.display = "block";
            errorsDiv.innerHTML = "";
            const ul = document.createElement("ul");
            for (const err of validationErrors) {
              const li = document.createElement("li");
              li.textContent = err;
              ul.appendChild(li);
            }
            errorsDiv.appendChild(ul);
          } else {
            errorsDiv.style.display = "none";
          }
        }
      })
      .catch(() => {
        // Fail open — don't block the shopper
        if (addBtn) addBtn.disabled = false;
        earnedTier = null;
      });
  }

  function handleAddToCart(): void {
    if (isAdding) return;
    const addBtn = document.getElementById("add-to-cart-btn") as HTMLButtonElement | null;
    if (!addBtn) return;

    isAdding = true;
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    addBtn.classList.add("adding");

    const selectedArray = Array.from(selectedVariantIds);
    const quantities = selectedArray.map(() => 1);

    host
      .call("/widget/cart/add", {
        bundle_id: bundleId,
        selected_variant_ids: selectedArray,
        quantities,
      })
      .then((resp: any) => {
        if (!resp.success) {
          showAddErrors(resp.errors ?? ["Failed to add to cart"]);
          resetAddButton(addBtn);
          return;
        }

        // Use the line_items from the server response to add to the Shopify Ajax cart
        const lineItems = resp.line_items ?? [];
        const cartItems = lineItems.map((li: any) => ({
          id: li.id,
          quantity: li.quantity,
          properties: li.properties ?? {},
        }));

        return host
          .storefront("/cart/add.js", { items: cartItems })
          .then(() => {
            addBtn.textContent = "✓ Added to Cart!";
            addBtn.style.background = "#047857";
            // Re-enable after 2 seconds
            setTimeout(() => {
              addBtn.textContent = "Add Bundle to Cart";
              addBtn.style.background = "";
              addBtn.disabled = false;
              addBtn.classList.remove("adding");
              isAdding = false;
            }, 2000);
          })
          .catch(() => {
            showAddErrors(["Could not add to cart. Please try again."]);
            resetAddButton(addBtn);
          });
      })
      .catch((err: Error) => {
        showAddErrors([err?.message ?? "Add to cart failed"]);
        resetAddButton(addBtn);
      });
  }

  function resetAddButton(btn: HTMLButtonElement): void {
    isAdding = false;
    btn.disabled = false;
    btn.textContent = "Add Bundle to Cart";
    btn.classList.remove("adding");
  }

  function showAddErrors(errors: string[]): void {
    const errorsDiv = document.getElementById("validation-errors");
    if (!errorsDiv) return;
    errorsDiv.style.display = "block";
    errorsDiv.innerHTML = "";
    const ul = document.createElement("ul");
    for (const err of errors) {
      const li = document.createElement("li");
      li.textContent = err;
      ul.appendChild(li);
    }
    errorsDiv.appendChild(ul);
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  loadBundle();
}
