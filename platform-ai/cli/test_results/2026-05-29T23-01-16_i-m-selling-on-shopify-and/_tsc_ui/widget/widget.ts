import type { Host } from "@platform/storefront-sdk";
import type {
  BundleId,
  BundleType,
  DiscountKind,
  BundleDiscountTierRow,
  MemberWithLiveInfo,
  WidgetBundleResponse,
  WidgetPreviewTotalResponse,
  WidgetAddToCartResponse,
} from "../src/types/contracts.js";

export function mount(container: HTMLElement, host: Host): void {
  // ─── CSS ─────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bundle-widget {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 20px;
      margin: 16px 0;
      background: #fff;
    }
    .bundle-title {
      font-size: 18px;
      font-weight: 700;
      margin: 0 0 4px 0;
    }
    .bundle-subtitle {
      font-size: 13px;
      color: #666;
      margin: 0 0 16px 0;
    }
    .bundle-tiers {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .tier-badge {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      background: #f0fdf4;
      border: 1px solid #86efac;
      color: #166534;
    }
    .tier-badge.active {
      background: #166534;
      color: #fff;
      border-color: #166534;
    }
    .bundle-members {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 16px;
    }
    .member-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .member-card.selected {
      border-color: #008060;
      background: #f0fdf4;
    }
    .member-card.unavailable {
      opacity: 0.5;
      cursor: not-allowed;
      border-color: #f87171;
      background: #fef2f2;
    }
    .member-card.fixed-item {
      border-color: #008060;
      background: #f0fdf4;
      cursor: default;
    }
    .member-img {
      width: 48px;
      height: 48px;
      object-fit: cover;
      border-radius: 4px;
      background: #f3f4f6;
    }
    .member-img-placeholder {
      width: 48px;
      height: 48px;
      background: #f3f4f6;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .member-info { flex: 1; }
    .member-name { font-weight: 600; font-size: 14px; margin: 0; }
    .member-price { font-size: 13px; color: #555; margin: 2px 0 0 0; }
    .member-stock-badge { font-size: 11px; color: #dc2626; font-weight: 600; }
    .member-check {
      width: 22px; height: 22px;
      border: 2px solid #ccc;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px;
      flex-shrink: 0;
    }
    .member-check.checked { background: #008060; border-color: #008060; color: #fff; }
    .bundle-total {
      padding: 12px;
      background: #f9fafb;
      border-radius: 6px;
      margin-bottom: 16px;
    }
    .total-row { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 4px; }
    .total-row.original { color: #999; text-decoration: line-through; }
    .total-row.discounted { font-weight: 700; font-size: 16px; color: #166534; }
    .total-row.saving { color: #166534; font-size: 13px; }
    .bundle-cta button {
      width: 100%;
      padding: 14px;
      background: #008060;
      color: #fff;
      font-size: 15px;
      font-weight: 700;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .bundle-cta button:disabled {
      background: #9ca3af;
      cursor: not-allowed;
    }
    .bundle-cta button:hover:not(:disabled) { background: #006b4f; }
    .bundle-selection-info {
      text-align: center;
      font-size: 13px;
      color: #666;
      margin-top: 8px;
    }
    .bundle-error {
      color: #dc2626;
      font-size: 13px;
      margin-top: 8px;
      text-align: center;
    }
    .bundle-loading {
      text-align: center;
      color: #888;
      padding: 24px;
    }
    @media (max-width: 600px) {
      .bundle-widget { padding: 14px; }
      .member-card { flex-wrap: wrap; }
    }
  `;
  container.appendChild(style);

  // ─── Root element ────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "bundle-widget";
  container.appendChild(root);

  // ─── Derive bundle_id from URL params ─────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const bundleId = params.get("bundle_id") as BundleId | null;

  if (!bundleId) {
    // No bundle configured — widget gracefully stays invisible
    root.style.display = "none";
    return;
  }

  // ─── State ─────────────────────────────────────────────────────────────────
  let bundleData: WidgetBundleResponse | null = null;
  let selectedVariantIds: Set<string> = new Set();
  let previewTotal: WidgetPreviewTotalResponse | null = null;
  let previewDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isAdding = false;

  // ─── Load bundle ──────────────────────────────────────────────────────────
  async function loadBundle(): Promise<void> {
    showLoading("Loading bundle...");
    try {
      bundleData = (await host.call("/widget/bundle", {
        bundle_id: bundleId,
      })) as WidgetBundleResponse;
      renderBundle();
    } catch {
      // Fall open — don't block page
      root.style.display = "none";
    }
  }

  function showLoading(msg: string): void {
    root.innerHTML = "";
    const p = document.createElement("p");
    p.className = "bundle-loading";
    p.textContent = msg;
    root.appendChild(p);
  }

  // ─── Main render ──────────────────────────────────────────────────────────
  function renderBundle(): void {
    if (!bundleData) return;
    root.innerHTML = "";

    const { bundle, members, tiers } = bundleData;

    // Title
    const titleEl = document.createElement("h3");
    titleEl.className = "bundle-title";
    titleEl.textContent = bundle.title;
    root.appendChild(titleEl);

    // Subtitle
    const subtitleEl = document.createElement("p");
    subtitleEl.className = "bundle-subtitle";
    if (bundle.bundle_type === "flexible") {
      subtitleEl.textContent = `Pick any ${bundle.required_selection_count} items from the selection below`;
    } else {
      subtitleEl.textContent = "Complete bundle — all items included";
    }
    root.appendChild(subtitleEl);

    // Tier badges
    if (tiers.length > 0) {
      const tiersContainer = document.createElement("div");
      tiersContainer.className = "bundle-tiers";
      for (const tier of tiers) {
        const badge = document.createElement("span");
        badge.className = "tier-badge";
        badge.textContent = formatTierLabel(tier, bundle.discount_kind);
        badge.dataset["tierId"] = tier.id;
        tiersContainer.appendChild(badge);
      }
      root.appendChild(tiersContainer);
    }

    // Members list
    const membersContainer = document.createElement("div");
    membersContainer.className = "bundle-members";
    membersContainer.id = "bundle-members-container";
    root.appendChild(membersContainer);

    renderMembers(members, bundle.bundle_type, membersContainer, tiers, bundle.discount_kind);

    // Total section
    const totalSection = document.createElement("div");
    totalSection.className = "bundle-total";
    totalSection.id = "bundle-total-section";
    root.appendChild(totalSection);
    renderTotalSection(totalSection, null);

    // CTA
    const ctaSection = document.createElement("div");
    ctaSection.className = "bundle-cta";
    root.appendChild(ctaSection);

    const addBtn = document.createElement("button");
    addBtn.id = "bundle-add-btn";
    addBtn.textContent = "Add Bundle to Cart";
    addBtn.disabled = true;
    ctaSection.appendChild(addBtn);

    const selectionInfo = document.createElement("div");
    selectionInfo.className = "bundle-selection-info";
    selectionInfo.id = "bundle-selection-info";
    ctaSection.appendChild(selectionInfo);

    const errorEl = document.createElement("div");
    errorEl.className = "bundle-error";
    errorEl.id = "bundle-error";
    ctaSection.appendChild(errorEl);

    // For fixed bundles, pre-select all available members
    if (bundle.bundle_type === "fixed") {
      for (const member of members) {
        if (member.available && member.variant_external_id) {
          selectedVariantIds.add(member.variant_external_id);
        }
      }
    }

    updateUI();

    addBtn.addEventListener("click", handleAddToCart);
  }

  function renderMembers(
    members: MemberWithLiveInfo[],
    bundleType: BundleType,
    membersContainer: HTMLElement,
    tiers: BundleDiscountTierRow[],
    discountKind: DiscountKind
  ): void {
    membersContainer.innerHTML = "";

    for (const member of members) {
      const card = document.createElement("div");
      card.className = "member-card";

      const isUnavailable = !member.available;
      const variantId = member.variant_external_id ?? member.product_external_id;
      const isSelected = selectedVariantIds.has(variantId);
      const isFixed = bundleType === "fixed";

      if (isUnavailable) {
        card.classList.add("unavailable");
      } else if (isFixed) {
        card.classList.add("fixed-item");
      } else if (isSelected) {
        card.classList.add("selected");
      }

      // Image
      if (member.live?.image_url) {
        const img = document.createElement("img");
        img.className = "member-img";
        img.src = member.live.image_url;
        img.alt = member.live.title;
        card.appendChild(img);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "member-img-placeholder";
        card.appendChild(placeholder);
      }

      // Info
      const info = document.createElement("div");
      info.className = "member-info";

      const nameEl = document.createElement("p");
      nameEl.className = "member-name";
      nameEl.textContent = member.live?.title ?? `Product ${member.product_external_id}`;
      info.appendChild(nameEl);

      if (member.live?.price_amount) {
        const priceEl = document.createElement("p");
        priceEl.className = "member-price";
        priceEl.textContent = formatPrice(
          member.live.price_amount,
          member.live.price_currency
        );
        info.appendChild(priceEl);
      }

      if (isUnavailable) {
        const stockBadge = document.createElement("span");
        stockBadge.className = "member-stock-badge";
        stockBadge.textContent = "Out of Stock";
        info.appendChild(stockBadge);
      }

      card.appendChild(info);

      // Check indicator (flexible only)
      if (!isFixed) {
        const check = document.createElement("div");
        check.className = "member-check" + (isSelected && !isUnavailable ? " checked" : "");
        check.textContent = isSelected && !isUnavailable ? "✓" : "";
        card.appendChild(check);
      }

      // Click handler for flexible bundles
      if (!isFixed && !isUnavailable) {
        card.addEventListener("click", () => {
          if (selectedVariantIds.has(variantId)) {
            selectedVariantIds.delete(variantId);
          } else {
            selectedVariantIds.add(variantId);
          }
          // Re-render members to update selection state
          if (bundleData) {
            renderMembers(
              bundleData.members,
              bundleData.bundle.bundle_type,
              membersContainer,
              tiers,
              discountKind
            );
          }
          updateUI();
        });
      }

      membersContainer.appendChild(card);
    }
  }

  function renderTotalSection(
    totalSection: HTMLElement,
    preview: WidgetPreviewTotalResponse | null
  ): void {
    totalSection.innerHTML = "";

    if (!preview) {
      const placeholder = document.createElement("p");
      placeholder.style.cssText = "text-align:center;color:#888;font-size:13px;margin:0;";
      placeholder.textContent = "Select items to see bundle pricing";
      totalSection.appendChild(placeholder);
      return;
    }

    const currency = preview.currency;

    if (preview.original_total !== preview.discounted_total) {
      const originalRow = document.createElement("div");
      originalRow.className = "total-row original";
      const origLabel = document.createElement("span");
      origLabel.textContent = "Original total";
      const origAmount = document.createElement("span");
      origAmount.textContent = formatMinorUnits(preview.original_total, currency);
      originalRow.appendChild(origLabel);
      originalRow.appendChild(origAmount);
      totalSection.appendChild(originalRow);
    }

    const discountedRow = document.createElement("div");
    discountedRow.className = "total-row discounted";
    const discLabel = document.createElement("span");
    discLabel.textContent = preview.original_total !== preview.discounted_total ? "Bundle price" : "Total";
    const discAmount = document.createElement("span");
    discAmount.textContent = formatMinorUnits(preview.discounted_total, currency);
    discountedRow.appendChild(discLabel);
    discountedRow.appendChild(discAmount);
    totalSection.appendChild(discountedRow);

    if (preview.discount_amount > 0) {
      const savingRow = document.createElement("div");
      savingRow.className = "total-row saving";
      const saveLabel = document.createElement("span");
      saveLabel.textContent = "You save";
      const saveAmount = document.createElement("span");
      saveAmount.textContent = formatMinorUnits(preview.discount_amount, currency);
      savingRow.appendChild(saveLabel);
      savingRow.appendChild(saveAmount);
      totalSection.appendChild(savingRow);
    }

    if (preview.tier_matched && bundleData?.bundle.discount_kind === "bxgy") {
      const bxgyNote = document.createElement("p");
      bxgyNote.style.cssText = "font-size:12px;color:#166534;margin:8px 0 0;text-align:center;";
      bxgyNote.textContent = `${preview.tier_matched.free_item_count ?? 1} item(s) free at checkout!`;
      totalSection.appendChild(bxgyNote);
    }
  }

  function updateUI(): void {
    if (!bundleData) return;

    const { bundle, tiers } = bundleData;
    const addBtn = root.querySelector<HTMLButtonElement>("#bundle-add-btn");
    const selectionInfo = root.querySelector<HTMLElement>("#bundle-selection-info");
    const errorEl = root.querySelector<HTMLElement>("#bundle-error");
    const tiersContainer = root.querySelector<HTMLElement>(".bundle-tiers");
    const totalSection = root.querySelector<HTMLElement>("#bundle-total-section");

    if (!addBtn || !selectionInfo || !errorEl) return;
    if (errorEl) errorEl.textContent = "";

    const selCount = selectedVariantIds.size;
    let canAdd = false;

    if (bundle.bundle_type === "flexible") {
      const required = bundle.required_selection_count;
      canAdd = selCount === required;
      selectionInfo.textContent = `${selCount} of ${required} items selected`;
    } else {
      // fixed — check all members are available
      const allAvailable = bundleData.members.every((m) => m.available);
      canAdd = allAvailable && selCount > 0;
      selectionInfo.textContent = allAvailable
        ? `${selCount} item${selCount !== 1 ? "s" : ""} in bundle`
        : "Some items are unavailable";
    }

    addBtn.disabled = !canAdd || isAdding;

    // Update tier badge highlights based on selection count
    if (tiersContainer) {
      tiersContainer.querySelectorAll<HTMLElement>(".tier-badge").forEach((badge) => {
        badge.classList.remove("active");
      });
      // Find best matching tier
      let matchedTier: BundleDiscountTierRow | null = null;
      for (const tier of tiers) {
        if (tier.min_item_count <= selCount) {
          if (!matchedTier || tier.min_item_count > matchedTier.min_item_count) {
            matchedTier = tier;
          }
        }
      }
      if (matchedTier) {
        const matchedBadge = tiersContainer.querySelector<HTMLElement>(
          `[data-tier-id="${matchedTier.id}"]`
        );
        if (matchedBadge) matchedBadge.classList.add("active");
      }
    }

    // Trigger preview total fetch with debounce
    if (selCount > 0) {
      if (previewDebounceTimer !== null) {
        clearTimeout(previewDebounceTimer);
      }
      previewDebounceTimer = setTimeout(() => {
        fetchPreviewTotal(totalSection);
      }, 300);
    } else {
      previewTotal = null;
      if (totalSection) renderTotalSection(totalSection, null);
    }
  }

  async function fetchPreviewTotal(totalSection: HTMLElement | null): Promise<void> {
    if (!bundleData || selectedVariantIds.size === 0) return;
    try {
      previewTotal = (await host.call("/widget/bundle/preview-total", {
        bundle_id: bundleData.bundle.id,
        selected_variant_ids: Array.from(selectedVariantIds),
      })) as WidgetPreviewTotalResponse;
      if (totalSection) renderTotalSection(totalSection, previewTotal);
    } catch {
      // Non-fatal — keep showing old total
    }
  }

  async function handleAddToCart(): Promise<void> {
    if (!bundleData || isAdding) return;

    const errorEl = root.querySelector<HTMLElement>("#bundle-error");
    const addBtn = root.querySelector<HTMLButtonElement>("#bundle-add-btn");
    if (errorEl) errorEl.textContent = "";

    isAdding = true;
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.textContent = "Adding to cart...";
    }

    try {
      const result = (await host.call("/widget/bundle/add-to-cart", {
        bundle_id: bundleData.bundle.id,
        selected_variant_ids: Array.from(selectedVariantIds),
      })) as WidgetAddToCartResponse;

      if (result.errors && result.errors.length > 0) {
        if (errorEl) errorEl.textContent = result.errors.join(". ");
        return;
      }

      if (result.checkout_url) {
        // Navigate to checkout
        location.href = result.checkout_url;
      } else if (result.cart_id) {
        // Redirect to cart page
        location.href = "/cart";
      }
    } catch {
      if (errorEl) errorEl.textContent = "Failed to add bundle to cart. Please try again.";
    } finally {
      isAdding = false;
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = "Add Bundle to Cart";
      }
    }
  }

  // ─── Formatting helpers ───────────────────────────────────────────────────

  function formatTierLabel(tier: BundleDiscountTierRow, discountKind: DiscountKind): string {
    if (discountKind === "percentage" && tier.discount_value) {
      const pct = Math.round(parseFloat(tier.discount_value) * 100);
      return `${tier.min_item_count}+ items: ${pct}% off`;
    } else if (discountKind === "flat_amount" && tier.discount_amount) {
      const major = parseInt(String(tier.discount_amount), 10) / 100;
      return `${tier.min_item_count}+ items: $${major.toFixed(2)} off`;
    } else if (discountKind === "bxgy" && tier.free_item_count) {
      return `Buy ${tier.min_item_count}, get ${tier.free_item_count} free`;
    }
    return `${tier.min_item_count}+ items`;
  }

  function formatPrice(amount: string, currency: string): string {
    const num = parseFloat(amount);
    if (isNaN(num)) return amount;
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).format(num);
  }

  function formatMinorUnits(minorUnits: number, currency: string): string {
    // Determine decimal digits from currency
    const major = minorUnits / 100; // default for 2-decimal currencies
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).format(major);
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  void loadBundle();
}
