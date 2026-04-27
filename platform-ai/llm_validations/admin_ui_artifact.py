"""
Admin-UI-artifact validation — runs on the generated admin-panel JS.

Public entry point: validate_admin_ui_artifact.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from utils.static_validations.shared_checks import (
    find_document_violations as _find_document_violations,
    find_setTimeout_violations as _find_setTimeout_violations,
)


FORBIDDEN_ADMIN_UI_PATTERNS = [
    (
        r"\bexport\s+default\b",
        "export default is forbidden — use named export only: export function mount(container, bridge) { ... }",
    ),
    (
        r"\bimport\s+",
        "import statements are forbidden — admin UI must be self-contained vanilla JS with no imports",
    ),
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

    if not re.search(r"\bexport\s+function\s+mount\b", admin_ui_js):
        errors.append(
            "must export a named mount function: export function mount(container, bridge) { ... }"
        )

    for pattern, message in FORBIDDEN_ADMIN_UI_PATTERNS:
        if re.search(pattern, admin_ui_js):
            errors.append(message)

    # setTimeout is allowed only as a bounded debounce — check delays.
    errors.extend(_find_setTimeout_violations(admin_ui_js))

    # document.* denylist — reject shapes that leak outside the container or
    # mutate page-wide state; allow safe page reads/events.
    errors.extend(_find_document_violations(admin_ui_js))

    # bridge.call() paths must be in the admin catalog
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

    if re.search(r"\btenant[_-]?id\s*[:=]\s*['\"]", admin_ui_js, re.IGNORECASE):
        errors.append(
            "hardcoded tenant_id detected — read from bridge.context.tenantId instead"
        )

    has_explicit_submit = bool(
        re.search(
            r"type=[\"']submit[\"']|addEventListener\([\"']submit|\.submit\s*\(",
            admin_ui_js,
        )
    )
    has_form_input = bool(re.search(r"<input|<textarea|\bgetFormData\b", admin_ui_js))
    has_click_submit = bool(re.search(r"addEventListener\([\"']click", admin_ui_js))
    has_bridge_call = bool(re.search(r"\bbridge\.call\s*\(", admin_ui_js))
    if (
        has_explicit_submit or (has_click_submit and has_form_input)
    ) and not has_bridge_call:
        errors.append(
            "admin UI has a form action but never calls bridge.call() — collected data "
            "is silently discarded. Add a POST endpoint to adminApiCatalog and call it "
            "via bridge.call(path, data)."
        )

    # Status enum cross-check: any literal status string the UI references
    # (filter buttons, badge classes, conditional rendering) must be in the
    # union of every column-level enum the architect declared. Catches the
    # "always-empty filter bucket" failure mode described in Finding 6 of
    # docs/FINDINGS_DEFERRED_4_5_6.md.
    errors.extend(_check_admin_ui_enum_filters(admin_ui_js, db_contracts or []))

    return errors

def _check_admin_ui_enum_filters(
    admin_ui_js: str, db_contracts: List[Dict[str, Any]]
) -> List[str]:
    """
    Heuristic: look for status filter literals (`status === 'xxx'`,
    `data-status="xxx"`, `status: 'xxx'`) and reject any value that does
    not appear in some column-level enum.

    Cross-column union (rather than per-column): the UI may render the
    same set of buttons across multiple tables, and we don't have a
    reliable way to bind a literal to a specific dbContract column from
    the JS source. The union check still catches inventions like
    'converted' / 'skipped' that no column enums.
    """
    enum_union: set = set()
    enum_columns: set = set()
    for contract in db_contracts:
        for col in contract.get("columns") or []:
            enum_values = col.get("enum")
            if isinstance(enum_values, list) and enum_values:
                enum_union.update(enum_values)
                enum_columns.add((col.get("name") or "").lower())
    if not enum_union or not enum_columns:
        return []

    errors: List[str] = []
    seen: set = set()
    # Match status comparisons + data attributes + object keys for any
    # column whose name appears in an enum.
    for col_name in enum_columns:
        patterns = [
            rf"\b{re.escape(col_name)}\s*(?:===|==)\s*['\"]([^'\"]+)['\"]",
            rf"['\"]{re.escape(col_name)}['\"]\s*:\s*['\"]([^'\"]+)['\"]",
            rf"data-{re.escape(col_name)}\s*=\s*['\"]([^'\"]+)['\"]",
        ]
        for pattern in patterns:
            for literal in re.findall(pattern, admin_ui_js, re.IGNORECASE):
                if literal in enum_union or literal == "":
                    continue
                if literal.lower() in {"all", "any"}:
                    continue
                if literal in seen:
                    continue
                seen.add(literal)
                errors.append(
                    f"admin UI references {col_name}='{literal}' but the "
                    f"architect-declared enum union is {sorted(enum_union)!r}. "
                    "A filter or branch on this value will always be empty — "
                    "the handler never writes it. Either drop the reference "
                    "or extend the dbContracts column enum to include it."
                )
    return errors
