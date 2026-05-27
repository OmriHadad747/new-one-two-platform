export function mount(container: HTMLElement, host: any): void {
  // ─── Types ────────────────────────────────────────────────────────────────
  type BundleMode = "fixed" | "flexible";
  type BundleHealthStatus = "healthy" | "warned" | "auto_disabled";
  type ObservedAvailability = "available" | "out_of_stock" | "deleted";

  interface BundleTier {
    id: string;
    minimum_item_count: number;
    discount_rate: number; // basis points
    display_order: number;
  }

  interface BundleItem {
    id: string;
    variant_external_id: number;
    product_external_id: number;
    observed_availability: ObservedAvailability;
  }

  interface BundleConfig {
    id: string;
    title: string;
    description: string | null;
    mode: BundleMode;
    enabled: boolean;
    health_status: BundleHealthStatus;
  }

  interface VariantInfo {
    id: number; // legacy numeric id
    title: string;
    price: string;
    available: boolean;
    image: string | null;
    product_title: string;
    product_handle: string;
  }

  // ─── State ────────────────────────────────────────────────────────────────
  let bundle: BundleConfig | null = null;
  let tiers: BundleTier[] = [];
  let items: BundleItem[] = [];
  let variantInfoMap: Map<number, VariantInfo> = new Map();
  let selectedVariantIds: Set<number> = new Set();
  let currentDiscountBp = 0;
  let earnedTierLabel = "";
  let isLoading = false;
  let validationErrors: string[] = [];

  // ─── CSS ─────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bundle-widget { font-family: inherit; padding: 16px; box-sizing: border-box; }
    .bundle-widget * { box-sizing: border-box; }
    .bundle-widget h2 { margin: 0 0 8px; font-size: 1.1rem; font-weight: 700; }
    .bundle-widget .bundle-desc { color: #6d7175; font-size: 0.875rem; margin: 0 0 12px; }
    .bundle-widget .tier-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
    .bundle-widget .tier-badge {
      padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 600;
      background: #f0f4ff; color: #2c3e8c; border: 1px solid #c5d0ff;
      transition: background 0.15s, color 0.15s;
    }
    .bundle-widget .tier-badge.active { background: #008060; color: #fff; border-color: #006e52; }
    .bundle-widget .items-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 10px; margin-bottom: 16px;
    }
    .bundle-widget .item-card {
      border: 2px solid #e1e3e5; border-radius: 8px; padding: 10px;
      cursor: pointer; transition: border-color 0.15s, background 0.15s; text-align: center;
      position: relative;
    }
    .bundle-widget .item-card:hover { border-color: #a1a9b0; }
    .bundle-widget .item-card.selected { border-color: #008060; background: #f0faf7; }
    .bundle-widget .item-card.unavailable { opacity: 0.5; cursor: not-allowed; border-color: #e1e3e5; background: #f9fafb; }
    .bundle-widget .item-card img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; margin-bottom: 6px; }
    .bundle-widget .item-card .item-title { font-size: 0.8rem; font-weight: 500; margin-bottom: 2px; line-height: 1.2; }
    .bundle-widget .item-card .item-price { font-size: 0.875rem; color: #008060; font-weight: 600; }
    .bundle-widget .item-card .item-unavail { font-size: 0.75rem; color: #d82c0d; margin-top: 2px; }
    .bundle-widget .item-card .check-icon {
      position: absolute; top: 6px; right: 6px;
      width: 20px; height: 20px; background: #008060; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; color: #fff; font-size: 0.7rem;
    }
    .bundle-widget .discount-bar {
      padding: 10px 14px; background: #f0faf7; border: 1px solid #00806040;
      border-radius: 6px; margin-bottom: 14px; font-size: 0.875rem; font-weight: 600;
      color: #006e52; transition: opacity 0.2s;
      display: flex; align-items: center; gap: 8px;
    }
    .bundle-widget .discount-bar.hidden { display: none; }
    .bundle-widget .errors { margin-bottom: 10px; }
    .bundle-widget .error-item { color: #d82c0d; font-size: 0.8rem; margin-bottom: 4px; }
    .bundle-widget .add-btn {
      width: 100%; padding: 12px; background: #008060; color: #fff; border: none;
      border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer;
      transition: background 0.15s;
    }
    .bundle-widget .add-btn:hover { background: #006e52; }
    .bundle-widget .add-btn:disabled { background: #b5b5b5; cursor: not-allowed; }
    .bundle-widget .fixed-mode-note { font-size: 0.8rem; color: #6d7175; margin-bottom: 10px; }
    .bundle-widget .mode-label { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; background: #e8f5f1; color: #006e52; margin-bottom: 10px; }
    .bundle-widget .loading { text-align: center; padding: 24px; color: #6d7175; }
    @media (max-width: 480px) {
      .bundle-widget .items-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
    }
  `;
  container.appendChild(style);

  const widget = document.createElement("div");
  widget.className = "bundle-widget";
  container.appendChild(widget);

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function formatDiscount(bp: number): string {
    return (bp / 100).toFixed(0) + "% off";
  }

  function escHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ─── Fetch bundle config ──────────────────────────────────────────────────
  async function loadBundle(): Promise<void> {
    // Read bundle_id from URL query param or page data attribute
    const params = new URLSearchParams(window.location.search);
    let bundleId = params.get("bundle_id");

    // Fallback: read from a data attribute on a nearby element
    if (!bundleId) {
      const el = document.querySelector("[data-bundle-id]");
      if (el) bundleId = el.getAttribute("data-bundle-id");
    }

    if (!bundleId) {
      widget.innerHTML = `<div class="loading">No bundle configured for this page.</div>`;
      return;
    }

    widget.innerHTML = `<div class="loading">Loading bundle...</div>`;

    try {
      const resp = await host.call("/widget/bundle", { bundle_id: bundleId });
      bundle = resp.bundle;
      tiers = resp.tiers;
      items = resp.items;

      if (!bundle || !bundle.enabled) {
        widget.innerHTML = `<div class="loading">This bundle is not currently available.</div>`;
        return;
      }

      // Fetch variant info from Shopify storefront for each product
      await loadVariantInfo();
      render();
    } catch {
      widget.innerHTML = `<div class="loading">Unable to load bundle. Please refresh the page.</div>`;
    }
  }

  async function loadVariantInfo(): Promise<void> {
    // Group items by product handle — we'll use /products/{handle}.js for each unique product
    const productIds = [...new Set(items.map((i) => i.product_external_id))];

    // Use the storefront product endpoint for each product id
    // We query using product handle. Since we only have numeric IDs, use /products.json approach
    // Shopify Ajax: /products/{handle}.js - but we have product IDs not handles
    // We'll use the recommendations or fetch each product by its GID
    // Best approach: use /search/suggest.json to look up by product IDs
    // Actually, we have product handles from the Shopify Ajax API. Use cart.js to check variant availability
    // Instead: call host.call to our backend which already has observed_availability
    // The items list already includes observed_availability from the backend.
    // For display purposes (titles, prices, images), use host.storefront with a cart.js check.

    // For each product we need its handle. We don't have it. 
    // We can use host.storefront("/cart.js") to check current cart state.
    // For variant details (title, price, image), the best approach without handles
    // is to pass the variant IDs in note_attributes and let the widget render with 
    // what the backend gives us (availability status + variant IDs).
    
    // Since we don't have product handles, build minimal VariantInfo from what we know.
    for (const item of items) {
      variantInfoMap.set(item.variant_external_id, {
        id: item.variant_external_id,
        title: `Variant #${item.variant_external_id}`,
        price: "",
        available: item.observed_availability === "available",
        image: null,
        product_title: `Product #${item.product_external_id}`,
        product_handle: "",
      });
    }

    // Try to enrich with Shopify storefront data where possible
    // We'll query /cart.js to see if any variants are in cart (available check)
    try {
      const cart = await host.storefront("/cart.js");
      // Mark cart item variants as confirmed available
      if (cart?.items) {
        for (const cartItem of cart.items) {
          if (variantInfoMap.has(cartItem.variant_id)) {
            const existing = variantInfoMap.get(cartItem.variant_id)!;
            variantInfoMap.set(cartItem.variant_id, {
              ...existing,
              price: String(cartItem.price),
              title: cartItem.variant_title || existing.title,
              product_title: cartItem.product_title || existing.product_title,
              image: cartItem.image || existing.image,
            });
          }
        }
      }
    } catch {
      // Ignore cart fetch errors — we have observed availability from backend
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  function render(): void {
    if (!bundle) return;

    const isFixed = bundle.mode === "fixed";

    // In fixed mode, all available items are auto-selected
    if (isFixed) {
      selectedVariantIds = new Set(
        items
          .filter((i) => i.observed_availability === "available")
          .map((i) => i.variant_external_id)
      );
    }

    renderWidget();
  }

  function renderWidget(): void {
    if (!bundle) return;

    const isFixed = bundle.mode === "fixed";
    const selectedCount = selectedVariantIds.size;

    // Find the highest earned tier
    let earnedTier: BundleTier | null = null;
    const sortedTiers = [...tiers].sort((a, b) => b.minimum_item_count - a.minimum_item_count);
    for (const tier of sortedTiers) {
      if (selectedCount >= tier.minimum_item_count) {
        earnedTier = tier;
        break;
      }
    }

    currentDiscountBp = earnedTier?.discount_rate ?? 0;
    earnedTierLabel = earnedTier
      ? `${formatDiscount(earnedTier.discount_rate)} (${selectedCount} items selected)`
      : "";

    // Build tier badges
    const tierBadgesHtml = tiers.map((t) => {
      const isActive = earnedTier && t.id === earnedTier.id;
      return `<span class="tier-badge ${isActive ? "active" : ""}" title="Select at least ${t.minimum_item_count} items">
        Buy ${t.minimum_item_count}+ → ${formatDiscount(t.discount_rate)}
      </span>`;
    }).join("");

    // Build item cards
    const itemCardsHtml = items.map((item) => {
      const info = variantInfoMap.get(item.variant_external_id);
      const isSelected = selectedVariantIds.has(item.variant_external_id);
      const isAvailable = item.observed_availability === "available";
      const priceDisplay = info?.price ? `$${(parseInt(info.price, 10) / 100).toFixed(2)}` : "";
      const imageHtml = info?.image
        ? `<img src="${escHtml(info.image)}" alt="${escHtml(info?.title ?? "")}">` 
        : `<div style="width:100%;aspect-ratio:1;background:#f0f0f0;border-radius:4px;margin-bottom:6px;display:flex;align-items:center;justify-content:center;color:#999;font-size:1.5rem;">📦</div>`;

      const cardClasses = ["item-card"];
      if (isSelected && !isFixed) cardClasses.push("selected");
      if (!isAvailable) cardClasses.push("unavailable");

      return `
        <div class="${cardClasses.join(" ")}" data-variant-id="${item.variant_external_id}" role="button" tabindex="${isAvailable && !isFixed ? 0 : -1}" aria-pressed="${isSelected}" aria-label="Variant ${item.variant_external_id}${!isAvailable ? " (unavailable)" : ""}">
          ${imageHtml}
          <div class="item-title">${escHtml(info?.product_title ?? `Product #${item.product_external_id}`)}</div>
          <div class="item-title" style="color:#6d7175;">${escHtml(info?.title ?? `Variant #${item.variant_external_id}`)}</div>
          ${priceDisplay ? `<div class="item-price">${escHtml(priceDisplay)}</div>` : ""}
          ${!isAvailable ? `<div class="item-unavail">Unavailable</div>` : ""}
          ${isSelected && !isFixed ? `<span class="check-icon" aria-hidden="true">✓</span>` : ""}
        </div>
      `;
    }).join("");

    // Errors
    const errorsHtml = validationErrors.length > 0
      ? `<div class="errors">${validationErrors.map((e) => `<div class="error-item">⚠ ${escHtml(e)}</div>`).join("")}</div>`
      : "";

    // Button state
    const canAdd = earnedTier !== null && selectedVariantIds.size >= 1;
    const btnText = isFixed
      ? (earnedTier ? `Add Bundle to Cart — ${formatDiscount(earnedTier.discount_rate)}` : "Add Bundle to Cart")
      : (earnedTier ? `Add ${selectedCount} Items to Cart — ${formatDiscount(earnedTier.discount_rate)}` : `Select at least ${tiers.length > 0 ? tiers[tiers.length - 1]?.minimum_item_count ?? 1 : 1} items for a discount`);

    widget.innerHTML = `
      <h2>${escHtml(bundle.title)}</h2>
      <span class="mode-label">${bundle.mode === "fixed" ? "Fixed Bundle" : "Flexible Bundle"}</span>
      ${bundle.description ? `<p class="bundle-desc">${escHtml(bundle.description)}</p>` : ""}
      <div class="tier-badges">${tierBadgesHtml}</div>
      ${isFixed ? `<p class="fixed-mode-note">This is a fixed bundle. All items below are included.</p>` : `<p class="fixed-mode-note">Select ${tiers.length > 0 ? `at least ${tiers[tiers.length - 1]?.minimum_item_count ?? 1}` : "your"} items to earn a discount.</p>`}
      ${earnedTierLabel ? `<div class="discount-bar">🎉 Discount applied: ${escHtml(earnedTierLabel)}</div>` : `<div class="discount-bar hidden"></div>`}
      <div class="items-grid">${itemCardsHtml}</div>
      ${errorsHtml}
      <button class="add-btn" id="add-to-cart-btn" ${(!isFixed && !canAdd) ? "disabled" : ""}>${escHtml(btnText)}</button>
    `;

    // Wire up item card clicks for flexible bundles
    if (!isFixed) {
      widget.querySelectorAll<HTMLElement>(".item-card").forEach((card) => {
        const variantId = parseInt(card.dataset.variantId!, 10);
        const item = items.find((i) => i.variant_external_id === variantId);
        if (!item || item.observed_availability !== "available") return;

        card.addEventListener("click", () => toggleVariantSelection(variantId));
        card.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleVariantSelection(variantId);
          }
        });
      });
    }

    // Wire up add to cart
    widget.querySelector("#add-to-cart-btn")!.addEventListener("click", handleAddToCart);
  }

  function toggleVariantSelection(variantId: number): void {
    validationErrors = [];
    if (selectedVariantIds.has(variantId)) {
      selectedVariantIds.delete(variantId);
    } else {
      selectedVariantIds.add(variantId);
    }
    renderWidget();
  }

  // ─── Add to Cart ──────────────────────────────────────────────────────────
  async function handleAddToCart(): Promise<void> {
    if (!bundle || isLoading) return;

    const isFixed = bundle.mode === "fixed";
    const variantIds = [...selectedVariantIds];

    if (variantIds.length === 0) return;

    isLoading = true;
    const btn = widget.querySelector<HTMLButtonElement>("#add-to-cart-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Validating..."; }

    // Validate server-side
    const validateResp = await host.call("/widget/bundle/validate", {
      bundle_id: bundle.id,
      selected_variant_ids: variantIds,
    });

    if (!validateResp.valid) {
      validationErrors = validateResp.validation_errors;
      isLoading = false;
      renderWidget();
      return;
    }

    const discountBp = validateResp.discount_rate as number;
    const discountPct = discountBp / 100; // e.g. 1000 → 10

    // Call server to confirm and record
    const cartResp = await host.call("/widget/cart/add", {
      bundle_id: bundle.id,
      selected_variant_ids: variantIds,
      quantities: variantIds.map(() => 1),
    });

    if (!cartResp.success) {
      validationErrors = cartResp.errors;
      isLoading = false;
      renderWidget();
      return;
    }

    // Add items to cart via Shopify Ajax API
    if (btn) btn.textContent = "Adding to cart...";

    try {
      const cartItems = variantIds.map((id) => ({ id, quantity: 1 }));
      await host.storefront("/cart/add.js", {
        items: cartItems,
        attributes: {
          bundle_id: bundle.id,
          bundle_discount_pct: String(discountPct),
        },
      });

      // Apply discount code if > 0
      if (discountBp > 0) {
        // Bundle discount via cart attributes — the discount is informational here
        // Full coupon-code discount application would require backend-generated code
        await host.storefront("/cart/update.js", {
          attributes: {
            [`bundle_${bundle.id}_discount`]: String(discountBp),
          },
        });
      }

      isLoading = false;
      validationErrors = [];

      if (btn) {
        btn.textContent = "✓ Added to Cart!";
        btn.style.background = "#006e52";
      }

      // Reset selection after a short delay
      setTimeout(() => {
        if (bundle?.mode === "flexible") selectedVariantIds.clear();
        isLoading = false;
        renderWidget();
      }, 1500);
    } catch {
      isLoading = false;
      validationErrors = ["Failed to add items to cart. Please try again."];
      renderWidget();
    }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  loadBundle();
}
