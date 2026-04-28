"""
Cross-artifact validation — widget JS field-shape vs handler routes.

Public entry point: validate_widget_handler_contract.

Scans the widget's `host.call(path, { field1, field2 })` invocations and the
handler's matching `widgetRouter.<method>("/path", async (req, res) => {…})`
route bodies, and flags field-name mismatches between what the widget sends
and what the handler reads from the appropriate request slot:

  - For paths the architect's catalog declares as POST: handler reads
    from `req.body` (destructure or direct access).
  - For paths the catalog declares as GET: handler reads from `req.query`.
    The host.call SDK encodes args as a query string for GET and as JSON
    body for POST — see widget-runtime.js call() implementation.

Catalog method is supplied by the caller via `platform_api_catalog` (the
architect's full widgetApiCatalog with `path` + `method`); paths absent
from the catalog default to POST, matching the SDK's fallback behaviour
for handler-internal routes that bypass the catalog.

(Earlier revisions of this file targeted the legacy `ctx.widgetPath` /
`ctx.widgetBody` harness shape and silently matched nothing under the new
Express harness. The current shape supports both GET and POST routes
correctly.)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from utils.static_validations.js_parse import (
    NON_FIELD as _NON_FIELD,
    extract_call_keys as _extract_call_keys,
)


# ── Regex anchors ─────────────────────────────────────────────────────────────


# Widget side: host.call('path', { field1: ..., field2 })
_WIDGET_CALL_RE = re.compile(
    r"host\.call\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*\{([^}]*)\}",
    re.DOTALL,
)

# Handler side: widgetRouter.<method>("/path", async (req, res) => { ... })
# Captures method (group 1) and path (group 2) so we can map per-path to
# the right req.body / req.query check.
_WIDGET_ROUTE_RE = re.compile(
    r"""widgetRouter\s*\.\s*(\w+)\s*\(\s*['"]([^'"]+)['"]\s*,\s*"""
    r"""(?:async\s*)?\([^)]*\)\s*=>\s*\{""",
    re.DOTALL,
)

# req.body and req.query destructure / direct-access — same shape, two slots.
_REQ_BODY_DESTR_RE = re.compile(
    r"""(?:const|let|var)\s*\{([^}]+)\}\s*=\s*req\s*\.\s*body""",
    re.DOTALL,
)
_REQ_BODY_FIELD_RE = re.compile(r"req\s*\.\s*body\s*\.\s*([a-zA-Z_]\w*)")
_REQ_QUERY_DESTR_RE = re.compile(
    r"""(?:const|let|var)\s*\{([^}]+)\}\s*=\s*req\s*\.\s*query""",
    re.DOTALL,
)
_REQ_QUERY_FIELD_RE = re.compile(r"req\s*\.\s*query\s*\.\s*([a-zA-Z_]\w*)")


def _route_body(handler_code: str, body_open: int) -> str:
    """
    Return the contents of a `{ ... }` block starting at `body_open` (the
    index of the opening `{`). Walks balanced braces, ignoring braces inside
    string / template literals (cheap heuristic — good enough for handler-
    style code that doesn't put unbalanced braces in strings).
    """
    depth = 0
    i = body_open
    n = len(handler_code)
    in_str: str | None = None
    while i < n:
        c = handler_code[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in ("'", '"', "`"):
            in_str = c
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return handler_code[body_open + 1 : i]
        i += 1
    return handler_code[body_open + 1 :]  # unbalanced — return rest


def _build_method_map(
    platform_api_catalog: Optional[List[Dict[str, Any]]],
) -> Dict[str, str]:
    """
    Build path → method map from the architect's catalog. Default POST when
    method is missing or invalid (matches the SDK's fallback behaviour for
    paths that bypass the catalog).
    """
    method_map: Dict[str, str] = {}
    for entry in platform_api_catalog or []:
        path = entry.get("path") if isinstance(entry, dict) else None
        if not isinstance(path, str):
            continue
        method = (entry.get("method") or "POST").upper()
        method_map[path] = method if method in ("GET", "POST") else "POST"
    return method_map


def _collect_handler_fields(body: str, slot: str) -> set:
    """
    Collect field names the handler reads from `slot` (`body` or `query`).
    Handles both destructure (`const {a, b} = req.<slot>`) and direct
    access (`req.<slot>.field`) patterns.
    """
    handler_fields: set = set()
    if slot == "body":
        destr_re, field_re = _REQ_BODY_DESTR_RE, _REQ_BODY_FIELD_RE
    else:
        destr_re, field_re = _REQ_QUERY_DESTR_RE, _REQ_QUERY_FIELD_RE
    for d in destr_re.finditer(body):
        for tok in re.findall(r"\b([a-zA-Z_]\w*)\b", d.group(1)):
            if tok not in _NON_FIELD:
                handler_fields.add(tok)
    for d in field_re.finditer(body):
        handler_fields.add(d.group(1))
    return handler_fields


def validate_widget_handler_contract(
    widget_js: str,
    handler_code: str,
    platform_api_catalog: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, List[str]]:
    """
    Check that field names the widget sends via host.call() match what the
    handler reads from `req.body` (POST routes) or `req.query` (GET routes)
    for the same widgetRouter route.

    `platform_api_catalog` is the architect's `widgetApiCatalog` — the
    `method` field per row drives whether the handler should read body
    vs query. When the catalog is absent or a path is not listed, defaults
    to POST (matches the host.call SDK fallback for routes that bypass
    the catalog).

    Returns {generator_name: [errors]} attributed to both sides so both
    receive the mismatch on retry. Route existence is pre-checked by
    validate_handler_artifact's `_validate_widget_router`.

    Skipped silently when:
      - either artifact is empty;
      - the widget's host.call uses a template-literal path
        (host.call(`/x/${id}`, …)) — dynamic paths can't be statically matched;
      - the route body opens with a brace pattern this scanner can't bound
        (rare; falls back to "no fields found" → no false flag).
    """
    if not widget_js or not handler_code:
        return {}

    errors: Dict[str, List[str]] = {}
    method_map = _build_method_map(platform_api_catalog)

    # Build path → route-body map from the handler bundle once, then walk
    # every host.call() in the widget against it.
    route_bodies: Dict[str, str] = {}
    for m in _WIDGET_ROUTE_RE.finditer(handler_code):
        # group(1) is the HTTP method (get/post/etc.) — informational only;
        # we use the architect catalog for the source-of-truth method.
        path = m.group(2)
        body_open = m.end() - 1  # index of the `{` we matched
        route_bodies[path] = _route_body(handler_code, body_open)

    for m in _WIDGET_CALL_RE.finditer(widget_js):
        path = m.group(1)
        body_block = m.group(2)

        sent_fields = _extract_call_keys(body_block)
        if not sent_fields:
            continue

        body = route_bodies.get(path)
        if body is None:
            # Route absence is reported by validate_handler_artifact; skip here
            # to avoid double-reporting the same drift to both generators.
            continue

        method = method_map.get(path, "POST")
        slot = "query" if method == "GET" else "body"
        slot_label = "req.query" if slot == "query" else "req.body"
        handler_fields = _collect_handler_fields(body, slot)

        if not handler_fields:
            # Handler accepted the route but never reads from the slot the
            # SDK populates for this method. Real cross-artifact drift —
            # data the widget sends is silently discarded.
            msg = (
                f"widget sends {sorted(sent_fields)} to '{path}' "
                f"({method}) but handler's widgetRouter route never reads "
                f"`{slot_label}` — collected data is silently discarded"
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("widget_js", []).append(msg)
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
            errors.setdefault("widget_js", []).append(msg)

    return errors
