"""
Widget capability registry.

Variable surface the browser-side widget uses beyond the always-on
host.call(path, body) channel to the handler. Declared only for storefront
archetypes; the architect emits `widgetCapabilities: null` for backend-only
apps that have no widget at all.

Each entry is a Capability with a short architect-facing description and
(once the widget JIT exists) a full widget-prompt docs block. Today the
widget generator does not consume docs — `.docs` is set but informational
only; widget JIT is the follow-up work.
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
backend handler. Do not try to proxy storefront reads through host.call().\
""",
            ),
        ),
    ]
)

ALLOWED_WIDGET_CAPABILITIES: frozenset = frozenset(WIDGET_CAPABILITIES.keys())
