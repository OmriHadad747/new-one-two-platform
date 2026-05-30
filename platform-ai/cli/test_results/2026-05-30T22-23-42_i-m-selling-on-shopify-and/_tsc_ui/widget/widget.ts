import type { Host } from "@platform/storefront-sdk";
import type {
  BundleId,
  WidgetBundleSummary,
  WidgetBundleComponent,
  WidgetBundleTierSummary,
  WidgetListBundlesResponse,
  WidgetAddToCartRequest,
  WidgetAddToCartResponse,
  WidgetPreviewTotalRequest,
  WidgetPreviewTotalResponse,
  ShopifyVariantExternalId,
} from "../src/types/contracts.js";

// ─── mount ────────────────────────────────────────────────────────────────────

export function mount(container: HTMLElement, host: Host): void {
  // Inject styles into container (never document.head)
  const style = document.createElement("style");
  style.textContent = `
    .bw-root { font-family: inherit; padding: 16px 0; }
    .bw-bundle { border: 1px solid #e3e3e3; border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
    .bw-bundle-header { background: #f9f9f9; padding: 12px 16px; border-bottom: 1px solid #e3e3e3; }
    .bw-bundle-title { margin: 0; font-size: 16px; font-weight: 700; }
    .bw-bundle-meta { font-size: 13px; color: #6d6d6d; margin: 4px 0 0; }
    .bw-bundle-body { padding: 16px; }
    .bw-component-list { list-style: none; margin: 0 0 12px; padding: 0; }
    .bw-component-item { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
    .bw-component-item:last-child { border-bottom: none; }
    .bw-variant-select { padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; min-width: 160px; }
    .bw-qty-badge { background: #f0f0f0; border-radius: 4px; padding: 2px 8px; font-size: 12px; color: #333; }
    .bw-totals { background: #f9f9f9; border: 1px solid #e3e3e3; border-radius: 6px; padding: 12px 16px; margin: 12px 0; }
    .bw-original-total { font-size: 13px; color: #6d6d6d; text-decoration: line-through; }
    .bw-discounted-total { font-size: 18px; font-weight: 700; color: #008060; }
    .bw-tier-label { font-size: 13px; color: #008060; margin: 4px 0 0; }
    .bw-savings { font-size: 13px; color: #6d6d6d; }
    .bw-tiers { margin: 8px 0; }
    .bw-tier-badge { display: inline-block; font-size: 12px; background: #e3f5ee; color: #008060; border-radius: 12px; padding: 2px 10px; margin: 2px 4px 2px 0; }
    .bw-add-btn { width: 100%; padding: 12px; background: #008060; color: #fff; border: none; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .bw-add-btn:disabled { background: #a0c4b8; cursor: not-allowed; }
    .bw-add-btn:hover:not(:disabled) { background: #006e52; }
    .bw-item-count { font-size: 13px; color: #6d6d6d; margin: 6px 0 4px; }
    .bw-warning { background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 8px 12px; font-size: 13px; color: #856404; margin: 8px 0; }
    .bw-error { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 4px; padding: 8px 12px; font-size: 13px; color: #b91c1c; margin: 8px 0; }
    .bw-success { background: #f0fdf4; border: 1px solid #86efac; border-radius: 4px; padding: 8px 12px; font-size: 13px; color: #166534; margin: 8px 0; }
    .bw-loading { color: #6d6d6d; font-size: 14px; padding: 12px 0; }
    .bw-no-bundles { color: #6d6d6d; font-size: 14px; padding: 8px 0; }
    .bw-pagination { display: flex; gap: 8px; margin-top: 12px; }
    .bw-page-btn { padding: 6px 14px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px; }
    .bw-page-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  `;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = "bw-root";
  container.appendChild(root);

  // Derive product external id from the page URL or data attributes
  // Storefront convention: /products/<handle> — we look for a variant/product form
  // Fall back to a meta tag that Shopify themes set
  const productId = resolveProductId();
  if (!productId) {
    // No product context — widget is not applicable
    return;
  }

  loadBundles(root, host, productId, null);
}

// ─── Resolve product external id from page ────────────────────────────────────

