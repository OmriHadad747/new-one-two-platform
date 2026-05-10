"""
Widget shape registry — single source of truth for the storefront agent's
example library and the LLD agent's widgetShapes classification.

Mirrors the LLD's `platform_runtime_examples.py` pattern: a dict keyed by
stable bucket names, plus a dumb dispatcher that maps inputs → bucket
names. The codegen agent (`agent.py`) appends the dispatched example
bodies to its user message — it never imports this file's internals.

Adding a new shape: add ONE entry to `WIDGET_SHAPES`. The LLD prompt's
enum section, the schema validator, and the storefront dispatcher all
pick it up automatically.

Snippet philosophy: examples teach the NON-TRIVIAL patterns only. Things
the model already knows (basic DOM construction, event listeners, regex,
try/catch around await) are NOT repeated. The "anchor" example
(form_persist_state_check) is longer because it doubles as the
composition reference; new shapes are focused snippets showing only
the unique delta.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional


# ── Route-shape predicates (mechanical dispatch from lld.httpRoutes.widget) ──


def _has_get_and_post(routes: List[Dict[str, Any]]) -> bool:
    """True when the widget catalog has at least one GET/POST pair on the
    same path — the canonical form-persist-with-state-check shape."""
    by_path: Dict[str, set] = {}
    for r in routes:
        path = r.get("path", "")
        method = (r.get("method") or "POST").upper()
        by_path.setdefault(path, set()).add(method)
    return any({"GET", "POST"}.issubset(methods) for methods in by_path.values())


def _post_only(routes: List[Dict[str, Any]]) -> bool:
    """True when the catalog has POSTs but no GETs — form-persist that
    skips the state-check (server-side dedup)."""
    methods = {(r.get("method") or "POST").upper() for r in routes}
    return "POST" in methods and "GET" not in methods


def _get_only(routes: List[Dict[str, Any]]) -> bool:
    """True when the catalog is read-only — stateless display."""
    methods = {(r.get("method") or "POST").upper() for r in routes}
    return "GET" in methods and "POST" not in methods


def _multiple_post_paths(routes: List[Dict[str, Any]]) -> bool:
    """True when the catalog has POSTs on multiple distinct paths —
    suggests a list view + add form (Q&A pattern)."""
    post_paths = {
        r.get("path", "")
        for r in routes
        if (r.get("method") or "POST").upper() == "POST"
    }
    return len(post_paths) >= 2


# ── Example bodies — inline triple-strings, mirror LLD pattern ───────────────


_EXAMPLE_FORM_PERSIST_STATE_CHECK = r"""// Anchor example — form-persist with paired state-check.
//
// The complete composition reference. Every other shape's snippet
// assumes the conventions shown here (scoped CSS prefix, identity
// flow, statusEl helper, textContent for runtime values). Don't repeat
// those conventions in new shape snippets — extend or override them.
//
// Hypothetical catalog:
//   GET  /engraving/state    receives: { already_requested }
//   POST /engraving/request  receives: { request_id, status }

