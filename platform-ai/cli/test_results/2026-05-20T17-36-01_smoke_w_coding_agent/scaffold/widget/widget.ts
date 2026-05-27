export function mount(container: HTMLElement, host: any): void {
  // ─── CSS (injected into container) ─────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bw-root { font-family: inherit; box-sizing: border-box; }
    .bw-root *, .bw-root *::before, .bw-root *::after { box-sizing: inherit; }
    .bw-loading { text-align: center; padding: 24px; color: #666; }
    .bw-error { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 6px; padding: 12px 16px; color: #b91c1c; margin: 8px 0; }
    .bw-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 4px; }
    .bw-desc { font-size: 0.875rem; color: #555; margin: 0 0 14px; }
    .bw-badge-fixed { background: #e0f2fe; color: #0369a1; border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; font-weight: 600; margin-left: 6px; }
    .bw-badge-flexible { background: #fef9c3; color: #854d0e; border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; font-weight: 600; margin-left: 6px; }
    .bw-tiers { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    .bw-tier { border: 1.5px solid #d1d5db; border-radius: 8px; padding: 8px 14px; text-align: center; cursor: default; transition: border-color 0.15s; min-width: 90px; }
    .bw-tier.earned { border-color: #008060; background: #f0fdf4; }
    .bw-tier-count { font-size: 1rem; font-weight: 700; color: #111; }
    .bw-tier-label { font-size: 0.75rem; color: #555; }
    .bw-tier-disc { font-size: 0.875rem; font-weight: 600; color: #008060; }
    .bw-items-section { margin-bottom: 14px; }
    .bw-items-section h3 { font-size: 0.9rem; font-weight: 600; margin: 0 0 8px; }
    .bw-items-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
    @media (max-width: 480px) { .bw-items-grid { grid-template-columns: repeat(2, 1fr); } }
    .bw-item-card { border: 1.5px solid #e5e7eb; border-radius: 8px; padding: 10px 8px; cursor: pointer; transition: border-color 0.15s, background 0.15s; text-align: center; user-select: none; }
    .bw-item-card.selected { border-color: #008060; background: #f0fdf4; }
    .bw-item-card.unavailable { opacity: 0.45; cursor: not-allowed; }
    .bw-item-card.unavailable-selected { border-color: #ef4444; background: #fef2f2; }
    .bw-item-name { font-size: 0.8rem; font-weight: 500; word-break: break-word; }
    .bw-item-avail { font-size: 0.7rem; margin-top: 4px; }
    .bw-item-avail.oos { color: #b91c1c; }
    .bw-item-avail.ok { color: #16a34a; }
    .bw-item-avail.del { color: #6b7280; }
    .bw-qty-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; justify-content: center; }
    .bw-qty-btn { width: 24px; height: 24px; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; cursor: pointer; font-size: 1rem; line-height: 1; display: flex; align-items: center; justify-content: center; }
    .bw-qty-btn:hover { background: #f3f4f6; }
    .bw-qty-val { min-width: 24px; text-align: center; font-size: 0.85rem; font-weight: 600; }
    .bw-discount-banner { background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; font-size: 0.875rem; color: #15803d; font-weight: 500; display: flex; align-items: center; gap: 8px; }
    .bw-discount-banner.inactive { background: #f9fafb; border-color: #e5e7eb; color: #6b7280; }
    .bw-validation-errors { margin: 8px 0; list-style: disc; padding-left: 18px; }
    .bw-validation-errors li { color: #b91c1c; font-size: 0.82rem; margin-bottom: 4px; }
    .bw-cta { width: 100%; padding: 12px; background: #008060; color: #fff; border: none; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 8px; transition: background 0.15s; }
    .bw-cta:hover { background: #006e52; }
    .bw-cta:disabled { background: #9ca3af; cursor: not-allowed; }
    .bw-load-more { text-align: center; margin-top: 8px; }
    .bw-load-more button { background: none; border: 1px solid #d1d5db; border-radius: 4px; padding: 6px 14px; font-size: 0.82rem; cursor: pointer; color: #374151; }
    .bw-load-more button:hover { background: #f3f4f6; }
    .bw-success-msg { background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 14px; text-align: center; color: #15803d; font-weight: 600; }
  `;
  container.appendChild(style);

  // ─── Root element ─────────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "bw-root";
  container.appendChild(root);

  // ─── State ───────────────────────────────────────────────────────────────────
  let bundle: any = null;
  let tiers: any[] = [];
  let items: any[] = [];
  let nextCursor: string | null = null;
  const selectedIds = new Set<number>();
  const quantities = new Map<number, number>();
  let earnedTier: any = null;
  let discountRate = 0;
  let validationErrors: string[] = [];
  let isAdding = false;
  let addSuccess = false;

  // ─── Read bundle_id from URL ─────────────────────────────────────────────────
  const urlParams = new URLSearchParams(location.search);
  const bundleId = urlParams.get("bundle_id");

  if (!bundleId) {
    root.innerHTML = `<div class="bw-error">No bundle_id specified in page URL.</div>`;
    return;
  }

  // ─── Load bundle data ────────────────────────────────────────────────────────
  async function loadBundle(cursor?: string): Promise<void> {
    if (!cursor) {
      root.innerHTML = `<div class="bw-loading">Loading bundle…</div>`;
    }

    try {
      const data = await host.call("/widget/bundle", {
        bundle_id: bundleId,
        cursor: cursor ?? undefined,
      });

      if (!cursor) {
        bundle = data.bundle;
        tiers = data.tiers;
        items = data.items;
        nextCursor = data.next_cursor;

        // For fixed bundles: auto-select all available items
        if (bundle.mode === "fixed") {
          for (const item of items) {
            if (item.observed_availability === "available") {
              selectedIds.add(item.variant_external_id as number);
              quantities.set(item.variant_external_id as number, 1);
            }
          }
        }
      } else {
        items = [...items, ...data.items];
        nextCursor = data.next_cursor;
        if (bundle && bundle.mode === "fixed") {
          for (const item of data.items) {
            if (item.observed_availability === "available") {
              selectedIds.add(item.variant_external_id as number);
              quantities.set(item.variant_external_id as number, 1);
            }
          }
        }
      }

      await recalcTier();
      render();
    } catch {
      root.innerHTML = `<div class="bw-error">This bundle is not currently available.</div>`;
    }
  }

  // ─── Recalculate earned tier via backend validate ─────────────────────────────
  async function recalcTier(): Promise<void> {
    if (!bundle) return;
    const selected = Array.from(selectedIds);
    if (selected.length === 0) {
      earnedTier = null;
      discountRate = 0;
      validationErrors = [];
      return;
    }

    try {
      const resp = await host.call("/widget/bundle/validate", {
        bundle_id: bundleId,
        selected_variant_ids: selected,
      });
      earnedTier = resp.earned_tier;
      discountRate = resp.discount_rate;
      validationErrors = resp.validation_errors ?? [];
    } catch {
      earnedTier = null;
      discountRate = 0;
    }
  }

  // ─── Main render ────────────────────────────────────────────────────────────
  function render(): void {
    root.innerHTML = "";

    if (addSuccess) {
      const msg = document.createElement("div");
      msg.className = "bw-success-msg";
      msg.textContent = "🎉 Bundle added to cart with discount applied!";
      root.appendChild(msg);

      const reset = document.createElement("button");
      reset.style.cssText = "margin-top:10px;background:none;border:1px solid #d1d5db;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:0.85rem;display:block;margin-left:auto;margin-right:auto;";
      reset.textContent = "Add another";
      reset.addEventListener("click", () => {
        addSuccess = false;
        selectedIds.clear();
        quantities.clear();
        earnedTier = null;
        discountRate = 0;
        if (bundle && bundle.mode === "fixed") {
          for (const item of items) {
            if (item.observed_availability === "available") {
              selectedIds.add(item.variant_external_id as number);
              quantities.set(item.variant_external_id as number, 1);
            }
          }
        }
        render();
        recalcTier().then(render);
      });
      root.appendChild(reset);
      return;
    }

    if (!bundle) return;

    // Title + mode badge
    const header = document.createElement("div");
    header.innerHTML = `
      <div class="bw-title">
        ${bundle.title}
        <span class="${bundle.mode === "fixed" ? "bw-badge-fixed" : "bw-badge-flexible"}">
          ${bundle.mode === "fixed" ? "Fixed Bundle" : "Flexible Bundle"}
        </span>
      </div>
      ${bundle.description ? `<div class="bw-desc">${bundle.description}</div>` : ""}
    `;
    root.appendChild(header);

    // Tiers display
    if (tiers.length > 0) {
      const tiersSection = document.createElement("div");
      tiersSection.className = "bw-tiers";
      for (const tier of tiers) {
        const card = document.createElement("div");
        const isEarned = earnedTier && earnedTier.id === tier.id;
        card.className = `bw-tier${isEarned ? " earned" : ""}`;
        card.innerHTML = `
          <div class="bw-tier-count">${tier.minimum_item_count}+ items</div>
          <div class="bw-tier-disc">${(tier.discount_rate / 100).toFixed(0)}% off</div>
          <div class="bw-tier-label">${isEarned ? "✓ Unlocked" : `Add ${tier.minimum_item_count} to unlock`}</div>
        `;
        tiersSection.appendChild(card);
      }
      root.appendChild(tiersSection);
    }

    // Discount banner
    const banner = document.createElement("div");
    if (earnedTier && discountRate > 0) {
      banner.className = "bw-discount-banner";
      banner.innerHTML = `🏷️ <strong>${(discountRate / 100).toFixed(0)}% discount</strong> will be applied at checkout!`;
    } else {
      const sortedTiers = [...tiers].sort((a, b) => a.minimum_item_count - b.minimum_item_count);
      const minTier = sortedTiers.length > 0 ? sortedTiers[0] : null;
      banner.className = "bw-discount-banner inactive";
      if (minTier) {
        const needed = (minTier.minimum_item_count as number) - selectedIds.size;
        if (needed > 0) {
          banner.textContent = `Select ${needed} more item(s) to unlock your first discount.`;
        } else {
          banner.textContent = "Select items to unlock a discount.";
        }
      } else {
        banner.textContent = "No discount tiers configured.";
      }
    }
    root.appendChild(banner);

    // Validation errors
    if (validationErrors.length > 0) {
      const errList = document.createElement("ul");
      errList.className = "bw-validation-errors";
      for (const err of validationErrors) {
        const li = document.createElement("li");
        li.textContent = err;
        errList.appendChild(li);
      }
      root.appendChild(errList);
    }

    // Items section
    const itemsSection = document.createElement("div");
    itemsSection.className = "bw-items-section";
    const itemsHeader = document.createElement("h3");
    itemsHeader.textContent =
      bundle.mode === "fixed"
        ? "Bundle Contents"
        : `Select Items (${selectedIds.size} selected)`;
    itemsSection.appendChild(itemsHeader);

    const grid = document.createElement("div");
    grid.className = "bw-items-grid";

    for (const item of items) {
      const vid = item.variant_external_id as number;
      const isAvailable = item.observed_availability === "available";
      const isSelected = selectedIds.has(vid);
      const isOos = item.observed_availability === "out_of_stock";
      const isDeleted = item.observed_availability === "deleted";

      const card = document.createElement("div");
      const cardClasses = ["bw-item-card"];
      if (isSelected && isAvailable) cardClasses.push("selected");
      if (!isAvailable) cardClasses.push("unavailable");
      if (isSelected && !isAvailable) cardClasses.push("unavailable-selected");
      card.className = cardClasses.join(" ");

      const availText = isOos ? "Out of stock" : isDeleted ? "Unavailable" : "In stock";
      const availClass = isOos ? "oos" : isDeleted ? "del" : "ok";

      card.innerHTML = `
        <div class="bw-item-name">Variant #${vid}</div>
        <div class="bw-item-avail ${availClass}">${availText}</div>
      `;

      // Quantity controls for flexible bundles (selected + available)
      if (bundle.mode === "flexible" && isAvailable && isSelected) {
        const qty = quantities.get(vid) ?? 1;
        const qtyRow = document.createElement("div");
        qtyRow.className = "bw-qty-row";

        const decBtn = document.createElement("button");
        decBtn.className = "bw-qty-btn";
        decBtn.textContent = "−";
        decBtn.setAttribute("aria-label", "Decrease quantity");

        const qtySpan = document.createElement("span");
        qtySpan.className = "bw-qty-val";
        qtySpan.textContent = String(qty);

        const incBtn = document.createElement("button");
        incBtn.className = "bw-qty-btn";
        incBtn.textContent = "+";
        incBtn.setAttribute("aria-label", "Increase quantity");

        decBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const current = quantities.get(vid) ?? 1;
          if (current > 1) {
            quantities.set(vid, current - 1);
            qtySpan.textContent = String(current - 1);
          }
        });

        incBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const current = quantities.get(vid) ?? 1;
          quantities.set(vid, current + 1);
          qtySpan.textContent = String(current + 1);
        });

        qtyRow.appendChild(decBtn);
        qtyRow.appendChild(qtySpan);
        qtyRow.appendChild(incBtn);
        card.appendChild(qtyRow);
      }

      // Toggle selection for flexible bundles (available items only)
      if (bundle.mode === "flexible" && isAvailable) {
        card.addEventListener("click", () => {
          if (selectedIds.has(vid)) {
            selectedIds.delete(vid);
            quantities.delete(vid);
          } else {
            selectedIds.add(vid);
            quantities.set(vid, 1);
          }
          recalcTier().then(render);
        });
      }

      grid.appendChild(card);
    }

    itemsSection.appendChild(grid);

    // Load more button
    if (nextCursor) {
      const loadMoreDiv = document.createElement("div");
      loadMoreDiv.className = "bw-load-more";
      const loadMoreBtn = document.createElement("button");
      loadMoreBtn.textContent = "Load more items…";
      loadMoreBtn.addEventListener("click", async () => {
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = "Loading…";
        await loadBundle(nextCursor ?? undefined);
      });
      loadMoreDiv.appendChild(loadMoreBtn);
      itemsSection.appendChild(loadMoreDiv);
    }

    root.appendChild(itemsSection);

    // CTA button
    const ctaBtn = document.createElement("button");
    ctaBtn.className = "bw-cta";
    const sortedTiersAsc = [...tiers].sort((a, b) => a.minimum_item_count - b.minimum_item_count);
    const minTier = sortedTiersAsc.length > 0 ? sortedTiersAsc[0] : null;
    const meetsMin = minTier ? selectedIds.size >= (minTier.minimum_item_count as number) : false;
    const hasValidationErrors = validationErrors.some((e) =>
      !e.includes("out of stock") && !e.includes("no longer available")
    );

    ctaBtn.disabled = isAdding || !meetsMin || hasValidationErrors;

    if (isAdding) {
      ctaBtn.textContent = "Adding to cart…";
    } else if (!meetsMin && minTier) {
      const needed = (minTier.minimum_item_count as number) - selectedIds.size;
      ctaBtn.textContent = `Select ${needed} more to add`;
    } else {
      ctaBtn.textContent =
        discountRate > 0
          ? `Add to Cart — ${(discountRate / 100).toFixed(0)}% off`
          : "Add to Cart";
    }

    ctaBtn.addEventListener("click", handleAddToCart);
    root.appendChild(ctaBtn);
  }

  // ─── Add to cart handler ─────────────────────────────────────────────────────
  async function handleAddToCart(): Promise<void> {
    if (isAdding) return;
    isAdding = true;
    render();

    const selectedVariantIds = Array.from(selectedIds);
    const qtys = selectedVariantIds.map((vid) => ({
      variant_id: vid,
      quantity: quantities.get(vid) ?? 1,
    }));

    try {
      // 1. Server-side validate + get earned discount
      const validateResp = await host.call("/widget/bundle/validate", {
        bundle_id: bundleId,
        selected_variant_ids: selectedVariantIds,
      });

      if (!validateResp.valid) {
        validationErrors = validateResp.validation_errors ?? ["Validation failed. Please review your selection."];
        earnedTier = validateResp.earned_tier;
        discountRate = validateResp.discount_rate;
        isAdding = false;
        render();
        return;
      }

      earnedTier = validateResp.earned_tier;
      discountRate = validateResp.discount_rate;

      // 2. Confirm with backend cart-add endpoint (server-side guard + final rate)
      const cartResp = await host.call("/widget/cart/add", {
        bundle_id: bundleId,
        selected_variant_ids: selectedVariantIds,
        quantities: qtys,
      });

      if (!cartResp.success) {
        validationErrors = cartResp.errors ?? ["Failed to add to cart."];
        isAdding = false;
        render();
        return;
      }

      // 3. Add items to Shopify cart via storefront Ajax API
      const cartPayload = {
        items: selectedVariantIds.map((vid) => ({
          id: vid,
          quantity: quantities.get(vid) ?? 1,
        })),
      };

      await host.storefront("/cart/add.js", cartPayload);

      isAdding = false;
      addSuccess = true;
      render();
    } catch {
      validationErrors = ["An error occurred while adding to cart. Please try again."];
      isAdding = false;
      render();
    }
  }

  // ─── Kick off loading ─────────────────────────────────────────────────────────
  loadBundle();
}
