import type { Host } from "@platform/storefront-sdk";
import type {
  WidgetAvailabilityResponse,
  WidgetSignupStatusResponse,
  WidgetSignupResponse,
  WidgetUnsubscribeResponse,
  SignupLevel,
} from "../src/types/contracts.js";

export function mount(container: HTMLElement, host: Host): void {
  // ── CSS ─────────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bis-widget { margin: 12px 0; font-size: 14px; }
    .bis-widget.hidden { display: none; }
    .bis-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; }
    .bis-email-input {
      flex: 1 1 200px;
      padding: 8px 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 14px;
    }
    .bis-email-input.error { border-color: #d82c0d; }
    .bis-submit-btn {
      padding: 8px 16px;
      background: #008060;
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      white-space: nowrap;
    }
    .bis-submit-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .bis-msg { margin-top: 8px; font-size: 13px; }
    .bis-msg.success { color: #008060; }
    .bis-msg.error { color: #d82c0d; }
    .bis-already { color: var(--color-foreground, #333); font-size: 13px; }
    .bis-label { display: block; margin-bottom: 6px; color: var(--color-foreground, #333); }
  `;
  container.appendChild(style);

  // ── Root element ──────────────────────────────────────────────────────────
  const widget = document.createElement("div");
  widget.className = "bis-widget hidden";
  container.appendChild(widget);

  // ── Read page context ──────────────────────────────────────────────────────
  // The product id and variant id come from Shopify's page globals or URL params.
  // We read from document.querySelector to find the Shopify form data.
  let productIdStr: string | null = null;
  let variantIdStr: string | null = null;
  let signupLevel: SignupLevel = "product";
  let itemDisplayName: string = "";
  let itemPageUrl: string = window.location.href;

  // Read product id from a hidden input or meta — common Shopify theme pattern
  const productForm = document.querySelector<HTMLFormElement>("form[action='/cart/add']");
  if (productForm) {
    const productIdInput = productForm.querySelector<HTMLInputElement>("input[name='product-id'], [data-product-id]");
    if (productIdInput) {
      productIdStr = productIdInput.dataset["productId"] ?? productIdInput.value ?? null;
    }
    const variantInput = productForm.querySelector<HTMLInputElement>("input[name='id']");
    if (variantInput) {
      variantIdStr = variantInput.value || null;
    }
  }

  // Fallback: read from URL path /products/{handle} or window.ShopifyAnalytics
  if (!productIdStr) {
    const shopifyMeta = document.querySelector<HTMLElement>("[data-product-id]");
    if (shopifyMeta) {
      productIdStr = shopifyMeta.dataset["productId"] ?? null;
    }
  }

  if (!productIdStr) {
    // Cannot determine product — widget stays hidden
    return;
  }

  // Validate: product id must be numeric
  if (!/^\d+$/.test(productIdStr)) {
    return;
  }

  if (variantIdStr && !/^\d+$/.test(variantIdStr)) {
    variantIdStr = null;
  }

  // Determine signup level
  signupLevel = variantIdStr ? "variant" : "product";

  // Try to read item display name from page
  const titleEl = document.querySelector<HTMLElement>(".product__title h1, .product-single__title, h1.title");
  if (titleEl) {
    itemDisplayName = titleEl.textContent?.trim() ?? "";
  }

  // ── Check availability ─────────────────────────────────────────────────────

  function checkAndRender(): void {
    if (!productIdStr) return;

    const availReq: Record<string, string> = { product_id: productIdStr };
    if (variantIdStr) {
      availReq["variant_id"] = variantIdStr;
    }

    host.call("/widget/availability", availReq).then((raw) => {
      const data = raw as WidgetAvailabilityResponse;

      if (data.available) {
        // Item is in stock — widget should not appear
        widget.classList.add("hidden");
        return;
      }

      // Use the backend's signup_level (it knows best)
      signupLevel = data.signup_level;

      // Render form or already-signed-up state
      renderForm();
      widget.classList.remove("hidden");
    }).catch(() => {
      // Fall open on failure — don't show widget
      widget.classList.add("hidden");
    });
  }

  // ── Render form ───────────────────────────────────────────────────────────

  function renderForm(): void {
    widget.innerHTML = "";

    const label = document.createElement("label");
    label.className = "bis-label";
    label.textContent = "Notify me when back in stock:";
    widget.appendChild(label);

    const form = document.createElement("div");
    form.className = "bis-form";

    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.className = "bis-email-input";
    emailInput.placeholder = "Enter your email";
    emailInput.autocomplete = "email";
    emailInput.setAttribute("aria-label", "Email address for back-in-stock notification");

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "bis-submit-btn";
    submitBtn.textContent = "Notify Me";

    const msgEl = document.createElement("div");
    msgEl.className = "bis-msg";

    form.appendChild(emailInput);
    form.appendChild(submitBtn);
    widget.appendChild(form);
    widget.appendChild(msgEl);

    // ── Handle submit ──────────────────────────────────────────────────────

    function setMsg(text: string, kind: "success" | "error"): void {
      msgEl.className = "bis-msg " + kind;
      msgEl.textContent = text;
    }

    function clearMsg(): void {
      msgEl.textContent = "";
      msgEl.className = "bis-msg";
    }

    submitBtn.addEventListener("click", () => {
      const email = emailInput.value.trim();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        emailInput.classList.add("error");
        setMsg("Please enter a valid email address.", "error");
        return;
      }
      emailInput.classList.remove("error");
      clearMsg();

      submitBtn.disabled = true;
      submitBtn.textContent = "Signing up…";

      if (!productIdStr) {
        setMsg("Unable to identify product.", "error");
        submitBtn.disabled = false;
        submitBtn.textContent = "Notify Me";
        return;
      }

      if (!itemDisplayName) {
        setMsg("Unable to identify the product. Please try refreshing the page.", "error");
        submitBtn.disabled = false;
        submitBtn.textContent = "Notify Me";
        return;
      }

      const safeDisplayName = itemDisplayName;

      const signupBody: Record<string, string> = {
        product_id: productIdStr,
        email,
        item_display_name: safeDisplayName,
        item_page_url: itemPageUrl,
        signup_level: signupLevel,
      };
      if (variantIdStr) {
        signupBody["variant_id"] = variantIdStr;
      }

      host.call("/widget/signup", signupBody).then((raw) => {
        const result = raw as WidgetSignupResponse;
        submitBtn.disabled = false;
        submitBtn.textContent = "Notify Me";

        if (result.already_signed_up) {
          renderAlreadySignedUp();
        } else if (result.success) {
          renderConfirmation();
        } else {
          setMsg("Something went wrong. Please try again.", "error");
        }
      }).catch(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = "Notify Me";
        setMsg("Failed to submit. Please try again.", "error");
      });
    });

    // Allow enter key to submit
    emailInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        submitBtn.click();
      }
    });
  }

  function renderConfirmation(): void {
    widget.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "bis-msg success";
    msg.textContent = "✓ You're on the list! We'll email you when this item is back in stock.";
    widget.appendChild(msg);
  }

  function renderAlreadySignedUp(): void {
    widget.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "bis-already";
    msg.textContent = "✓ You're already on the waitlist for this item.";
    widget.appendChild(msg);
  }

  // ── Listen for variant changes ─────────────────────────────────────────────
  // Many themes dispatch a custom event when the variant selector changes.

  document.addEventListener("variant:changed", (e: Event) => {
    const customEvent = e as CustomEvent<{ variant?: { id?: number | string; available?: boolean } }>;
    const variant = customEvent.detail?.variant;
    if (variant) {
      const newVariantId = variant.id !== undefined ? String(variant.id) : null;
      if (newVariantId && /^\d+$/.test(newVariantId)) {
        variantIdStr = newVariantId;
        signupLevel = "variant";
      }
      widget.classList.add("hidden");
      widget.innerHTML = "";
      // Re-check availability for the newly selected variant
      setTimeout(() => checkAndRender(), 50);
    }
  });

  // Also listen for standard Shopify input change on variant selector
  const variantSelect = document.querySelector<HTMLSelectElement>("select[name='id']");
  if (variantSelect) {
    variantSelect.addEventListener("change", () => {
      const newVal = variantSelect.value;
      if (newVal && /^\d+$/.test(newVal)) {
        variantIdStr = newVal;
        signupLevel = "variant";
        widget.classList.add("hidden");
        widget.innerHTML = "";
        setTimeout(() => checkAndRender(), 50);
      }
    });
  }

  // ── Initial render ────────────────────────────────────────────────────────
  checkAndRender();
}