function resolveProductId(): ShopifyVariantExternalId | null {
  // Shopify themes expose product id via a hidden input or data attribute
  const productForm = document.querySelector("form[action*='/cart/add']");
  if (productForm) {
    const idInput = productForm.querySelector("[name='id']") as HTMLInputElement | null;
    if (idInput && /^\d+$/.test(idInput.value)) {
      // This is actually a variant id — use it as product id approximation only
      // In practice, we read product_id from the product JSON script tag
    }
  }

  // Try Shopify's product JSON script tag (most reliable)
  const productJsonEl = document.querySelector("[data-product-json]");
  if (productJsonEl && productJsonEl.textContent) {
    try {
      const parsed = JSON.parse(productJsonEl.textContent) as { id?: number };
      if (parsed.id && typeof parsed.id === "number") {
        return String(parsed.id) as ShopifyVariantExternalId;
      }
    } catch (_) {
      // ignore parse errors
    }
  }

  // Try URL: /products/handle — need product ID from meta
  const metaProductId = document.querySelector("meta[property='og:product:retailer_item_id']") as HTMLMetaElement | null;
  if (metaProductId && /^\d+$/.test(metaProductId.content)) {
    return metaProductId.content as ShopifyVariantExternalId;
  }

  // Try Shopify theme product data attribute
  const sectionEl = document.querySelector("[data-product-id]") as HTMLElement | null;
  if (sectionEl && /^\d+$/.test(sectionEl.dataset["productId"] ?? "")) {
    return (sectionEl.dataset["productId"] ?? "") as ShopifyVariantExternalId;
  }

  return null;
}

// ─── Load bundles from backend ────────────────────────────────────────────────

interface BundlePageState {
  bundles: WidgetBundleSummary[];
  nextCursor: string | null;
  pageCursor: string | null;
  cursorStack: string[];
  totalCount: number;
}

async function loadBundles(
  root: HTMLElement,
  host: Host,
  productId: string,
  cursor: string | null,
): Promise<void> {
  root.innerHTML = "";
  const loading = document.createElement("p");
  loading.className = "bw-loading";
  loading.textContent = "Loading bundles…";
  root.appendChild(loading);

  try {
    const body: Record<string, string> = { product_external_id: productId };
    if (cursor) body["cursor"] = cursor;

    const resp = await host.call("/widget/bundles", body) as WidgetListBundlesResponse;

    root.innerHTML = "";

    if (resp.bundles.length === 0) {
      // No bundles for this product — render nothing (fall open)
      return;
    }

    const pageState: BundlePageState = {
      bundles: resp.bundles,
      nextCursor: resp.next_cursor,
      pageCursor: cursor,
      cursorStack: [],
      totalCount: resp.total_count,
    };

    renderBundles(root, host, productId, pageState);
  } catch (_err) {
    // Fall open: a network failure should not block the shopper
    root.innerHTML = "";
  }
}

// ─── Render all bundles ───────────────────────────────────────────────────────

function renderBundles(
  root: HTMLElement,
  host: Host,
  productId: string,
  pageState: BundlePageState,
): void {
  root.innerHTML = "";

  for (const bundle of pageState.bundles) {
    const el = renderBundle(bundle, host);
    root.appendChild(el);
  }

  // Pagination
  if (pageState.nextCursor || pageState.cursorStack.length > 0) {
    const pagination = document.createElement("div");
    pagination.className = "bw-pagination";

    const prevBtn = document.createElement("button");
    prevBtn.className = "bw-page-btn";
    prevBtn.textContent = "← Previous";
    prevBtn.disabled = pageState.cursorStack.length === 0;
    prevBtn.addEventListener("click", async () => {
      const prev = pageState.cursorStack.pop() ?? null;
      await loadBundles(root, host, productId, prev);
    });

    const nextBtn = document.createElement("button");
    nextBtn.className = "bw-page-btn";
    nextBtn.textContent = "Next →";
    nextBtn.disabled = !pageState.nextCursor;
    nextBtn.addEventListener("click", async () => {
      if (pageState.pageCursor !== null) {
        pageState.cursorStack.push(pageState.pageCursor);
      }
      pageState.pageCursor = pageState.nextCursor;
      await loadBundles(root, host, productId, pageState.nextCursor);
    });

    pagination.appendChild(prevBtn);
    pagination.appendChild(nextBtn);
    root.appendChild(pagination);
  }
}

// ─── Render a single bundle card ──────────────────────────────────────────────

