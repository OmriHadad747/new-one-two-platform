"""
Widget-artifact validation — runs on the generated storefront widget JS.

Public entry point: validate_widget_artifact.

document.* scoping and setTimeout discipline live in
utils.static_validations.shared_checks because they are reused by the
admin_ui validator with identical semantics.
"""

from __future__ import annotations

import re
from typing import Dict, List

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
def validate_widget_artifact(
    widget_js: str,
    platform_api_catalog: List[Dict[str, str]],
) -> List[str]:
    """
    Validate the generated storefront widget ES module.
    Only runs for storefront_backend / storefront_backend_admin apps.
    """
    errors: List[str] = []

    if not widget_js or not widget_js.strip():
        return errors  # backend — no widget JS to validate

    if not re.search(r"\bexport\s+function\s+mount\b", widget_js):
        errors.append(
            "must export a named mount function: export function mount(container, host) { ... }"
        )

    for pattern, message in FORBIDDEN_WIDGET_JS_PATTERNS:
        if re.search(pattern, widget_js):
            errors.append(message)

    # setTimeout is allowed only as a bounded debounce — check delays.
    errors.extend(_find_setTimeout_violations(widget_js))

    # document.* denylist — reject shapes that leak outside the container or
    # mutate page-wide state; allow safe page reads/events.
    errors.extend(_find_document_violations(widget_js))

    # host.storefront() must use relative paths
    storefront_calls = re.findall(
        r"""host\.storefront\s*\(\s*['"`]([^'"`]+)['"`]""", widget_js
    )
    for path in storefront_calls:
        if path.startswith("http://") or path.startswith("https://"):
            errors.append(
                f"host.storefront() must use a relative path (e.g. '/products/x.js'), "
                f"not a full URL: '{path[:60]}'"
            )

    # host.call() paths must be in the catalog
    catalog_paths = {entry["path"] for entry in platform_api_catalog}
    called_paths = re.findall(r"""host\.call\s*\(\s*['"]([^'"]+)['"]""", widget_js)
    for path in called_paths:
        if path not in catalog_paths:
            errors.append(
                f"host.call() references unlisted path '{path}'. "
                f"Allowed: {sorted(catalog_paths)}"
            )

    if re.search(r"\btenant[_-]?id\s*[:=]\s*['\"]", widget_js, re.IGNORECASE):
        errors.append("hardcoded tenant_id detected — read from host.context instead")

    # Detect form submissions: either an explicit submit button/listener, or a button
    # click listener combined with a form input — both indicate the widget is collecting
    # data and attempting to send it somewhere.
    has_explicit_submit = bool(
        re.search(
            r"type=[\"']submit[\"']|addEventListener\([\"']submit|\.submit\s*\(",
            widget_js,
        )
    )
    has_form_input = bool(re.search(r"<input|<textarea|\bgetFormData\b", widget_js))
    has_click_submit = bool(re.search(r"addEventListener\([\"']click", widget_js))
    has_host_call = bool(re.search(r"\bhost\.call\s*\(", widget_js))
    if (
        has_explicit_submit or (has_click_submit and has_form_input)
    ) and not has_host_call:
        errors.append(
            "widget has a form action but never calls host.call() — collected data "
            "is silently discarded. Add a POST endpoint to platformApiCatalog and call "
            "it via host.call(path, data) to persist the submission"
        )

    return errors
