"""
Widget-artifact validation — runs on the generated storefront widget JS.

Public entry point: validate_storefront_artifact.

document.* scoping and setTimeout discipline live in
utils.static_validations.shared_checks because they are reused by the
admin_ui validator (subagents/e_codegen_agent/admin_agent/validator.py)
with identical semantics.
"""

from __future__ import annotations

import re
from typing import Dict, List

from utils.static_validations.js_parse import (
    strip_comments_and_strings as _strip_comments_and_strings,
)
from utils.static_validations.shared_checks import (
    find_document_violations as _find_document_violations,
    find_setTimeout_violations as _find_setTimeout_violations,
)


FORBIDDEN_WIDGET_JS_PATTERNS = [
    (
        r"\bfetch\s*\(",
        "raw fetch() not allowed — use host.call() for backend requests or host.storefront() for Shopify public endpoints",
    ),
    (r"\bXMLHttpRequest\b", "XMLHttpRequest not allowed — use host.call()"),
    (r"\beval\s*\(", "eval() is not allowed"),
    (r"\bnew\s+Function\s*\(", "new Function() is not allowed"),
    (
        r"\bwindow\.(parent|top|opener|frames)\b",
        "window.parent/top/opener/frames cross-frame access is not allowed",
    ),
    # document.* scoping is enforced by _find_document_violations() — see the
    # shared denylist above. We do NOT ban the full document.* namespace:
    # addEventListener / querySelector / getElementById / dispatchEvent are
    # legitimate when the component needs page-level reads or events.
    (r"\bsetInterval\s*\(", "setInterval is not allowed"),
]


# ── document.* scoping — shared between widget and admin_ui validators ──────
#
# Both widget and admin_ui shells render into a `container` DOM node. Freely
# reaching for document.* can leak outside the component (document.body /
# document.head appendChild), mutate the merchant's page (document.title,
# document.documentElement.style), or read/write sensitive state
# (document.cookie). We denylist those specific shapes and accept
# everything else — addEventListener, querySelector, getElementById,
# dispatchEvent, createElement are all legitimate.
def validate_storefront_artifact(
    storefront: str,
    platform_api_catalog: List[Dict[str, str]],
) -> List[str]:
    """
    Validate the generated storefront widget ES module.
    Only runs for storefront_backend / storefront_backend_admin apps.
    """
    errors: List[str] = []

    if not storefront or not storefront.strip():
        return errors  # backend — no widget JS to validate

    # Single-file artifact: the revision agent's prompt forbids `===FILE:===`
    # markers in storefront / admin_ui (they're handler-bundle-only). If a
    # marker leaks in, the App Block runtime fails to evaluate the module
    # (`===` at file head is an ES-module syntax error) — silent storefront
    # breakage at deploy time with no actionable error. Run against the RAW
    # source: the marker is a literal token at line start, not something
    # scrubbing should erase.
    if re.search(r"^\s*===FILE:\s+", storefront, re.MULTILINE):
        errors.append(
            "storefront must be a single-file ES module — '===FILE: …===' "
            "bundle markers are not allowed (handler-bundle format leaked into "
            "widget output; see prompts/core/revision.py)"
        )

    # Scrub comments + string-literal contents BEFORE applying the token-
    # level denylists. A comment like `// don't use document.body` or an
    # error message like `'eval() is forbidden'` would otherwise FP every
    # regex below. Same pattern as handler_artifact._check_no_tenant_id_in_sql.
    # Path-arg extraction (host.call, host.storefront) and the form-submission
    # signal continue to use the RAW source — they need the literal string
    # contents inside the quotes that scrubbing would erase.
    scrubbed = _strip_comments_and_strings(storefront)

    if not re.search(r"\bexport\s+function\s+mount\b", scrubbed):
        errors.append(
            "must export a named mount function: export function mount(container, host) { ... }"
        )

    for pattern, message in FORBIDDEN_WIDGET_JS_PATTERNS:
        if re.search(pattern, scrubbed):
            errors.append(message)

    # setTimeout is allowed only as a bounded debounce — check delays.
    errors.extend(_find_setTimeout_violations(scrubbed))

    # document.* denylist — reject shapes that leak outside the container or
    # mutate page-wide state; allow safe page reads/events.
    errors.extend(_find_document_violations(scrubbed))

    # host.storefront() must use relative paths. Uses RAW source — the path
    # we want to inspect lives inside a string literal that scrubbing erases.
    storefront_calls = re.findall(
        r"""host\.storefront\s*\(\s*['"`]([^'"`]+)['"`]""", storefront
    )
    for path in storefront_calls:
        if path.startswith("http://") or path.startswith("https://"):
            errors.append(
                f"host.storefront() must use a relative path (e.g. '/products/x.js'), "
                f"not a full URL: '{path[:60]}'"
            )

    # host.call() paths must be in the catalog. Uses RAW source for the same
    # reason — the path is inside the literal that scrubbing erases.
    catalog_paths = {entry["path"] for entry in platform_api_catalog}
    called_paths = re.findall(r"""host\.call\s*\(\s*['"]([^'"]+)['"]""", storefront)
    for path in called_paths:
        if path not in catalog_paths:
            errors.append(
                f"host.call() references unlisted path '{path}'. "
                f"Allowed: {sorted(catalog_paths)}"
            )

    # Hardcoded tenant_id literal. Run against scrubbed source so a comment
    # like `// hardcoded tenant_id is forbidden` doesn't FP.
    if re.search(r"\btenant[_-]?id\s*[:=]\s*['\"]", scrubbed, re.IGNORECASE):
        errors.append("hardcoded tenant_id detected — read from host.context instead")

    # Identity persistence: never write `customerId` to localStorage. The
    # browser is shared across shoppers (public computers, family devices),
    # so a stored customerId is read by the next shopper as if it were theirs
    # — wrong-customer data, privacy breach class. host.context supplies it
    # fresh on every mount; no caching needed. Run against scrubbed source.
    if re.search(
        r"""localStorage\s*\.\s*setItem\s*\(\s*['"]customerId['"]""",
        scrubbed,
    ):
        errors.append(
            "localStorage.setItem('customerId', ...) is forbidden — host.context "
            "supplies customerId fresh on every mount. Storing it locally leaks "
            "the previous shopper's identity to the next one on shared browsers."
        )

    # Form submissions without backend wiring (silent data loss). Tightened
    # to the explicit-submit signal only — `<button type="submit">`,
    # `addEventListener("submit", …)`, `.submit()` — which is the
    # near-zero-FP shape. The earlier (click + input) heuristic was
    # FP-prone against legitimate read-only filter UIs and is delegated to
    # the LLM `agent_rules` validator instead. Run against the RAW source —
    # `type="submit"` lives inside an HTML-attribute string literal that
    # scrubbing erases, but we still want to detect it.
    has_explicit_submit = bool(
        re.search(
            r"""type=["']submit["']|addEventListener\(\s*["']submit["']|\.submit\s*\(""",
            storefront,
        )
    )
    has_host_call = bool(re.search(r"\bhost\.call\s*\(", scrubbed))
    if has_explicit_submit and not has_host_call:
        errors.append(
            "widget has an explicit form submission (type='submit' / submit listener / "
            ".submit()) but never calls host.call() — collected data is silently "
            "discarded. Add a POST endpoint to platformApiCatalog and call it via "
            "host.call(path, data) to persist the submission."
        )

    return errors
