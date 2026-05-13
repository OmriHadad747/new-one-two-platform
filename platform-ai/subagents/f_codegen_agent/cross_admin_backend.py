"""
Cross-artifact validation — admin UI field-shape vs handler routes.

Public entry point: validate_admin_backend_contract.

Scans the admin panel's `bridge.call(path, { field1, field2 })`
invocations and the handler's matching `adminRouter.<method>("/path",
async (req, res) => {…})` route bodies, and flags field-name mismatches
between what the panel sends and what the handler reads from the
appropriate request slot:

  - For paths the architect's catalog declares as POST: handler reads
    from `req.body` (destructure or direct access).
  - For paths the catalog declares as GET: handler reads from `req.query`.
    The bridge.call SDK encodes args as a query string for GET and as
    JSON body for POST — see AdminShell.tsx call() implementation.

Catalog method is supplied by the caller via `admin_api_catalog`; paths
absent from the catalog default to POST, matching the SDK fallback.

The shared shape (method-map, route-body extraction, field-collection
across `req.body` / `req.query`) lives in
`utils/static_validations/cross_handler.py`; this module owns only the
admin-specific regex anchors, the public entry-point, and the error
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

# Admin-UI side: bridge.call('path', { field1: ..., field2 })
_ADMIN_CALL_RE = re.compile(
    r"bridge\.call\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*\{([^}]*)\}",
    re.DOTALL,
)

# Handler side: adminRouter.<method>("/path", async (req, res) => { ... })
# Captures method (group 1) and path (group 2) so extract_route_bodies can
# key on path; the method capture is informational — the architect catalog
# is the source-of-truth method.
_ADMIN_ROUTE_RE = re.compile(
    r"""adminRouter\s*\.\s*(\w+)\s*\(\s*['"]([^'"]+)['"]\s*,\s*"""
    r"""(?:async\s*)?\([^)]*\)\s*=>\s*\{""",
    re.DOTALL,
)


def validate_admin_backend_contract(
    admin_ui_js: str,
    handler_code: str,
    admin_api_catalog: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, List[str]]:
    """
    Check that field names the admin panel sends via bridge.call() match
    what the handler reads from `req.body` (POST routes) or `req.query`
    (GET routes) for the same adminRouter route.

    `admin_api_catalog` is the architect's `adminApiCatalog` — the
    `method` field per row drives whether the handler should read body
    vs query. When the catalog is absent or a path is not listed,
    defaults to POST (matches the bridge.call SDK fallback).

    Returns {generator_name: [errors]} attributed to both sides so both
    receive the mismatch on retry. Route existence is pre-checked by
    validate_backend_artifact's `_validate_admin_router`.

    Skipped silently when:
      - either artifact is empty;
      - the panel's bridge.call uses a template-literal path
        (bridge.call(`/x/${id}`, …)) — dynamic paths can't be statically matched;
      - the route body opens with a brace pattern this scanner can't
        bound (rare; falls back to "no fields found" → no false flag).
    """
    if not admin_ui_js or not handler_code:
        return {}

    errors: Dict[str, List[str]] = {}
    method_map = build_method_map(admin_api_catalog)
    route_bodies = extract_route_bodies(handler_code, _ADMIN_ROUTE_RE)

    for m in _ADMIN_CALL_RE.finditer(admin_ui_js):
        path = m.group(1)
        body_block = m.group(2)

        sent_fields = _extract_call_keys(body_block)
        if not sent_fields:
            continue

        body = route_bodies.get(path)
        if body is None:
            # Route absence is reported by validate_backend_artifact;
            # skip here to avoid double-reporting the same drift.
            continue

        method = method_map.get(path, "POST")
        slot = slot_for_method(method)
        slot_label = f"req.{slot}"
        handler_fields = collect_handler_fields(body, slot)

        if not handler_fields:
            msg = (
                f"admin UI sends {sorted(sent_fields)} to '{path}' "
                f"({method}) but handler's adminRouter route never reads "
                f"`{slot_label}` — collected data is silently discarded"
            )
            errors.setdefault("backend", []).append(msg)
            errors.setdefault("admin_ui", []).append(msg)
            continue

        missing = sent_fields - handler_fields
        if missing:
            msg = (
                f"admin UI sends field(s) {sorted(missing)} to '{path}' "
                f"({method}) but handler reads {sorted(handler_fields)} "
                f"from {slot_label} — field-name mismatch. Align both "
                f"sides to the adminApiCatalog requestShape."
            )
            errors.setdefault("backend", []).append(msg)
            errors.setdefault("admin_ui", []).append(msg)

    return errors
