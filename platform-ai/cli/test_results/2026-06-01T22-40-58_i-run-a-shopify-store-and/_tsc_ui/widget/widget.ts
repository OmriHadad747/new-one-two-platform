import type { Host } from "@platform/storefront-sdk";
import type {
  ItemScope,
  WidgetAvailabilityResponse,
  WidgetSignupCheckResponse,
  WidgetSignupResponse,
  WidgetUnsubscribeResponse,
} from "../src/types/contracts.js";

export function mount(container: HTMLElement, host: Host): void {
  // ─── Inject scoped styles ────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bis-widget { font-family: inherit; margin: 8px 0; }
    .bis-widget--hidden { display: none; }
    .bis-form { display: flex; flex-direction: column; gap: 8px; }
    .bis-form input[type="email"] {
      padding: 10px 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 1rem;
      width: 100%;
      box-sizing: border-box;
    }
    .bis-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 1rem;
      background: #008060;
      color: #fff;
    }
    .bis-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .bis-confirm { color: #008060; font-weight: 600; margin: 0; }
    .bis-queue { color: #555; font-size: 0.9rem; margin: 4px 0 0; }
    .bis-error { color: #c00; margin: 4px 0 0; }
    .bis-unsubscribe-btn {
      background: none; border: none; padding: 0; color: #555;
      font-size: 0.8rem; cursor: pointer; text-decoration: underline;
    }
  `;
  container.appendChild(style);

  // ─── Root widget wrapper ─────────────────────────────────────────────────
  const widget = document.createElement("div");
  widget.className = "bis-widget bis-widget--hidden";
  container.appendChild(widget);

  // ─── Read page context ───────────────────────────────────────────────────
  // The widget reads item context from the page URL search params or
  // data attributes the merchant's theme passes to the app block.
  // Convention: the theme passes data-item-external-id and data-item-scope
  // via app block settings, or we fall back to parsing the URL.

  function getItemContext(): {
    itemExternalId: number;
    productExternalId: number;
    itemScope: ItemScope;
  } | null {
    // Try data attributes on the container
    const itemIdAttr = container.dataset.itemExternalId;
    const productIdAttr = container.dataset.productExternalId;
    const scopeAttr = container.dataset.itemScope;

    if (itemIdAttr && productIdAttr && (scopeAttr === "variant" || scopeAttr === "product")) {
      const itemId = parseInt(itemIdAttr, 10);
      const productId = parseInt(productIdAttr, 10);
      if (!isNaN(itemId) && !isNaN(productId)) {
        return { itemExternalId: itemId, productExternalId: productId, itemScope: scopeAttr };
      }
    }

    // Fallback: read from URL search params
    const params = new URLSearchParams(location.search);
    const variantParam = params.get("variant");
    if (variantParam) {
      const variantId = parseInt(variantParam, 10);
      if (!isNaN(variantId)) {
        // Try to extract product id from URL path: /products/<handle> is common
        // but we don't have product id from URL — look for data-product-id on page
        const productEl = document.querySelector<HTMLElement>("[data-product-id]");
        const productId = productEl ? parseInt(productEl.dataset.productId ?? "", 10) : NaN;
        if (!isNaN(productId)) {
          return { itemExternalId: variantId, productExternalId: productId, itemScope: "variant" };
        }
      }
    }

    return null;
  }

  // ─── Render states ───────────────────────────────────────────────────────

  function renderLoading(): void {
    widget.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = "Checking availability…";
    widget.appendChild(p);
  }

  function renderForm(
    itemExternalId: number,
    productExternalId: number,
    itemScope: ItemScope,
    itemTitle: string,
    prefillEmail: string | null,
    initialQueuePos: number | null,
  ): void {
    widget.innerHTML = "";

    if (initialQueuePos !== null) {
      // Already signed up
      renderAlreadySignedUp(itemTitle, initialQueuePos, itemExternalId, itemScope);
      return;
    }

    const formEl = document.createElement("form");
    formEl.className = "bis-form";
    formEl.noValidate = true;

    const label = document.createElement("label");
    const labelText = document.createTextNode("Notify me when ");
    const strong = document.createElement("strong");
    strong.textContent = itemTitle;
    const trailText = document.createTextNode(" is back in stock:");
    label.appendChild(labelText);
    label.appendChild(strong);
    label.appendChild(trailText);
    formEl.appendChild(label);

    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.placeholder = "your@email.com";
    emailInput.required = true;
    emailInput.name = "email";
    if (prefillEmail) emailInput.value = prefillEmail;
    formEl.appendChild(emailInput);

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "bis-btn";
    submitBtn.textContent = "Notify Me";
    formEl.appendChild(submitBtn);

    const errorMsg = document.createElement("p");
    errorMsg.className = "bis-error";
    errorMsg.style.display = "none";
    formEl.appendChild(errorMsg);

    formEl.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (!email) {
        errorMsg.textContent = "Please enter your email address.";
        errorMsg.style.display = "";
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Signing up…";
      errorMsg.style.display = "none";

      try {
        const resp = (await host.call("/widget/signup", {
          email,
          item_external_id: String(itemExternalId),
          item_scope: itemScope,
          product_external_id: String(productExternalId),
        })) as WidgetSignupResponse;

        if (resp.success) {
          renderConfirmed(itemTitle, resp.queue_position, email, itemExternalId, itemScope);
        } else {
          errorMsg.textContent = "Something went wrong. Please try again.";
          errorMsg.style.display = "";
          submitBtn.disabled = false;
          submitBtn.textContent = "Notify Me";
        }
      } catch {
        errorMsg.textContent = "Something went wrong. Please try again.";
        errorMsg.style.display = "";
        submitBtn.disabled = false;
        submitBtn.textContent = "Notify Me";
      }
    });

    widget.appendChild(formEl);
  }

  function renderAlreadySignedUp(
    itemTitle: string,
    queuePosition: number,
    itemExternalId: number,
    itemScope: ItemScope,
  ): void {
    widget.innerHTML = "";

    const msg = document.createElement("p");
    msg.className = "bis-confirm";
    msg.textContent = `You're on the waitlist for "${itemTitle}"!`;
    widget.appendChild(msg);

    const queueMsg = document.createElement("p");
    queueMsg.className = "bis-queue";
    queueMsg.textContent = `You are #${queuePosition} in the queue.`;
    widget.appendChild(queueMsg);
  }

  function renderConfirmed(
    itemTitle: string,
    queuePosition: number,
    email: string,
    itemExternalId: number,
    itemScope: ItemScope,
  ): void {
    widget.innerHTML = "";

    const msg = document.createElement("p");
    msg.className = "bis-confirm";
    const confirmText = document.createTextNode(`We'll notify you at `);
    const emailStrong = document.createElement("strong");
    emailStrong.textContent = email;
    const trailText = document.createTextNode(` when ${itemTitle} is back in stock.`);
    msg.appendChild(confirmText);
    msg.appendChild(emailStrong);
    msg.appendChild(trailText);
    widget.appendChild(msg);

    const queueMsg = document.createElement("p");
    queueMsg.className = "bis-queue";
    queueMsg.textContent = `You are #${queuePosition} in the queue.`;
    widget.appendChild(queueMsg);
  }

  // ─── Main boot ───────────────────────────────────────────────────────────
  async function boot(): Promise<void> {
    const ctx = getItemContext();
    if (!ctx) {
      // No item context — do not render the widget
      return;
    }

    const { itemExternalId, productExternalId, itemScope } = ctx;

    // Check availability (fall open on failure)
    let availResp: WidgetAvailabilityResponse;
    try {
      availResp = (await host.call("/widget/availability", {
        item_external_id: String(itemExternalId),
        item_scope: itemScope,
      })) as WidgetAvailabilityResponse;
    } catch {
      // Fall open — default to not showing the widget if we can't determine stock
      return;
    }

    if (!availResp.sold_out) {
      // Item is in stock — do not render
      return;
    }

    // Item is sold out — show the widget
    widget.classList.remove("bis-widget--hidden");
    renderLoading();

    // Check if this shopper is already signed up (best-effort by checking localStorage for email)
    const storedEmail = localStorage.getItem("bis.email");

    if (storedEmail) {
      let checkResp: WidgetSignupCheckResponse | null = null;
      try {
        checkResp = (await host.call("/widget/signup", {
          email: storedEmail,
          item_external_id: String(itemExternalId),
          item_scope: itemScope,
        })) as WidgetSignupCheckResponse;
      } catch {
        // Fall open — show the form
      }

      if (checkResp?.already_signed_up) {
        renderAlreadySignedUp(
          availResp.item_title,
          checkResp.queue_position ?? 0,
          itemExternalId,
          itemScope,
        );
        return;
      }
    }

    renderForm(itemExternalId, productExternalId, itemScope, availResp.item_title, storedEmail, null);

    // Attach one-time form submit interceptor to store email
    const formEl = widget.querySelector("form");
    if (formEl) {
      formEl.addEventListener("submit", () => {
        const emailInput = formEl.querySelector<HTMLInputElement>("input[type='email']");
        if (emailInput?.value) {
          localStorage.setItem("bis.email", emailInput.value.trim());
        }
      });
    }
  }

  // ─── Handle unsubscribe link ─────────────────────────────────────────────
  // If the page URL has ?bis_unsubscribe=<token>, process it inline
  async function handleUnsubscribeLink(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const token = params.get("bis_unsubscribe");
    if (!token) return;

    widget.classList.remove("bis-widget--hidden");
    widget.innerHTML = "";

    const msg = document.createElement("p");
    msg.textContent = "Processing your unsubscribe request…";
    widget.appendChild(msg);

    try {
      const resp = (await host.call("/widget/unsubscribe", {
        unsubscribe_token: token,
      })) as WidgetUnsubscribeResponse;

      msg.innerHTML = "";
      if (resp.success) {
        msg.textContent = `You've been unsubscribed from ${resp.removed_count} waitlist(s).`;
        localStorage.removeItem("bis.email");
      } else {
        msg.textContent = "Unable to process your unsubscribe request. Please try again.";
      }
    } catch {
      msg.textContent = "Unable to process your unsubscribe request. Please try again.";
    }
  }

  // ─── Entry point ─────────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  if (params.get("bis_unsubscribe")) {
    handleUnsubscribeLink();
  } else {
    boot();
  }
}
