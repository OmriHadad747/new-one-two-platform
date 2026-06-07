import type { Host } from "@platform/storefront-sdk";
import type {
  WidgetSignupRequest,
  WidgetSignupResponse,
  WidgetSignupStatusRequest,
  WidgetSignupStatusResponse,
  ItemType,
} from "../src/types/contracts.js";

export function mount(container: HTMLElement, host: Host): void {
  // ── Styles ───────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bis-widget { margin-top: 12px; font-family: sans-serif; }
    .bis-form { display: flex; flex-direction: column; gap: 8px; }
    .bis-form input[type="email"] {
      padding: 10px 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 14px;
      width: 100%;
      box-sizing: border-box;
    }
    .bis-form button {
      padding: 10px 16px;
      background: #008060;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
    }
    .bis-form button:disabled { opacity: 0.6; cursor: default; }
    .bis-message { font-size: 14px; padding: 8px 0; }
    .bis-message.success { color: #008060; }
    .bis-message.error { color: #d72c0d; }
    .bis-already { font-size: 14px; color: #637381; }
  `;
  container.appendChild(style);

  // ── Widget root ──────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "bis-widget";
  container.appendChild(root);

  // ── Read page context ────────────────────────────────────
  // Item ids are embedded in page meta by the theme app extension.
  // We read them from data attributes on the container itself,
  // or from URL params / product JSON as a fallback.
  //
  // The theme must pass:
  //   data-item-external-id  (variant id if variant-level, product id if product-level)
  //   data-item-type         ("variant" | "product")
  //   data-product-external-id (always the product id)

  const itemExternalId = container.dataset["itemExternalId"] ?? "";
  const rawItemType = container.dataset["itemType"] ?? "variant";
  const itemType: ItemType =
    rawItemType === "product" ? "product" : "variant";
  const productExternalId = container.dataset["productExternalId"] ?? "";

  // Validate that we have real numeric ids before rendering anything
  if (!/^\d+$/.test(itemExternalId) || !/^\d+$/.test(productExternalId)) {
    // Widget can't operate without valid ids — render nothing (fall open)
    return;
  }

  // ── State ────────────────────────────────────────────────
  type WidgetState =
    | { phase: "loading" }
    | { phase: "form" }
    | { phase: "already_signed_up" }
    | { phase: "success"; message: string }
    | { phase: "error"; message: string };

  let state: WidgetState = { phase: "loading" };

  function render(): void {
    // Clear and re-render
    root.textContent = "";

    if (state.phase === "loading") {
      // Render nothing while loading — avoids flash
      return;
    }

    if (state.phase === "already_signed_up") {
      const msg = document.createElement("p");
      msg.className = "bis-already";
      msg.textContent =
        "✓ You're already on the waitlist for this item. We'll email you when it's back!";
      root.appendChild(msg);
      return;
    }

    if (state.phase === "success") {
      const msg = document.createElement("p");
      msg.className = "bis-message success";
      msg.textContent = state.message;
      root.appendChild(msg);
      return;
    }

    if (state.phase === "error") {
      // Render form again with error message
      renderForm(state.message);
      return;
    }

    // phase === "form"
    renderForm(null);
  }

  function renderForm(errorMsg: string | null): void {
    const form = document.createElement("form");
    form.className = "bis-form";

    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.name = "email";
    emailInput.placeholder = "Enter your email";
    emailInput.required = true;
    emailInput.autocomplete = "email";
    form.appendChild(emailInput);

    if (errorMsg) {
      const errEl = document.createElement("p");
      errEl.className = "bis-message error";
      errEl.textContent = errorMsg;
      form.appendChild(errEl);
    }

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.textContent = "Notify me when back in stock";
    form.appendChild(submitBtn);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const formData = host.getFormData(form);
      const email = String(formData.email ?? "").trim();

      if (!email || !email.includes("@")) {
        state = { phase: "error", message: "Please enter a valid email address." };
        render();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";

      const body: WidgetSignupRequest = {
        email,
        item_external_id: itemExternalId,
        item_type: itemType,
        product_external_id: productExternalId,
      };

      try {
        const resp = (await host.call("/widget/signup", body)) as WidgetSignupResponse;

        if (resp.result === "created" || resp.result === "duplicate") {
          state = { phase: "success", message: resp.message };
        } else {
          state = { phase: "error", message: resp.message };
        }
      } catch {
        // Fall open: show a friendly inline message, never block checkout
        state = {
          phase: "error",
          message: "Something went wrong. Please try again.",
        };
      }

      render();
    });

    root.appendChild(form);
  }

  // ── Check current signup status on mount ─────────────────
  // We try to pre-populate state from the signup status endpoint.
  // If the shopper's email is in localStorage (from a prior signup
  // on any item), we can check immediately.

  async function checkInitialStatus(): Promise<void> {
    const storedEmail = localStorage.getItem("bis.email");

    if (storedEmail) {
      try {
        const req: WidgetSignupStatusRequest = {
          email: storedEmail,
          item_external_id: itemExternalId,
        };
        const resp = (await host.call(
          "/widget/signup/status",
          req,
        )) as WidgetSignupStatusResponse;

        if (resp.signed_up) {
          state = { phase: "already_signed_up" };
        } else {
          state = { phase: "form" };
        }
      } catch {
        // Fall open: show form if status check fails
        state = { phase: "form" };
      }
    } else {
      state = { phase: "form" };
    }

    render();
  }

  // Kick off initial render — loading state first, then real state
  render(); // renders nothing (loading phase)
  checkInitialStatus(); // async; sets real state and re-renders
}
