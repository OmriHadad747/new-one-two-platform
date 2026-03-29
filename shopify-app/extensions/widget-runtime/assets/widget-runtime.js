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

  try {
    const widgetModule = await fetchWidgetModule(platformUrl, shop, appId);
    const host = buildHost({ appId, shop, platformUrl });
    await widgetModule.mount(container, host);
  } catch (err) {
    console.error(`[widget-runtime] Failed to mount widget "${appId}":`, err);
  }
}

/**
 * Fetches the widget JS from the platform and imports it as an ES module.
 * We use a Blob URL so the browser treats it as a module.
 * Plain GET with no custom headers = simple CORS request, no preflight needed.
 */
async function fetchWidgetModule(platformUrl, shop, appId) {
  const widgetUrl = `${platformUrl}/widgets/${encodeURIComponent(shop)}/${encodeURIComponent(appId)}.js`;

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
    // Widget calls are proxied through the platform API, which forwards them
    // internally to the deployed container. Containers are not browser-accessible
    // (Docker-internal in dev, INGRESS_TRAFFIC_INTERNAL_ONLY in production).
    call: async (path, body) => {
      const proxyUrl = `${platformUrl}/widgets/${encodeURIComponent(shop)}/${encodeURIComponent(appId)}/widget${path}`;
      const res = await fetch(proxyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "1",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`[host.call] ${path} failed [${res.status}]: ${text}`);
      }

      return res.json();
    },

    // ── Form helpers ──────────────────────────────────────────────────────────
    getFormData: (form) => Object.fromEntries(new FormData(form).entries()),
  };
}

