"""
Shared infrastructure for cross-artifact handler validators.

The widget and admin cross-handler validators
(`llm_validations/cross_widget_handler.py`,
`llm_validations/cross_admin_handler.py`) have identical shape: scan the
client's `host.call(path, {fields})` / `bridge.call(path, {fields})`
invocations, scan the handler's `<router>.<method>("/path", async (req,
res) => {…})` route bodies, and cross-check field-name sets between
what the client sends and what the handler reads — from `req.body` for
POST routes or `req.query` for GET routes.

The architect catalog (`widgetApiCatalog` / `adminApiCatalog`) is the
source of truth for method per path; both surfaces consume it through
`build_method_map`, branch the slot via `slot_for_method`, and collect
fields via `collect_handler_fields` against the `req.body` / `req.query`
regexes here.

This module is pure structural extraction — no rule strings, no client-
specific labels (the surface modules add those when they format error
messages). When a third surface ships, it reuses these helpers; the
surface module owns only the regex anchors for its router + call-fn
shape, the public entry-point signature, and the error-message wording.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set


# ── Slot regexes — same shape, two slots ─────────────────────────────────────
# Both `req.body` and `req.query` support destructure (`const {a, b} =
# req.<slot>`) and direct-access (`req.<slot>.field`) shapes; the
# patterns below cover both.

REQ_BODY_DESTR_RE = re.compile(
    r"""(?:const|let|var)\s*\{([^}]+)\}\s*=\s*req\s*\.\s*body""",
    re.DOTALL,
)
REQ_BODY_FIELD_RE = re.compile(r"req\s*\.\s*body\s*\.\s*([a-zA-Z_]\w*)")
REQ_QUERY_DESTR_RE = re.compile(
    r"""(?:const|let|var)\s*\{([^}]+)\}\s*=\s*req\s*\.\s*query""",
    re.DOTALL,
)
REQ_QUERY_FIELD_RE = re.compile(r"req\s*\.\s*query\s*\.\s*([a-zA-Z_]\w*)")


# ── Catalog method map ───────────────────────────────────────────────────────


_VALID_METHODS = ("GET", "POST")


def build_method_map(
    catalog: Optional[List[Dict[str, Any]]],
) -> Dict[str, str]:
    """
    Build path → method map from the architect's catalog. Missing or
    invalid method silently defaults to POST — matches the SDK fallback
    for paths that bypass the catalog. (`arch_plan.py` is the upstream
    gate that should reject invalid methods loudly; this is defense in
    depth.)
    """
    method_map: Dict[str, str] = {}
    for entry in catalog or []:
        if not isinstance(entry, dict):
            continue
        path = entry.get("path")
        if not isinstance(path, str):
            continue
        raw_method = entry.get("method") or "POST"
        method = raw_method.upper() if isinstance(raw_method, str) else ""
        method_map[path] = method if method in _VALID_METHODS else "POST"
    return method_map


def slot_for_method(method: str) -> str:
    """`"GET"` → `"query"`; anything else (including `"POST"`) → `"body"`."""
    return "query" if method == "GET" else "body"


# ── Route-body extraction ────────────────────────────────────────────────────


def extract_route_bodies(
    handler_code: str, route_re: "re.Pattern[str]"
) -> Dict[str, str]:
    """
    For each `<router>.<method>("/path", async (req, res) => { ... })`
    match in `handler_code`, return a mapping of path → body contents.

    `route_re` MUST capture path as group 2 (group 1 is the HTTP method,
    informational only — the architect catalog drives method routing).
    The match must end on the opening `{` of the route body so we can
    walk balanced braces from there.

    When the same path appears with multiple methods (rare in generated
    code; one-method-per-path is the catalog norm), the last match wins.
    """
    route_bodies: Dict[str, str] = {}
    for m in route_re.finditer(handler_code):
        path = m.group(2)
        body_open = m.end() - 1  # index of the `{` we matched
        route_bodies[path] = _route_body(handler_code, body_open)
    return route_bodies


def _route_body(code: str, body_open: int) -> str:
    """
    Return the contents of a `{ ... }` block starting at `body_open` (the
    index of the opening `{`). Walks balanced braces, ignoring braces
    inside string / template literals (cheap heuristic — good enough for
    handler-style code that doesn't put unbalanced braces in strings).
    """
    depth = 0
    i = body_open
    n = len(code)
    in_str: Optional[str] = None
    while i < n:
        c = code[i]
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
                return code[body_open + 1 : i]
        i += 1
    return code[body_open + 1 :]  # unbalanced — return rest


# ── Handler-field collection ─────────────────────────────────────────────────


# Identifiers that look like object keys but are JS keywords / runtime
# globals — never treated as "fields" by the catalog ↔ code matchers.
# Same set as utils/static_validations/js_parse.py:NON_FIELD; duplicated
# here to keep the cross_handler module a single import site for the
# shared cross-validator surface.
from utils.static_validations.js_parse import NON_FIELD


def collect_handler_fields(body: str, slot: str) -> Set[str]:
    """
    Collect field names the handler reads from `slot` (`"body"` or
    `"query"`). Handles both destructure (`const {a, b} = req.<slot>`)
    and direct access (`req.<slot>.field`) patterns.
    """
    fields: Set[str] = set()
    if slot == "body":
        destr_re, field_re = REQ_BODY_DESTR_RE, REQ_BODY_FIELD_RE
    else:
        destr_re, field_re = REQ_QUERY_DESTR_RE, REQ_QUERY_FIELD_RE
    for d in destr_re.finditer(body):
        for tok in re.findall(r"\b([a-zA-Z_]\w*)\b", d.group(1)):
            if tok not in NON_FIELD:
                fields.add(tok)
    for d in field_re.finditer(body):
        fields.add(d.group(1))
    return fields
