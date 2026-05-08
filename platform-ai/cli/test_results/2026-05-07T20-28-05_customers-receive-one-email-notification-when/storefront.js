window.__PLATFORM_CATALOG__ = [];
export function mount(container, host) {
  const SLUG = "back-in-stock";
  const KEY = `${SLUG}.guestToken`;
  const { customerId } = host.context;

  let guestToken = localStorage.getItem(KEY);
  if (!customerId && !guestToken) {
    guestToken =
      (crypto.randomUUID && crypto.randomUUID()) ||
      String(Date.now()) + Math.random().toString(36).slice(2);
    localStorage.setItem(KEY, guestToken);
  }

  const params = new URLSearchParams(location.search);
  const variantId = params.get("variant");
  const pathParts = location.pathname.split("/");
  const productHandle = pathParts[pathParts.indexOf("products") + 1] || null;

  const style = document.createElement("style");
  style.textContent = `
    .app-${SLUG}-root {
      font-family: inherit;
      font-size: 1rem;
      box-sizing: border-box;
    }
    .app-${SLUG}-root *, .app-${SLUG}-root *::before, .app-${SLUG}-root *::after {
      box-sizing: inherit;
    }
    .app-${SLUG}-loading {
      color: #666;
      padding: 8px 0;
    }
    .app-${SLUG}-form-wrap {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .app-${SLUG}-label {
      font-size: 0.875rem;
      font-weight: 600;
      color: #333;
    }
    .app-${SLUG}-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .app-${SLUG}-input {
      flex: 1 1 200px;
      padding: 9px 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 0.9rem;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s;
    }
    .app-${SLUG}-input:focus {
      border-color: #555;
    }
    .app-${SLUG}-input[aria-invalid="true"] {
      border-color: #b00020;
    }
    .app-${SLUG}-button {
      padding: 9px 18px;
      background: #222;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 0.9rem;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s;
    }
    .app-${SLUG}-button:hover:not([disabled]) {
      opacity: 0.85;
    }
    .app-${SLUG}-button[disabled] {
      opacity: 0.55;
      cursor: wait;
    }
    .app-${SLUG}-status {
      font-size: 0.85rem;
      min-height: 1.2em;
      margin: 0;
      padding: 0;
    }
    .app-${SLUG}-status[data-tone="error"] {
      color: #b00020;
    }
    .app-${SLUG}-status[data-tone="success"] {
      color: #1a6e1a;
    }
    .app-${SLUG}-confirmed {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .app-${SLUG}-confirmed-msg {
      font-size: 0.9rem;
      color: #1a6e1a;
      font-weight: 600;
      margin: 0;
    }
    .app-${SLUG}-unsub-btn {
      background: none;
      border: none;
      padding: 0;
      font-size: 0.8rem;
      color: #666;
      text-decoration: underline;
      cursor: pointer;
      font-family: inherit;
      width: fit-content;
    }
    .app-${SLUG}-unsub-btn:hover {
      color: #333;
    }
    .app-${SLUG}-unsub-btn[disabled] {
      opacity: 0.5;
      cursor: wait;
    }
    .app-${SLUG}-unsub-status {
      font-size: 0.8rem;
      color: #666;
      margin: 0;
    }
    .app-${SLUG}-unsub-status[data-tone="error"] {
      color: #b00020;
    }
  `;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = `app-${SLUG}-root`;
  container.appendChild(root);

  function setLoading() {
    root.innerHTML = `<p class="app-${SLUG}-loading" aria-live="polite">Loading…</p>`;
  }

  function setError(msg) {
    root.innerHTML = `<p class="app-${SLUG}-status" data-tone="error" aria-live="polite">${msg}</p>`;
  }

  function renderConfirmed(email, resolvedVariantId) {
    const wrap = document.createElement("div");
    wrap.className = `app-${SLUG}-confirmed`;

    const msg = document.createElement("p");
    msg.className = `app-${SLUG}-confirmed-msg`;
    msg.setAttribute("aria-live", "polite");
    msg.textContent = "You're on the list — we'll email you when it's back.";

    const unsubBtn = document.createElement("button");
    unsubBtn.className = `app-${SLUG}-unsub-btn`;
    unsubBtn.type = "button";
    unsubBtn.textContent = "Unsubscribe from this notification";

    const unsubStatus = document.createElement("p");
    unsubStatus.className = `app-${SLUG}-unsub-status`;
    unsubStatus.setAttribute("aria-live", "polite");
    unsubStatus.textContent = "";

    wrap.appendChild(msg);
    wrap.appendChild(unsubBtn);
    wrap.appendChild(unsubStatus);
    root.innerHTML = "";
    root.appendChild(wrap);

    unsubBtn.addEventListener("click", async () => {
      unsubBtn.disabled = true;
      unsubStatus.dataset.tone = "";
      unsubStatus.textContent = "Removing…";
      try {
        const result = await host.call("/signup/remove", {
          variant_external_id: resolvedVariantId,
          customer_email: email,
        });
        if (result && result.success) {
          unsubStatus.dataset.tone = "";
          unsubStatus.textContent = "You've been unsubscribed.";
          unsubBtn.remove();
        } else {
          unsubBtn.disabled = false;
          unsubStatus.dataset.tone = "error";
          unsubStatus.textContent = "Could not unsubscribe. Please try again.";
        }
      } catch (_) {
        unsubBtn.disabled = false;
        unsubStatus.dataset.tone = "error";
        unsubStatus.textContent = "Something went wrong. Please try again.";
      }
    });
  }

  function renderForm(prefillEmail, resolvedVariantId, productId) {
    const inputId = `${SLUG}-email`;

    const wrap = document.createElement("div");
    wrap.className = `app-${SLUG}-form-wrap`;

    const label = document.createElement("label");
    label.className = `app-${SLUG}-label`;
    label.setAttribute("for", inputId);
    label.textContent = "Notify me when available";

    const row = document.createElement("div");
    row.className = `app-${SLUG}-row`;

    const input = document.createElement("input");
    input.id = inputId;
    input.className = `app-${SLUG}-input`;
    input.name = "customer_email";
    input.type = "email";
    input.placeholder = "you@example.com";
    input.required = true;
    input.setAttribute("autocomplete", "email");
    input.setAttribute("aria-label", "Email address");
    if (prefillEmail) input.value = prefillEmail;

    const button = document.createElement("button");
    button.className = `app-${SLUG}-button`;
    button.type = "submit";
    button.textContent = "Notify me";

    row.appendChild(input);
    row.appendChild(button);

    const status = document.createElement("p");
    status.className = `app-${SLUG}-status`;
    status.setAttribute("aria-live", "polite");
    status.textContent = "";

    const form = document.createElement("form");
    form.setAttribute("novalidate", "");
    form.appendChild(row);
    form.appendChild(status);

    wrap.appendChild(label);
    wrap.appendChild(form);

    root.innerHTML = "";
    root.appendChild(wrap);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const data = host.getFormData(form);
      const email = (data.customer_email || "").trim();

      if (!email) {
        input.setAttribute("aria-invalid", "true");
        status.dataset.tone = "error";
        status.textContent = "Please enter your email address.";
        input.focus();
        return;
      }

      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(email)) {
        input.setAttribute("aria-invalid", "true");
        status.dataset.tone = "error";
        status.textContent = "Please enter a valid email address.";
        input.focus();
        return;
      }

      input.removeAttribute("aria-invalid");
      button.disabled = true;
      button.textContent = "Saving…";
      status.dataset.tone = "";
      status.textContent = "";

      try {
        const body = {
          variant_external_id: resolvedVariantId,
          product_external_id: productId,
          customer_email: email,
        };

        const result = await host.call("/signup", body);

        if (result && result.success) {
          if (customerId && guestToken) {
            localStorage.removeItem(KEY);
          }
          renderConfirmed(email, resolvedVariantId);
        } else {
          button.disabled = false;
          button.textContent = "Notify me";
          status.dataset.tone = "error";
          status.textContent = "Could not save your signup. Please try again.";
        }
      } catch (_) {
        button.disabled = false;
        button.textContent = "Notify me";
        status.dataset.tone = "error";
        status.textContent = "Something went wrong. Please try again.";
      }
    });
  }

  async function init() {
    setLoading();

    let resolvedVariantId = variantId;
    let productId = null;
    let prefillEmail = null;

    // Fetch product data to get variant/product IDs and prefill context
    if (productHandle) {
      try {
        const product = await host.storefront(`/products/${productHandle}.js`);
        if (product) {
          productId = product.id ? String(product.id) : null;

          if (!resolvedVariantId && product.variants && product.variants.length > 0) {
            resolvedVariantId = String(product.variants[0].id);
          } else if (resolvedVariantId) {
            resolvedVariantId = String(resolvedVariantId);
          }

          // Only show the widget if the selected variant is unavailable
          if (product.variants && resolvedVariantId) {
            const matchedVariant = product.variants.find(
              (v) => String(v.id) === String(resolvedVariantId)
            );
            if (matchedVariant && matchedVariant.available) {
              // Product/variant is in stock — widget not needed
              root.innerHTML = "";
              return;
            }
          } else if (product.available) {
            root.innerHTML = "";
            return;
          }
        }
      } catch (_) {
        // Non-fatal: proceed without product data
      }
    }

    if (!resolvedVariantId) {
      setError("Unable to determine product variant. Please refresh the page.");
      return;
    }

    // Try to get logged-in customer's email via cart for prefill
    try {
      const cart = await host.storefront("/cart.js");
      if (cart && cart.items && cart.items.length > 0) {
        // Cart doesn't expose email directly; skip prefill from cart
      }
    } catch (_) {
      // Non-fatal
    }

    // Check if already signed up — need an email to check.
    // If customerId is present, we still need the email — we'll render
    // the form and check on submit for dedup; or check with a known email.
    // Per catalog, GET /signup requires customer_email; we can only check
    // state after the user provides their email. Render form directly,
    // and after user inputs email we'll do a real-time check on submit.
    // However, to honor the lifecycle, we will render the form immediately
    // and handle dedup server-side (the POST /signup backend deduplicates).

    renderForm(prefillEmail, resolvedVariantId, productId);
  }

  init();
}