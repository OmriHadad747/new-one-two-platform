"""
Cross-artifact validation — widget JS field-shape vs handler routes.

Public entry point: validate_widget_handler_contract.

Scans the widget's `host.call(path, { field1, field2 })` invocations and
the handler's matching `widgetRouter.<method>("/path", async (req, res)
=> {…})` route bodies, and flags field-name mismatches between what the
widget sends and what the handler reads from the appropriate request
slot:

  - For paths the architect's catalog declares as POST: handler reads
    from `req.body` (destructure or direct access).
  - For paths the catalog declares as GET: handler reads from `req.query`.
    The host.call SDK encodes args as a query string for GET and as JSON
    body for POST — see widget-runtime.js call() implementation.

Catalog method is supplied by the caller via `platform_api_catalog` (the
architect's full widgetApiCatalog with `path` + `method`); paths absent
from the catalog default to POST, matching the SDK's fallback behaviour
for handler-internal routes that bypass the catalog.

The shared shape (method-map, route-body extraction, field-collection
across `req.body` / `req.query`) lives in
`utils/static_validations/cross_handler.py`; this module owns only the
widget-specific regex anchors, the public entry-point, and the error
message wording.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from utils.static_validations.cross_handler import (
    build_method_map,
    collect_handler_fields,
    extract_route_bodies,
    slot_for_method,
)
from utils.static_validations.js_parse import extract_call_keys as _extract_call_keys


# Widget side: host.call('path', { field1: ..., field2 })
_WIDGET_CALL_RE = re.compile(
    r"host\.call\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*\{([^}]*)\}",
    re.DOTALL,
)

# Handler side: widgetRouter.<method>("/path", async (req, res) => { ... })
# Captures method (group 1) and path (group 2) so extract_route_bodies can
# key on path; the method capture is informational — the architect catalog
# is the source-of-truth method.
_WIDGET_ROUTE_RE = re.compile(
    r"""widgetRouter\s*\.\s*(\w+)\s*\(\s*['"]([^'"]+)['"]\s*,\s*"""
    r"""(?:async\s*)?\([^)]*\)\s*=>\s*\{""",
    re.DOTALL,
)


def validate_widget_handler_contract(
    storefront: str,
    handler_code: str,
    platform_api_catalog: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, List[str]]:
    """
    Check that field names the widget sends via host.call() match what
    the handler reads from `req.body` (POST routes) or `req.query` (GET
    routes) for the same widgetRouter route.

    `platform_api_catalog` is the architect's `widgetApiCatalog` — the
    `method` field per row drives whether the handler should read body
    vs query. When the catalog is absent or a path is not listed,
    defaults to POST (matches the host.call SDK fallback for routes that
    bypass the catalog).

    Returns {generator_name: [errors]} attributed to both sides so both
    receive the mismatch on retry. Route existence is pre-checked by
    validate_handler_artifact's `_validate_widget_router`.

    Skipped silently when:
      - either artifact is empty;
      - the widget's host.call uses a template-literal path
        (host.call(`/x/${id}`, …)) — dynamic paths can't be statically matched;
      - the route body opens with a brace pattern this scanner can't
        bound (rare; falls back to "no fields found" → no false flag).
    """
    if not storefront or not handler_code:
        return {}

    errors: Dict[str, List[str]] = {}
    method_map = build_method_map(platform_api_catalog)
    route_bodies = extract_route_bodies(handler_code, _WIDGET_ROUTE_RE)

    for m in _WIDGET_CALL_RE.finditer(storefront):
        path = m.group(1)
        body_block = m.group(2)

        sent_fields = _extract_call_keys(body_block)
        if not sent_fields:
            continue

        body = route_bodies.get(path)
        if body is None:
            # Route absence is reported by validate_handler_artifact;
            # skip here to avoid double-reporting the same drift.
            continue

        method = method_map.get(path, "POST")
        slot = slot_for_method(method)
        slot_label = f"req.{slot}"
        handler_fields = collect_handler_fields(body, slot)

        if not handler_fields:
            msg = (
                f"widget sends {sorted(sent_fields)} to '{path}' "
                f"({method}) but handler's widgetRouter route never reads "
                f"`{slot_label}` — collected data is silently discarded"
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("storefront", []).append(msg)
            continue

        missing = sent_fields - handler_fields
        if missing:
            msg = (
                f"widget sends field(s) {sorted(missing)} to '{path}' "
                f"({method}) but handler reads {sorted(handler_fields)} "
                f"from {slot_label} — field-name mismatch. Align both "
                f"sides to the widgetApiCatalog requestShape."
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("storefront", []).append(msg)

    return errors
