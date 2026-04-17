"""
Admin UI capability registry — reserved for future use.

No declarable admin-panel capabilities today. The admin UI's variable surface
(list / form views, App Bridge features like Toast / Modal / ResourcePicker)
is currently handled inline by the admin_ui generator based on the
adminApiCatalog shape.

When the first scoped admin capability appears, add it here and wire
`adminCapabilities` into the architect output shape and validator — the
plumbing mirrors widget.py.
"""

from __future__ import annotations

from collections import OrderedDict


ADMIN_CAPABILITIES: "OrderedDict[str, str]" = OrderedDict()

ALLOWED_ADMIN_CAPABILITIES: frozenset = frozenset(ADMIN_CAPABILITIES.keys())
