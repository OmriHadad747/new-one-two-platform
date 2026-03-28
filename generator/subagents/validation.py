"""
Static analysis utilities shared across all generators.

Each Generator subclass owns its validate() method and delegates here for the
actual checks. This file contains:

  Planning gates (two-stage chain):
    - validate_architect()      — structural decisions (topics, cron, catalog)
    - validate_codespec()       — algorithm correctness (claim ordering, field names)

  Per-artifact validators:
    - validate_handler()        — CommonJS handler.js
    - validate_migration()      — PostgreSQL DDL
    - validate_widget_js()      — storefront ES module

  Cross-artifact validator:
    - validate_cross_artifact() — widget↔handler field-name contract

  Shared constants (VALID_WEBHOOK_TOPICS, forbidden pattern lists)
  _js_is_syntactically_complete() heuristic used by validate_handler
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


def _is_valid_cron(expr: str) -> bool:
    """Minimal cron validator — checks for 5 whitespace-separated fields."""
    return len(expr.strip().split()) == 5


# ── Architect validator ────────────────────────────────────────────────────────


def validate_architect(
    architect_output: Dict[str, Any], app_archetype: str = "backend_only"
) -> List[str]:
    """
    Rule-based gate on the Architect Agent output (structural decisions only).
    Returns a list of error strings; empty list = valid.

    Checks:
      1. All webhookTopics are in the known-valid set.
      2. cronSchedule, if present, is a valid 5-field cron expression.
      3. storefront_ui apps must have a non-empty widgetApiCatalog.
      4. All widgetApiCatalog paths start with '/'.
      5. stateMachine.unknownSentinel, if set, must be the string "null".
    """
    errors: List[str] = []
    shopify = architect_output.get("shopifyPlan") or {}
    impl = architect_output.get("implementationSpec") or {}

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

    # 3. storefront_ui apps should declare their widget API catalog
    widget_catalog = impl.get("widgetApiCatalog") or []
    storefront_reads = impl.get("storefrontReads") or []
    if app_archetype == "storefront_ui" and not widget_catalog and not storefront_reads:
        # Check widgetGuidance for evidence of host.storefront() usage before failing
        guidance = (impl.get("widgetGuidance") or "").lower()
        if "host.storefront" not in guidance and "storefront" not in guidance:
            errors.append(
                "widgetApiCatalog is null/empty for a storefront_ui app — "
                "list every path the widget calls via host.call() with its responseShape, "
                "or if all widget data comes from Shopify's public storefront, "
                "describe host.storefront() usage in widgetGuidance"
            )

    # 4. Every widgetApiCatalog path must start with '/'
    for entry in widget_catalog:
        path = entry.get("path", "")
        if path and not path.startswith("/"):
            errors.append(
                f"widgetApiCatalog path {path!r} must start with '/' "
                f"(e.g. '/signup', '/status')"
            )

    # 5. stateMachine.unknownSentinel must be the string "null", never 0 or false
    sm = impl.get("stateMachine") or {}
    if sm.get("needsStateTracking"):
        sentinel = sm.get("unknownSentinel")
        if sentinel != "null":
            errors.append(
                f"stateMachine.unknownSentinel is {sentinel!r} — must be the string "
                f"\"null\" (not the number 0, not false, not empty string). "
                f"Reason: 0 is a valid real state (zero inventory); null = never observed."
            )

    return errors


# ── CodeSpec validator ─────────────────────────────────────────────────────────


def validate_codespec(
    codespec_output: Dict[str, Any],
    architect_output: Dict[str, Any],
) -> List[str]:
    """
    Rule-based gate on the CodeSpec Agent output (algorithm correctness).
    Returns a list of error strings; empty list = valid.

    Args:
        codespec_output:  { "codeSpec": { webhookPath, cronPath, widgetPath, functions } }
        architect_output: Full architect plan (shopifyPlan + implementationSpec without codeSpec).

    Checks:
      1. Each widgetApiCatalog path has at least one widgetPath entry.
      2. storefrontReads declared by architect must appear as host.storefront() in widgetPath.
      3. Atomic claim: every RETURNING step is immediately followed by a skip guard.
      4. State transition guard present when needsStateTracking is true.
      5. No Shopify API calls inside per-item loop bodies — any path.
      6. For each path, host.call() fields must match ctx.widgetBody destructuring (spec contract).
      7. Cron path SELECTs must be scoped to ctx.tenantId — never cross-tenant.
    """
    errors: List[str] = []
    impl = architect_output.get("implementationSpec") or {}
    sm = impl.get("stateMachine") or {}
    batching = impl.get("cronBatching") or {}
    widget_catalog = impl.get("widgetApiCatalog") or []
    storefront_reads = impl.get("storefrontReads") or []

    code_spec = codespec_output.get("codeSpec") or {}
    webhook_path: List[str] = code_spec.get("webhookPath") or []
    cron_path: List[str] = code_spec.get("cronPath") or []
    widget_path: List[str] = code_spec.get("widgetPath") or []

    # 1. Each catalog path must be covered by at least one widgetPath step
    for entry in widget_catalog:
        catalog_path = entry.get("path", "")
        if catalog_path:
            covered = any(
                f"path {catalog_path}" in step or catalog_path in step
                for step in widget_path
            )
            if not covered:
                errors.append(
                    f"widgetApiCatalog path '{catalog_path}' has no corresponding "
                    f"entry in codeSpec.widgetPath — each catalog path needs at least "
                    f"one widgetPath step starting with 'path {catalog_path}:'"
                )

    # 2. storefrontReads declared by architect must appear as host.storefront() in widgetPath
    if storefront_reads:
        has_storefront_call = any("host.storefront" in step for step in widget_path)
        if not has_storefront_call:
            errors.append(
                f"implementationSpec.storefrontReads declares {len(storefront_reads)} storefront "
                f"read(s) but codeSpec.widgetPath has no host.storefront() call — "
                f"add widget steps that call host.storefront() for: "
                f"{', '.join(r.get('path', '?') for r in storefront_reads)}"
            )

    # 3. Atomic claim ordering: RETURNING step must be immediately followed by a skip guard
    for path_name, path_steps in [("webhookPath", webhook_path), ("cronPath", cron_path)]:
        for i, step in enumerate(path_steps):
            if "RETURNING" in step or "returning" in step.lower():
                next_step = path_steps[i + 1] if i + 1 < len(path_steps) else ""
                has_length_check = bool(
                    re.search(r"\.length\s*[=!]=\s*0|=== 0|== 0", next_step)
                )
                has_skip_word = any(
                    w in next_step.lower()
                    for w in ("skip", "return", "continue", "stop", "break")
                )
                if not (has_length_check or has_skip_word):
                    errors.append(
                        f"codeSpec.{path_name} step {i + 1}: RETURNING-based atomic claim "
                        f"must be immediately followed by a skip-if-zero-rows guard "
                        f"(e.g. 'if claimed.length === 0: return'). "
                        f"Next step is: {next_step[:80]!r}"
                    )

    # 4. State transition guard required when needsStateTracking is true
    if sm.get("needsStateTracking"):
        all_steps = webhook_path + cron_path
        has_null_guard = any(
            re.search(r"\bprev\w*\s*[=!]=\s*null|\bprev\w*\s+is\s+null", s, re.IGNORECASE)
            or re.search(r"never.?observed|null.?sentinel|first.?seen|first.?observation", s, re.IGNORECASE)
            for s in all_steps
        )
        if not has_null_guard:
            errors.append(
                "stateMachine.needsStateTracking is true but codeSpec has no "
                "null-state skip guard — add an explicit step handling the case where "
                "previous state is null (never observed): skip the transition check"
            )

    # 5. No Shopify API calls inside per-item loop bodies — applies to ALL paths always.
    loop_indicators = re.compile(
        r"\bfor\s+each\b|\bfor\s+\(|\bfor\s+const\b|loop\s+body|\binside\s+loop\b",
        re.IGNORECASE,
    )
    shopify_call = re.compile(r"/admin/api/|ctx\.shopify\.", re.IGNORECASE)
    for path_name, path_steps in [("webhookPath", webhook_path), ("cronPath", cron_path)]:
        for i, step in enumerate(path_steps):
            if loop_indicators.search(step) and shopify_call.search(step):
                # Allow batch pre-fetch steps (the loop that chunks IDs and calls Shopify)
                if not re.search(r"\bbatch\b|\bchunk\b|\bpre.?fetch\b", step, re.IGNORECASE):
                    errors.append(
                        f"codeSpec.{path_name} step {i + 1}: Shopify API call inside a "
                        f"per-item loop — move all ctx.shopify calls to a pre-fetch phase "
                        f"before the loop (batch pattern). "
                        f"Step: {step[:100]!r}"
                    )

    # 6. For each widgetPath route, host.call() body fields must exactly match
    # ctx.widgetBody destructuring fields. Catches spec-level contradictions before codegen.
    _NON_FIELD_SPEC = {"true", "false", "null", "undefined", "host", "context", "await",
                       "only", "when", "if", "is", "not"}
    _spec_call_fields: Dict[str, set] = {}
    _spec_body_fields: Dict[str, set] = {}
    for step in widget_path:
        pm = re.match(r"path\s+(/\S+):\s*(.*)", step.strip(), re.IGNORECASE)
        if not pm:
            continue
        slug, content = pm.group(1), pm.group(2)
        call_m = re.search(
            r"host\.call\s*\(['\"][^'\"]+['\"],\s*\{([^}]*)\}", content, re.IGNORECASE
        )
        if call_m:
            fields = {f for f in re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b", call_m.group(1))
                      if f not in _NON_FIELD_SPEC}
            _spec_call_fields[slug] = fields
        body_m = re.search(r"const\s*\{([^}]+)\}\s*=\s*ctx\.widgetBody", content)
        if body_m:
            fields = {f for f in re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b", body_m.group(1))
                      if f not in _NON_FIELD_SPEC}
            _spec_body_fields[slug] = fields

    for slug in set(list(_spec_call_fields.keys()) + list(_spec_body_fields.keys())):
        call_f = _spec_call_fields.get(slug, set())
        body_f = _spec_body_fields.get(slug, set())
        if call_f and body_f and call_f != body_f:
            parts = []
            extra = body_f - call_f
            missing = call_f - body_f
            if extra:
                parts.append(f"handler destructures {sorted(extra)} not sent by widget")
            if missing:
                parts.append(f"widget sends {sorted(missing)} not destructured by handler")
            errors.append(
                f"codeSpec.widgetPath '{slug}': widget↔handler field contract mismatch — "
                f"{'; '.join(parts)}. "
                f"ctx.widgetBody destructuring must exactly match the host.call() body fields."
            )

    # 8. Cron path SELECTs must be scoped to ctx.tenantId — never cross-tenant
    select_re = re.compile(r"\bSELECT\b", re.IGNORECASE)
    tenant_re = re.compile(r"ctx\.tenantId", re.IGNORECASE)
    for i, step in enumerate(cron_path):
        if select_re.search(step) and not tenant_re.search(step):
            errors.append(
                f"codeSpec.cronPath step {i + 1}: SELECT is missing tenant_id filter — "
                f"add 'AND tenant_id = ${{ctx.tenantId}}'. "
                f"The harness calls the cron handler once per tenant with ctx.tenantId set."
            )

    return errors


# ── Cross-artifact validator ───────────────────────────────────────────────────


def validate_cross_artifact(
    widget_js: str,
    handler_code: str,
) -> Dict[str, List[str]]:
    """
    Checks that field names the widget sends via host.call() match what the handler
    destructures from ctx.widgetBody for the same route path.

    Only runs for storefront_ui apps (crew.py guards on is_storefront).
    Returns {generator_name: [errors]} — errors are attributed to both "handler"
    and "widget_js" so both generators receive the mismatch on retry and can converge.
    """
    if not widget_js or not handler_code:
        return {}

    errors: Dict[str, List[str]] = {}

    _NON_FIELD = {
        "true", "false", "null", "undefined", "host", "context", "await",
        "const", "let", "var", "return", "if", "else", "new", "this",
        "async", "function", "result", "data", "response", "error",
    }

    # Extract all host.call('/path', { ... }) from widget JS
    call_pattern = re.compile(
        r"host\.call\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*\{([^}]*)\}",
        re.DOTALL,
    )

    for m in call_pattern.finditer(widget_js):
        path = m.group(1)
        body_str = m.group(2)

        # Extract all identifier names from the object body
        raw_idents = re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b", body_str)
        sent_fields = {f for f in raw_idents if f not in _NON_FIELD}

        if not sent_fields:
            continue

        # Find the handler's route block for this path
        route_match = re.search(
            rf"ctx\.widgetPath\s*===\s*['\"](?:{re.escape(path)})['\"]",
            handler_code,
        )
        if not route_match:
            # Path not in handler — already caught by validate_widget_js path check
            continue

        # Scan from this route match to the next ctx.widgetPath check (or end of handler)
        route_start = route_match.start()
        next_route = re.search(r"ctx\.widgetPath\s*===", handler_code[route_start + 1:])
        route_end = (route_start + 1 + next_route.start()) if next_route else len(handler_code)
        window = handler_code[route_start:route_end]

        destr_match = re.search(
            r"const\s*\{([^}]+)\}\s*=\s*ctx\.widgetBody",
            window,
        )

        if not destr_match:
            # No destructuring — check if handler even reads ctx.widgetBody
            if "ctx.widgetBody" not in window:
                msg = (
                    f"widget sends {sorted(sent_fields)} to '{path}' but handler "
                    f"has no ctx.widgetBody access in the '{path}' route"
                )
                errors.setdefault("handler", []).append(msg)
                errors.setdefault("widget_js", []).append(msg)
            continue

        # Extract field names from the destructuring pattern
        destr_str = destr_match.group(1)
        raw_destr = re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b", destr_str)
        handler_fields = {f for f in raw_destr if f not in _NON_FIELD}

        missing = sent_fields - handler_fields
        if missing:
            msg = (
                f"widget sends field(s) {sorted(missing)} to '{path}' but handler "
                f"destructures {sorted(handler_fields)} from ctx.widgetBody — "
                f"field name mismatch. "
                f"The codeSpec.widgetPath is the ground truth: align both sides to it."
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("widget_js", []).append(msg)

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

    # Each CREATE TABLE must include tenant_id; customer_id must be nullable
    create_table_stmts = re.findall(
        r"CREATE\s+TABLE\s+\w+\s*\([\s\S]*?\);", sql, re.IGNORECASE
    )
    for stmt in create_table_stmts:
        if "tenant_id" not in stmt.lower():
            errors.append(
                f"CREATE TABLE missing tenant_id column: " f"{stmt[:80].strip()}..."
            )
        if re.search(r"\bcustomer_id\b[^,\n]*\bNOT\s+NULL\b", stmt, re.IGNORECASE):
            errors.append(
                "customer_id column must be nullable (BIGINT without NOT NULL) — "
                "storefront widget visitors can be guests with customerId = null"
            )

    # RLS policy required when creating tables
    has_create_table = bool(re.search(r"\bCREATE\s+TABLE\b", sql, re.IGNORECASE))
    has_rls = bool(
        re.search(r"\bROW\s+LEVEL\s+SECURITY\b", sql, re.IGNORECASE)
    ) or bool(re.search(r"\bCREATE\s+POLICY\b", sql, re.IGNORECASE))
    if has_create_table and not has_rls:
        errors.append("CREATE TABLE present but no RLS policy found")

    # Each CREATE POLICY must have WITH CHECK so INSERTs are also tenant-scoped
    policy_stmts = re.findall(
        r"CREATE\s+POLICY\b[^;]+;", sql, re.IGNORECASE | re.DOTALL
    )
    for stmt in policy_stmts:
        if "with check" not in stmt.lower():
            # Extract policy name for a readable error
            name_match = re.search(r"CREATE\s+POLICY\s+(\w+)", stmt, re.IGNORECASE)
            policy_name = name_match.group(1) if name_match else "unknown"
            errors.append(
                f"policy '{policy_name}' missing WITH CHECK clause — "
                "INSERT operations bypass tenant isolation without it"
            )

    return errors


# ── Widget JS validator ────────────────────────────────────────────────────────

FORBIDDEN_WIDGET_JS_PATTERNS = [
    (r"\bfetch\s*\(", "raw fetch() not allowed — use host.call() for backend requests or host.storefront() for Shopify public endpoints"),
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

    # host.storefront() must use relative paths only — no full URLs
    storefront_calls = re.findall(r"""host\.storefront\s*\(\s*['"`]([^'"`]+)['"`]""", widget_js)
    for path in storefront_calls:
        if path.startswith("http://") or path.startswith("https://"):
            errors.append(
                f"host.storefront() must use a relative path (e.g. '/products/x.js'), "
                f"not a full URL: '{path[:60]}'"
            )

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
        errors.append("hardcoded tenant_id detected — read from host.context instead")

    # Widget must not silently discard collected user data
    has_submit = bool(
        re.search(
            r"type=[\"']submit[\"']|addEventListener\([\"']submit|\.submit\s*\(",
            widget_js,
        )
    )
    has_host_call = bool(re.search(r"\bhost\.call\s*\(", widget_js))
    if has_submit and not has_host_call:
        errors.append(
            "widget has a submit action but never calls host.call() — collected data "
            "is silently discarded. Add a POST endpoint to platformApiCatalog and call "
            "it via host.call(path, data) to persist the submission"
        )

    return errors
