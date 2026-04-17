"""
Widget capability registry.

Variable surface the browser-side widget uses beyond the always-on
host.call(path, body) channel to the handler. Declared only for storefront
archetypes; the architect emits `widgetCapabilities: null` for backend-only
apps that have no widget at all.

The widget JIT (future) will map each entry here to a widget prompt section
and include it only when the capability appears in the architect's
declaration.
"""

from __future__ import annotations

from collections import OrderedDict


WIDGET_CAPABILITIES: "OrderedDict[str, str]" = OrderedDict(
    [
        (
            "storefront",
            "host.storefront(path) — widget reads public Shopify data client-side (products, collections, cart). Bypasses the handler entirely. Declare when the widget needs live storefront data the handler does not provide.",
        ),
    ]
)

ALLOWED_WIDGET_CAPABILITIES: frozenset = frozenset(WIDGET_CAPABILITIES.keys())
