"""
Cross-artifact validation — admin UI field-shape vs handler routes.

Public entry point: validate_admin_handler_contract.
"""

from __future__ import annotations

import re
from typing import Dict, List

from utils.static_validations.js_parse import (
    NON_FIELD as _NON_FIELD,
    extract_call_keys as _extract_call_keys,
    extract_js_fields as _extract_js_fields,
)


def validate_admin_handler_contract(
    admin_ui_js: str,
    handler_code: str,
) -> Dict[str, List[str]]:
    """
    Check that field names the admin UI sends via bridge.call() match what the handler
    destructures from ctx.adminBody inside the admin trigger block.

    Returns {generator_name: [errors]} attributed to both sides. Route existence
    is pre-checked by validate_handler_artifact.
    """
    if not admin_ui_js or not handler_code:
        return {}

    errors: Dict[str, List[str]] = {}

    admin_block_match = re.search(r"ctx\.trigger\s*===\s*['\"]admin['\"]", handler_code)
    admin_block = handler_code[admin_block_match.start() :] if admin_block_match else ""

    call_pattern = re.compile(
        r"bridge\.call\s*\(\s*['\"]([^'\"]+)['\"]\s*(?:,\s*\{([^}]*)\})?",
        re.DOTALL,
    )

    for m in call_pattern.finditer(admin_ui_js):
        path = m.group(1)
        body_str = m.group(2) or ""

        # Use key-only extraction — same rationale as validate_widget_handler_contract
        sent_fields = _extract_call_keys(body_str)
        if not sent_fields:
            continue

        route_match = re.search(
            rf"ctx\.adminPath\s*===\s*['\"](?:{re.escape(path)})['\"]",
            admin_block,
        )
        if not route_match:
            continue  # route absence already reported by validate_handler_artifact

        route_start = route_match.start()
        next_route = re.search(r"ctx\.adminPath\s*===", admin_block[route_start + 1 :])
        route_end = (
            (route_start + 1 + next_route.start()) if next_route else len(admin_block)
        )
        window = admin_block[route_start:route_end]

        destr_match = re.search(r"const\s*\{([^}]+)\}\s*=\s*ctx\.adminBody", window)
        if not destr_match:
            if "ctx.adminBody" not in window:
                msg = (
                    f"admin UI sends {sorted(sent_fields)} to '{path}' but handler "
                    f"has no ctx.adminBody access in the admin '{path}' route"
                )
                errors.setdefault("handler", []).append(msg)
                errors.setdefault("admin_ui", []).append(msg)
            continue

        handler_fields = {
            f
            for f in re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b", destr_match.group(1))
            if f not in _NON_FIELD
        }
        missing = sent_fields - handler_fields
        if missing:
            msg = (
                f"admin UI sends field(s) {sorted(missing)} to '{path}' but handler "
                f"destructures {sorted(handler_fields)} from ctx.adminBody in the admin block — "
                f"field name mismatch. Align both sides to the adminApiCatalog requestShape."
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("admin_ui", []).append(msg)

    return errors
