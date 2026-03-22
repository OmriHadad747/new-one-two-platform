"""
Agent 4 — Validation Agent (no LLM).

Pure static analysis across all generated artifacts:
  - Handler: CommonJS module shape, no forbidden patterns, valid webhook topics
  - Migration: no DROP/ALTER, all CREATE TABLE have tenant_id, RLS policies present
  - Widget JS: exports mount function, no forbidden globals (storefront_ui only)

Returns a list of error strings. Empty list = all validation passed.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

VALID_WEBHOOK_TOPICS = {
    "orders/create",
    "orders/updated",
    "orders/cancelled",
    "orders/paid",
    "products/create",
    "products/update",
    "products/delete",
    "customers/create",
    "customers/update",
    "customers/delete",
    "inventory_levels/update",
    "inventory_items/update",
    "app/uninstalled",
}

FORBIDDEN_HANDLER_PATTERNS = [
    (r"\brequire\s*\(", "require() calls are not allowed"),
    (r"\bfetch\s*\(", "raw fetch() calls are not allowed — use ctx.shopify"),
    (r"https?://", "raw HTTP URLs are not allowed — use ctx.shopify"),
    (r"\beval\s*\(", "eval() is not allowed"),
    (r"\bprocess\.exit\b", "process.exit is not allowed"),
    (r"\bprocess\.kill\b", "process.kill is not allowed"),
    (r"\bprocess\.env\b", "process.env access is not allowed"),
    (r"\bnew\s+Function\s*\(", "new Function() is not allowed"),
]


def validate_handler(code: str, api_plan_topics: List[str]) -> List[str]:
    """Validate the generated CommonJS handler.js."""
    errors: List[str] = []

    # Shape checks
    if "module.exports" not in code:
        errors.append("handler.js: module.exports not found")
    if "webhookTopics" not in code:
        errors.append("handler.js: webhookTopics not found in exports")
    if "handler" not in code:
        errors.append("handler.js: handler function not found in exports")

    # Forbidden patterns
    for pattern, message in FORBIDDEN_HANDLER_PATTERNS:
        if re.search(pattern, code):
            errors.append(f"handler.js: {message}")

    # Extract declared webhook topics
    topic_match = re.search(r"webhookTopics\s*:\s*\[([^\]]*)\]", code)
    if topic_match:
        raw_topics = topic_match.group(1)
        declared = set(re.findall(r"""['"]([^'"]+)['"]""", raw_topics))

        unknown = declared - VALID_WEBHOOK_TOPICS
        if unknown:
            errors.append(
                f"handler.js: unknown webhook topics: {sorted(unknown)}"
            )

        planned = set(api_plan_topics)
        mismatch = declared.symmetric_difference(planned)
        if mismatch and planned:
            errors.append(
                f"handler.js: webhook topics don't match API plan. "
                f"Declared: {sorted(declared)}, Planned: {sorted(planned)}"
            )

    return errors


def validate_migration(sql: str) -> List[str]:
    """Validate the generated SQL migration."""
    errors: List[str] = []

    if not sql.strip():
        return errors  # empty migration is valid

    forbidden_ddl = [
        (r"\bDROP\s+TABLE\b", "DROP TABLE"),
        (r"\bDROP\s+COLUMN\b", "DROP COLUMN"),
        (r"\bTRUNCATE\b", "TRUNCATE"),
        # ALTER TABLE is allowed only for ENABLE ROW LEVEL SECURITY (required RLS pattern).
        # Any other ALTER TABLE form (ADD COLUMN, DROP COLUMN, etc.) is forbidden.
        (r"\bALTER\s+TABLE\b(?!\s+\w+\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY)", "ALTER TABLE on existing tables"),
    ]
    for pattern, name in forbidden_ddl:
        if re.search(pattern, sql, re.IGNORECASE):
            errors.append(f"migration: forbidden SQL operation: {name}")

    # Each CREATE TABLE must include tenant_id
    create_table_stmts = re.findall(
        r"CREATE\s+TABLE\s+\w+\s*\([\s\S]*?\);", sql, re.IGNORECASE
    )
    for stmt in create_table_stmts:
        if "tenant_id" not in stmt.lower():
            errors.append(
                f"migration: CREATE TABLE missing tenant_id column: "
                f"{stmt[:80].strip()}..."
            )

    # RLS policy required when creating tables
    has_create_table = bool(re.search(r"\bCREATE\s+TABLE\b", sql, re.IGNORECASE))
    has_rls = bool(
        re.search(r"\bROW\s+LEVEL\s+SECURITY\b", sql, re.IGNORECASE)
    ) or bool(re.search(r"\bCREATE\s+POLICY\b", sql, re.IGNORECASE))
    if has_create_table and not has_rls:
        errors.append("migration: CREATE TABLE present but no RLS policy found")

    return errors


FORBIDDEN_WIDGET_JS_PATTERNS = [
    (r"\bfetch\s*\(", "raw fetch() not allowed — use host.call()"),
    (r"\bXMLHttpRequest\b", "XMLHttpRequest not allowed — use host.call()"),
    (r"\beval\s*\(", "eval() is not allowed"),
    (r"\bnew\s+Function\s*\(", "new Function() is not allowed"),
    (r"\bwindow\.", "window.* access is not allowed"),
    (r"\bdocument\.(?!querySelector|querySelectorAll|createElement|createTextNode|getElementById|body)", "direct document.* access is not allowed outside container queries"),
    (r"\bsetTimeout\s*\(", "setTimeout is not allowed"),
    (r"\bsetInterval\s*\(", "setInterval is not allowed"),
    (r"https?://", "hardcoded URLs are not allowed — use host.call() with catalog paths"),
]


def validate_widget_js(
    widget_js: str,
    platform_api_catalog: List[Dict[str, str]],
) -> List[str]:
    """Validate the generated widget ES module (storefront_ui only)."""
    errors: List[str] = []

    if not widget_js or not widget_js.strip():
        return errors  # backend_only — no widget JS to validate

    # Must export a mount function
    if not re.search(r"\bexport\s+function\s+mount\b", widget_js):
        errors.append(
            "widget_js: must export a named mount function: export function mount(container, host) { ... }"
        )

    # Forbidden patterns
    for pattern, message in FORBIDDEN_WIDGET_JS_PATTERNS:
        if re.search(pattern, widget_js):
            errors.append(f"widget_js: {message}")

    # host.call() paths must be in the platform API catalog
    catalog_paths = {entry["path"] for entry in platform_api_catalog}
    called_paths = re.findall(r"""host\.call\s*\(\s*['"]([^'"]+)['"]""", widget_js)
    for path in called_paths:
        if path not in catalog_paths:
            errors.append(
                f"widget_js: host.call() references unlisted path '{path}'. "
                f"Allowed: {sorted(catalog_paths)}"
            )

    # No hardcoded tenant IDs
    if re.search(r"\btenant[_-]?id\s*[:=]\s*['\"]", widget_js, re.IGNORECASE):
        errors.append(
            "widget_js: hardcoded tenant_id detected — read from host.context instead"
        )

    return errors


def validate_bundle(
    handler_code: str,
    migration_sql: str,
    widget_js: str,
    platform_api_catalog: List[Dict[str, str]],
    api_plan_topics: List[str],
) -> List[str]:
    """Run all validators and return the combined error list."""
    return (
        validate_handler(handler_code, api_plan_topics)
        + validate_migration(migration_sql)
        + validate_widget_js(widget_js, platform_api_catalog)
    )