export function mount(container, host) {
  const SLUG = "engraving";
  const KEY = `${SLUG}.guestToken`;
  const customerId = host.context.customerId;

  // Identity migration — mint guestToken once for guests, send on
  // every host.call, clear AFTER a successful call that included both
  // (the handler merges the guest row onto the customer record).
  let guestToken = localStorage.getItem(KEY);
  if (!customerId && !guestToken) {
    guestToken = (crypto.randomUUID && crypto.randomUUID()) ||
                 String(Date.now()) + Math.random().toString(36).slice(2);
    localStorage.setItem(KEY, guestToken);
  }

  // Locale-tolerant product handle. Matches /products/, /de/products/,
  // /fr-ca/products/ — international stores serve PDP under a locale
  // segment, and a regex without it silently misses ~70% of those stores.
  const productHandle = (location.pathname.match(
    /\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\/([^/?#]+)/
  ) || [])[1];
  if (!productHandle) return;

  // Scoped CSS — every selector is `.app-${SLUG}-*` so theme styles
  // can't bleed in and your styles can't bleed out. Inject through
  // container, never document.head.
  const style = document.createElement("style");
  style.textContent = `.app-${SLUG}-root { font: inherit; padding: 12px 0; }
    .app-${SLUG}-status { font-size: 0.85em; min-height: 1.2em; }
    .app-${SLUG}-status[data-tone="error"] { color: #b00020; }
    .app-${SLUG}-button[disabled] { opacity: 0.55; cursor: wait; }`;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = `app-${SLUG}-root`;
  container.appendChild(root);

  // aria-live so screen readers announce status changes.
  function statusEl(text, tone) {
    const p = document.createElement("p");
    p.className = `app-${SLUG}-status`;
    p.setAttribute("aria-live", "polite");
    if (tone) p.dataset.tone = tone;
    p.textContent = text;
    return p;
  }

  function renderConfirmed(productTitle) {
    root.innerHTML = "";  // clearing only — never with interpolation
    const title = document.createElement("p");
    title.textContent = "Engraving request received";
    root.appendChild(title);
    root.appendChild(statusEl(
      `We'll review your engraving for ${productTitle} and email you within 1 business day.`
    ));
  }

  function renderForm(productTitle) {
    root.innerHTML = "";
    // Build form with createElement (not innerHTML interpolation).
    // Inputs need: visible label OR aria-label, name= (for getFormData),
    // required where applicable. See FORM CONSTRUCTION rules in the prompt.
    const form = /* form with name+font_style+customer_email inputs and a submit button */;
    const status = statusEl("");
    form.appendChild(status);
    root.appendChild(form);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = host.getFormData(form);
      // Validate locally; on invalid set aria-invalid + focus first bad field.
      // ...

      const button = form.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = "Saving…";
      status.textContent = "";

      try {
        await host.call("/engraving/request", {
          product_handle: productHandle,
          engraved_name: data.engraved_name.trim(),
          font_style: data.font_style,
          customer_email: data.customer_email.trim(),
          customerId, guestToken,
        });
        // Migration cleanup — only after a successful call that sent both.
        if (customerId && guestToken) localStorage.removeItem(KEY);
        renderConfirmed(productTitle);
      } catch (_) {
        button.disabled = false;
        button.textContent = "Request engraving";
        status.dataset.tone = "error";
        status.textContent = "Something went wrong. Please try again.";
      }
    });
  }

  // Lifecycle: LOADING → product gate → state-check → CONFIRMED or FORM.
  async function init() {
    root.appendChild(statusEl("Loading…"));

    // Product gate — fetch product info from the public Ajax catalog and
    // hide the widget when it doesn't apply (collapses the App Block region).
    let product = null;
    try { product = await host.storefront(`/products/${productHandle}.js`); }
    catch (_) { /* non-fatal */ }
    const tags = (product && Array.isArray(product.tags)) ? product.tags : [];
    if (product && !tags.includes("engravable")) {
      container.innerHTML = "";
      return;
    }
    const productTitle = (product && product.title) || "this product";

    // State-check — fail OPEN to the form so a backend hiccup never
    // blocks the shopper. Backend dedups on submit.
    try {
      const state = await host.call("/engraving/state",
        { product_handle: productHandle, customerId, guestToken });
      if (state && state.already_requested) {
        renderConfirmed(productTitle);
        return;
      }
    } catch (_) { /* fail open */ }

    renderForm(productTitle);
  }

  init();
}
"""


_EXAMPLE_STATELESS_DISPLAY = r"""// Stateless display — read-only widget. Fetch on mount, render once.
//
// No state-check, no form, no per-shopper persistence. Just
// LOADING → fetch → render-or-hide.
//
// Hypothetical catalog:
//   GET /announcement/config  receives: { enabled, text, link, bg_color }

export function mount(container, host) {
  const SLUG = "announcement";

  // Scoped CSS — see anchor for full pattern.
  const style = document.createElement("style");
  style.textContent = `.app-${SLUG}-bar { font: inherit; padding: 8px 16px;
      text-align: center; }
    .app-${SLUG}-bar a { color: inherit; text-decoration: underline; }`;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = `app-${SLUG}-bar`;
  container.appendChild(root);

  async function init() {
    let config = null;
    try { config = await host.call("/announcement/config"); }
    catch (_) { container.innerHTML = ""; return; }

    // Empty-state — feature toggled off OR no content configured →
    // collapse the App Block region. Better than rendering an empty bar.
    if (!config || !config.enabled || !config.text) {
      container.innerHTML = "";
      return;
    }

    // Apply runtime values via element.style / textContent / setAttribute,
    // never via innerHTML interpolation.
    root.style.background = config.bg_color || "#222";
    root.style.color = "#fff";

    if (config.link) {
      const a = document.createElement("a");
      a.setAttribute("href", config.link);
      a.textContent = config.text;
      root.appendChild(a);
    } else {
      root.textContent = config.text;
    }
  }

  init();
}
"""


_EXAMPLE_MODAL_OVERLAY = r"""// Modal overlay — page-gating dialog shown on mount, dismissed by user.
//
// Pattern: aria-modal + role="dialog", ESC-to-close, click-outside-to-close,
// focus management (move focus on open, restore on close), localStorage
// flag so the gate doesn't re-show on every page view, AND the
// scroll-lock dance under the MODAL SCROLL-LOCK EXCEPTION.
//
// Hypothetical catalog:
//   GET /age-gate/config  receives: { enabled, threshold, message }

