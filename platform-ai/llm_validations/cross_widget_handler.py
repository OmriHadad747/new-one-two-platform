"""
Cross-artifact validation — widget JS field-shape vs handler routes.

Public entry point: validate_widget_handler_contract.
"""

from __future__ import annotations

import re
from typing import Dict, List

from utils.static_validations.js_parse import (
    NON_FIELD as _NON_FIELD,
    extract_call_keys as _extract_call_keys,
    extract_js_fields as _extract_js_fields,
)

def validate_widget_handler_contract(
    widget_js: str,
    handler_code: str,
) -> Dict[str, List[str]]:
    """
    Check that field names the widget sends via host.call() match what the handler
    destructures from ctx.widgetBody for the same route path.

    Returns {generator_name: [errors]} attributed to both sides so both receive
    the mismatch on retry. Route existence is pre-checked by validate_handler_artifact.
    """
    if not widget_js or not handler_code:
        return {}

    errors: Dict[str, List[str]] = {}

    call_pattern = re.compile(
        r"host\.call\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*\{([^}]*)\}",
        re.DOTALL,
    )

    for m in call_pattern.finditer(widget_js):
        path = m.group(1)
        body_str = m.group(2)

        # Use key-only extraction to avoid false mismatches from value expressions
        # (e.g. { email: formData.email } → {'email'}, not {'email', 'formData'})
        sent_fields = _extract_call_keys(body_str)
        if not sent_fields:
            continue

        route_match = re.search(
            rf"ctx\.widgetPath\s*===\s*['\"](?:{re.escape(path)})['\"]",
            handler_code,
        )
        if not route_match:
            continue  # route absence already reported by validate_handler_artifact

        route_start = route_match.start()
        next_route = re.search(
            r"ctx\.widgetPath\s*===", handler_code[route_start + 1 :]
        )
        route_end = (
            (route_start + 1 + next_route.start()) if next_route else len(handler_code)
        )
        window = handler_code[route_start:route_end]

        destr_match = re.search(r"const\s*\{([^}]+)\}\s*=\s*ctx\.widgetBody", window)
        if not destr_match:
            if "ctx.widgetBody" not in window:
                msg = (
                    f"widget sends {sorted(sent_fields)} to '{path}' but handler "
                    f"has no ctx.widgetBody access in the '{path}' route"
                )
                errors.setdefault("handler", []).append(msg)
                errors.setdefault("widget_js", []).append(msg)
            continue

        handler_fields = {
            f
            for f in re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b", destr_match.group(1))
            if f not in _NON_FIELD
        }
        missing = sent_fields - handler_fields
        if missing:
            msg = (
                f"widget sends field(s) {sorted(missing)} to '{path}' but handler "
                f"destructures {sorted(handler_fields)} from ctx.widgetBody — "
                f"field name mismatch. Align both sides to the widgetApiCatalog requestShape."
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("widget_js", []).append(msg)

    return errors
