"""
shopify_storefront capability — Shopify Storefront API (public data).

Exposed via two distinct entry points, one per surface:
  handler → shopify.storefront(query, variables?) — server-side, via src/lib/shopify.ts
  widget  → host.storefront(path) — client-side, via the App Block host shim

Per-agent views:
  HANDLER_ARCHITECT / HANDLER_DOCS — server-side server read (declared in handlerCapabilities)
  WIDGET_ARCHITECT  / WIDGET_DOCS  — client-side read from the shopper's browser
                                     (declared in widgetCapabilities)
"""

# ── Handler view (server-side) ─────────────────────────────────────────────────

HANDLER_ARCHITECT = (
    "shopify.storefront(query, variables?) — server-side Shopify Storefront API "
    "(public data) via the template's src/lib/shopify.ts helper. "
    "Declare when the handler itself needs public storefront data server-side "
    "(e.g. product-by-handle lookups inside a webhook or cron)."
)

HANDLER_DOCS = """\
── shopify.storefront (server-side Storefront API) ──────────

Same helper as REST / Admin GraphQL:

  import { shopifyClientFor } from "../lib/shopify.js";
  const shopify = shopifyClientFor(req.platform!);

shopify.storefront(query: string, variables?: object) → Promise<any>
  Shopify Storefront API (public GraphQL). Uses the Storefront Access
  Token stored at OAuth time.
  The helper unwraps { data: ... } — access fields directly on the
  result.
  Use this for publicly available storefront data the handler needs
  server-side (e.g. product-by-handle lookups during a webhook or cron
  job). Widget code reads storefront data client-side — the handler's
  storefront access is for server-side-only paths.
  Example:
    const data = await shopify.storefront(
      `query GetProduct($handle: String!) {
        productByHandle(handle: $handle) {
          id
          title
          variants(first: 10) { nodes { id availableForSale } }
        }
      }`,
      { handle: <product_handle> },
    );\
"""

# ── Widget view (client-side) ──────────────────────────────────────────────────

WIDGET_ARCHITECT = (
    "host.storefront(path) — widget reads public Shopify data client-side "
    "(products, collections, cart). Bypasses the handler entirely. "
    "Declare when the widget needs live storefront data the handler does not provide."
)

WIDGET_DOCS = """\
── host.storefront (client-side Storefront reads) ───────────

host.storefront(relativePath) → Promise<any>
  Fetches public Shopify storefront endpoints (same-origin, no auth required).
  Common paths:
    '/products/${handle}.js'       → full product JSON including variants[].available
    '/collections/${handle}.js'    → collection with products
    '/cart.js'                     → current cart state

The widget calls host.storefront() directly — these requests do NOT touch the
backend handler. Do not try to proxy storefront reads through host.call().

URL access — read the current page URL to build storefront paths:
  location.pathname — e.g. "/products/my-handle", "/collections/sale"
  location.search   — e.g. "?variant=12345"
  These are the ONLY browser globals you may read for page context; all other
  window.* / document.* access rules from the base prompt still apply.

DECISION RULE — host.call vs host.storefront:
  Public Shopify data (product details, variant availability, pricing, cart)
    → host.storefront(relativePath)
  Your backend (DB state, Admin-API-only data, writes)
    → host.call(path, body)

Rule: host.storefront(path) must use a relative path, never a full URL.
Rule: host.storefront() paths are Shopify's public paths — they are NOT listed
  in the platformApiCatalog. Only host.call() paths come from the catalog.\
"""