export function mount(container, host) {
  const SLUG = "age-gate";
  const STORAGE_KEY = `${SLUG}.confirmed`;

  // Once confirmed in this browser, skip rendering entirely.
  if (localStorage.getItem(STORAGE_KEY)) return;

  const style = document.createElement("style");
  style.textContent = `.app-${SLUG}-overlay {
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
    }
    .app-${SLUG}-dialog {
      background: #fff; padding: 24px; border-radius: 8px;
      max-width: 400px; font: inherit;
    }`;
  container.appendChild(style);

  // SCROLL-LOCK — capture original value BEFORE mutating, restore on
  // every close path. See MODAL SCROLL-LOCK EXCEPTION in the system
  // prompt; this is the ONLY documented exception to the
  // document.documentElement.* ban.
  const prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";

  // Capture the previously-focused element to restore on close (a11y).
  const previouslyFocused = document.activeElement;

  const overlay = document.createElement("div");
  overlay.className = `app-${SLUG}-overlay`;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Age confirmation required");

  const dialog = document.createElement("div");
  dialog.className = `app-${SLUG}-dialog`;
  // Build dialog content (heading, message, confirm/deny buttons) with
  // createElement + textContent — see anchor for the form-construction
  // pattern. confirmBtn is the primary; denyBtn is secondary.

  function close() {
    container.removeChild(overlay);
    document.removeEventListener("keydown", onKey);
    // RESTORE scroll-lock — runs on EVERY close (ESC, backdrop click,
    // confirm, deny). Skipping this leaves the page un-scrollable.
    document.documentElement.style.overflow = prevOverflow;
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  }

  function onKey(e) {
    // ESC closes (treats it as "deny" — no localStorage write).
    if (e.key === "Escape") close();
  }

  // Click on the overlay backdrop (NOT the dialog itself) closes.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // confirmBtn click handler — set the flag, then optionally tell the
  // backend, then close (which runs the scroll-lock restore).
  // confirmBtn.addEventListener("click", async () => {
  //   localStorage.setItem(STORAGE_KEY, "1");
  //   try { await host.call("/age-gate/confirm"); } catch (_) {}
  //   close();
  // });

  document.addEventListener("keydown", onKey);

  overlay.appendChild(dialog);
  container.appendChild(overlay);

  // Move focus into the dialog so Tab cycles within it (a11y baseline).
  // confirmBtn.focus();
}
"""


_EXAMPLE_CART_AWARE = r"""// Cart-aware widget — reads /cart.js and reacts to cart state.
//
// Pattern: fetch /cart.js on mount, re-fetch on visibilitychange (covers
// add-to-cart in another tab, back-button, etc.). Does NOT subscribe to
// theme-specific cart events (cart:updated, cart:refresh) — those vary
// across themes and are unreliable.
//
// Hypothetical catalog:
//   GET /shipping-bar/config  receives: { threshold_cents }

