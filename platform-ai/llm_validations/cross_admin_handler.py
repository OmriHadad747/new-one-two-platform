"""
Cross-artifact validation — admin UI field-shape vs handler routes.

Public entry point: validate_admin_handler_contract.

Scans the admin panel's `bridge.call(path, { field1, field2 })` invocations
and the handler's matching `adminRouter.<method>("/path", async (req, res) =>
{ … })` route bodies, and flags field-name mismatches between what the
panel sends and what the handler reads from `req.body`.

(Earlier revisions of this file targeted the legacy `ctx.adminPath` /
`ctx.adminBody` harness shape and silently matched nothing under the new
Express harness. This rewrite reads the Express `adminRouter.<method>(...)`
shape that handler_agent emits today.)
"""

from __future__ import annotations

import re
from typing import Dict, List

from utils.static_validations.js_parse import (
    NON_FIELD as _NON_FIELD,
    extract_call_keys as _extract_call_keys,
)


# ── Regex anchors ─────────────────────────────────────────────────────────────


# Admin-UI side: bridge.call('path', { field1: ..., field2 })
_ADMIN_CALL_RE = re.compile(
    r"bridge\.call\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*\{([^}]*)\}",
    re.DOTALL,
)

# Handler side: adminRouter.<method>("/path", async (req, res) => { ... })
# The route body opens with the `{` after the arrow; we capture the open-brace
# index via group span and find the matching close via balanced-brace scan.
_ADMIN_ROUTE_RE = re.compile(
    r"""adminRouter\s*\.\s*\w+\s*\(\s*['"]([^'"]+)['"]\s*,\s*"""
    r"""(?:async\s*)?\([^)]*\)\s*=>\s*\{""",
    re.DOTALL,
)

# Inside a route body: `const { a, b } = req.body` and similar destructure.
_REQ_BODY_DESTR_RE = re.compile(
    r"""(?:const|let|var)\s*\{([^}]+)\}\s*=\s*req\s*\.\s*body""",
    re.DOTALL,
)

# Inside a route body: `req.body.fieldName` direct accesses.
_REQ_BODY_FIELD_RE = re.compile(r"req\s*\.\s*body\s*\.\s*([a-zA-Z_]\w*)")


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


def validate_admin_handler_contract(
    admin_ui_js: str,
    handler_code: str,
) -> Dict[str, List[str]]:
    """
    Check that field names the admin panel sends via bridge.call() match
    what the handler reads from req.body for the same adminRouter route.

    Returns {generator_name: [errors]} attributed to both sides so both
    receive the mismatch on retry. Route existence is pre-checked by
    validate_handler_artifact's `_validate_admin_router`.

    Skipped silently when:
      - either artifact is empty;
      - the panel's bridge.call uses a template-literal path
        (bridge.call(`/x/${id}`, …)) — dynamic paths can't be statically matched;
      - the route body opens with a brace pattern this scanner can't bound
        (rare; falls back to "no destructure found" → no false flag).
    """
    if not admin_ui_js or not handler_code:
        return {}

    errors: Dict[str, List[str]] = {}

    # Build a path → route-body map from the handler bundle once, then walk
    # every bridge.call() in the panel against it.
    route_bodies: Dict[str, str] = {}
    for m in _ADMIN_ROUTE_RE.finditer(handler_code):
        path = m.group(1)
        body_open = m.end() - 1  # index of the `{` we matched
        route_bodies[path] = _route_body(handler_code, body_open)

    for m in _ADMIN_CALL_RE.finditer(admin_ui_js):
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

        # Collect every field the handler reads from req.body — both
        # destructure and direct access shapes.
        handler_fields: set[str] = set()
        for d in _REQ_BODY_DESTR_RE.finditer(body):
            for tok in re.findall(r"\b([a-zA-Z_]\w*)\b", d.group(1)):
                if tok not in _NON_FIELD:
                    handler_fields.add(tok)
        for d in _REQ_BODY_FIELD_RE.finditer(body):
            handler_fields.add(d.group(1))

        if not handler_fields:
            # Handler accepted the route but never reads the body. That's a
            # real cross-artifact drift even when no specific field is
            # missing — surface it.
            msg = (
                f"admin UI sends {sorted(sent_fields)} to '{path}' but handler's "
                f"adminRouter route never reads `req.body` — collected data is "
                f"silently discarded"
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("admin_ui", []).append(msg)
            continue

        missing = sent_fields - handler_fields
        if missing:
            msg = (
                f"admin UI sends field(s) {sorted(missing)} to '{path}' but handler "
                f"reads {sorted(handler_fields)} from req.body — field-name "
                f"mismatch. Align both sides to the adminApiCatalog requestShape."
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("admin_ui", []).append(msg)

    return errors