function renderBundle(bundle: WidgetBundleSummary, host: Host): HTMLElement {
  const card = document.createElement("div");
  card.className = "bw-bundle";

  // Header
  const header = document.createElement("div");
  header.className = "bw-bundle-header";

  const titleEl = document.createElement("h3");
  titleEl.className = "bw-bundle-title";
  titleEl.textContent = bundle.title;
  header.appendChild(titleEl);

  const metaEl = document.createElement("p");
  metaEl.className = "bw-bundle-meta";
  const bundleTypeLabel = bundle.bundle_type === "fixed" ? "Fixed bundle" : "Flexible bundle";
  const pickLabel = bundle.bundle_type === "flexible" && bundle.flexible_pick_count
    ? ` — pick any ${bundle.flexible_pick_count}`
    : "";
  metaEl.textContent = `${bundleTypeLabel}${pickLabel}`;
  header.appendChild(metaEl);

  card.appendChild(header);

  // Body
  const body = document.createElement("div");
  body.className = "bw-bundle-body";

  // Tier badges
  if (bundle.tiers.length > 0) {
    const tiersEl = document.createElement("div");
    tiersEl.className = "bw-tiers";
    for (const tier of bundle.tiers) {
      const badge = document.createElement("span");
      badge.className = "bw-tier-badge";
      badge.textContent = formatTierLabel(tier, bundle.discount_kind);
      tiersEl.appendChild(badge);
    }
    body.appendChild(tiersEl);
  }

  // Selected variants tracking (for flexible bundles)
  const selectedVariants: ShopifyVariantExternalId[] = [];

  // Component list
  const compList = document.createElement("ul");
  compList.className = "bw-component-list";

  // For fixed bundles, all components are pre-selected (their pinned variant or default)
  // For flexible bundles, the customer picks from available variants

  if (bundle.bundle_type === "fixed") {
    // Fixed: show all components; use live_variant_gid when set
    for (const comp of bundle.components) {
      const li = buildFixedComponentItem(comp);
      compList.appendChild(li);

      // Pre-select the variant: use variant_external_id when set (not product_external_id)
      if (comp.variant_external_id) {
        for (let i = 0; i < comp.quantity; i++) {
          selectedVariants.push(comp.variant_external_id as ShopifyVariantExternalId);
        }
      }
      // If no variant_external_id, the component is product-level; backend handles
      // — we don't add it to selectedVariants for cart (backend will validate)
    }
  } else {
    // Flexible: show selectors for each slot
    const pickCount = bundle.flexible_pick_count ?? bundle.components.length;

    for (let slot = 0; slot < pickCount; slot++) {
      const li = buildFlexibleSlot(slot, bundle.components, selectedVariants, bundle, body, host);
      compList.appendChild(li);
    }
  }

  body.appendChild(compList);

  // Item count indicator (for flexible bundles)
  const itemCountEl = document.createElement("p");
  itemCountEl.className = "bw-item-count";
  if (bundle.bundle_type === "flexible") {
    const pickCount = bundle.flexible_pick_count ?? bundle.components.length;
    itemCountEl.textContent = `Select ${pickCount} item(s) to unlock bundle pricing`;
    body.appendChild(itemCountEl);
  }

  // Live totals area
  const totalsEl = document.createElement("div");
  totalsEl.className = "bw-totals";
  totalsEl.style.display = "none";
  body.appendChild(totalsEl);

  // Message area
  const msgEl = document.createElement("div");
  body.appendChild(msgEl);

  // Add to cart button
  const addBtn = document.createElement("button");
  addBtn.className = "bw-add-btn";
  addBtn.textContent = "Add Bundle to Cart";

  // For fixed bundles, enable button only if we have variant selections
  // For flexible bundles, enable only when enough variants are selected
  function updateButtonState(): void {
    const pickCount = bundle.bundle_type === "flexible"
      ? (bundle.flexible_pick_count ?? bundle.components.length)
      : bundle.components.length;
    const selCount = selectedVariants.filter((v) => v !== "").length;
    addBtn.disabled = selCount < pickCount;
  }

  updateButtonState();

  // For fixed bundles: pre-trigger a preview if we have all selections
  if (bundle.bundle_type === "fixed" && selectedVariants.length > 0) {
    triggerPreview(bundle, selectedVariants, totalsEl, host);
  }

  addBtn.addEventListener("click", async () => {
    msgEl.innerHTML = "";
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";

    // Get cart token from Shopify Ajax API
    let cartId: string = "";
    try {
      const cartData = await host.storefront("/cart.js") as { token: string };
      cartId = cartData.token;
    } catch (_) {
      // cart.js unavailable — try to proceed with empty cartId (backend may handle)
    }

    const pickCount = bundle.bundle_type === "flexible"
      ? (bundle.flexible_pick_count ?? bundle.components.length)
      : bundle.components.length;

    const filteredVariants = selectedVariants.filter((v) => v !== "") as ShopifyVariantExternalId[];

    if (filteredVariants.length < pickCount) {
      const errEl = document.createElement("div");
      errEl.className = "bw-error";
      errEl.textContent = `Please select ${pickCount} item(s) to complete this bundle.`;
      msgEl.appendChild(errEl);
      addBtn.disabled = false;
      addBtn.textContent = "Add Bundle to Cart";
      return;
    }

    const req: WidgetAddToCartRequest = {
      bundle_id: bundle.id,
      cart_external_id: cartId,
      // Use the validated filteredVariants directly (already numeric strings from backend)
      selected_variant_external_ids: filteredVariants,
      item_count: filteredVariants.length,
    };

    try {
      const resp = await host.call("/widget/bundle/add-to-cart", req) as WidgetAddToCartResponse;

      const successEl = document.createElement("div");
      successEl.className = "bw-success";

      const line1 = document.createElement("strong");
      line1.textContent = "Bundle added to cart!";
      successEl.appendChild(line1);

      if (resp.discount_code) {
        const line2 = document.createElement("p");
        line2.style.margin = "4px 0 0";
        line2.textContent = `Discount code ${resp.discount_code} applied automatically.`;
        successEl.appendChild(line2);
      }

      msgEl.appendChild(successEl);

      // Show warnings
      for (const w of resp.warnings) {
        const warnEl = document.createElement("div");
        warnEl.className = "bw-warning";
        warnEl.textContent = w;
        msgEl.appendChild(warnEl);
      }

      addBtn.textContent = "Add Bundle to Cart";
      addBtn.disabled = false;
    } catch (err) {
      const errEl = document.createElement("div");
      errEl.className = "bw-error";
      errEl.textContent = `Failed to add bundle: ${String(err)}`;
      msgEl.appendChild(errEl);

      addBtn.disabled = false;
      addBtn.textContent = "Add Bundle to Cart";
    }
  });

  body.appendChild(addBtn);
  card.appendChild(body);

  // Helper: preview total
  async function triggerPreview(
    b: WidgetBundleSummary,
    variants: ShopifyVariantExternalId[],
    totals: HTMLElement,
    h: Host,
  ): Promise<void> {
    const valid = variants.filter((v) => v !== "") as ShopifyVariantExternalId[];
    if (valid.length === 0) {
      totals.style.display = "none";
      return;
    }

    try {
      const previewReq: WidgetPreviewTotalRequest = {
        bundle_id: b.id,
        selected_variant_external_ids: valid,
        item_count: valid.length,
      };
      const resp = await h.call("/widget/bundle/preview-total", previewReq) as WidgetPreviewTotalResponse;

      totals.style.display = "block";
      totals.innerHTML = "";

      if (resp.original_total !== resp.discounted_total) {
        const origEl = document.createElement("div");
        origEl.className = "bw-original-total";
        origEl.textContent = formatMinorUnits(resp.original_total);
        totals.appendChild(origEl);
      }

      const discEl = document.createElement("div");
      discEl.className = "bw-discounted-total";
      discEl.textContent = formatMinorUnits(resp.discounted_total);
      totals.appendChild(discEl);

      const labelEl = document.createElement("div");
      labelEl.className = "bw-tier-label";
      labelEl.textContent = resp.tier_label;
      totals.appendChild(labelEl);

      if (resp.discount_amount > 0) {
        const savingsEl = document.createElement("div");
        savingsEl.className = "bw-savings";
        savingsEl.textContent = `You save ${formatMinorUnits(resp.discount_amount)}`;
        totals.appendChild(savingsEl);
      }
    } catch (_) {
      // Best-effort — don't block the UI
      totals.style.display = "none";
    }
  }

  // Attach preview trigger for flexible bundles (after selections change)
  // We store a debounce timeout id
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePreview(): void {
    if (previewTimer !== null) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const validVariants = selectedVariants.filter((v) => v !== "") as ShopifyVariantExternalId[];
      void triggerPreview(bundle, validVariants, totalsEl, host);
      updateButtonState();
    }, 300);
  }

  // Re-render flexible slot selectors attaches this callback via closure
  // We need to pass it to buildFlexibleSlot — rebuild approach:
  if (bundle.bundle_type === "flexible") {
    // Replace compList children with event-connected ones
    compList.innerHTML = "";
    const pickCount2 = bundle.flexible_pick_count ?? bundle.components.length;
    for (let slot = 0; slot < pickCount2; slot++) {
      const li = buildFlexibleSlotWithCallback(
        slot,
        bundle.components,
        selectedVariants,
        schedulePreview,
      );
      compList.appendChild(li);
    }
  }

  return card;
}

