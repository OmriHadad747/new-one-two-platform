"""
Static analysis utilities shared across all generators.

Each Generator subclass owns its validate() method and delegates here for the
actual checks. This file contains:
  - validate_plan()    — rule-based gate on the Planner output (Change 2)
  - Per-artifact validate functions (validate_handler, validate_migration, validate_widget_js)
  - Shared constants (VALID_WEBHOOK_TOPICS, forbidden pattern lists)
  - _js_is_syntactically_complete() heuristic used by validate_handler

validate_bundle() has been removed. Orchestration (crew.py) now calls
gen.validate(artifact, ctx) on each generator directly.
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


# ── Plan validator (Change 2) ──────────────────────────────────────────────────


def _is_valid_cron(expr: str) -> bool:
    """Minimal cron validator — checks for 5 whitespace-separated fields."""
    return len(expr.strip().split()) == 5


def validate_plan(plan: Dict[str, Any]) -> List[str]:
    """
    Rule-based gate on the Planner Agent output. Called in crew.py before codegen.
    Returns a list of error strings; empty list = plan is valid.

    Checks:
      1. All webhookTopics are in the known-valid set.
      2. cronSchedule, if present, is a syntactically valid 5-field cron expression.
      3. When needsStateTracking is true and a cronPath exists, the cronPath must
         contain an explicit atomic-claim step (RETURNING + skip-if-zero-rows).
    """
    errors: List[str] = []
    shopify = plan.get("shopifyPlan") or {}
    impl = plan.get("implementationSpec") or {}

    # 1. Webhook topics must be known
    for topic in shopify.get("webhookTopics") or []:
        if topic not in VALID_WEBHOOK_TOPICS:
            errors.append(
                f"unknown webhook topic {topic!r} — "
                f"valid topics: {sorted(VALID_WEBHOOK_TOPICS)}"
            )

    # 2. cronSchedule must be a valid 5-field expression if present
    cron = shopify.get("cronSchedule")
    if cron is not None and not _is_valid_cron(cron):
        errors.append(
            f"invalid cronSchedule {cron!r} — must be a 5-field cron expression "
            f"(e.g. '*/15 * * * *')"
        )

    # 3. State machine + cron path requires an explicit atomic claim step
    sm = impl.get("stateMachine") or {}
    if sm.get("needsStateTracking"):
        code_spec = impl.get("codeSpec") or {}
        cron_path = code_spec.get("cronPath") or []
        if cron_path:
            has_claim = any(
                "RETURNING" in step
                or "returning" in step.lower()
                or "claimed" in step.lower()
                for step in cron_path
            )
            if not has_claim:
                errors.append(
                    "stateMachine.needsStateTracking is true but codeSpec.cronPath "
                    "has no atomic claim step — add a RETURNING-based UPDATE with "
                    "a skip-if-zero-rows guard before acting on the transition"
                )

    return errors


# ── Handler validator ──────────────────────────────────────────────────────────

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


def _js_is_syntactically_complete(code: str) -> bool:
    """
    Heuristic completeness check — catches truncated output before Node.js sees it.
    Tracks brace/bracket/paren depth and string state; returns False if unbalanced.
    """
    depth = 0
    in_string: str | None = None
    in_line_comment = False
    in_block_comment = False
    i = 0
    while i < len(code):
        c = code[i]
        nxt = code[i + 1] if i + 1 < len(code) else ""

        if in_line_comment:
            if c == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if c == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if c == "\\":
                i += 2  # skip escaped char
                continue
            if c == in_string:
                in_string = None
            i += 1
            continue

        if c == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue
        if c == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue
        if c in ('"', "'", "`"):
            in_string = c
            i += 1
            continue

        if c in ("{", "(", "["):
            depth += 1
        elif c in ("}", ")", "]"):
            depth -= 1
            if depth < 0:
                return False
        i += 1

    return depth == 0 and in_string is None and not in_block_comment


def validate_handler(code: str, api_plan_topics: List[str]) -> List[str]:
    """Validate the generated CommonJS handler.js."""
    errors: List[str] = []

    # Syntax completeness — catches truncated output before anything else
    if not _js_is_syntactically_complete(code):
        errors.append(
            "code is syntactically incomplete (truncated output) — "
            "unbalanced braces, unclosed string, or unmatched brackets"
        )
        return errors  # further checks are meaningless on broken code

    # Shape checks
    if "module.exports" not in code:
        errors.append("module.exports not found")
    if "webhookTopics" not in code:
        errors.append("webhookTopics not found in exports")
    if "handler" not in code:
        errors.append("handler function not found in exports")

    # Forbidden patterns
    for pattern, message in FORBIDDEN_HANDLER_PATTERNS:
        match = re.search(pattern, code)
        if match:
            # For URL violations, show the offending URL so the retry prompt is specific
            if "URL" in message or "http" in message.lower():
                # Extract up to 80 chars of context around the match
                start = max(0, match.start() - 20)
                snippet = code[start : match.start() + 60].replace("\n", " ").strip()
                errors.append(f"{message} — found: '{snippet}'")
            else:
                errors.append(message)

    # Extract declared webhook topics
    topic_match = re.search(r"webhookTopics\s*:\s*\[([^\]]*)\]", code)
    if topic_match:
        raw_topics = topic_match.group(1)
        declared = set(re.findall(r"""['"]([^'"]+)['"]""", raw_topics))

        unknown = declared - VALID_WEBHOOK_TOPICS
        if unknown:
            errors.append(f"unknown webhook topics: {sorted(unknown)}")

        planned = set(api_plan_topics)
        mismatch = declared.symmetric_difference(planned)
        if mismatch and planned:
            errors.append(
                f"webhook topics don't match API plan. "
                f"Declared: {sorted(declared)}, Planned: {sorted(planned)}"
            )

    return errors


# ── Migration validator ────────────────────────────────────────────────────────


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
        (
            r"\bALTER\s+TABLE\b(?!\s+\w+\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY)",
            "ALTER TABLE on existing tables",
        ),
    ]
    for pattern, name in forbidden_ddl:
        if re.search(pattern, sql, re.IGNORECASE):
            errors.append(f"forbidden SQL operation: {name}")

    # Each CREATE TABLE must include tenant_id
    create_table_stmts = re.findall(
        r"CREATE\s+TABLE\s+\w+\s*\([\s\S]*?\);", sql, re.IGNORECASE
    )
    for stmt in create_table_stmts:
        if "tenant_id" not in stmt.lower():
            errors.append(
                f"CREATE TABLE missing tenant_id column: "
                f"{stmt[:80].strip()}..."
            )

    # RLS policy required when creating tables
    has_create_table = bool(re.search(r"\bCREATE\s+TABLE\b", sql, re.IGNORECASE))
    has_rls = bool(
        re.search(r"\bROW\s+LEVEL\s+SECURITY\b", sql, re.IGNORECASE)
    ) or bool(re.search(r"\bCREATE\s+POLICY\b", sql, re.IGNORECASE))
    if has_create_table and not has_rls:
        errors.append("CREATE TABLE present but no RLS policy found")

    return errors


# ── Widget JS validator ────────────────────────────────────────────────────────

FORBIDDEN_WIDGET_JS_PATTERNS = [
    (r"\bfetch\s*\(", "raw fetch() not allowed — use host.call()"),
    (r"\bXMLHttpRequest\b", "XMLHttpRequest not allowed — use host.call()"),
    (r"\beval\s*\(", "eval() is not allowed"),
    (r"\bnew\s+Function\s*\(", "new Function() is not allowed"),
    (r"\bwindow\.", "window.* access is not allowed"),
    (
        r"\bdocument\.(?!querySelector|querySelectorAll|createElement|createTextNode|getElementById|body)",
        "direct document.* access is not allowed outside container queries",
    ),
    (r"\bsetTimeout\s*\(", "setTimeout is not allowed"),
    (r"\bsetInterval\s*\(", "setInterval is not allowed"),
    (
        r"https?://",
        "hardcoded URLs are not allowed — use host.call() with catalog paths",
    ),
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
            "must export a named mount function: export function mount(container, host) { ... }"
        )

    # Forbidden patterns
    for pattern, message in FORBIDDEN_WIDGET_JS_PATTERNS:
        if re.search(pattern, widget_js):
            errors.append(message)

    # host.call() paths must be in the platform API catalog
    catalog_paths = {entry["path"] for entry in platform_api_catalog}
    called_paths = re.findall(r"""host\.call\s*\(\s*['"]([^'"]+)['"]""", widget_js)
    for path in called_paths:
        if path not in catalog_paths:
            errors.append(
                f"host.call() references unlisted path '{path}'. "
                f"Allowed: {sorted(catalog_paths)}"
            )

    # No hardcoded tenant IDs
    if re.search(r"\btenant[_-]?id\s*[:=]\s*['\"]", widget_js, re.IGNORECASE):
        errors.append(
            "hardcoded tenant_id detected — read from host.context instead"
        )

    return errors
