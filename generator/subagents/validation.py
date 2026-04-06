"""
Static analysis utilities shared across all generators.

Naming convention
-----------------
  _plan      — validates LLM plan output (Architect / CodeSpec) before codegen starts
  _artifact  — validates a single generated artifact in isolation
  _contract  — cross-artifact check (two artifacts must agree on a shared interface)

Execution order in the pipeline
--------------------------------
  1. validate_architect_plan()   — after Architect agent
  2. validate_codespec_plan()    — after CodeSpec agent
  3. validate_handler_artifact() )
     validate_migration_artifact() ) — after parallel CodeGen (per artifact)
     validate_widget_artifact()    )
     validate_admin_ui_artifact()  )
  4. validate_widget_handler_contract()  ) — after all per-artifact checks pass
     validate_admin_handler_contract()   )

Cross-artifact validators (step 4) only check *field alignment* — route existence
is already verified statically by validate_handler_artifact() in step 3.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Webhook topic registry ────────────────────────────────────────────────────
#
# Primary source: shopify_mcp/cache/webhook_topics.json — populated by
#   shopify_mcp.client.prefetch_for_run() before each pipeline run (24 h TTL).
# Fallback: hardcoded set below — covers the most common topics so validation
#   never fails with a false-positive on a cache miss or MCP outage.

_FALLBACK_WEBHOOK_TOPICS: frozenset[str] = frozenset(
    {
        "orders/create",
        "orders/updated",
        "orders/cancelled",
        "orders/paid",
        "orders/fulfilled",
        "orders/partially_fulfilled",
        "products/create",
        "products/update",
        "products/delete",
        "customers/create",
        "customers/update",
        "customers/delete",
        "customers/enable",
        "customers/disable",
        "inventory_levels/update",
        "inventory_levels/connect",
        "inventory_levels/disconnect",
        "inventory_items/create",
        "inventory_items/update",
        "inventory_items/delete",
        "app/uninstalled",
        "app/subscriptions/update",
        "collections/create",
        "collections/update",
        "collections/delete",
        "draft_orders/create",
        "draft_orders/update",
        "fulfillments/create",
        "fulfillments/update",
        "refunds/create",
        "checkouts/create",
        "checkouts/update",
        "checkouts/delete",
        "carts/create",
        "carts/update",
        "disputes/create",
        "disputes/redacted",
    }
)

_MCP_TOPICS_CACHE = (
    Path(__file__).parent.parent / "shopify_mcp" / "cache" / "webhook_topics.json"
)
_TOPICS_CACHE_TTL = 24 * 60 * 60


def _get_valid_webhook_topics() -> frozenset[str]:
    """Return the current valid webhook topic set (MCP cache → fallback)."""
    try:
        if _MCP_TOPICS_CACHE.exists():
            entry = json.loads(_MCP_TOPICS_CACHE.read_text(encoding="utf-8"))
            if time.time() - entry.get("fetched_at", 0) < entry.get(
                "ttl_seconds", _TOPICS_CACHE_TTL
            ):
                live = frozenset(entry.get("data") or [])
                if live:
                    return live
    except Exception:
        pass
    return _FALLBACK_WEBHOOK_TOPICS


# Snapshot at import time for callers that do `from validation import VALID_WEBHOOK_TOPICS`.
# Prefer _get_valid_webhook_topics() inside validators so they always see the freshest cache.
VALID_WEBHOOK_TOPICS = _get_valid_webhook_topics()


def _is_valid_cron(expr: str) -> bool:
    """Minimal cron validator — checks for 5 whitespace-separated fields."""
    return len(expr.strip().split()) == 5


# ═══════════════════════════════════════════════════════════════════════════════
# PLAN VALIDATORS  (run before codegen, on LLM plan output)
# ═══════════════════════════════════════════════════════════════════════════════


def validate_architect_plan(
    architect_output: Dict[str, Any], app_archetype: str
) -> List[str]:
    """
    Gate on the Architect Agent output (structural decisions only).
    Returns error strings; empty = valid.

    Checks:
      1. All webhookTopics are in the known-valid set.
      2. cronSchedule, if present, is a valid 5-field cron expression.
      3. storefront apps must have a non-empty widgetApiCatalog OR storefrontReads.
      4. All widgetApiCatalog paths start with '/'.
      5. Admin archetypes (storefront_backend_admin, backend_admin) must have a non-empty adminApiCatalog.
      6. All adminApiCatalog paths start with '/'.
      7. stateMachine.unknownSentinel must be the string "null".
    """
    errors: List[str] = []
    shopify = architect_output.get("shopifyPlan") or {}
    impl = architect_output.get("implementationSpec") or {}

    # 1. Webhook topics must be known
    valid_topics = _get_valid_webhook_topics()
    for topic in shopify.get("webhookTopics") or []:
        if topic not in valid_topics:
            errors.append(
                f"unknown webhook topic {topic!r} — "
                f"valid topics: {sorted(valid_topics)}"
            )

    # 2. cronSchedule must be a valid 5-field expression if present
    cron = shopify.get("cronSchedule")
    if cron is not None and not _is_valid_cron(cron):
        errors.append(
            f"invalid cronSchedule {cron!r} — must be a 5-field cron expression "
            f"(e.g. '*/15 * * * *')"
        )

    # 3. storefront apps must declare widget catalog or storefront reads
    widget_catalog = impl.get("widgetApiCatalog") or []
    storefront_reads = impl.get("storefrontReads") or []
    if (
        app_archetype in ("storefront_backend", "storefront_backend_admin")
        and not widget_catalog
        and not storefront_reads
    ):
        guidance = (impl.get("widgetGuidance") or "").lower()
        if "host.storefront" not in guidance and "storefront" not in guidance:
            errors.append(
                "widgetApiCatalog is null/empty for a storefront_backend app — "
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

    # 5. Admin archetypes must declare a non-empty adminApiCatalog
    admin_catalog = impl.get("adminApiCatalog") or []
    if app_archetype in ("storefront_backend_admin", "backend_admin"):
        if not admin_catalog:
            errors.append(
                f"adminApiCatalog is null/empty for a {app_archetype!r} app — "
                "list every path the admin panel calls via bridge.call() with its responseShape "
                "(e.g. '/list', '/trigger', '/config/save')"
            )

    # 6. Every adminApiCatalog path must start with '/'
    for entry in admin_catalog:
        path = entry.get("path", "")
        if path and not path.startswith("/"):
            errors.append(
                f"adminApiCatalog path {path!r} must start with '/' "
                f"(e.g. '/list', '/trigger', '/config/save')"
            )

    # 7. stateMachine.unknownSentinel must be the string "null"
    sm = impl.get("stateMachine") or {}
    if sm.get("needsStateTracking"):
        sentinel = sm.get("unknownSentinel")
        if sentinel != "null":
            errors.append(
                f"stateMachine.unknownSentinel is {sentinel!r} — must be the string "
                f'"null" (not the number 0, not false, not empty string). '
                f"Reason: 0 is a valid real state (zero inventory); null = never observed."
            )

    return errors


def _extract_js_fields(obj_literal: str) -> List[str]:
    """
    Extract property key names from a JS object literal fragment.

    Handles shorthand  { email, variantId }
    and explicit       { email: formData.email, variantId: someVar }

    Returns sorted list of key identifiers only (not values).
    Uses a split-based approach so the last field is always captured even when
    the closing `}` is not present in the captured substring (common when the
    field list is extracted via a regex group that stops before `}`).
    """
    keys: List[str] = []
    seen: set = set()
    # strip surrounding braces/whitespace in case the caller left them in
    s = obj_literal.strip().strip("{}").strip()
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        # explicit "key: value" — take the key only; shorthand "key" — take as-is
        key = part.split(":")[0].strip()
        if re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", key) and key not in _NON_FIELD and key not in seen:
            keys.append(key)
            seen.add(key)
    return sorted(keys)


def extract_widget_field_contracts(widget_path: List[str]) -> Dict[str, List[str]]:
    """
    Parse codeSpec.widgetPath steps and extract the field contract for each path.

    Returns {'/path': ['field1', 'field2']} based on host.call() body objects.
    Both the handler and widget generators call this to get the authoritative field
    list for each route — so both sides implement the exact same names.

    Only paths with an explicit JS object literal in host.call() are returned.
    Paths called with no body (GET-style) are omitted.
    """
    contracts: Dict[str, List[str]] = {}
    call_re = re.compile(
        r"host\.call\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*\{([^}]*)\}",
    )
    for step in widget_path:
        m = call_re.search(step)
        if m:
            path = m.group(1)
            fields = _extract_js_fields(m.group(2))
            if fields:
                contracts[path] = fields
    return contracts


def extract_admin_field_contracts(admin_path: List[str]) -> Dict[str, List[str]]:
    """
    Same as extract_widget_field_contracts but for bridge.call() in adminPath steps.
    Only paths that send a body are returned — GET-style paths with no body are skipped.
    """
    contracts: Dict[str, List[str]] = {}
    call_re = re.compile(
        r"bridge\.call\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*\{([^}]*)\}",
    )
    for step in admin_path:
        m = call_re.search(step)
        if m:
            path = m.group(1)
            fields = _extract_js_fields(m.group(2))
            if fields:
                contracts[path] = fields
    return contracts


def validate_codespec_plan(
    codespec_output: Dict[str, Any],
    architect_output: Dict[str, Any],
) -> List[str]:
    """
    Gate on the CodeSpec Agent output (algorithm correctness).
    Returns error strings; empty = valid.

    Args:
        codespec_output:  { "codeSpec": { webhookPath, cronPath, widgetPath, adminPath, functions } }
        architect_output: Full architect plan (shopifyPlan + implementationSpec without codeSpec).

    Checks:
      1. Each widgetApiCatalog path has at least one widgetPath entry.
      2. Each adminApiCatalog path has at least one adminPath entry.
      3. storefrontReads declared by architect must appear as host.storefront() in widgetPath.
      4. Atomic claim: every RETURNING step is immediately followed by a skip guard (all paths).
      5. No Shopify API calls inside per-item loop bodies.
      6. DB SELECT steps in webhook, cron, and admin paths must reference ctx.tenantId.
      7. Each widgetApiCatalog path must have an explicit host.call() body with JS field names
         AND a matching ctx.widgetBody destructuring step with identical fields.
      8. Each adminApiCatalog path that sends a body must have a matching ctx.adminBody
         destructuring step with identical fields.
    """
    errors: List[str] = []
    impl = architect_output.get("implementationSpec") or {}
    widget_catalog = impl.get("widgetApiCatalog") or []
    admin_catalog = impl.get("adminApiCatalog") or []
    storefront_reads = impl.get("storefrontReads") or []

    code_spec = codespec_output.get("codeSpec") or {}
    webhook_path: List[str] = code_spec.get("webhookPath") or []
    cron_path: List[str] = code_spec.get("cronPath") or []
    widget_path: List[str] = code_spec.get("widgetPath") or []
    admin_path: List[str] = code_spec.get("adminPath") or []

    # 1. Each widgetApiCatalog path must be covered by at least one widgetPath step
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

    # 2. Each adminApiCatalog path must be covered by at least one adminPath step
    for entry in admin_catalog:
        catalog_path = entry.get("path", "")
        if catalog_path:
            covered = any(
                f"path {catalog_path}" in step or catalog_path in step
                for step in admin_path
            )
            if not covered:
                errors.append(
                    f"adminApiCatalog path '{catalog_path}' has no corresponding "
                    f"entry in codeSpec.adminPath — each admin catalog path needs at least "
                    f"one adminPath step"
                )

    # 3. storefrontReads declared by architect must appear as host.storefront() in widgetPath
    if storefront_reads:
        has_storefront_call = any("host.storefront" in step for step in widget_path)
        if not has_storefront_call:
            errors.append(
                f"implementationSpec.storefrontReads declares {len(storefront_reads)} storefront "
                f"read(s) but codeSpec.widgetPath has no host.storefront() call — "
                f"add widget steps that call host.storefront() for: "
                f"{', '.join(r.get('path', '?') for r in storefront_reads)}"
            )

    # 4. Atomic claim ordering: RETURNING step must be immediately followed by a skip guard.
    #    Applies to all paths — any path may perform UPDATE...RETURNING for idempotency.
    for path_name, path_steps in [
        ("webhookPath", webhook_path),
        ("cronPath", cron_path),
        ("widgetPath", widget_path),
        ("adminPath", admin_path),
    ]:
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

    # 5. No Shopify API calls inside per-item loop bodies
    loop_indicators = re.compile(
        r"\bfor\s+each\b|\bfor\s+\(|\bfor\s+const\b|loop\s+body|\binside\s+loop\b",
        re.IGNORECASE,
    )
    shopify_call = re.compile(r"/admin/api/|ctx\.shopify\.", re.IGNORECASE)
    for path_name, path_steps in [
        ("webhookPath", webhook_path),
        ("cronPath", cron_path),
    ]:
        for i, step in enumerate(path_steps):
            if loop_indicators.search(step) and shopify_call.search(step):
                if not re.search(
                    r"\bbatch\b|\bchunk\b|\bpre.?fetch\b", step, re.IGNORECASE
                ):
                    errors.append(
                        f"codeSpec.{path_name} step {i + 1}: Shopify API call inside a "
                        f"per-item loop — move all ctx.shopify calls to a pre-fetch phase "
                        f"before the loop (batch pattern). "
                        f"Step: {step[:100]!r}"
                    )

    # 6. DB SELECT steps must always be scoped to ctx.tenantId.
    #    Applies to webhook, cron, and admin paths — any path that queries tenant tables.
    #    (widgetPath is excluded: widget queries are single-entity lookups scoped by the
    #    entity ID from the widget body, tenant scoping enforced at artifact level.)
    select_re = re.compile(r"\bSELECT\b", re.IGNORECASE)
    tenant_re = re.compile(r"ctx\.tenantId", re.IGNORECASE)
    for path_name, path_steps in [
        ("webhookPath", webhook_path),
        ("cronPath", cron_path),
        ("adminPath", admin_path),
    ]:
        for i, step in enumerate(path_steps):
            if select_re.search(step) and not tenant_re.search(step):
                errors.append(
                    f"codeSpec.{path_name} step {i + 1}: SELECT is missing tenant_id filter — "
                    f"add 'AND tenant_id = ${{ctx.tenantId}}'. "
                    f"Every DB query must be scoped to the current tenant."
                )

    # 7. widgetPath field contract self-consistency.
    #    Each widgetApiCatalog path that sends a body must have:
    #      (a) a step with host.call('/path', { field1, field2 }) — explicit JS identifiers
    #      (b) a step with const { field1, field2 } = ctx.widgetBody — exact same names
    #    Catching this in the codeSpec prevents codegen agents from independently
    #    inventing field names and producing a mismatch that only surfaces after codegen.
    for entry in widget_catalog:
        catalog_path = entry.get("path", "")
        if not catalog_path:
            continue
        path_steps = [s for s in widget_path if catalog_path in s]

        call_m = None
        for step in path_steps:
            m = re.search(
                rf"host\.call\s*\(\s*['\"](?:{re.escape(catalog_path)})['\"].*?\{{([^}}]+)\}}",
                step,
            )
            if m:
                call_m = m
                break

        destr_m = None
        for step in path_steps:
            m = re.search(r"const\s*\{([^}]+)\}\s*=\s*ctx\.widgetBody", step)
            if m:
                destr_m = m
                break

        if not call_m:
            errors.append(
                f"codeSpec.widgetPath for '{catalog_path}': missing explicit host.call() body — "
                f"write the exact JS object: "
                f"\"path {catalog_path}: widget calls host.call('{catalog_path}', {{ field1, field2 }})\" "
                f"using camelCase identifiers only, no prose"
            )

        if not destr_m:
            errors.append(
                f"codeSpec.widgetPath for '{catalog_path}': missing ctx.widgetBody destructuring — "
                f"write: \"path {catalog_path}: handler: const {{ field1, field2 }} = ctx.widgetBody\" "
                f"with the same field names as the host.call() body"
            )

        if call_m and destr_m:
            widget_fields = set(_extract_js_fields(call_m.group(1)))
            handler_fields = set(_extract_js_fields(destr_m.group(1)))
            if widget_fields != handler_fields:
                errors.append(
                    f"codeSpec.widgetPath '{catalog_path}' internal field mismatch: "
                    f"host.call() sends {sorted(widget_fields)}, "
                    f"ctx.widgetBody destructures {sorted(handler_fields)} — "
                    f"both steps must use identical field names. Fix the codeSpec before codegen runs."
                )

    # 8. adminPath field contract self-consistency.
    #    Same check for bridge.call() bodies vs ctx.adminBody destructuring.
    #    GET-style paths (no body) are skipped — only paths with a body need the check.
    for entry in admin_catalog:
        catalog_path = entry.get("path", "")
        if not catalog_path:
            continue
        path_steps_admin = [s for s in admin_path if catalog_path in s]

        call_m = None
        for step in path_steps_admin:
            m = re.search(
                rf"bridge\.call\s*\(\s*['\"](?:{re.escape(catalog_path)})['\"].*?\{{([^}}]+)\}}",
                step,
            )
            if m:
                call_m = m
                break

        if not call_m:
            continue  # GET-style admin path with no body — no contract to validate

        destr_m = None
        for step in path_steps_admin:
            m = re.search(r"const\s*\{([^}]+)\}\s*=\s*ctx\.adminBody", step)
            if m:
                destr_m = m
                break

        if not destr_m:
            errors.append(
                f"codeSpec.adminPath for '{catalog_path}': has bridge.call() body but no "
                f"ctx.adminBody destructuring — write: "
                f"\"path {catalog_path}: handler: const {{ field1, field2 }} = ctx.adminBody\""
            )
        elif call_m and destr_m:
            admin_fields = set(_extract_js_fields(call_m.group(1)))
            handler_fields = set(_extract_js_fields(destr_m.group(1)))
            if admin_fields != handler_fields:
                errors.append(
                    f"codeSpec.adminPath '{catalog_path}' internal field mismatch: "
                    f"bridge.call() sends {sorted(admin_fields)}, "
                    f"ctx.adminBody destructures {sorted(handler_fields)} — "
                    f"both steps must use identical field names."
                )

    return errors


# ═══════════════════════════════════════════════════════════════════════════════
# ARTIFACT VALIDATORS  (run per-artifact after codegen, single artifact in isolation)
# ═══════════════════════════════════════════════════════════════════════════════

# ── Handler ───────────────────────────────────────────────────────────────────

FORBIDDEN_HANDLER_PATTERNS = [
    (
        r"\bfetch\s*\(",
        "raw fetch() calls are not allowed — use ctx.shopify or ctx.http.call()",
    ),
    (
        r"(?<!ctx\.http\.call\(['\"])https?://",
        "raw HTTP URLs are not allowed outside ctx.http.call() — use ctx.shopify for Shopify API, ctx.http.call(url) for external APIs",
    ),
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
                i += 2
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


def validate_handler_artifact(
    code: str,
    api_plan_topics: List[str],
    widget_catalog: Optional[List[Dict[str, Any]]] = None,
    admin_catalog: Optional[List[Dict[str, Any]]] = None,
) -> List[str]:
    """
    Validate the generated CommonJS handler.js.

    Checks:
      1. Syntax completeness (balanced braces/parens/strings).
      2. module.exports, webhookTopics, handler present.
      3. Forbidden patterns (require, fetch, eval, process.env, etc.).
      4. Declared webhookTopics match the architect plan.
      5. Every widgetApiCatalog path has a ctx.widgetPath === '/path' branch
         outside any admin block (widget trigger routing).
      6. Every adminApiCatalog path has a ctx.adminPath === '/path' branch
         inside the ctx.trigger === 'admin' block.
    """
    errors: List[str] = []

    # 1. Syntax completeness — fail fast, further checks are meaningless on broken code
    if not _js_is_syntactically_complete(code):
        errors.append(
            "code is syntactically incomplete (truncated output) — "
            "unbalanced braces, unclosed string, or unmatched brackets"
        )
        return errors

    # 2. Shape checks
    if "module.exports" not in code:
        errors.append("module.exports not found")
    if "webhookTopics" not in code:
        errors.append("webhookTopics not found in exports")
    if "npmPackages" not in code:
        errors.append("npmPackages not found in exports — add npmPackages: [] even if empty")
    if "handler" not in code:
        errors.append("handler function not found in exports")

    # 2b. Every require('pkg') call must be declared in npmPackages,
    #     and every npmPackages entry must be from the approved list.
    #     Built-in Node modules are always exempt.
    BUILTIN_MODULES = {
        "path", "fs", "os", "crypto", "stream", "util", "events",
        "buffer", "url", "http", "https", "net", "querystring",
        "string_decoder", "child_process", "process", "zlib",
    }
    # Approved JS library packages — keep in sync with harness_contract.py.
    # Only the base package name (no version), scoped packages use full @scope/name.
    ALLOWED_NPM_PACKAGES = {
        "qrcode",
        "jsbarcode",
        "@xmldom/xmldom",
        "sharp",
        "pdfkit",
        "exceljs",
        "csv-parse",
        "csv-stringify",
        "fast-xml-parser",
        "handlebars",
        "marked",
        "dayjs",
        "jszip",
        "uuid",
        "slugify",
    }

    def _pkg_base(name: str) -> str:
        """Strip version from a package name, handling scoped packages."""
        if name.startswith("@"):
            # @scope/pkg@version → @scope/pkg
            parts = name[1:].split("@")
            return "@" + parts[0]
        return name.split("@")[0]

    npm_match = re.search(r"npmPackages\s*:\s*\[([^\]]*)\]", code)
    declared_packages: set = set()
    if npm_match:
        raw = npm_match.group(1)
        for pkg in re.findall(r"""['"]([^'"]+)['"]""", raw):
            base = _pkg_base(pkg)
            declared_packages.add(base)
            if base not in ALLOWED_NPM_PACKAGES:
                errors.append(
                    f"npmPackages contains unsupported package '{pkg}' — "
                    f"only these packages are available: {sorted(ALLOWED_NPM_PACKAGES)}"
                )

    for req_match in re.finditer(r"""\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)""", code):
        pkg_name = req_match.group(1)
        # Allow sub-path imports like 'csv-parse/sync' — base is still 'csv-parse'
        base = _pkg_base(pkg_name.split("/")[0] if not pkg_name.startswith("@") else
                         "/".join(pkg_name.split("/")[:2]))
        if base in BUILTIN_MODULES:
            continue
        if base not in declared_packages:
            errors.append(
                f"require('{pkg_name}') used but '{pkg_name}' is not declared in npmPackages — "
                f"add it to the npmPackages array in module.exports"
            )

    # 3. Forbidden patterns
    for pattern, message in FORBIDDEN_HANDLER_PATTERNS:
        match = re.search(pattern, code)
        if match:
            if "URL" in message or "http" in message.lower():
                start = max(0, match.start() - 20)
                snippet = code[start : match.start() + 60].replace("\n", " ").strip()
                errors.append(f"{message} — found: '{snippet}'")
            else:
                errors.append(message)

    # 4. Declared webhook topics must match the plan
    topic_match = re.search(r"webhookTopics\s*:\s*\[([^\]]*)\]", code)
    if topic_match:
        raw_topics = topic_match.group(1)
        declared = set(re.findall(r"""['"]([^'"]+)['"]""", raw_topics))

        unknown = declared - _get_valid_webhook_topics()
        if unknown:
            errors.append(f"unknown webhook topics: {sorted(unknown)}")

        planned = set(api_plan_topics)
        if declared and not planned:
            # Handler invented topics when the plan has none (cron-only / backend app)
            errors.append(
                f"handler declares webhook topics {sorted(declared)} but the plan has none — "
                f"set webhookTopics to [] for cron-only or backend apps"
            )
        elif planned:
            mismatch = declared.symmetric_difference(planned)
            if mismatch:
                errors.append(
                    f"webhook topics don't match API plan — "
                    f"declared: {sorted(declared)}, planned: {sorted(planned)}"
                )

    # 5. Every widget catalog path must have a route branch somewhere in the handler.
    #    We search the entire code rather than trying to slice a "widget region" by
    #    position — ordering of trigger blocks varies and position-based slicing
    #    produces false negatives when the admin block appears before the widget block.
    #    Widget and admin catalog paths are always distinct slugs (by architect design),
    #    so a widget path match can't be a false positive from the admin block.
    for entry in widget_catalog or []:
        path = entry.get("path", "")
        if not path:
            continue
        route_present = bool(
            re.search(
                rf"ctx\.widgetPath\s*===\s*['\"]{ re.escape(path) }['\"]",
                code,
            )
        )
        if not route_present:
            errors.append(
                f"handler missing widget route for '{path}' — "
                f"add: if (ctx.widgetPath === '{path}') {{ ... }} "
                f"inside the widget trigger block. "
                f"Every widgetApiCatalog path MUST be handled."
            )

    # 6. Every admin catalog path must have a route branch inside the admin block
    admin_block = ""
    admin_block_match = re.search(r"ctx\.trigger\s*===\s*['\"]admin['\"]", code)
    if admin_block_match:
        admin_block = code[admin_block_match.start() :]

    for entry in admin_catalog or []:
        path = entry.get("path", "")
        if not path:
            continue
        if not admin_block:
            errors.append(
                f"handler has no ctx.trigger === 'admin' block but adminApiCatalog "
                f"requires path '{path}' — add an admin trigger block that routes on ctx.adminPath"
            )
            continue
        route_present = bool(
            re.search(
                rf"ctx\.adminPath\s*===\s*['\"]{ re.escape(path) }['\"]",
                admin_block,
            )
        )
        if not route_present:
            errors.append(
                f"handler missing admin route for '{path}' — "
                f"add: if (ctx.adminPath === '{path}') {{ ... }} "
                f"inside the ctx.trigger === 'admin' block. "
                f"Every adminApiCatalog path MUST be handled."
            )

    return errors


# ── Migration ─────────────────────────────────────────────────────────────────


def validate_migration_artifact(sql: str) -> List[str]:
    """Validate the generated PostgreSQL DDL migration."""
    errors: List[str] = []

    if not sql.strip():
        return errors  # empty migration is valid

    forbidden_ddl = [
        (r"\bDROP\s+TABLE\b", "DROP TABLE"),
        (r"\bDROP\s+COLUMN\b", "DROP COLUMN"),
        (r"\bTRUNCATE\b", "TRUNCATE"),
        (
            r"\bALTER\s+TABLE\b(?!\s+\w+\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY)",
            "ALTER TABLE on existing tables",
        ),
    ]
    for pattern, name in forbidden_ddl:
        if re.search(pattern, sql, re.IGNORECASE):
            errors.append(f"forbidden SQL operation: {name}")

    create_table_stmts = re.findall(
        r"CREATE\s+TABLE\s+\w+\s*\([\s\S]*?\);", sql, re.IGNORECASE
    )
    for stmt in create_table_stmts:
        if "tenant_id" not in stmt.lower():
            errors.append(
                f"CREATE TABLE missing tenant_id column: {stmt[:80].strip()}..."
            )
        if re.search(r"\bcustomer_id\b[^,\n]*\bNOT\s+NULL\b", stmt, re.IGNORECASE):
            errors.append(
                "customer_id column must be nullable (BIGINT without NOT NULL) — "
                "storefront widget visitors can be guests with customerId = null"
            )

    # RLS is required per table — a single file-level check would pass when only
    # one of multiple tables has a policy. Check each created table individually.
    created_tables = re.findall(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", sql, re.IGNORECASE
    )
    for table_name in created_tables:
        has_enable_rls = bool(
            re.search(
                rf"ALTER\s+TABLE\s+{re.escape(table_name)}\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY",
                sql,
                re.IGNORECASE,
            )
        )
        has_policy = bool(
            re.search(
                rf"CREATE\s+POLICY\s+\w+\s+ON\s+{re.escape(table_name)}\b",
                sql,
                re.IGNORECASE,
            )
        )
        missing_stmts = []
        if not has_enable_rls:
            missing_stmts.append(
                f"ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY"
            )
        if not has_policy:
            missing_stmts.append(
                f"CREATE POLICY ... ON {table_name} USING (tenant_id = auth.uid()) WITH CHECK (tenant_id = auth.uid())"
            )
        if missing_stmts:
            errors.append(
                f"table '{table_name}' is missing row-level security — add: "
                + "; ".join(missing_stmts)
            )

    policy_stmts = re.findall(
        r"CREATE\s+POLICY\b[^;]+;", sql, re.IGNORECASE | re.DOTALL
    )
    for stmt in policy_stmts:
        name_match = re.search(r"CREATE\s+POLICY\s+(\w+)", stmt, re.IGNORECASE)
        policy_name = name_match.group(1) if name_match else "unknown"

        if "with check" not in stmt.lower():
            errors.append(
                f"policy '{policy_name}' missing WITH CHECK clause — "
                "INSERT operations bypass tenant isolation without it"
            )

        # The USING and WITH CHECK expressions must reference tenant_id to actually
        # enforce isolation. A policy with USING (true) would pass the clause check
        # above but allow cross-tenant reads.
        if "tenant_id" not in stmt.lower():
            errors.append(
                f"policy '{policy_name}' does not reference tenant_id — "
                "USING and WITH CHECK expressions must filter by tenant_id "
                "(e.g. USING (tenant_id = auth.uid()) WITH CHECK (tenant_id = auth.uid()))"
            )

    return errors


# ── Widget ────────────────────────────────────────────────────────────────────

FORBIDDEN_WIDGET_JS_PATTERNS = [
    (
        r"\bfetch\s*\(",
        "raw fetch() not allowed — use host.call() for backend requests or host.storefront() for Shopify public endpoints",
    ),
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
    has_form_input = bool(
        re.search(r"<input|<textarea|\bgetFormData\b", widget_js)
    )
    has_click_submit = bool(
        re.search(r"addEventListener\([\"']click", widget_js)
    )
    has_host_call = bool(re.search(r"\bhost\.call\s*\(", widget_js))
    if (has_explicit_submit or (has_click_submit and has_form_input)) and not has_host_call:
        errors.append(
            "widget has a form action but never calls host.call() — collected data "
            "is silently discarded. Add a POST endpoint to platformApiCatalog and call "
            "it via host.call(path, data) to persist the submission"
        )

    return errors


# ── Admin UI ──────────────────────────────────────────────────────────────────

FORBIDDEN_ADMIN_UI_PATTERNS = [
    (
        r"\bfetch\s*\(",
        "raw fetch() not allowed — use bridge.call() for backend requests",
    ),
    (r"\bXMLHttpRequest\b", "XMLHttpRequest not allowed — use bridge.call()"),
    (r"\beval\s*\(", "eval() is not allowed"),
    (r"\bnew\s+Function\s*\(", "new Function() is not allowed"),
    (r"\bwindow\.", "window.* access is not allowed"),
    (
        r"\bdocument\.(?!querySelector|querySelectorAll|createElement|createTextNode|getElementById)",
        "direct document.* access is not allowed outside container queries — use container.querySelector() patterns",
    ),
    (
        r"https?://",
        "hardcoded URLs are not allowed — use bridge.call() with catalog paths",
    ),
    (r"\bsetInterval\s*\(", "setInterval is not allowed"),
]


def validate_admin_ui_artifact(
    admin_ui_js: str,
    admin_api_catalog: List[Dict[str, str]],
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
    has_form_input = bool(
        re.search(r"<input|<textarea|\bgetFormData\b", admin_ui_js)
    )
    has_click_submit = bool(
        re.search(r"addEventListener\([\"']click", admin_ui_js)
    )
    has_bridge_call = bool(re.search(r"\bbridge\.call\s*\(", admin_ui_js))
    if (has_explicit_submit or (has_click_submit and has_form_input)) and not has_bridge_call:
        errors.append(
            "admin UI has a form action but never calls bridge.call() — collected data "
            "is silently discarded. Add a POST endpoint to adminApiCatalog and call it "
            "via bridge.call(path, data)."
        )

    return errors


# ═══════════════════════════════════════════════════════════════════════════════
# CONTRACT VALIDATORS  (cross-artifact field alignment, run after artifact validators)
# ═══════════════════════════════════════════════════════════════════════════════
#
# These only run when BOTH artifacts already passed their individual validators.
# Route existence is guaranteed by validate_handler_artifact() — these validators
# only check that field names sent by the UI match what the handler destructures.


def _extract_call_keys(body_str: str) -> set:
    """
    Extract top-level property key names from a JavaScript object literal fragment.
    Delegates to _extract_js_fields which correctly handles the last field even when
    the captured group does not include the closing `}`.
    """
    return set(_extract_js_fields(body_str))

_NON_FIELD = {
    "true",
    "false",
    "null",
    "undefined",
    "host",
    "bridge",
    "context",
    "await",
    "const",
    "let",
    "var",
    "return",
    "if",
    "else",
    "new",
    "this",
    "async",
    "function",
    "result",
    "data",
    "response",
    "error",
}


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
                f"field name mismatch. Align both sides to the codeSpec.widgetPath."
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("widget_js", []).append(msg)

    return errors


def validate_admin_handler_contract(
    admin_ui_js: str,
    handler_code: str,
) -> Dict[str, List[str]]:
    """
    Check that field names the admin UI sends via bridge.call() match what the handler
    destructures from ctx.widgetBody inside the admin trigger block.

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
                f"field name mismatch. Align both sides to the codeSpec.adminPath."
            )
            errors.setdefault("handler", []).append(msg)
            errors.setdefault("admin_ui", []).append(msg)

    return errors
