window.__PLATFORM_CATALOG__ = [{"path": "/bundle", "method": "GET"}, {"path": "/bundle/validate", "method": "POST"}, {"path": "/cart/add", "method": "POST"}];
export function mount(container, host) {
  const SLUG = "bundle";

  // ── Styles ──────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .app-${SLUG}-wrap { font-family: inherit; max-width: 640px; margin: 0 auto; }
    .app-${SLUG}-loading { padding: 16px; color: #666; text-align: center; }
    .app-${SLUG}-error { padding: 12px 16px; background: #fff3f3; border: 1px solid #e00; border-radius: 6px; color: #c00; margin-bottom: 12px; }
    .app-${SLUG}-disabled { padding: 16px; color: #888; text-align: center; font-style: italic; }
    .app-${SLUG}-title { font-size: 1.15em; font-weight: 700; margin: 0 0 4px; }
    .app-${SLUG}-desc { font-size: 0.92em; color: #555; margin: 0 0 14px; }
    .app-${SLUG}-tiers { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    .app-${SLUG}-tier { flex: 1 1 auto; min-width: 120px; padding: 8px 12px; border-radius: 6px; border: 2px solid #ddd; background: #fafafa; text-align: center; font-size: 0.85em; color: #444; transition: border-color 0.2s, background 0.2s; }
    .app-${SLUG}-tier.earned { border-color: #1a7f37; background: #e6f4ea; color: #1a7f37; font-weight: 700; }
    .app-${SLUG}-tier.next { border-color: #bbb; background: #f5f5f5; color: #666; }
    .app-${SLUG}-tier-label { font-size: 0.8em; display: block; margin-top: 2px; }
    .app-${SLUG}-progress { margin-bottom: 16px; }
    .app-${SLUG}-progress-bar-bg { height: 6px; background: #e0e0e0; border-radius: 3px; overflow: hidden; }
    .app-${SLUG}-progress-bar-fill { height: 100%; background: #1a7f37; border-radius: 3px; transition: width 0.3s; }
    .app-${SLUG}-progress-text { font-size: 0.82em; color: #555; margin-top: 4px; }
    .app-${SLUG}-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .app-${SLUG}-item { border: 2px solid #ddd; border-radius: 8px; overflow: hidden; cursor: pointer; background: #fff; transition: border-color 0.18s, box-shadow 0.18s; position: relative; user-select: none; }
    .app-${SLUG}-item.selected { border-color: #1a7f37; box-shadow: 0 0 0 2px #1a7f3733; }
    .app-${SLUG}-item.unavailable { opacity: 0.45; cursor: not-allowed; }
    .app-${SLUG}-item-img { width: 100%; aspect-ratio: 1/1; object-fit: cover; display: block; background: #f0f0f0; }
    .app-${SLUG}-item-img-placeholder { width: 100%; aspect-ratio: 1/1; background: #ececec; display: flex; align-items: center; justify-content: center; color: #bbb; font-size: 1.5em; }
    .app-${SLUG}-item-info { padding: 8px 8px 10px; }
    .app-${SLUG}-item-title { font-size: 0.8em; font-weight: 600; margin: 0 0 2px; line-height: 1.3; }
    .app-${SLUG}-item-variant { font-size: 0.74em; color: #777; margin: 0 0 2px; }
    .app-${SLUG}-item-badge { display: inline-block; font-size: 0.7em; padding: 1px 6px; border-radius: 4px; font-weight: 600; }
    .app-${SLUG}-item-badge.oos { background: #fce8e8; color: #c00; }
    .app-${SLUG}-item-badge.avail { background: #e6f4ea; color: #1a7f37; }
    .app-${SLUG}-item-check { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; background: #1a7f37; display: none; align-items: center; justify-content: center; }
    .app-${SLUG}-item-check svg { width: 12px; height: 12px; }
    .app-${SLUG}-item.selected .app-${SLUG}-item-check { display: flex; }
    .app-${SLUG}-item-fixed-qty { font-size: 0.75em; color: #555; margin-top: 2px; }
    .app-${SLUG}-summary { background: #f9f9f9; border: 1px solid #eee; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
    .app-${SLUG}-summary-row { display: flex; justify-content: space-between; font-size: 0.88em; margin-bottom: 4px; }
    .app-${SLUG}-summary-row.discount { color: #1a7f37; font-weight: 600; }
    .app-${SLUG}-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .app-${SLUG}-btn { padding: 11px 22px; border-radius: 6px; border: none; font-size: 0.95em; font-weight: 600; cursor: pointer; transition: background 0.18s, opacity 0.18s; }
    .app-${SLUG}-btn-primary { background: #1a7f37; color: #fff; }
    .app-${SLUG}-btn-primary:disabled { background: #a0c8aa; cursor: not-allowed; }
    .app-${SLUG}-btn-secondary { background: #eee; color: #333; }
    .app-${SLUG}-btn-secondary:disabled { opacity: 0.55; cursor: not-allowed; }
    .app-${SLUG}-status { margin-top: 10px; font-size: 0.88em; }
    .app-${SLUG}-status.success { color: #1a7f37; }
    .app-${SLUG}-status.error { color: #c00; }
    .app-${SLUG}-discount-note { font-size: 0.78em; color: #888; margin-top: 8px; }
    @media (max-width: 420px) {
      .app-${SLUG}-items { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
      .app-${SLUG}-tiers { gap: 5px; }
    }
  `;
  container.appendChild(style);

  const wrap = document.createElement("div");
  wrap.className = `app-${SLUG}-wrap`;
  container.appendChild(wrap);

  // ── Helpers ──────────────────────────────────────────────────────────────
  function showLoading() {
    wrap.innerHTML = "";
    const p = document.createElement("p");
    p.className = `app-${SLUG}-loading`;
    p.textContent = "Loading bundle…";
    wrap.appendChild(p);
  }

  function showDisabled(msg) {
    wrap.innerHTML = "";
    const p = document.createElement("p");
    p.className = `app-${SLUG}-disabled`;
    p.textContent = msg || "This bundle is not currently available.";
    wrap.appendChild(p);
  }

  function fmtRate(bps) {
    return (bps / 100).toFixed(2).replace(/\.00$/, "") + "%";
  }

  function getBundleId() {
    const params = new URLSearchParams(location.search);
    if (params.get("bundle_id")) return params.get("bundle_id");
    // Attempt to read from a data attribute the merchant may place on the
    // container or its parent (theme integration convention).
    if (container.dataset.bundleId) return container.dataset.bundleId;
    return null;
  }

  // ── State ────────────────────────────────────────────────────────────────
  let bundleData = null;   // { bundle, tiers, items }
  let productCache = {};   // handle → product data from storefront
  let variantMeta = {};    // variant_external_id → { title, variant_title, image, available, price }
  let selectedIds = [];    // string[] of variant_external_id (flexible) or preset in fixed
  let earnedTier = null;   // { minimum_item_count, discount_rate } | null
  let validating = false;
  let validateTimer = null;

  // ── Mount flow ───────────────────────────────────────────────────────────
  async function init() {
    showLoading();

    const bundleId = getBundleId();
    if (!bundleId) {
      showDisabled("No bundle configured for this page.");
      return;
    }

    let resp;
    try {
      resp = await host.call("/bundle", { bundle_id: bundleId, page: 1, page_size: 100 });
    } catch (_) {
      showDisabled("Unable to load bundle. Please try again.");
      return;
    }

    if (!resp || !resp.bundle) {
      showDisabled("Bundle not found.");
      return;
    }

    if (!resp.bundle.enabled) {
      showDisabled("This bundle is currently unavailable.");
      return;
    }

    if (resp.bundle.health_status && resp.bundle.health_status !== "healthy") {
      // Warn but still render — merchant will see a banner
    }

    bundleData = { bundle: resp.bundle, tiers: resp.tiers || [], items: resp.items || [] };

    // Sort tiers ascending by minimum_item_count
    bundleData.tiers.sort((a, b) => a.minimum_item_count - b.minimum_item_count);

    // Fetch variant metadata from storefront for each unique product
    await loadVariantMeta();

    // For fixed bundles seed the full item list as the selection
    if (bundleData.bundle.mode === "fixed") {
      selectedIds = bundleData.items
        .filter(it => it.observed_availability !== "out_of_stock")
        .map(it => it.variant_external_id);
    } else {
      selectedIds = [];
    }

    renderBundle();
  }

  async function loadVariantMeta() {
    // Collect unique product_external_ids; use /products/{handle}.js via
    // a handle we can derive. Since the catalog only gives us product IDs,
    // we need to load each product's handle from Shopify. We first fetch
    // /products/{handle}.js but we only have IDs. Use search suggest to
    // map product_id → handle.
    const uniqueProductIds = [...new Set(bundleData.items.map(it => it.product_external_id))];

    const handleFetches = uniqueProductIds.map(async (pid) => {
      try {
        // Use predictive search to find the product handle by ID.
        const searchRes = await host.storefront(
          `/search/suggest.json?q=${encodeURIComponent(pid)}&resources[type]=product&resources[limit]=5`
        );
        const products = searchRes &&
          searchRes.resources &&
          searchRes.resources.results &&
          searchRes.resources.results.products;
        if (!products || products.length === 0) return;

        // Find the product whose id matches. Shopify suggest returns numeric IDs.
        const match = products.find(p => String(p.id) === String(pid));
        if (!match || !match.handle) return;

        // Now fetch full product data
        const prod = await host.storefront(`/products/${match.handle}.js`);
        if (!prod || !prod.variants) return;
        productCache[pid] = prod;

        prod.variants.forEach(v => {
          variantMeta[String(v.id)] = {
            productTitle: prod.title,
            variantTitle: v.title,
            price: v.price,
            available: v.available,
            image: prod.featured_image || null,
          };
        });
      } catch (_) {
        // Fallback: leave variantMeta unpopulated for this product
      }
    });

    await Promise.all(handleFetches);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function renderBundle() {
    wrap.innerHTML = "";

    const { bundle, tiers, items } = bundleData;

    // Title
    const title = document.createElement("h2");
    title.className = `app-${SLUG}-title`;
    title.textContent = bundle.title;
    wrap.appendChild(title);

    if (bundle.description) {
      const desc = document.createElement("p");
      desc.className = `app-${SLUG}-desc`;
      desc.textContent = bundle.description;
      wrap.appendChild(desc);
    }

    // Health warning
    if (bundle.health_status && bundle.health_status !== "healthy") {
      const warn = document.createElement("p");
      warn.className = `app-${SLUG}-error`;
      warn.textContent = "Some items in this bundle may be out of stock. Please review your selection.";
      wrap.appendChild(warn);
    }

    // Tiers display
    if (tiers.length > 0) {
      const tierRow = document.createElement("div");
      tierRow.className = `app-${SLUG}-tiers`;
      tierRow.setAttribute("aria-label", "Discount tiers");
      tiers.forEach(tier => {
        const td = document.createElement("div");
        td.className = `app-${SLUG}-tier`;
        td.dataset.tierId = tier.id;
        const main = document.createElement("span");
        main.textContent = `${fmtRate(tier.discount_rate)} off`;
        const sub = document.createElement("span");
        sub.className = `app-${SLUG}-tier-label`;
        sub.textContent = `Pick ${tier.minimum_item_count}+ item${tier.minimum_item_count !== 1 ? "s" : ""}`;
        td.appendChild(main);
        td.appendChild(sub);
        tierRow.appendChild(td);
      });
      wrap.appendChild(tierRow);

      // Progress bar
      if (bundle.mode !== "fixed") {
        const progressDiv = document.createElement("div");
        progressDiv.className = `app-${SLUG}-progress`;
        const barBg = document.createElement("div");
        barBg.className = `app-${SLUG}-progress-bar-bg`;
        const barFill = document.createElement("div");
        barFill.className = `app-${SLUG}-progress-bar-fill`;
        barFill.id = `app-${SLUG}-progress-fill`;
        barFill.style.width = "0%";
        barBg.appendChild(barFill);
        const progressText = document.createElement("p");
        progressText.className = `app-${SLUG}-progress-text`;
        progressText.id = `app-${SLUG}-progress-text`;
        progressDiv.appendChild(barBg);
        progressDiv.appendChild(progressText);
        wrap.appendChild(progressDiv);
      }
    }

    // Items grid
    const itemsGrid = document.createElement("div");
    itemsGrid.className = `app-${SLUG}-items`;
    itemsGrid.setAttribute("role", "list");

    items.forEach(item => {
      const meta = variantMeta[item.variant_external_id] || {};
      const isAvailable = item.observed_availability !== "out_of_stock" &&
        (meta.available !== false);

      const card = document.createElement("div");
      card.className = `app-${SLUG}-item`;
      card.setAttribute("role", "listitem");
      card.dataset.variantId = item.variant_external_id;

      if (!isAvailable) {
        card.classList.add("unavailable");
        card.setAttribute("aria-disabled", "true");
      }

      if (selectedIds.includes(item.variant_external_id)) {
        card.classList.add("selected");
      }

      card.setAttribute("aria-label",
        (meta.productTitle || "Product") +
        (meta.variantTitle && meta.variantTitle !== "Default Title" ? " – " + meta.variantTitle : "") +
        (isAvailable ? "" : " (out of stock)")
      );

      // Image
      if (meta.image) {
        const img = document.createElement("img");
        img.className = `app-${SLUG}-item-img`;
        img.src = meta.image;
        img.alt = meta.productTitle || "";
        img.loading = "lazy";
        card.appendChild(img);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = `app-${SLUG}-item-img-placeholder`;
        placeholder.setAttribute("aria-hidden", "true");
        placeholder.textContent = "📦";
        card.appendChild(placeholder);
      }

      // Checkmark overlay
      const check = document.createElement("div");
      check.className = `app-${SLUG}-item-check`;
      check.setAttribute("aria-hidden", "true");
      check.innerHTML = '<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="1,6 4.5,9.5 11,2.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      card.appendChild(check);

      // Info
      const info = document.createElement("div");
      info.className = `app-${SLUG}-item-info`;

      const itemTitle = document.createElement("p");
      itemTitle.className = `app-${SLUG}-item-title`;
      itemTitle.textContent = meta.productTitle || "Product";
      info.appendChild(itemTitle);

      if (meta.variantTitle && meta.variantTitle !== "Default Title") {
        const vTitle = document.createElement("p");
        vTitle.className = `app-${SLUG}-item-variant`;
        vTitle.textContent = meta.variantTitle;
        info.appendChild(vTitle);
      }

      const badge = document.createElement("span");
      badge.className = `app-${SLUG}-item-badge ${isAvailable ? "avail" : "oos"}`;
      badge.textContent = isAvailable ? "Available" : "Out of stock";
      info.appendChild(badge);

      if (bundle.mode === "fixed" && meta.price != null) {
        const fixedQty = document.createElement("p");
        fixedQty.className = `app-${SLUG}-item-fixed-qty`;
        fixedQty.textContent = "Included in bundle";
        info.appendChild(fixedQty);
      }

      card.appendChild(info);

      // Click handler for flexible mode
      if (bundle.mode !== "fixed") {
        card.addEventListener("click", () => {
          if (!isAvailable) return;
          toggleSelection(item.variant_external_id);
        });
        card.setAttribute("tabindex", isAvailable ? "0" : "-1");
        card.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" || e.key === " ") && isAvailable) {
            e.preventDefault();
            toggleSelection(item.variant_external_id);
          }
        });
      }

      itemsGrid.appendChild(card);
    });

    wrap.appendChild(itemsGrid);

    // Summary block
    const summary = document.createElement("div");
    summary.className = `app-${SLUG}-summary`;
    summary.id = `app-${SLUG}-summary`;
    wrap.appendChild(summary);

    // Actions
    const actions = document.createElement("div");
    actions.className = `app-${SLUG}-actions`;

    const addBtn = document.createElement("button");
    addBtn.className = `app-${SLUG}-btn app-${SLUG}-btn-primary`;
    addBtn.id = `app-${SLUG}-add-btn`;
    addBtn.textContent = "Add bundle to cart";
    addBtn.disabled = true;
    actions.appendChild(addBtn);

    if (bundle.mode !== "fixed") {
      const clearBtn = document.createElement("button");
      clearBtn.className = `app-${SLUG}-btn app-${SLUG}-btn-secondary`;
      clearBtn.textContent = "Clear selection";
      clearBtn.addEventListener("click", () => {
        selectedIds = [];
        earnedTier = null;
        refreshSelectionUI();
        scheduleValidate();
      });
      actions.appendChild(clearBtn);
    }

    wrap.appendChild(actions);

    // Status
    const status = document.createElement("p");
    status.className = `app-${SLUG}-status`;
    status.setAttribute("aria-live", "polite");
    status.id = `app-${SLUG}-status`;
    wrap.appendChild(status);

    // Discount note
    const note = document.createElement("p");
    note.className = `app-${SLUG}-discount-note`;
    note.textContent = "Discounts are applied via promo code at checkout. Ensure matching discount rules are configured in your Shopify Admin.";
    wrap.appendChild(note);

    addBtn.addEventListener("click", handleAddToCart);

    // Initial UI update
    refreshSelectionUI();
    scheduleValidate();
  }

  function toggleSelection(variantId) {
    const idx = selectedIds.indexOf(variantId);
    if (idx >= 0) {
      selectedIds.splice(idx, 1);
    } else {
      selectedIds.push(variantId);
    }
    refreshSelectionUI();
    scheduleValidate();
  }

  function refreshSelectionUI() {
    const { tiers, items, bundle } = bundleData;

    // Update card selected states
    const cards = container.querySelectorAll(`.app-${SLUG}-item`);
    cards.forEach(card => {
      const vid = card.dataset.variantId;
      if (!vid) return;
      if (selectedIds.includes(vid)) {
        card.classList.add("selected");
      } else {
        card.classList.remove("selected");
      }
    });

    const count = selectedIds.length;
    const maxTier = getMaxEarnedTier(count);

    // Update tier highlights
    tiers.forEach(tier => {
      const el = container.querySelector(`.app-${SLUG}-tier[data-tier-id="${tier.id}"]`);
      if (!el) return;
      el.classList.remove("earned", "next");
      if (maxTier && tier.id === maxTier.id) {
        el.classList.add("earned");
      } else if (!maxTier || tier.minimum_item_count > (maxTier ? maxTier.minimum_item_count : 0)) {
        el.classList.add("next");
      }
    });

    // Progress bar (flexible only)
    if (bundle.mode !== "fixed" && tiers.length > 0) {
      const maxCount = tiers[tiers.length - 1].minimum_item_count;
      const pct = Math.min(100, Math.round((count / maxCount) * 100));
      const fill = container.querySelector(`#app-${SLUG}-progress-fill`);
      const text = container.querySelector(`#app-${SLUG}-progress-text`);
      if (fill) fill.style.width = pct + "%";
      if (text) {
        if (maxTier) {
          text.textContent = `${count} item${count !== 1 ? "s" : ""} selected — ${fmtRate(maxTier.discount_rate)} off unlocked!`;
        } else {
          const next = tiers.find(t => t.minimum_item_count > count);
          if (next) {
            const need = next.minimum_item_count - count;
            text.textContent = `${count} item${count !== 1 ? "s" : ""} selected — pick ${need} more for ${fmtRate(next.discount_rate)} off`;
          } else {
            text.textContent = `${count} item${count !== 1 ? "s" : ""} selected`;
          }
        }
      }
    }

    // Summary
    updateSummary(count, maxTier);

    // Enable add button only if at least the minimum tier is met
    const addBtn = container.querySelector(`#app-${SLUG}-add-btn`);
    if (addBtn) {
      const minRequired = tiers.length > 0 ? tiers[0].minimum_item_count : 1;
      addBtn.disabled = count < minRequired || validating;
    }
  }

  function getMaxEarnedTier(count) {
    const { tiers } = bundleData;
    let best = null;
    for (const tier of tiers) {
      if (count >= tier.minimum_item_count) best = tier;
    }
    return best;
  }

  function updateSummary(count, tier) {
    const summary = container.querySelector(`#app-${SLUG}-summary`);
    if (!summary) return;
    summary.innerHTML = "";

    const row1 = document.createElement("div");
    row1.className = `app-${SLUG}-summary-row`;
    const r1l = document.createElement("span");
    r1l.textContent = "Items selected";
    const r1v = document.createElement("span");
    r1v.textContent = String(count);
    row1.appendChild(r1l);
    row1.appendChild(r1v);
    summary.appendChild(row1);

    if (tier) {
      const row2 = document.createElement("div");
      row2.className = `app-${SLUG}-summary-row discount`;
      const r2l = document.createElement("span");
      r2l.textContent = "Discount applied";
      const r2v = document.createElement("span");
      r2v.textContent = fmtRate(tier.discount_rate) + " off";
      row2.appendChild(r2l);
      row2.appendChild(r2v);
      summary.appendChild(row2);

      if (earnedTier && earnedTier.discount_rate !== tier.discount_rate) {
        // validation result differs from local estimate — show validated value
        const row3 = document.createElement("div");
        row3.className = `app-${SLUG}-summary-row discount`;
        const r3l = document.createElement("span");
        r3l.textContent = "Validated discount";
        const r3v = document.createElement("span");
        r3v.textContent = fmtRate(earnedTier.discount_rate) + " off";
        row3.appendChild(r3l);
        row3.appendChild(r3v);
        summary.appendChild(row3);
      }
    } else if (count > 0 && bundleData.tiers.length > 0) {
      const row2 = document.createElement("div");
      row2.className = `app-${SLUG}-summary-row`;
      const r2l = document.createElement("span");
      const minTier = bundleData.tiers[0];
      r2l.textContent = `Add ${minTier.minimum_item_count - count} more to unlock ${fmtRate(minTier.discount_rate)} off`;
      row2.appendChild(r2l);
      summary.appendChild(row2);
    }
  }

  // ── Validate ─────────────────────────────────────────────────────────────
  function scheduleValidate() {
    if (validateTimer) clearTimeout(validateTimer);
    const count = selectedIds.length;
    const minRequired = bundleData.tiers.length > 0 ? bundleData.tiers[0].minimum_item_count : 1;
    if (count < minRequired) {
      earnedTier = null;
      return;
    }
    validateTimer = setTimeout(runValidate, 350);
  }

  async function runValidate() {
    if (!bundleData) return;
    const snapshotIds = selectedIds.slice();
    if (snapshotIds.length === 0) return;

    validating = true;
    const addBtn = container.querySelector(`#app-${SLUG}-add-btn`);
    if (addBtn) addBtn.disabled = true;

    try {
      const res = await host.call("/bundle/validate", {
        bundle_id: bundleData.bundle.id,
        selected_variant_ids: snapshotIds,
      });

      if (!res) return;

      earnedTier = res.earned_tier || null;

      // Sync local selectedIds if the snapshot is still valid
      if (JSON.stringify(snapshotIds) === JSON.stringify(selectedIds)) {
        const statusEl = container.querySelector(`#app-${SLUG}-status`);

        if (res.valid) {
          if (statusEl) {
            statusEl.className = `app-${SLUG}-status success`;
            statusEl.textContent = earnedTier
              ? `Selection valid — ${fmtRate(earnedTier.discount_rate)} off unlocked!`
              : "Selection valid.";
          }
        } else {
          if (statusEl) {
            statusEl.className = `app-${SLUG}-status error`;
            statusEl.textContent = res.validation_errors && res.validation_errors.length > 0
              ? res.validation_errors[0]
              : "Some selected items are unavailable. Please update your selection.";
          }
        }
        refreshSelectionUI();
      }
    } catch (_) {
      // On validate failure fall open — keep local tier estimate
    } finally {
      validating = false;
      const addBtn2 = container.querySelector(`#app-${SLUG}-add-btn`);
      if (addBtn2) {
        const count = selectedIds.length;
        const minRequired = bundleData.tiers.length > 0 ? bundleData.tiers[0].minimum_item_count : 1;
        addBtn2.disabled = count < minRequired;
      }
    }
  }

  // ── Add to cart ──────────────────────────────────────────────────────────
  async function handleAddToCart() {
    if (!bundleData) return;

    const addBtn = container.querySelector(`#app-${SLUG}-add-btn`);
    const statusEl = container.querySelector(`#app-${SLUG}-status`);

    const count = selectedIds.length;
    const minRequired = bundleData.tiers.length > 0 ? bundleData.tiers[0].minimum_item_count : 1;
    if (count < minRequired) return;

    if (addBtn) {
      addBtn.disabled = true;
      addBtn.textContent = "Adding…";
    }
    if (statusEl) {
      statusEl.className = `app-${SLUG}-status`;
      statusEl.textContent = "";
    }

    const quantities = selectedIds.map(() => 1);

    let res;
    try {
      res = await host.call("/cart/add", {
        bundle_id: bundleData.bundle.id,
        selected_variant_ids: selectedIds.slice(),
        quantities,
      });
    } catch (_) {
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = "Add bundle to cart";
      }
      if (statusEl) {
        statusEl.className = `app-${SLUG}-status error`;
        statusEl.textContent = "Could not add to cart. Please try again.";
      }
      return;
    }

    if (res && res.success) {
      if (statusEl) {
        statusEl.className = `app-${SLUG}-status success`;
        let msg = "Bundle added to cart!";
        if (res.applied_discount_rate != null) {
          msg += ` ${fmtRate(res.applied_discount_rate)} discount applied.`;
        }
        statusEl.textContent = msg;
      }
      if (addBtn) {
        addBtn.textContent = "Added to cart ✓";
        // Keep disabled to prevent duplicate adds; let them navigate to cart
      }

      // Notify any cart-aware theme components via a standard DOM event
      try {
        document.dispatchEvent(new CustomEvent("cart:updated", { bubbles: true }));
      } catch (_) {}
    } else {
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = "Add bundle to cart";
      }
      if (statusEl) {
        statusEl.className = `app-${SLUG}-status error`;
        const errMsg = res && res.errors && res.errors.length > 0
          ? res.errors[0]
          : "Failed to add bundle. Please check your selection and try again.";
        statusEl.textContent = errMsg;
      }
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  init();
}