// ─── Fixed component item ─────────────────────────────────────────────────────

function buildFixedComponentItem(comp: WidgetBundleComponent): HTMLElement {
  const li = document.createElement("li");
  li.className = "bw-component-item";

  const nameEl = document.createElement("span");
  nameEl.style.flex = "1";

  if (comp.variant_external_id) {
    // Variant-pinned component — display variant info
    // live_variant_gid is set by the backend for this component (non-null)
    nameEl.textContent = `Variant #${comp.variant_external_id}`;
  } else {
    nameEl.textContent = `Product #${comp.product_external_id}`;
  }
  li.appendChild(nameEl);

  const qtyBadge = document.createElement("span");
  qtyBadge.className = "bw-qty-badge";
  qtyBadge.textContent = `×${comp.quantity}`;
  li.appendChild(qtyBadge);

  return li;
}

// ─── Flexible slot (without callback — initial pass) ─────────────────────────

function buildFlexibleSlot(
  slot: number,
  components: WidgetBundleComponent[],
  selectedVariants: ShopifyVariantExternalId[],
  bundle: WidgetBundleSummary,
  body: HTMLElement,
  host: Host,
): HTMLElement {
  return buildFlexibleSlotWithCallback(slot, components, selectedVariants, () => {
    void (async () => {
      const valid = selectedVariants.filter((v) => v !== "") as ShopifyVariantExternalId[];
      if (valid.length === 0) return;
      const previewReq: WidgetPreviewTotalRequest = {
        bundle_id: bundle.id,
        selected_variant_external_ids: valid,
        item_count: valid.length,
      };
      try {
        await host.call("/widget/bundle/preview-total", previewReq);
      } catch (_) { /* ignore */ }
    })();
  });
}

