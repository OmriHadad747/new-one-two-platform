import type { Host } from "@platform/storefront-sdk";
import type {
  BundleId,
  BundleType,
  BundleWithDetails,
  BundleItemShape,
  BundleItemVariantShape,
  DiscountTierShape,
  DiscountType,
  WidgetListBundlesResponse,
  WidgetAddToCartRequest,
  WidgetAddToCartResponse,
  VariantMerchandiseGid,
  CartGid,
} from "../src/types/contracts.js";

export function mount(container: HTMLElement, host: Host): void {
  // ── Inject scoped CSS ──────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bw-bundle-widget { font-family: inherit; padding: 16px 0; }
    .bw-bundle-widget * { box-sizing: border-box; }
    .bw-card { border: 1px solid #e1e3e5; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .bw-title { font-size: 16px; font-weight: 700; margin: 0 0 4px; }
    .bw-subtitle { font-size: 13px; color: #6d7175; margin: 0 0 12px; }
    .bw-item-list { list-style: none; padding: 0; margin: 0 0 12px; }
    .bw-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f2f3; }
    .bw-item:last-child { border-bottom: none; }
    .bw-item-title { font-size: 14px; }
    .bw-item-unavailable { color: #6d7175; font-style: italic; }
    .bw-variant-select { font-size: 13px; padding: 4px 8px; border: 1px solid #c4cdd5; border-radius: 4px; }
    .bw-progress { font-size: 13px; color: #008060; font-weight: 600; margin-bottom: 8px; }
    .bw-price-block { background: #f1f2f3; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
    .bw-price-row { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 4px; }
    .bw-price-row.total { font-weight: 700; font-size: 16px; }
    .bw-price-row.discount { color: #008060; }
    .bw-btn { display: block; width: 100%; padding: 12px; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .bw-btn-primary { background: #008060; color: #fff; }
    .bw-btn-primary:disabled { background: #a5b4ac; cursor: not-allowed; }
    .bw-btn-secondary { background: #fff; color: #202223; border: 1px solid #c4cdd5; }
    .bw-toast { position: fixed; bottom: 20px; right: 20px; background: #202223; color: #fff; padding: 12px 20px; border-radius: 6px; font-size: 14px; z-index: 9999; opacity: 0; transition: opacity 0.3s; }
    .bw-toast.visible { opacity: 1; }
    .bw-selector-card { border: 2px solid transparent; border-radius: 8px; padding: 12px; cursor: pointer; }
    .bw-selector-card.selected { border-color: #008060; }
    .bw-step-indicator { font-size: 12px; color: #6d7175; margin-bottom: 8px; }
    .bw-disabled-notice { color: #6d7175; font-size: 13px; font-style: italic; padding: 8px 0; }
  `;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = "bw-bundle-widget";
  container.appendChild(root);

  // ── State ──────────────────────────────────────────────────────────────────
  interface WidgetState {
    step: 1 | 2 | 3;
    bundles: BundleWithDetails[];
    selectedBundleIdx: number;
    // For flexible bundles: variant GIDs selected by customer.
    // Key: bundle_item id, value: chosen variant GID (from live_variant_gid)
    selectedVariants: Map<string, VariantMerchandiseGid>;
    // For fixed bundles: one variant per item (first available)
    fixedVariants: Map<string, VariantMerchandiseGid>;
    loading: boolean;
    error: string | null;
    productExternalId: string | null;
    // Shopify cart GID
    cartId: CartGid | null;
  }

  const state: WidgetState = {
    step: 1,
    bundles: [],
    selectedBundleIdx: 0,
    selectedVariants: new Map(),
    fixedVariants: new Map(),
    loading: false,
    error: null,
    productExternalId: null,
    cartId: null,
  };

  // ── Derive product id from page URL or meta ────────────────────────────────
  function getProductIdFromPage(): string | null {
    // Try meta tag (standard Shopify theme)
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[property="og:url"], meta[name="shopify:product"]'
    );
    if (meta) {
      const content = meta.getAttribute("content") ?? "";
      const match = content.match(/\/products\/([^/?]+)/);
      if (match) return match[1] ?? null; // handle, not numeric id
    }
    // Try pathname
    const pathMatch = location.pathname.match(/\/products\/([^/?]+)/);
    if (pathMatch) return pathMatch[1] ?? null;
    return null;
  }

  // We need numeric product id. Shopify Ajax API's /products/{handle}.js
  // returns the numeric id.
  async function resolveProductId(): Promise<string | null> {
    const handle = getProductIdFromPage();
    if (!handle) return null;
    try {
      const data = (await host.storefront(`/products/${handle}.js`)) as {
        id: number;
        [key: string]: unknown;
      };
      return String(data.id);
    } catch {
      return null;
    }
  }

  // ── Cart resolution ───────────────────────────────────────────────────────
  async function resolveCart(): Promise<CartGid | null> {
    try {
      const cart = (await host.storefront("/cart.js")) as {
        token: string;
        [key: string]: unknown;
      };
      // Shopify cart GID: "gid://shopify/Cart/<token>"
      return `gid://shopify/Cart/${cart.token}` as CartGid;
    } catch {
      return null;
    }
  }

  // ── Tier computation ──────────────────────────────────────────────────────
  function getBestTier(
    tiers: DiscountTierShape[],
    itemCount: number
  ): DiscountTierShape | null {
    // Sort ascending by min_item_count
    const sorted = [...tiers].sort((a, b) => a.min_item_count - b.min_item_count);
    // Best match = highest tier where min_item_count <= itemCount
    // If none match, use the lowest tier as a clamp.
    let best: DiscountTierShape | null = null;
    for (const t of sorted) {
      if (t.min_item_count <= itemCount) {
        best = t;
      }
    }
    if (!best && sorted.length > 0) {
      // Clamp: apply lowest tier even if count doesn't reach it
      best = sorted[0] ?? null;
    }
    return best;
  }

  function formatPrice(cents: number): string {
    return new Intl.NumberFormat(navigator.language, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(cents / 100);
  }

  // ── Resolve sentinel variant GIDs ─────────────────────────────────────────
  // Sentinels are stored for "all" variant mode items when the customer checks them.
  // Format: "__resolve:product:<numericId>"
  // Resolution: call /products/{handle}.js via storefront to get the default variant id.
  // Returns null if any sentinel cannot be resolved.
  async function resolveSentinelGids(
    gids: VariantMerchandiseGid[]
  ): Promise<VariantMerchandiseGid[] | null> {
    const resolved: VariantMerchandiseGid[] = [];
    for (const gid of gids) {
      if (!gid.startsWith("__resolve:product:")) {
        // Already a real GID — use as-is
        resolved.push(gid);
        continue;
      }
      // Extract product numeric id from sentinel
      const productId = gid.replace("__resolve:product:", "");
      // Use search/suggest to find the product handle from its numeric id
      try {
        const suggestResp = (await host.storefront(
          `/search/suggest.json?q=${productId}&resources[type]=product&resources[limit]=1`
        )) as {
          resources?: {
            results?: {
              products?: Array<{ id: number; handle: string; [key: string]: unknown }>;
            };
          };
        };
        const products = suggestResp.resources?.results?.products ?? [];
        const matched = products.find((p) => String(p.id) === productId);
        if (!matched) return null;

        // Fetch product details to get default variant id
        const productData = (await host.storefront(
          `/products/${matched.handle}.js`
        )) as {
          variants?: Array<{ id: number; available: boolean; [key: string]: unknown }>;
          [key: string]: unknown;
        };

        // Pick first available variant, or first variant if none available
        const variants = productData.variants ?? [];
        const defaultVariant =
          variants.find((v) => v.available) ?? variants[0];
        if (!defaultVariant) return null;

        resolved.push(
          `gid://shopify/ProductVariant/${defaultVariant.id}` as VariantMerchandiseGid
        );
      } catch {
        return null;
      }
    }
    return resolved;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render(): void {
    root.innerHTML = "";

    if (state.loading) {
      const p = document.createElement("p");
      p.textContent = "Loading bundles…";
      p.style.color = "#6d7175";
      root.appendChild(p);
      return;
    }

    if (state.bundles.length === 0) {
      // No bundles for this product — render nothing (or empty).
      return;
    }

    if (state.step === 1) renderStep1();
    else if (state.step === 2) renderStep2();
    else renderStep3();
  }

  // ── Step 1: Bundle selector ────────────────────────────────────────────────
  function renderStep1(): void {
    const title = document.createElement("p");
    title.className = "bw-title";
    title.textContent = "Available Bundles";
    root.appendChild(title);

    const stepInd = document.createElement("div");
    stepInd.className = "bw-step-indicator";
    stepInd.textContent = "Step 1 of 3 — Choose a bundle";
    root.appendChild(stepInd);

    state.bundles.forEach((bundle, idx) => {
      const card = document.createElement("div");
      card.className =
        "bw-selector-card" +
        (state.selectedBundleIdx === idx ? " selected" : "");

      const cardTitle = document.createElement("div");
      cardTitle.className = "bw-title";
      cardTitle.textContent = bundle.name;
      card.appendChild(cardTitle);

      const typeLabel = document.createElement("div");
      typeLabel.className = "bw-subtitle";
      const typeText =
        bundle.bundle_type === "fixed"
          ? "Fixed bundle — all items included"
          : `Flexible — pick ${bundle.required_item_count ?? "any"} from ${bundle.items.length} items`;
      typeLabel.textContent = typeText;
      card.appendChild(typeLabel);

      // Check if any items are unavailable
      const unavailableCount = bundle.items.filter((it) => !it.available).length;
      if (unavailableCount > 0) {
        const unavailableNote = document.createElement("div");
        unavailableNote.className = "bw-disabled-notice";
        unavailableNote.textContent = `${unavailableCount} item(s) currently unavailable`;
        card.appendChild(unavailableNote);
      }

      card.addEventListener("click", () => {
        state.selectedBundleIdx = idx;
        render();
      });
      root.appendChild(card);
    });

    const nextBtn = document.createElement("button");
    nextBtn.className = "bw-btn bw-btn-primary";
    nextBtn.textContent = "Configure Bundle →";
    nextBtn.addEventListener("click", () => {
      const bundle = state.bundles[state.selectedBundleIdx];
      if (!bundle) return;

      // Pre-select fixed bundle variants
      if (bundle.bundle_type === "fixed") {
        state.fixedVariants = new Map();
        for (const item of bundle.items) {
          if (!item.available) continue;
          if (item.variant_mode === "specific" && item.variants.length > 0) {
            // Use first specific variant's live_variant_gid
            const firstVariant = item.variants[0];
            if (firstVariant) {
              state.fixedVariants.set(item.id, firstVariant.live_variant_gid);
            }
          } else if (item.variant_mode === "all") {
            // "all" mode: no pre-selected variant GID available from backend.
            // Widget will need to resolve via /products/{handle}.js if needed.
            // For cart: store a placeholder — the actual variant will be chosen via storefront.
            // We store the product external id tagged so we can resolve later.
            // NOTE: we do NOT use product_external_id as a variant GID — that breaks cartCreate.
            // Instead, mark that we need to resolve the default variant.
            // We'll resolve in step 3 (reviewable) or when adding to cart.
          }
        }
      } else {
        state.selectedVariants = new Map();
      }

      state.step = 2;
      render();
    });
    root.appendChild(nextBtn);
  }

  // ── Step 2: Item configuration ─────────────────────────────────────────────
  function renderStep2(): void {
    const bundle = state.bundles[state.selectedBundleIdx];
    if (!bundle) {
      state.step = 1;
      render();
      return;
    }

    const stepInd = document.createElement("div");
    stepInd.className = "bw-step-indicator";
    stepInd.textContent = `Step 2 of 3 — ${bundle.bundle_type === "fixed" ? "Review items" : "Select items"}`;
    root.appendChild(stepInd);

    const title = document.createElement("div");
    title.className = "bw-title";
    title.textContent = bundle.name;
    root.appendChild(title);

    if (bundle.bundle_type === "flexible") {
      // Progress indicator
      const required = bundle.required_item_count ?? bundle.items.length;
      const selectedCount = state.selectedVariants.size;
      const progressDiv = document.createElement("div");
      progressDiv.className = "bw-progress";
      progressDiv.textContent = `${selectedCount} of ${required} items selected`;
      root.appendChild(progressDiv);
    }

    // Items list
    const list = document.createElement("ul");
    list.className = "bw-item-list";

    for (const item of bundle.items) {
      const li = document.createElement("li");
      li.className = "bw-item";

      const nameDiv = document.createElement("div");
      nameDiv.className = "bw-item-title";

      if (!item.available) {
        nameDiv.className += " bw-item-unavailable";
        const productLabel = document.createTextNode(`Product #${item.product_external_id} — `);
        nameDiv.appendChild(productLabel);
        const unavailableSpan = document.createElement("span");
        unavailableSpan.textContent = "Unavailable";
        nameDiv.appendChild(unavailableSpan);
        li.appendChild(nameDiv);
        list.appendChild(li);
        continue;
      }

      const productText = document.createTextNode(`Product #${item.product_external_id}`);
      nameDiv.appendChild(productText);
      li.appendChild(nameDiv);

      if (bundle.bundle_type === "fixed") {
        // For fixed bundles: show which variants are included
        if (item.variant_mode === "specific" && item.variants.length > 0) {
          const variantList = document.createElement("div");
          variantList.style.fontSize = "12px";
          variantList.style.color = "#6d7175";
          variantList.textContent = `${item.variants.length} variant(s) included`;
          li.appendChild(variantList);
        } else {
          const variantNote = document.createElement("div");
          variantNote.style.fontSize = "12px";
          variantNote.style.color = "#6d7175";
          variantNote.textContent = "All variants";
          li.appendChild(variantNote);
        }
      } else {
        // Flexible: customer picks a variant
        if (item.variant_mode === "specific" && item.variants.length > 0) {
          // Dropdown of available specific variants — using live_variant_gid
          const select = document.createElement("select");
          select.className = "bw-variant-select";

          const defaultOpt = document.createElement("option");
          defaultOpt.value = "";
          defaultOpt.textContent = "— Select —";
          select.appendChild(defaultOpt);

          for (const v of item.variants) {
            const opt = document.createElement("option");
            // CRITICAL: use live_variant_gid (returned by backend), NOT built from variant_external_id
            opt.value = v.live_variant_gid;
            opt.textContent = `Variant #${v.variant_external_id}`;
            opt.selected = state.selectedVariants.get(item.id) === v.live_variant_gid;
            select.appendChild(opt);
          }

          select.addEventListener("change", () => {
            if (select.value) {
              state.selectedVariants.set(item.id, select.value as VariantMerchandiseGid);
            } else {
              state.selectedVariants.delete(item.id);
            }
            render();
          });
          li.appendChild(select);
        } else {
          // "all" variant mode for flexible — show a checkbox to include
          const checkLabel = document.createElement("label");
          checkLabel.style.display = "flex";
          checkLabel.style.alignItems = "center";
          checkLabel.style.gap = "6px";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = state.selectedVariants.has(item.id);
          // For "all" variant mode we don't have a specific GID from the backend
          // (no specific variants returned). We mark this item with a placeholder
          // that signals "include default variant". The actual variant selection
          // happens server-side when we POST add-to-cart.
          // We CANNOT build a GID here — we don't have a variant_external_id.
          // So we track selected item.id, and send the bundle_item_id to the backend.
          // The backend's widget route will resolve the actual variant.
          // NOTE: this is an "all" mode item — we send it as a selected item.
          // The backend add-to-cart receives selected_variant_ids as GIDs, so
          // for "all" mode items we need to resolve a variant GID first.
          // We'll use storefront to get the product's default variant.
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              // Store a sentinel — we'll resolve actual GID before submission
              state.selectedVariants.set(
                item.id,
                `__resolve:product:${item.product_external_id}` as VariantMerchandiseGid
              );
            } else {
              state.selectedVariants.delete(item.id);
            }
            render();
          });
          checkLabel.appendChild(checkbox);
          const checkText = document.createTextNode("Include this product");
          checkLabel.appendChild(checkText);
          li.appendChild(checkLabel);
        }
      }

      list.appendChild(li);
    }

    root.appendChild(list);

    const btnRow = document.createElement("div");

    const backBtn = document.createElement("button");
    backBtn.className = "bw-btn bw-btn-secondary";
    backBtn.textContent = "← Back";
    backBtn.addEventListener("click", () => {
      state.step = 1;
      render();
    });
    btnRow.appendChild(backBtn);

    // For flexible: check count met
    const isFlexible = bundle.bundle_type === "flexible";
    const required = isFlexible ? (bundle.required_item_count ?? bundle.items.length) : 0;
    const selectedCount = state.selectedVariants.size;
    const countMet = !isFlexible || selectedCount >= required;

    const reviewBtn = document.createElement("button");
    reviewBtn.className = "bw-btn bw-btn-primary";
    reviewBtn.textContent = "Review & Price →";
    reviewBtn.disabled = !countMet;
    reviewBtn.addEventListener("click", () => {
      state.step = 3;
      render();
    });
    btnRow.appendChild(reviewBtn);

    root.appendChild(btnRow);
  }

  // ── Step 3: Price summary + add to cart ────────────────────────────────────
  function renderStep3(): void {
    const bundle = state.bundles[state.selectedBundleIdx];
    if (!bundle) {
      state.step = 1;
      render();
      return;
    }

    const stepInd = document.createElement("div");
    stepInd.className = "bw-step-indicator";
    stepInd.textContent = "Step 3 of 3 — Review & Add to Cart";
    root.appendChild(stepInd);

    const title = document.createElement("div");
    title.className = "bw-title";
    title.textContent = bundle.name;
    root.appendChild(title);

    // Compute selected variants list for the add-to-cart call.
    let selectedGids: VariantMerchandiseGid[] = [];
    if (bundle.bundle_type === "fixed") {
      // Fixed: use the specific variant GIDs that were pre-selected
      for (const item of bundle.items) {
        if (!item.available) continue;
        if (item.variant_mode === "specific" && item.variants.length > 0) {
          const firstVariant = item.variants[0];
          if (firstVariant) {
            selectedGids.push(firstVariant.live_variant_gid);
          }
        }
        // "all" mode for fixed bundles: skip items without explicit variant GIDs
        // (we cannot build a GID from a product id)
      }
    } else {
      // Flexible: use selectedVariants, filtering out resolve sentinels
      // (sentinels for "all" mode items will be resolved at submit time)
      selectedGids = Array.from(state.selectedVariants.values()).filter((gid) =>
        gid.startsWith("gid://shopify/ProductVariant/")
      );
    }

    const itemCount = selectedGids.length;
    const tier = getBestTier(bundle.discount_tiers, itemCount);

    // Price block — we show the item count and discount info.
    // We don't have per-item prices from our backend (products pricing is
    // live from Shopify). Show discount info only.
    const priceBlock = document.createElement("div");
    priceBlock.className = "bw-price-block";

    const itemCountRow = document.createElement("div");
    itemCountRow.className = "bw-price-row";
    const itemCountLabel = document.createElement("span");
    itemCountLabel.textContent = "Items selected:";
    itemCountRow.appendChild(itemCountLabel);
    const itemCountVal = document.createElement("span");
    itemCountVal.textContent = String(itemCount);
    itemCountRow.appendChild(itemCountVal);
    priceBlock.appendChild(itemCountRow);

    if (tier) {
      const discountRow = document.createElement("div");
      discountRow.className = "bw-price-row discount";
      const discLabel = document.createElement("span");
      discLabel.textContent = "Discount:";
      discountRow.appendChild(discLabel);
      const discVal = document.createElement("span");
      if (tier.is_bxgy) {
        discVal.textContent = "Buy X, Get 1 Free";
      } else if (bundle.discount_type === "percentage" && tier.discount_ratio) {
        const pct = Math.round(parseFloat(tier.discount_ratio) * 100);
        discVal.textContent = `${pct}% off`;
      } else if (bundle.discount_type === "flat" && tier.discount_amount !== null) {
        discVal.textContent = `${formatPrice(parseInt(tier.discount_amount, 10))} off`;
      } else {
        discVal.textContent = "Discount applied at checkout";
      }
      discountRow.appendChild(discVal);
      priceBlock.appendChild(discountRow);
    } else {
      const noTierRow = document.createElement("div");
      noTierRow.className = "bw-price-row";
      const noTierLabel = document.createElement("span");
      noTierLabel.textContent = "Discount applies at checkout";
      noTierRow.appendChild(noTierLabel);
      priceBlock.appendChild(noTierRow);
    }

    root.appendChild(priceBlock);

    // Bundle note about discount code
    if (bundle.discount_code_string) {
      const codeNote = document.createElement("div");
      codeNote.style.fontSize = "12px";
      codeNote.style.color = "#6d7175";
      codeNote.style.marginBottom = "8px";
      const noteText = document.createTextNode("Discount code ");
      codeNote.appendChild(noteText);
      const codeSpan = document.createElement("strong");
      codeSpan.textContent = bundle.discount_code_string;
      codeNote.appendChild(codeSpan);
      const noteText2 = document.createTextNode(" will be applied automatically.");
      codeNote.appendChild(noteText2);
      root.appendChild(codeNote);
    }

    // Add to cart button
    // For flexible, require selectedGids based on valid GIDs (not sentinels).
    const isFlexible = bundle.bundle_type === "flexible";
    const required = isFlexible ? (bundle.required_item_count ?? bundle.items.filter((i) => i.available).length) : 0;
    const validGidCount = selectedGids.length;
    const canAddToCart = !isFlexible || validGidCount >= required;

    const addBtn = document.createElement("button");
    addBtn.className = "bw-btn bw-btn-primary";
    addBtn.textContent = "Add Bundle to Cart";
    addBtn.disabled = !canAddToCart;
    addBtn.addEventListener("click", async () => {
      addBtn.disabled = true;
      addBtn.textContent = "Resolving items…";

      // Resolve any sentinel placeholders for "all" variant mode items.
      // Sentinels look like "__resolve:product:<numericId>".
      const resolvedGids = await resolveSentinelGids(
        Array.from(state.selectedVariants.values())
      );

      addBtn.disabled = false;
      addBtn.textContent = "Add Bundle to Cart";

      if (resolvedGids === null) {
        showToast("Could not resolve product variants. Please try again.", true);
        return;
      }

      // For fixed bundles, use fixed selectedGids directly.
      const finalGids = bundle.bundle_type === "fixed" ? selectedGids : resolvedGids;
      await handleAddToCart(bundle, finalGids);
    });
    root.appendChild(addBtn);

    const backBtn = document.createElement("button");
    backBtn.className = "bw-btn bw-btn-secondary";
    backBtn.textContent = "← Back";
    backBtn.addEventListener("click", () => {
      state.step = 2;
      render();
    });
    root.appendChild(backBtn);
  }

  // ── Add to cart handler ────────────────────────────────────────────────────
  async function handleAddToCart(
    bundle: BundleWithDetails,
    selectedGids: VariantMerchandiseGid[]
  ): Promise<void> {
    if (selectedGids.length === 0) return;

    // Resolve cart id
    const cartId = state.cartId ?? (await resolveCart());
    if (!cartId) {
      showToast("Could not resolve cart. Please refresh and try again.", true);
      return;
    }
    state.cartId = cartId;

    // Show loading state on button
    const addBtn = root.querySelector<HTMLButtonElement>(".bw-btn-primary");
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.textContent = "Adding…";
    }

    try {
      const reqBody: WidgetAddToCartRequest = {
        bundle_id: bundle.id,
        cart_external_id: cartId,
        selected_variant_ids: selectedGids,
      };

      const resp = (await host.call(
        "/widget/bundles/add-to-cart",
        reqBody
      )) as WidgetAddToCartResponse;

      if (resp.status === "ok") {
        const msg = resp.discount_applied
          ? "Bundle added! Discount applied at checkout."
          : "Bundle added to cart!";
        showToast(msg, false);
        // Reset state
        state.step = 1;
        state.selectedVariants = new Map();
        state.fixedVariants = new Map();
        state.cartId = resp.cart_external_id;
        render();
      } else {
        showToast(resp.error ?? "Failed to add bundle to cart.", true);
        if (addBtn) {
          addBtn.disabled = false;
          addBtn.textContent = "Add Bundle to Cart";
        }
      }
    } catch (err: unknown) {
      showToast("An error occurred. Please try again.", true);
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = "Add Bundle to Cart";
      }
    }
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function showToast(message: string, isError: boolean): void {
    const toast = document.createElement("div");
    toast.className = "bw-toast";
    toast.textContent = message;
    if (isError) toast.style.background = "#d72c0d";
    container.appendChild(toast);
    // Trigger animation
    setTimeout(() => toast.classList.add("visible"), 10);
    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 3000);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function init(): Promise<void> {
    state.loading = true;
    render();

    try {
      const productId = await resolveProductId();
      if (!productId) {
        // Not a product page — render nothing
        root.innerHTML = "";
        return;
      }
      state.productExternalId = productId;

      const resp = (await host.call("/widget/bundles", {
        product_external_id: productId,
      })) as WidgetListBundlesResponse;

      state.bundles = resp.bundles;

      // Pre-select if only one bundle
      if (state.bundles.length === 1) {
        state.selectedBundleIdx = 0;
      }

      state.loading = false;

      if (state.bundles.length === 0) {
        root.innerHTML = "";
        return;
      }

      render();
    } catch {
      // Fall open — don't block the customer's page
      state.loading = false;
      root.innerHTML = "";
    }
  }

  init();
}