export function mount(container, host) {
  const SLUG = "shipping-bar";
  let threshold = null;

  const style = document.createElement("style");
  style.textContent = `.app-${SLUG}-bar { font: inherit; padding: 6px 12px;
      background: #f4f4f4; text-align: center; font-size: 0.9em; }
    .app-${SLUG}-progress { height: 4px; background: #ddd; margin-top: 4px; }
    .app-${SLUG}-progress > div { height: 100%; background: #2a8e2a;
      transition: width 200ms ease; }`;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = `app-${SLUG}-bar`;
  const message = document.createElement("p");
  message.style.margin = "0";
  const progress = document.createElement("div");
  progress.className = `app-${SLUG}-progress`;
  const fill = document.createElement("div");
  progress.appendChild(fill);
  root.appendChild(message);
  root.appendChild(progress);
  container.appendChild(root);

  async function refresh() {
    if (threshold == null) return;
    let cart = null;
    try { cart = await host.storefront("/cart.js"); }
    catch (_) { return; }
    if (!cart) return;

    const remaining = threshold - cart.total_price;
    if (remaining <= 0) {
      message.textContent = "You qualify for free shipping!";
      fill.style.width = "100%";
    } else {
      // Currency-correct formatting — Shopify's total_price is in minor
      // units (cents/yen/etc.) and the cart includes the active currency
      // code. Don't hardcode "$" or " / 100".
      const amount = (remaining / 100).toLocaleString(undefined, {
        style: "currency", currency: cart.currency || "USD",
      });
      message.textContent = `${amount} away from free shipping`;
      const pct = Math.max(0, Math.min(100,
        (cart.total_price / threshold) * 100));
      fill.style.width = `${pct}%`;
    }
  }

  // Re-fetch when the tab becomes visible. No theme-event subscription.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });

  async function init() {
    let config = null;
    try { config = await host.call("/shipping-bar/config"); }
    catch (_) { container.innerHTML = ""; return; }
    if (!config || !config.threshold_cents) {
      container.innerHTML = "";
      return;
    }
    threshold = config.threshold_cents;
    refresh();
  }

  init();
}
"""


_EXAMPLE_PAGE_TEMPLATE = r"""// Page-template widget — fills a full page region with sub-routing
// and search/filter state.
//
// Pattern: read query params on mount, render filtered content,
// update URL via history.replaceState (no full-page navigation),
// re-render on popstate (back/forward).
//
// Hypothetical catalog:
//   GET /faq/tree  receives: { categories }
//                   categories[]: { slug, name, items }
//                   items[]: { question, answer }

export function mount(container, host) {
  const SLUG = "faq";
  let tree = null;

  const style = document.createElement("style");
  style.textContent = `.app-${SLUG}-page { font: inherit;
      max-width: 800px; margin: 0 auto; padding: 32px 16px; }
    .app-${SLUG}-search { padding: 8px 12px; width: 100%; font: inherit;
      border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    .app-${SLUG}-cat { margin: 24px 0 0 0; }
    .app-${SLUG}-q { margin: 8px 0; font-weight: 600; }
    .app-${SLUG}-a { color: #555; padding: 4px 0 12px 0; }`;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = `app-${SLUG}-page`;
  container.appendChild(root);

  // The URL's query string is the source of truth for page state —
  // bookmarkable, shareable, back-button-friendly. Don't keep state in
  // module-scoped variables that can fall out of sync with the URL.
  function readState() {
    const params = new URLSearchParams(location.search);
    return { query: (params.get("q") || "").trim().toLowerCase() };
  }

  // Update the URL without a full navigation. replaceState keeps history
  // tidy (one entry per page); pushState would create one per keystroke.
  function writeState(next) {
    const params = new URLSearchParams();
    if (next.query) params.set("q", next.query);
    const url = location.pathname + (params.toString() ? "?" + params : "");
    history.replaceState(null, "", url);
  }

  function render() {
    if (!tree) return;
    const state = readState();
    root.innerHTML = "";

    const search = document.createElement("input");
    search.className = `app-${SLUG}-search`;
    search.type = "search";
    search.placeholder = "Search FAQs…";
    search.value = state.query;
    search.setAttribute("aria-label", "Search FAQs");
    root.appendChild(search);

    // Debounced — under the literal-≤500ms allowance for input debounce.
    let debounce = null;
    search.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        writeState({ query: search.value.trim().toLowerCase() });
        render();
      }, 200);
    });

    for (const cat of tree.categories || []) {
      const visible = (cat.items || []).filter((i) =>
        !state.query || i.question.toLowerCase().includes(state.query)
          || i.answer.toLowerCase().includes(state.query));
      if (state.query && visible.length === 0) continue;

      const heading = document.createElement("h2");
      heading.className = `app-${SLUG}-cat`;
      heading.textContent = cat.name;
      root.appendChild(heading);

      for (const item of visible) {
        const q = document.createElement("p");
        q.className = `app-${SLUG}-q`;
        q.textContent = item.question;
        const a = document.createElement("p");
        a.className = `app-${SLUG}-a`;
        a.textContent = item.answer;
        root.appendChild(q);
        root.appendChild(a);
      }
    }
  }

  // Re-render on back/forward. The URL is the truth; sync the page to
  // it without reloading.
  window.addEventListener("popstate", render);

  async function init() {
    try { tree = await host.call("/faq/tree"); }
    catch (_) { container.innerHTML = ""; return; }
    if (!tree || !(tree.categories || []).length) {
      root.textContent = "No questions yet.";
      return;
    }
    render();
  }

  init();
}
"""


_EXAMPLE_MUTATE_PAGE_DOM = r"""// Mutate-page-DOM — change theme elements OUTSIDE container, AND
// react to variant changes. Demonstrates the full ESCAPE-HATCHES
// contract (capture-before-mutate, restore-on-cleanup, idempotent
// on remount) plus the standard-browser-events pattern for
// reacting to user actions outside container.
//
// Use this shape SPARINGLY — direct theme mutation is theme-fragile.
// Prefer rendering inside `container` whenever the feature allows.
//
// Hypothetical catalog:
//   GET /preorder/state  receives: { enabled, label, ship_date_iso }

