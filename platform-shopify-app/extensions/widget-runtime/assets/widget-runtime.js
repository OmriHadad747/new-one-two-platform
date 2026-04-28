/**
 * widget-runtime.js — Thin, fixed storefront runtime.
 *
 * Deployed once via App Block. Never changes after installation.
 *
 * Responsibilities:
 *   1. Find all App Block divs on the page ([data-widget-runtime])
 *   2. For each: fetch the merchant's widget JS from the platform
 *   3. Dynamic-import the widget ES module
 *   4. Build the `host` API (the sole controlled interface to the outside world)
 *   5. Call widget.mount(container, host)
 *
 * The widget cannot:
 *   - Touch the DOM outside its container
 *   - Make backend calls except through host.call
 *   - Make storefront calls except through host.storefront
 *
 * Multiple App Block instances on the same page each run independently.
 */

// ── URL-change detection (one-time setup) ────────────────────────────────────
// Shopify's variant picker uses history.pushState/replaceState without a page
// reload. We patch them once to fire a synthetic "urlchange" event so every
// mounted widget can re-evaluate its page context.
(function patchHistory() {
  function wrap(original) {
    return function (...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event("urlchange"));
      return result;
    };
  }
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener("popstate", () =>
    window.dispatchEvent(new Event("urlchange"))
  );
})();

(async () => {
  const blocks = document.querySelectorAll("[data-widget-runtime]");
  await Promise.all(Array.from(blocks).map(mountBlock));
})();

async function mountBlock(block) {
  if (block.dataset.widgetMounted) return;
  block.dataset.widgetMounted = "1";

  const appId = block.dataset.appId;
  const shop = block.dataset.shop;
  const platformUrl = block.dataset.platformUrl;

  if (!appId || !shop || !platformUrl) {
    console.warn("[widget-runtime] Missing data attributes on block", block);
    return;
  }

  // Create an isolated container the widget fully owns
  const container = document.createElement("div");
  container.setAttribute("data-widget-container", appId);
  block.appendChild(container);

  let widgetModule;
  try {
    widgetModule = await fetchWidgetModule(platformUrl, shop, appId);
  } catch (err) {
    console.error(`[widget-runtime] Failed to fetch widget "${appId}":`, err);
    return;
  }

  async function runMount() {
    container.innerHTML = "";
    try {
      const host = buildHost({ appId, shop, platformUrl });
      await widgetModule.mount(container, host);
    } catch (err) {
      console.error(`[widget-runtime] Failed to mount widget "${appId}":`, err);
    }
  }

  // Initial mount
  await runMount();

  // Re-mount whenever the URL changes (variant switches, navigation, etc.)
  let lastUrl = location.href;
  window.addEventListener("urlchange", () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      runMount();
    }
  });
}

/**
 * Fetches the widget JS from the platform and imports it as an ES module.
 * We use a Blob URL so the browser treats it as a module.
 * Plain GET with no custom headers = simple CORS request, no preflight needed.
 */
async function fetchWidgetModule(platformUrl, shop, appId) {
  const widgetUrl = `${platformUrl}/widget/${encodeURIComponent(appId)}/bundle.js`;

  const res = await fetch(widgetUrl, {
    credentials: "omit",
    headers: { "ngrok-skip-browser-warning": "1" },
  });
  if (!res.ok) {
    throw new Error(`Widget not found [${res.status}]: ${widgetUrl}`);
  }

  const code = await res.text();
  const blob = new Blob([code], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);

  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Builds the host API object passed to widget.mount(container, host).
 * This is the complete and only interface between the widget and the outside world.
 */
function buildHost({ appId, shop, platformUrl }) {
  return {
    // ── Page context ─────────────────────────────────────────────────────────
    context: {
      shop,
      customerId: window.ShopifyAnalytics?.meta?.page?.customerId ?? null,
    },

    // ── Storefront API calls ──────────────────────────────────────────────────
    // Generic proxy to Shopify's public storefront JSON endpoints.
    // Widgets use this to read public product/collection data without going
    // through the platform backend.
    storefront: async (path) => {
      const url = `https://${shop}${path}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`[host.storefront] ${path} failed [${res.status}]`);
      }
      return res.json();
    },

    // ── Backend calls ─────────────────────────────────────────────────────────
    // Widget calls go through Shopify's App Proxy: the browser calls the shop's
    // own domain, Shopify appends an HMAC signature, then forwards to platform-back
    // which verifies it. Containers are never directly browser-accessible.
    //
    // Method dispatch: the served bundle has `window.__PLATFORM_CATALOG__ = [...]`
    // prepended by platform-back's bundle-storage saver. We look up the
    // architect-declared method per path and route GET-with-querystring or
    // POST-with-body accordingly. Default POST when the manifest is absent
    // or the path isn't listed — matches the pre-method-aware-SDK behaviour
    // and works for handler-internal routes that bypass the catalog.
    call: async (path, args) => {
      const catalog = (typeof window !== "undefined" && window.__PLATFORM_CATALOG__) || [];
      const entry = catalog.find((e) => e && e.path === path);
      const method = (entry && entry.method ? entry.method : "POST").toUpperCase();

      let url = `https://${shop}/apps/new-one-two/${encodeURIComponent(appId)}${path}`;
      let body;

      if (method === "GET") {
        // Encode args as query string. Skip null/undefined so optional
        // filters land as "absent param" not "present-but-empty".
        if (args && typeof args === "object") {
          const qs = new URLSearchParams();
          for (const [k, v] of Object.entries(args)) {
            if (v === undefined || v === null) continue;
            qs.append(k, String(v));
          }
          const s = qs.toString();
          if (s) url += `?${s}`;
        }
      } else {
        body = args !== undefined ? JSON.stringify(args) : undefined;
      }

      // Only set Content-Type when there's a body — sending it on GET is
      // harmless but non-pristine and can trigger an unnecessary CORS
      // preflight on the App Proxy round-trip.
      const headers = { "ngrok-skip-browser-warning": "1" };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      const res = await fetch(url, { method, headers, body });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`[host.call] ${method} ${path} failed [${res.status}]: ${text}`);
      }

      return res.json();
    },

    // ── Form helpers ──────────────────────────────────────────────────────────
    getFormData: (form) => Object.fromEntries(new FormData(form).entries()),
  };
}