// ─── Flexible slot with explicit callback ─────────────────────────────────────

function buildFlexibleSlotWithCallback(
  slot: number,
  components: WidgetBundleComponent[],
  selectedVariants: ShopifyVariantExternalId[],
  onSelectionChange: () => void,
): HTMLElement {
  const li = document.createElement("li");
  li.className = "bw-component-item";

  const label = document.createElement("span");
  label.style.minWidth = "80px";
  label.style.fontSize = "13px";
  label.style.color = "#6d6d6d";
  label.textContent = `Slot ${slot + 1}:`;
  li.appendChild(label);

  const select = document.createElement("select");
  select.className = "bw-variant-select";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "— Pick an item —";
  select.appendChild(defaultOption);

  // Options: one per component that has a pinned variant
  // For components without a pinned variant, show product-level option
  for (const comp of components) {
    const option = document.createElement("option");
    if (comp.variant_external_id) {
      // Use variant_external_id as the value — it's what we send to the backend
      // live_variant_gid is available on the component from the backend
      // We send variant_external_id (numeric string) to the backend's add-to-cart
      option.value = comp.variant_external_id;
      option.textContent = `Variant #${comp.variant_external_id} (Product #${comp.product_external_id})`;
    } else {
      // Product-level: no specific variant pinned; mark as product option
      // The widget cannot add product-level items without a variant id to cartLinesAdd
      // We indicate this to the user and let the backend handle validation
      option.value = `product:${comp.product_external_id}`;
      option.textContent = `Product #${comp.product_external_id} (select variant separately)`;
      option.disabled = true; // can't add a product without a variant to cart
    }
    select.appendChild(option);
  }

  select.addEventListener("change", () => {
    const val = select.value;
    // Only store numeric variant ids (not "product:" prefixed)
    if (/^\d+$/.test(val)) {
      selectedVariants[slot] = val as ShopifyVariantExternalId;
    } else {
      selectedVariants[slot] = "" as ShopifyVariantExternalId;
    }
    onSelectionChange();
  });

  // Initialize slot
  selectedVariants[slot] = "" as ShopifyVariantExternalId;

  li.appendChild(select);
  return li;
}

// ─── Tier label formatter ─────────────────────────────────────────────────────

function formatTierLabel(tier: WidgetBundleTierSummary, discountKind: string): string {
  if (discountKind === "percentage" && tier.discount_value) {
    const basisPoints = parseInt(tier.discount_value, 10);
    const pct = (basisPoints / 100).toFixed(0);
    return `${tier.min_item_count}+ items: ${pct}% off`;
  }
  if (discountKind === "flat-amount" && tier.discount_amount) {
    const minor = parseInt(tier.discount_amount, 10);
    return `${tier.min_item_count}+ items: ${formatMinorUnits(minor)} off`;
  }
  if (discountKind === "buy-x-get-y" && tier.free_item_count) {
    const buy = tier.min_item_count - tier.free_item_count;
    return `Buy ${buy} get ${tier.free_item_count} free`;
  }
  return `${tier.min_item_count}+ items: discount`;
}

// ─── Money formatter ──────────────────────────────────────────────────────────

function formatMinorUnits(minorUnits: number): string {
  // Assume USD for storefront display; in production this would use host.context.currency
  const major = minorUnits / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(major);
}