export function mount(container, host) {
  const SLUG = "preorder";
  const MARK = `data-app-${SLUG}-touched`;

  // Locale-tolerant product handle — see anchor for the regex.
  const productHandle = (location.pathname.match(
    /\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\/([^/?#]+)/
  ) || [])[1];
  if (!productHandle) return;

  // Find the theme's Add-to-Cart button. Selectors here cover Dawn,
  // Debut, and most third-party themes; if no button is found this
  // template doesn't have an ATC and the feature isn't applicable.
  const atcButton = document.querySelector(
    'button[name="add"], button[type="submit"][form*="product-form"], button[data-add-to-cart]'
  );
  if (!atcButton) {
    container.innerHTML = "";
    return;
  }

  // IDEMPOTENT-ON-REMOUNT — if a previous mount already touched this
  // button, bail. The first mount owns the original label; a second
  // would cache an already-mutated value as "original" and lose it.
  if (atcButton.hasAttribute(MARK)) {
    container.innerHTML = "";
    return;
  }

  // CAPTURE-BEFORE-MUTATE — store the original label on the element
  // itself. Mark BEFORE any rendering can throw, so a partial mount
  // still locks out a second mount.
  const originalLabel = atcButton.textContent;
  atcButton.setAttribute(MARK, originalLabel);

  // The note is the only DOM the widget owns inside container; we
  // re-render it on every variant change.
  let note = null;

  function readVariantId() {
    return new URLSearchParams(location.search).get("variant");
  }

  async function applyState() {
    let state = null;
    try {
      state = await host.call("/preorder/state",
        { product_handle: productHandle, variant_id: readVariantId() });
    } catch (_) { return; }

    if (state && state.enabled) {
      atcButton.textContent = state.label || "Pre-order";
      if (note) container.removeChild(note);
      note = document.createElement("p");
      note.style.font = "inherit";
      note.style.fontSize = "0.85em";
      note.style.margin = "8px 0 0 0";
      if (state.ship_date_iso) {
        note.textContent = `Ships approximately ${
          new Date(state.ship_date_iso).toLocaleDateString()
        }`;
      }
      container.appendChild(note);
    } else {
      // RESTORE-ON-CLEANUP — variants where preorder doesn't apply
      // get the original label back. Without this, switching from a
      // preorder variant to an in-stock one leaves "Pre-order" stuck
      // on the in-stock variant's button.
      atcButton.textContent = originalLabel;
      if (note) { container.removeChild(note); note = null; }
    }
  }

  // React to variant changes via STANDARD BROWSER EVENTS — never
  // theme-specific custom events. Themes vary in how the variant
  // picker dispatches change, so listen on:
  //   - the product form's change event (covers <select>, radio
  //     groups, Dawn's <variant-selects> custom element)
  //   - popstate (browser back/forward)
  // The handler is idempotent (applyState reads the current variant
  // and renders), so duplicate fires are harmless.
  const productForm = atcButton.closest("form");
  if (productForm) productForm.addEventListener("change", applyState);
  window.addEventListener("popstate", applyState);

  applyState();
}
"""


_EXAMPLE_LIVE_TICK = r"""// Live-tick widget — displays a value that changes over time.
//
// Pattern: setInterval ≥1000ms, handle captured on container, paused
// when the tab is hidden, resumed on visibilitychange. PURE display —
// the interval body MUST NOT call host.call(). See LIVE-TICK PATTERN
// in the system prompt for the full contract.
//
// Hypothetical catalog:
//   GET /flash-sale/config  receives: { ends_at_iso }

export function mount(container, host) {
  const SLUG = "flash-sale";
  let endsAt = null;

  const style = document.createElement("style");
  style.textContent = `.app-${SLUG}-bar { font: inherit; padding: 8px 16px;
      background: #b00020; color: #fff; text-align: center; }`;
  container.appendChild(style);

  const root = document.createElement("div");
  root.className = `app-${SLUG}-bar`;
  root.setAttribute("aria-live", "polite");
  container.appendChild(root);

  function format(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  }

  function tick() {
    if (!endsAt) return;
    const remaining = endsAt - Date.now();
    if (remaining <= 0) {
      // Done — stop ticking and hide. No point keeping the interval alive.
      stopTick();
      container.innerHTML = "";
      return;
    }
    root.textContent = `Sale ends in ${format(remaining)}`;
  }

  function startTick() {
    if (container.__appTickHandle) return;  // already running
    tick();
    container.__appTickHandle = setInterval(tick, 1000);
  }

  function stopTick() {
    if (container.__appTickHandle) {
      clearInterval(container.__appTickHandle);
      container.__appTickHandle = null;
    }
  }

  // Pause in background tabs (no CPU burn) and resume when visible.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopTick();
    else startTick();
  });

  async function init() {
    let config = null;
    try { config = await host.call("/flash-sale/config"); }
    catch (_) { container.innerHTML = ""; return; }
    if (!config || !config.ends_at_iso) {
      container.innerHTML = "";
      return;
    }
    endsAt = Date.parse(config.ends_at_iso);
    if (isNaN(endsAt) || endsAt <= Date.now()) {
      container.innerHTML = "";
      return;
    }
    startTick();
  }

  init();
}
"""


# ── The registry — single source of truth ────────────────────────────────────


WIDGET_SHAPES: Dict[str, Dict[str, Any]] = {
    "form_persist_state_check": {
        "description": (
            "GET+POST pair: state-check on mount via GET, render form when "
            "not yet active, render CONFIRMED when active. Submit POSTs and "
            "swaps to CONFIRMED. Fail-open if GET errors."
        ),
        "example_js": _EXAMPLE_FORM_PERSIST_STATE_CHECK,
        "route_predicate": _has_get_and_post,
        "text_keywords": [],
    },
    "form_persist_no_state_check": {
        "description": (
            "POST only: skip the GET because the state-check requires "
            "input the widget doesn't have at mount (typically email). "
            "Render form directly; backend dedupes on submit."
        ),
        "example_js": None,  # snippet to be authored
        "route_predicate": _post_only,
        "text_keywords": [],
    },
    "form_persist_list_view": {
        "description": (
            "Display existing entries as a list AND a form to add a new "
            "one. POSTs to multiple paths (e.g. /qa/list and /qa/ask)."
        ),
        "example_js": None,  # snippet to be authored
        "route_predicate": _multiple_post_paths,
        "text_keywords": [],
    },
    "stateless_display": {
        "description": (
            "Read-only widget: fetch config or data on mount, render once. "
            "No form, no state-check, no submit."
        ),
        "example_js": _EXAMPLE_STATELESS_DISPLAY,
        "route_predicate": _get_only,
        "text_keywords": ["banner", "announcement", "badge", "trust"],
    },
    "modal_overlay": {
        "description": (
            "Renders a fixed overlay that gates page content (popup, age "
            "gate, lightbox). Mounted-but-hidden lifecycle, focus trap, "
            "ESC-to-close, scroll lock."
        ),
        "example_js": _EXAMPLE_MODAL_OVERLAY,
        "route_predicate": None,
        "text_keywords": ["popup", "modal", "overlay", "lightbox"],
    },
    "cart_aware": {
        "description": (
            "Reads /cart.js and reacts to cart state. Fetches on demand "
            "(after known actions or visibilitychange) — does NOT subscribe "
            "to theme-specific cart events."
        ),
        "example_js": _EXAMPLE_CART_AWARE,
        "route_predicate": None,
        "text_keywords": ["cart", "free shipping", "checkout total", "items in cart"],
    },
    "page_template": {
        "description": (
            "Fills a full page region (FAQ page, store locator). "
            "Sub-routing via query params, search/filter, larger state. "
            "Same mount(container, host) contract — just bigger."
        ),
        "example_js": _EXAMPLE_PAGE_TEMPLATE,
        "route_predicate": None,
        "text_keywords": ["faq page", "store locator", "full page", "/pages/"],
    },
    "mutate_page_dom": {
        "description": (
            "Changes elements OUTSIDE container (e.g. replace native "
            "Add-to-Cart, swap displayed price). Uses document.querySelector "
            "for theme integration; mutations must be idempotent."
        ),
        "example_js": _EXAMPLE_MUTATE_PAGE_DOM,
        "route_predicate": None,
        "text_keywords": [
            "replace add to cart",
            "convert price",
            "override price",
            "swap button",
        ],
    },
    "live_tick": {
        "description": (
            "Recurring updates via setInterval (countdown, polling). "
            "Requires the timer-rule pattern: capture handle on container, "
            "minimum 1000ms, pause on visibilitychange."
        ),
        "example_js": _EXAMPLE_LIVE_TICK,
        "route_predicate": None,
        "text_keywords": ["countdown", "ticking", "live updates", "refresh every"],
    },
}


# ── Public API ──────────────────────────────────────────────────────────────


def is_known_shape(name: str) -> bool:
    """Schema validator hook — the LLD's widgetShapes field accepts only
    keys present in WIDGET_SHAPES."""
    return name in WIDGET_SHAPES


def all_shape_names() -> List[str]:
    """Used by the LLD prompt's enum description."""
    return list(WIDGET_SHAPES.keys())


