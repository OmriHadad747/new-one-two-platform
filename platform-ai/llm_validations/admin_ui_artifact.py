"""
Admin-UI-artifact validation — runs on the generated admin-panel JS.

Public entry point: validate_admin_ui_artifact.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from utils.static_validations.js_parse import (
    strip_comments_and_strings as _strip_comments_and_strings,
)
from utils.static_validations.shared_checks import (
    find_document_violations as _find_document_violations,
    find_setTimeout_violations as _find_setTimeout_violations,
)


# `import` and `export default` are not in this list — the Shopify Admin
# iframe loads the panel as an ES module via `<script type="module">`, and
# any bare `import` fails to resolve at load time. That's a downstream
# fail-fast gate; matching the widget surface (which relies on the App
# Block runtime to do the same), we treat both as `no (paranoid)` and
# leave the regex out. agent_rules covers semantic drift inside the module.
FORBIDDEN_ADMIN_UI_PATTERNS = [
    (
        r"\bfetch\s*\(",
        "raw fetch() not allowed — use bridge.call() for backend requests",
    ),
    (r"\bXMLHttpRequest\b", "XMLHttpRequest not allowed — use bridge.call()"),
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

def validate_admin_ui_artifact(
    admin_ui_js: str,
    admin_api_catalog: List[Dict[str, str]],
    db_contracts: Optional[List[Dict[str, Any]]] = None,
) -> List[str]:
    """Validate the generated Admin UI ES module (storefront_backend_admin only)."""
    errors: List[str] = []

    if not admin_ui_js or not admin_ui_js.strip():
        return errors

    # Scrub comments + string-literal contents BEFORE applying token-level
    # denylists. A comment like `// don't use document.body` or an error
    # message like `'eval() is forbidden'` would otherwise FP every regex
    # below. Same pattern as widget_artifact.py + handler_artifact's
    # _check_no_tenant_id_in_sql.
    # Path-arg extraction (bridge.call) and the form-submission `type="submit"`
    # HTML-attribute signal continue to use the RAW source — they need the
    # literal contents inside the quotes that scrubbing would erase.
    scrubbed = _strip_comments_and_strings(admin_ui_js)

    if not re.search(r"\bexport\s+function\s+mount\b", scrubbed):
        errors.append(
            "must export a named mount function: export function mount(container, bridge) { ... }"
        )

    for pattern, message in FORBIDDEN_ADMIN_UI_PATTERNS:
        if re.search(pattern, scrubbed):
            errors.append(message)

    # setTimeout is allowed only as a bounded debounce — check delays.
    errors.extend(_find_setTimeout_violations(scrubbed))

    # document.* denylist — reject shapes that leak outside the container or
    # mutate page-wide state; allow safe page reads/events.
    errors.extend(_find_document_violations(scrubbed))

    # bridge.call() paths must be in the admin catalog. Uses RAW source —
    # the path is inside the literal that scrubbing erases.
    if admin_api_catalog:
        catalog_paths = {entry["path"] for entry in admin_api_catalog}
        called_paths = re.findall(
            r"""bridge\.call\s*\(\s*['"]([^'"]+)['"]""", admin_ui_js
        )
        for path in called_paths:
            if path not in catalog_paths:
                errors.append(
                    f"bridge.call() references unlisted path '{path}'. "
                    f"Allowed: {sorted(catalog_paths)}"
                )

    if re.search(r"\btenant[_-]?id\s*[:=]\s*['\"]", scrubbed, re.IGNORECASE):
        errors.append(
            "hardcoded tenant_id detected — read from bridge.context.tenantId instead"
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
            admin_ui_js,
        )
    )
    has_bridge_call = bool(re.search(r"\bbridge\.call\s*\(", admin_ui_js))
    if has_explicit_submit and not has_bridge_call:
        errors.append(
            "admin UI has an explicit form submission (type='submit' / submit listener / "
            ".submit()) but never calls bridge.call() — collected data is silently "
            "discarded. Add a POST endpoint to adminApiCatalog and call it via "
            "bridge.call(path, data)."
        )

    # Status-enum cross-check (formerly `_check_admin_ui_enum_filters`)
    # was reclassified to `llm` and removed from the static layer. The
    # check failed three of four bars: it had non-trivial FP risk
    # (UI-only `data-status="loading"` / `data-status="submitting"`,
    # error messages embedding literal comparisons), the failure mode
    # (always-empty filter bucket) was a UX bug rather than catastrophic,
    # and the canonical detection requires distinguishing UI-state
    # attributes from dbContracts-column filter attributes — semantic
    # work agent_rules can do but a regex cannot. See ADMIN_UI_RULES.md
    # row 23 (now llm). The `_format_state_machine` and
    # `_format_column_enums` user-prompt scaffolding in admin_ui_agent.py
    # remains in place — that's the prevention side; agent_rules is the
    # detection side.

    return errors

