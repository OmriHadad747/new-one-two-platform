"""
CHECK functions reused by 2+ artifact validators in `validation/`.

Unlike the parsers in `js_parse.py` / `sql_parse.py`, the helpers here
return findings (lists of error strings) and embed policy. Lifted out of
their original artifact validators because both widget and admin_ui shells
need them, and historically the email-send check was reachable from the
handler validator too.
"""

from __future__ import annotations

import re
from typing import List

from utils.static_validations.js_parse import top_level_keys_of


# ── document.* scoping (widget + admin_ui) ──────────────────────────────────
#
# Both widget and admin_ui shells render into a `container` DOM node. Freely
# reaching for document.* can leak outside the component (document.body /
# document.head appendChild), mutate the merchant's page (document.title,
# document.documentElement.style), or read/write sensitive state
# (document.cookie). We denylist those specific shapes and accept
# everything else — addEventListener, querySelector, getElementById,
# dispatchEvent, createElement are all legitimate.

DOCUMENT_DENYLIST: frozenset[str] = frozenset(
    {
        "body",  # document.body.appendChild leaks outside container
        "head",  # document.head.appendChild injects global styles
        "documentElement",  # document.documentElement.style mutates page root
        "cookie",  # security — reads/writes merchant session cookies
        "title",  # mutates the merchant's page title
        "write",  # catastrophic — rewrites the entire page
        "open",  # pairs with document.write
        "close",  # pairs with document.write
        "execCommand",  # legacy; prefer navigator.clipboard etc.
    }
)


def find_document_violations(js: str) -> List[str]:
    """
    Return a single actionable error naming the specific forbidden
    ``document.*`` properties used. Empty list when only safe shapes
    (addEventListener, querySelector, getElementById, createElement, etc.)
    appear. Reused by validate_widget_artifact and validate_admin_ui_artifact.
    """
    found = sorted(
        {
            m.group(1)
            for m in re.finditer(r"\bdocument\.([a-zA-Z_$][a-zA-Z0-9_$]*)", js)
            if m.group(1) in DOCUMENT_DENYLIST
        }
    )
    if not found:
        return []
    props = ", ".join(f"document.{p}" for p in found)
    return [
        f"forbidden DOM access: {props} — these shapes leak outside the "
        "component's container or mutate page-wide state. Use container.* for "
        "DOM the component owns. Safe document.* shapes are permitted: "
        "createElement / createTextNode (factories), addEventListener / "
        "removeEventListener / dispatchEvent (page events), querySelector / "
        "getElementById / querySelectorAll (reading the merchant's page)."
    ]


# ── setTimeout allowance (widget + admin_ui) ────────────────────────────────
#
# Accept calls whose SECOND argument is a numeric literal ≤ MAX_DEBOUNCE_MS.
# Reject everything else:
#   - Computed delays (setTimeout(fn, computedMs))   — can't verify the bound
#   - Long delays (setTimeout(fn, 5000))             — effectively a timer
#   - No explicit delay (setTimeout(fn))             — defaults to 0 but opens
#                                                       the door to patterns
#                                                       the validator can't inspect

MAX_DEBOUNCE_MS = 500


def find_setTimeout_violations(js: str) -> List[str]:
    """Return error strings for each disallowed setTimeout usage."""
    from utils.static_validations.js_parse import extract_settimeout_delays

    errs: List[str] = []
    delays = extract_settimeout_delays(js)

    for delay_str in delays:
        if delay_str is None:
            errs.append(
                "setTimeout call missing an explicit numeric delay argument — "
                "only setTimeout(fn, <literal ms ≤ 500>) is allowed"
            )
        elif not delay_str.isdigit():
            errs.append(
                f"setTimeout delay '{delay_str}' is not a numeric literal — "
                "only literal millisecond values ≤ 500 are allowed (debounce / throttle only)"
            )
        elif int(delay_str) > MAX_DEBOUNCE_MS:
            errs.append(
                f"setTimeout delay {delay_str}ms exceeds {MAX_DEBOUNCE_MS}ms — "
                "use event-driven patterns, not timers"
            )
    return errs


# ── deprecated email-send fields (handler) ──────────────────────────────────
#
# Fields the old email API used to accept — all of them have moved into the
# merchant-configured template, so a handler passing any of them is calling a
# deprecated shape that will be silently ignored (or worse, break when the
# merchant does configure their template and the handler's values override
# it). Only { to, data } are allowed.

DEPRECATED_EMAIL_FIELDS = frozenset(
    {"subject", "templateId", "template_id", "html", "body", "from"}
)


def find_email_send_violations(code: str) -> List[str]:
    """Flag ctx.services.email.send() calls that pass deprecated fields."""
    errs: List[str] = []
    pattern = re.compile(r"ctx\.(?:services\.)?email\.send\s*\(\s*")
    for match in pattern.finditer(code):
        obj_start = match.end()
        if obj_start >= len(code) or code[obj_start] != "{":
            continue  # non-object-literal argument (e.g. a variable) — skip
        keys = top_level_keys_of(code, obj_start)
        bad = sorted(keys & DEPRECATED_EMAIL_FIELDS)
        if bad:
            errs.append(
                f"ctx.services.email.send() passes forbidden field(s) {bad} — "
                "the platform owns subject/body/html/templateId/from. "
                "Only { to, data } is accepted; put dynamic values inside data."
            )
    return errs
