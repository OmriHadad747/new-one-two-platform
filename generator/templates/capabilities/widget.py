"""
Widget capability registry.

Variable surface the browser-side widget uses beyond the always-on
host.call(path, body) channel to the handler. Declared only for storefront
archetypes; the architect emits `widgetCapabilities: null` for backend-only
apps that have no widget at all.

Each entry is a Capability with a short architect-facing description and a
full widget-prompt docs block. The widget JIT in widget_js_agent.py injects
.docs for every declared entry, mirroring the handler JIT pattern.
"""

from __future__ import annotations

from collections import OrderedDict

from ._types import Capability


WIDGET_CAPABILITIES: "OrderedDict[str, Capability]" = OrderedDict(
    [
        (
            "storefront",
            Capability(
                short="host.storefront(path) — widget reads public Shopify data client-side (products, collections, cart). Bypasses the handler entirely. Declare when the widget needs live storefront data the handler does not provide.",
                docs="""\
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
""",
            ),
        ),
    ]
)

ALLOWED_WIDGET_CAPABILITIES: frozenset = frozenset(WIDGET_CAPABILITIES.keys())