def widget_shapes_section() -> str:
    """Render the LLD prompt's enum section from the registry. Adding a
    new shape to WIDGET_SHAPES regenerates this automatically — the LLD
    prompt does not hardcode the list."""
    lines = []
    for name, meta in WIDGET_SHAPES.items():
        lines.append(f"  {name}")
        # Wrap the description at ~70 cols under a 6-space indent.
        words = meta["description"].split()
        line = "      "
        for w in words:
            if len(line) + 1 + len(w) > 76:
                lines.append(line)
                line = "      " + w
            else:
                line = (line + " " + w).strip() if line.strip() else line + w
                if not line.startswith("      "):
                    line = "      " + line.lstrip()
        if line.strip():
            lines.append(line)
    return "\n".join(lines)


def examples_for_widget(
    lld: Dict[str, Any], intent: Dict[str, Any]
) -> List[str]:
    """
    Return the list of example JS bodies to append to the storefront
    agent's user message, picked by the dispatcher.

    Three signal sources, combined:

      1. Structured  — `lld.uxExpectations.widgetShapes`. When non-empty,
         this is the primary signal (heuristic fallback is suppressed).
      2. Mechanical  — apply each shape's `route_predicate` to the
         widget's HTTP route catalog.
      3. Heuristic   — fallback when (1) is empty: keyword match on
         `uxExpectations.storefront` + `intent.qualityBrief` +
         `intent.desiredOutcome`.

    Shapes whose `example_js` is None are skipped — the shape exists in
    the registry (for LLD classification) but no body has been authored
    yet.
    """
    routes = (lld.get("httpRoutes") or {}).get("widget") or []
    ux = lld.get("uxExpectations") or {}
    declared = set(ux.get("widgetShapes") or [])

    text = " ".join(
        [
            ux.get("storefront") or "",
            intent.get("qualityBrief") or "",
            intent.get("desiredOutcome") or "",
        ]
    ).lower()

    chosen: set[str] = set(declared)

    for name, meta in WIDGET_SHAPES.items():
        pred: Optional[Callable[[List[Dict[str, Any]]], bool]] = meta.get(
            "route_predicate"
        )
        if pred is not None and pred(routes):
            chosen.add(name)
        if not declared:
            for kw in meta.get("text_keywords") or []:
                if kw in text:
                    chosen.add(name)
                    break

    bodies: List[str] = []
    for name in sorted(chosen):
        body = WIDGET_SHAPES.get(name, {}).get("example_js")
        if body:
            bodies.append(body)
    return bodies
