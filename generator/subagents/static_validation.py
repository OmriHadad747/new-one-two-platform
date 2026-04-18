"""
Static analysis utilities shared across all generators.

Naming convention
-----------------
  _plan      — validates LLM plan output (Architect) before codegen starts
  _artifact  — validates a single generated artifact in isolation
  _contract  — cross-artifact check (two artifacts must agree on a shared interface)

Execution order in the pipeline
--------------------------------
  1. validate_architect_plan()     — after Architect agent
  2. validate_handler_artifact()   )
     validate_migration_artifact() ) — after parallel CodeGen (per artifact)
     validate_widget_artifact()    )
     validate_admin_ui_artifact()  )
  3. validate_widget_handler_contract()  ) — after all per-artifact checks pass
     validate_admin_handler_contract()   )

Cross-artifact validators (step 3) only check *field alignment* — route existence
is already verified statically by validate_handler_artifact() in step 2.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from templates.capabilities import (
    ALLOWED_ADMIN_CAPABILITIES,
    ALLOWED_HANDLER_CAPABILITIES,
    ALLOWED_NPM_PACKAGES,
    ALLOWED_WIDGET_CAPABILITIES,
)
from templates.capabilities.handler import HANDLER_CAPABILITY_REGISTRY

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
    Gate on the Architect Agent output.
    Returns error strings; empty = valid.

    Checks:
      1.  All webhookTopics are in the known-valid set.
      2.  cronSchedule, if present, is a valid 5-field cron expression.
      3.  Non-empty webhookTopics must be accompanied by a webhookContract.
      4.  Non-null cronSchedule must be accompanied by a cronContract.
      5.  storefront apps must declare widgetApiCatalog (non-null; [] is valid for pure storefront-read widgets).
      6.  All widgetApiCatalog paths start with '/'.
      7.  All widgetApiCatalog entries declare requestShape.
      8.  All widgetApiCatalog entries declare responseShape.
      9.  Admin archetypes must have a non-empty adminApiCatalog; non-admin archetypes must not.
      9b. No path parameters (:id, :run_id) in widgetApiCatalog or adminApiCatalog paths.
      10. All adminApiCatalog paths start with '/'.
      11. All adminApiCatalog entries declare requestShape.
      12. All adminApiCatalog entries declare responseShape.
      13. stateMachine.unknownSentinel must be the string "null" when stateMachine is set.
      13b.stateMachine must have entity, trackedField, and transitions when non-null.
      13c.stateMachine transitions must not use numeric range labels (positive/negative/zero/high/low etc.).
      14. dbContracts entries must include a tenant_id column. Money-holding
          columns (names ending _cents/_amount/_price/_total/…) must use BIGINT,
          not INTEGER — INTEGER overflows at ~$21.47M.
      15. storefront apps must declare widgetTargetTemplates (at least one valid template).
      16. cronBatching, when non-null, must include required=true.
      17. handlerCapabilities, when present, must be an array of strings drawn
          from the handler vocabulary in templates/capabilities/handler.py.
      18. widgetCapabilities must be null for non-storefront archetypes and an
          array from the widget vocabulary for storefront archetypes.
      19. adminCapabilities must be null for non-admin archetypes and an array
          from the admin vocabulary for admin archetypes (registry empty today).
      20. emailSpec must be a non-null object { type, purpose } when "email"
          is in handlerCapabilities, and null otherwise.
    """
    errors: List[str] = []
    shopify = architect_output.get("shopifyPlan") or {}
    impl = architect_output.get("appContracts") or {}

    # 1. Webhook topics must be known
    webhook_topics = shopify.get("webhookTopics") or []
    valid_topics = _get_valid_webhook_topics()
    for topic in webhook_topics:
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

    # 3. webhookTopics non-empty → webhookContract required
    if webhook_topics and not impl.get("webhookContract"):
        errors.append(
            "webhookContract is missing — required when webhookTopics is non-empty. "
            "Declare payloadFields (top-level payload fields the handler reads) and "
            "handlerMustProduce (what data must be resolved before DB writes)"
        )

    # 4. cronSchedule non-null → cronContract required
    if cron is not None and not impl.get("cronContract"):
        errors.append(
            "cronContract is missing — required when cronSchedule is non-null. "
            "Declare handlerMustProduce (what data each batch item must resolve before acting)"
        )

    # 5. storefront apps must declare widgetApiCatalog (non-null; [] valid for pure storefront-read widgets)
    widget_catalog = impl.get("widgetApiCatalog")
    if app_archetype in ("storefront_backend", "storefront_backend_admin") and widget_catalog is None:
        errors.append(
            "widgetApiCatalog is null for a storefront app — "
            "set to the list of paths the widget calls via host.call(), "
            "or [] if the widget reads exclusively from Shopify's public storefront API"
        )
    widget_catalog = widget_catalog or []

    # 6. Every widgetApiCatalog path must start with '/'
    for entry in widget_catalog:
        path = entry.get("path", "")
        if path and not path.startswith("/"):
            errors.append(f"widgetApiCatalog path {path!r} must start with '/'")

    # 7. Every widgetApiCatalog entry must declare requestShape
    for entry in widget_catalog:
        path = entry.get("path", "")
        if path and "requestShape" not in entry:
            errors.append(
                f"widgetApiCatalog path {path!r} is missing requestShape — "
                "declare the exact fields the widget sends in the host.call() body"
            )

    # 8. Every widgetApiCatalog entry must declare responseShape
    for entry in widget_catalog:
        path = entry.get("path", "")
        if path and "responseShape" not in entry:
            errors.append(
                f"widgetApiCatalog path {path!r} is missing responseShape — "
                "declare the exact JSON fields the handler returns on success"
            )

    # 9. Admin archetypes must declare a non-empty adminApiCatalog;
    #    non-admin archetypes must NOT (no admin UI generator will run for them).
    admin_catalog = impl.get("adminApiCatalog") or []
    if app_archetype in ("storefront_backend_admin", "backend_admin"):
        if not admin_catalog:
            errors.append(
                f"adminApiCatalog is null/empty for a {app_archetype!r} app — "
                "list every path the admin panel calls via bridge.call() "
                "with requestShape and responseShape"
            )
    elif admin_catalog:
        errors.append(
            f"adminApiCatalog is non-empty for a {app_archetype!r} app — "
            "no admin UI generator will run for this archetype, so these routes are dead code. "
            "Either change appCategory to backend_admin / storefront_backend_admin, "
            "or remove adminApiCatalog."
        )

    # 9b. No path parameters in widgetApiCatalog or adminApiCatalog paths.
    #     The harness routes on exact string equality — :param segments never match.
    _PATH_PARAM = re.compile(r"/:[\w]+")
    for catalog_name, catalog in [("widgetApiCatalog", widget_catalog), ("adminApiCatalog", admin_catalog)]:
        for entry in catalog:
            path = entry.get("path", "")
            if _PATH_PARAM.search(path):
                errors.append(
                    f"{catalog_name} path {path!r} contains a path parameter — "
                    "the harness routes on exact string equality, so ':param' segments will never match. "
                    "Use a flat path and put the identifier in requestShape instead: "
                    f"e.g. '{_PATH_PARAM.sub('', path)}/action' with requestShape: {{\"id\": \"string\"}}"
                )

    # 10. Every adminApiCatalog path must start with '/'
    for entry in admin_catalog:
        path = entry.get("path", "")
        if path and not path.startswith("/"):
            errors.append(f"adminApiCatalog path {path!r} must start with '/'")

    # 11. Every adminApiCatalog entry must declare requestShape
    for entry in admin_catalog:
        path = entry.get("path", "")
        if path and "requestShape" not in entry:
            errors.append(
                f"adminApiCatalog path {path!r} is missing requestShape — "
                "declare the exact fields the admin UI sends (use {{}} for paths with no body)"
            )

    # 12. Every adminApiCatalog entry must declare responseShape
    for entry in admin_catalog:
        path = entry.get("path", "")
        if path and "responseShape" not in entry:
            errors.append(
                f"adminApiCatalog path {path!r} is missing responseShape — "
                "declare the exact JSON fields the handler returns on success"
            )

    # 13. stateMachine.unknownSentinel must be the string "null" when stateMachine is set
    sm = impl.get("stateMachine")
    if sm and isinstance(sm, dict):
        sentinel = sm.get("unknownSentinel")
        if sentinel != "null":
            errors.append(
                f"stateMachine.unknownSentinel is {sentinel!r} — must be the string "
                f'"null" (not the number 0, not false, not empty string). '
                f"Reason: 0 is a valid real state value; null means never observed."
            )

    # 13b. stateMachine must have entity, trackedField, and transitions when non-null
    if sm and isinstance(sm, dict):
        for required_field in ("entity", "trackedField", "transitions"):
            if not sm.get(required_field):
                errors.append(
                    f"stateMachine is missing required field '{required_field}' — "
                    "stateMachine must declare: entity (the Shopify resource being tracked), "
                    "trackedField (the specific field compared across events), and "
                    "transitions (array of {from, to, action} objects). "
                    "Do not use stateMachine for application workflow states — "
                    "those are plain DB columns updated directly by the handler."
                )

    # 13c. stateMachine transitions must use exact stored enum values, not descriptive range labels
    _RANGE_LABEL_WORDS = re.compile(
        r"\b(positive|negative|zero|nonzero|non_zero|high|low|above|below|"
        r"greater|less|threshold|exceeded|or_negative|or_positive|and_above|and_below)\b",
        re.IGNORECASE,
    )
    if sm and isinstance(sm, dict):
        for t in sm.get("transitions") or []:
            for field in ("from", "to"):
                val = str(t.get(field, ""))
                if _RANGE_LABEL_WORDS.search(val):
                    errors.append(
                        f"stateMachine transition {field}={val!r} looks like a numeric range label, "
                        "not a stored enum value. stateMachine must not be used for numeric "
                        "threshold comparisons — set stateMachine: null and document the numeric "
                        "logic in webhookContract.handlerMustProduce instead."
                    )

    # 14. Each dbContracts entry must include a tenant_id column + typed column checks.
    #     Catching bogus types here (e.g. "STRING" instead of "TEXT") saves a Sonnet
    #     round-trip when the migration agent tries to generate DDL.
    _VALID_PG_TYPES = {
        "UUID", "BIGINT", "BIGSERIAL", "INTEGER", "INT", "SMALLINT", "SERIAL",
        "TEXT", "VARCHAR", "CHAR", "CITEXT",
        "BOOLEAN", "BOOL",
        "TIMESTAMPTZ", "TIMESTAMP", "DATE", "TIME", "INTERVAL",
        "JSONB", "JSON",
        "NUMERIC", "DECIMAL", "REAL", "DOUBLE", "DOUBLE PRECISION",
        "BYTEA",
    }
    _SHOPIFY_ID_COLS = {
        "variant_id", "product_id", "order_id", "customer_id",
        "inventory_item_id", "location_id", "fulfillment_id",
        "draft_order_id", "discount_id",
    }
    # Money-holding column name suffixes. INTEGER overflows at ~$21.47M in cents —
    # a single enterprise cart or any aggregate SUM() across a busy tenant can hit
    # that ceiling and crash the handler with 'integer out of range'. BIGINT caps
    # at ~$92 quadrillion, so it's the safe default for anything storing currency.
    _MONEY_COL_SUFFIXES = (
        "_cents", "_amount", "_price", "_total", "_subtotal",
        "_tax", "_fee", "_discount", "_cost", "_refund",
    )

    def _base_type(type_str: str) -> str:
        # Strip parameterisation (VARCHAR(255) → VARCHAR, NUMERIC(10,2) → NUMERIC).
        return type_str.upper().split("(")[0].strip()

    for contract in impl.get("dbContracts") or []:
        table = contract.get("table", "?")
        columns = contract.get("columns") or []
        col_names = {c.get("name", "").lower() for c in columns}
        if "tenant_id" not in col_names:
            errors.append(
                f"dbContracts table '{table}' is missing tenant_id column — "
                "every table must include tenant_id UUID NOT NULL for RLS tenant isolation"
            )
        for col in columns:
            name = (col.get("name") or "").lower()
            type_str = col.get("type") or ""
            if not type_str:
                errors.append(
                    f"dbContracts table '{table}' column '{name}' is missing a type — "
                    "every column must declare a PostgreSQL type"
                )
                continue
            base = _base_type(type_str)
            if base not in _VALID_PG_TYPES:
                errors.append(
                    f"dbContracts table '{table}' column '{name}' has invalid PostgreSQL type "
                    f"{type_str!r} — valid types: {sorted(_VALID_PG_TYPES)}"
                )
            if name in _SHOPIFY_ID_COLS and base == "UUID":
                errors.append(
                    f"dbContracts table '{table}' column '{name}' is a Shopify entity ID — "
                    f"use BIGINT (or TEXT), NEVER UUID. Only tenant_id and internal primary "
                    f"keys use UUID."
                )
            if base == "INTEGER" and any(name.endswith(s) for s in _MONEY_COL_SUFFIXES):
                errors.append(
                    f"dbContracts table '{table}' column '{name}' holds monetary values but uses INTEGER — "
                    f"use BIGINT. INTEGER overflows at ~$21.47M (2,147,483,647 cents); a single "
                    f"enterprise cart or SUM() aggregate above that ceiling crashes the handler with "
                    f"'integer out of range'."
                )

    # 15. storefront apps must declare widgetTargetTemplates
    _VALID_TEMPLATES = {"product", "collection", "index", "cart", "page", "blog", "article", "search"}
    if app_archetype in ("storefront_backend", "storefront_backend_admin"):
        targets = impl.get("widgetTargetTemplates") or []
        if not targets:
            errors.append(
                "widgetTargetTemplates is null/empty for a storefront app — "
                "declare which theme template pages the widget targets: "
                "one or more of: product, collection, index, cart, page, blog, article, search"
            )
        else:
            invalid = [t for t in targets if t not in _VALID_TEMPLATES]
            if invalid:
                errors.append(
                    f"widgetTargetTemplates contains invalid values {invalid!r} — "
                    f"valid values are: {sorted(_VALID_TEMPLATES)}"
                )

    # 16. cronBatching, when non-null, must include required=true
    batching = impl.get("cronBatching")
    if batching is not None and isinstance(batching, dict):
        if batching.get("required") is not True:
            errors.append(
                "cronBatching is missing required field 'required: true' — "
                "when cronBatching is declared, set required=true so the handler "
                "knows to inject the bulk-fetch pattern"
            )

    # 17. handlerCapabilities — closed-vocabulary array, REQUIRED (non-null).
    #     The handler JIT consumes this to decide which API docs to inject
    #     into the handler prompt; a missing value means the handler would
    #     ship without docs for the APIs it actually needs.
    handler_caps = impl.get("handlerCapabilities")
    if handler_caps is None:
        errors.append(
            "handlerCapabilities is missing — every app has a handler, so "
            "this field is required (use [] when the handler needs only the "
            "always-on surface ctx.db / ctx.logger / ctx.tenantId / ctx.trigger)"
        )
    else:
        _check_capability_list(
            handler_caps,
            field="handlerCapabilities",
            allowed=ALLOWED_HANDLER_CAPABILITIES,
            errors=errors,
        )

    # 18. widgetCapabilities — present only for storefront archetypes.
    #     null for backend / backend_admin, array (from widget vocabulary) for
    #     storefront_backend / storefront_backend_admin.
    widget_caps = impl.get("widgetCapabilities")
    has_widget = app_archetype in ("storefront_backend", "storefront_backend_admin")
    if has_widget:
        _check_capability_list(
            widget_caps,
            field="widgetCapabilities",
            allowed=ALLOWED_WIDGET_CAPABILITIES,
            errors=errors,
        )
    elif widget_caps is not None:
        errors.append(
            f"widgetCapabilities must be null for a {app_archetype!r} app — "
            "this archetype has no storefront widget, so there are no widget "
            "capabilities to declare (use null, not [])"
        )

    # 19. adminCapabilities — present only for admin archetypes.
    #     null for backend / storefront_backend, array (from admin vocabulary)
    #     for backend_admin / storefront_backend_admin. Admin vocabulary is
    #     empty today so the array is effectively always [] for admin archetypes.
    admin_caps = impl.get("adminCapabilities")
    has_admin_panel = app_archetype in ("backend_admin", "storefront_backend_admin")
    if has_admin_panel:
        _check_capability_list(
            admin_caps,
            field="adminCapabilities",
            allowed=ALLOWED_ADMIN_CAPABILITIES,
            errors=errors,
        )
    elif admin_caps is not None:
        errors.append(
            f"adminCapabilities must be null for a {app_archetype!r} app — "
            "this archetype has no admin panel, so there are no admin "
            "capabilities to declare (use null, not [])"
        )

    # 20. emailSpec — coupled to handlerCapabilities.
    #     Non-null object { type, purpose } when "email" is declared; null
    #     otherwise. Consumed downstream by the Email tab seed + the handler
    #     prompt's starter-content guidance.
    email_spec = impl.get("emailSpec")
    declares_email = isinstance(handler_caps, list) and "email" in handler_caps
    if declares_email:
        if email_spec is None:
            errors.append(
                "emailSpec is missing — required when 'email' is in "
                "handlerCapabilities. Set emailSpec to "
                "{ type: 'transactional'|'marketing', purpose: '<one-line description>' }"
            )
        elif not isinstance(email_spec, dict):
            errors.append(
                f"emailSpec must be an object, got {type(email_spec).__name__}"
            )
        else:
            spec_type = email_spec.get("type")
            if spec_type not in ("transactional", "marketing"):
                errors.append(
                    f"emailSpec.type must be 'transactional' or 'marketing', "
                    f"got {spec_type!r}"
                )
            purpose = email_spec.get("purpose")
            if not isinstance(purpose, str) or not purpose.strip():
                errors.append(
                    "emailSpec.purpose must be a non-empty string describing "
                    "when and why the email fires"
                )
    elif email_spec is not None:
        errors.append(
            "emailSpec must be null when 'email' is not in "
            "handlerCapabilities — do not declare an email spec for a "
            "handler that does not call ctx.services.email.send"
        )

    return errors


def _check_capability_list(
    value: Any,
    *,
    field: str,
    allowed: frozenset,
    errors: List[str],
) -> None:
    """
    Shared capability-list validation. Treats None as "omitted" (no-op).
    Rejects non-list, non-string items, and values outside the allowed set.
    """
    if value is None:
        return
    if not isinstance(value, list):
        errors.append(
            f"{field} must be an array of strings (or omitted) — "
            f"got {type(value).__name__}"
        )
        return
    unknown: List[str] = []
    bad_type: List[Any] = []
    for item in value:
        if not isinstance(item, str):
            bad_type.append(item)
        elif item not in allowed:
            unknown.append(item)
    if bad_type:
        errors.append(
            f"{field} contains non-string entries {bad_type!r} — "
            "every entry must be a capability name string"
        )
    if unknown:
        errors.append(
            f"{field} contains unknown value(s) {unknown!r} — "
            f"allowed values: {sorted(allowed)}"
        )


def _extract_js_fields(obj_literal: str) -> List[str]:
    """
    Extract property key names from a JS object literal fragment.

    Handles shorthand  { email, variantId }
    and explicit       { email: formData.email, variantId: someVar }

    Returns sorted list of key identifiers only (not values).
    Uses a split-based approach so the last field is always captured even when
    the closing `}` is not present in the captured substring.
    """
    keys: List[str] = []
    seen: set = set()
    s = obj_literal.strip().strip("{}").strip()
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        key = part.split(":")[0].strip()
        if re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", key) and key not in _NON_FIELD and key not in seen:
            keys.append(key)
            seen.add(key)
    return sorted(keys)


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
        r"\brequire\s*\(\s*['\"]https?['\"]",
        "Node.js native http/https modules are not allowed — use ctx.shopify for Shopify API, ctx.http.call(url) for external HTTP calls",
    ),
    (r"\beval\s*\(", "eval() is not allowed"),
    (r"\bprocess\.exit\b", "process.exit is not allowed"),
    (r"\bprocess\.kill\b", "process.kill is not allowed"),
    (r"\bprocess\.env\b", "process.env access is not allowed"),
    (r"\bnew\s+Function\s*\(", "new Function() is not allowed"),
    (r"\bsetInterval\s*\(", "setInterval is not allowed — handlers are short-lived invocations, not long-running processes"),
    (r"\bsetImmediate\s*\(", "setImmediate is not allowed"),
    (
        r"\bsetTimeout\s*\(",
        "setTimeout is not allowed in handlers — handlers are short-lived cron/webhook invocations, "
        "not UI code that needs debounce. Per-item sleeps inside loops burn cron runtime and risk "
        "timeouts; rate limiting belongs in the harness, not the handler.",
    ),
]

# Fields the old email API used to accept — all of them have moved into the
# merchant-configured template, so a handler passing any of them is calling a
# deprecated shape that will be silently ignored (or worse, break when the
# merchant does configure their template and the handler's values override it).
# Only { to, data } are allowed.
_DEPRECATED_EMAIL_FIELDS = frozenset(
    {"subject", "templateId", "template_id", "html", "body", "from"}
)


def _top_level_keys_of(code: str, start_idx: int) -> set:
    """
    Scan the object literal starting at the `{` at start_idx and return the set
    of property names declared at its top level (depth 0 of braces/brackets/parens).

    Handles strings and backticks so `{ key: "ignore: me" }` doesn't confuse us.
    Returns the empty set on malformed input rather than raising — this is a
    soft-check helper.
    """
    i = start_idx
    n = len(code)
    if i >= n or code[i] != "{":
        return set()
    depth = 0
    keys: set = set()
    in_string: Optional[str] = None
    at_key_position = True
    key_start = -1
    while i < n:
        c = code[i]
        if in_string:
            if c == "\\":
                i += 2
                continue
            if c == in_string:
                in_string = None
            i += 1
            continue
        if c in ('"', "'", "`"):
            in_string = c
            at_key_position = False
            i += 1
            continue
        if c == "{" or c == "[" or c == "(":
            depth += 1
            at_key_position = False
            i += 1
            continue
        if c == "}" or c == "]" or c == ")":
            depth -= 1
            if depth == 0 and c == "}":
                # End of our top-level object.
                # A trailing shorthand key right before the close also counts.
                if key_start >= 0 and at_key_position and depth == 0:
                    keys.add(code[key_start:i].strip())
                return keys
            i += 1
            continue
        if depth == 1:
            # Top-level of the object we're interested in.
            if c == "," and at_key_position and key_start >= 0:
                keys.add(code[key_start:i].strip())
                key_start = -1
            elif c == ":" and at_key_position and key_start >= 0:
                keys.add(code[key_start:i].strip())
                key_start = -1
                at_key_position = False
            elif c == ",":
                at_key_position = True
            elif at_key_position and (c.isalnum() or c == "_" or c == "$"):
                if key_start == -1:
                    key_start = i
        i += 1
    return keys


def _find_email_send_violations(code: str) -> List[str]:
    """Flag ctx.services.email.send() calls that pass deprecated fields."""
    errs: List[str] = []
    pattern = re.compile(r"ctx\.(?:services\.)?email\.send\s*\(\s*")
    for match in pattern.finditer(code):
        obj_start = match.end()
        if obj_start >= len(code) or code[obj_start] != "{":
            continue  # non-object-literal argument (e.g. a variable) — skip
        keys = _top_level_keys_of(code, obj_start)
        bad = sorted(keys & _DEPRECATED_EMAIL_FIELDS)
        if bad:
            errs.append(
                f"ctx.services.email.send() passes forbidden field(s) {bad} — "
                "the platform owns subject/body/html/templateId/from. "
                "Only { to, data } is accepted; put dynamic values inside data."
            )
    return errs


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
    cron_batching_required: bool = False,
    has_state_machine: bool = False,
) -> List[str]:
    """
    Validate the generated CommonJS handler.js.

    Checks:
      1. Syntax completeness (balanced braces/parens/strings).
      2. module.exports, webhookTopics, handler present.
      3. Forbidden patterns (fetch, eval, setInterval, setImmediate, setTimeout, process.env, etc.).
      4. Declared webhookTopics match the architect plan.
      5. Every widgetApiCatalog path has a ctx.widgetPath === '/path' branch
         outside any admin block (widget trigger routing).
      6. Every adminApiCatalog path has a ctx.adminPath === '/path' branch
         inside the ctx.trigger === 'admin' block.
      7. When cronBatching.required: handler has a cron trigger branch.
      8. When stateMachine is set: handler loads prior state from DB before writing.
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

    # 3b. Per-capability anti-pattern regexes — registry-owned. Each Capability
    # that supersedes a pattern the LLM might hand-roll (e.g. paginate
    # supersedes ?since_id= / ?page_info= URLs) declares a regex; a match means
    # the handler bypassed the capability and is rejected. Registry is the
    # single source of truth — no parallel list to maintain here.
    for cap_name, cap in HANDLER_CAPABILITY_REGISTRY.items():
        if not cap.static_validation_anti_pattern_regex:
            continue
        if re.search(cap.static_validation_anti_pattern_regex, code):
            errors.append(
                f"handler code hand-rolls a pattern that the '{cap_name}' capability "
                f"already provides — use the capability's helper instead "
                f"(see the capability's docs section)"
            )

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

    # 7. When cronBatching.required: handler must have a cron trigger branch.
    #    This is a structural gate — whether the bulk-fetch is correctly implemented
    #    inside that branch is verified by the agentic validator (Q7).
    if cron_batching_required:
        has_cron_branch = bool(
            re.search(r"ctx\.trigger\s*===\s*['\"]cron['\"]", code)
        )
        if not has_cron_branch:
            errors.append(
                "cronBatching.required is true but handler has no ctx.trigger === 'cron' branch — "
                "add a cron branch that bulk-fetches all Shopify data before iterating"
            )

    # 8. When stateMachine is set: handler must read prior state from DB before writing.
    #    Ensures the snapshot read (ctx.db`SELECT...`) precedes any INSERT/UPDATE that
    #    would record the new state — the agentic validator checks correctness of the logic.
    if has_state_machine:
        has_db_read = bool(re.search(r"ctx\.db`\s*SELECT", code, re.IGNORECASE))
        if not has_db_read:
            errors.append(
                "stateMachine is declared but handler never reads prior state from DB "
                "(no ctx.db`SELECT` found) — load the last-observed value before comparing "
                "to the incoming event and writing the new state"
            )

    # 9. ctx.services.email.send() must use the { to, data } shape only.
    errors.extend(_find_email_send_violations(code))

    return errors


# ── Migration ─────────────────────────────────────────────────────────────────


def validate_migration_artifact(sql: str, prior_tables: List[str] | None = None) -> List[str]:
    """Validate the generated PostgreSQL DDL migration.

    prior_tables: table names already applied in a previous deploy. RLS and
    CREATE POLICY checks are skipped for these — they already exist in the DB
    and the runner will make the policy creation idempotent.
    """
    errors: List[str] = []
    _prior = {t.lower() for t in (prior_tables or [])}

    if not sql.strip():
        return errors  # empty migration is valid

    forbidden_ddl = [
        (r"\bDROP\s+TABLE\b", "DROP TABLE"),
        (r"\bDROP\s+COLUMN\b", "DROP COLUMN"),
        (r"\bTRUNCATE\b", "TRUNCATE"),
    ]
    for pattern, name in forbidden_ddl:
        if re.search(pattern, sql, re.IGNORECASE):
            errors.append(f"forbidden SQL operation: {name}")

    # ALTER TABLE is allowed only for:
    #   - ENABLE ROW LEVEL SECURITY
    #   - ADD COLUMN IF NOT EXISTS  (safe incremental DDL for revision runs)
    alter_stmts = re.findall(r"\bALTER\s+TABLE\b[^;]+;", sql, re.IGNORECASE)
    for stmt in alter_stmts:
        is_rls = bool(re.search(r"\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b", stmt, re.IGNORECASE))
        is_add_col = bool(re.search(r"\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b", stmt, re.IGNORECASE))
        if not is_rls and not is_add_col:
            errors.append("forbidden SQL operation: ALTER TABLE on existing tables")

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
        # Skip RLS/policy checks for tables that already exist from a prior deploy —
        # the migration runner wraps CREATE POLICY in an idempotent DO block.
        if table_name.lower() in _prior:
            continue
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
    (
        r"\bwindow\.(parent|top|opener|frames)\b",
        "window.parent/top/opener/frames cross-frame access is not allowed",
    ),
    (
        r"\bdocument\.(?!createElement|createTextNode)",
        "direct document.* access is not allowed — use container.querySelector() and container.appendChild() instead. "
        "For styles: const s = document.createElement('style'); s.textContent = '...'; container.appendChild(s) — never document.head.",
    ),
    (r"\bsetInterval\s*\(", "setInterval is not allowed"),
]


# setTimeout allowance — debounce / throttle only. Accept calls whose SECOND
# argument is a numeric literal ≤ _MAX_DEBOUNCE_MS. Reject everything else:
#   - Computed delays (setTimeout(fn, computedMs)) — can't verify the bound.
#   - Long delays (setTimeout(fn, 5000))          — effectively a timer.
#   - No explicit delay (setTimeout(fn))          — defaults to 0 but opens the door to
#                                                   patterns the validator can't inspect.
_MAX_DEBOUNCE_MS = 500


def _extract_settimeout_delays(js: str) -> List[Optional[str]]:
    """
    For each setTimeout( call in js, return the delay (second top-level argument)
    as a stripped string, or None when no second argument is present.

    Uses a character scanner instead of a regex so that callbacks containing
    commas (arrow functions, multi-param functions, block bodies) are handled
    correctly.  Example: setTimeout(() => search(q, page), 300) → "300".
    """
    delays: List[Optional[str]] = []
    for m in re.finditer(r"\bsetTimeout\s*\(", js):
        i = m.end()           # index just past the opening '('
        n = len(js)
        depth = 1             # we're inside the outer '('
        in_string: Optional[str] = None
        first_top_comma: Optional[int] = None

        while i < n and depth > 0:
            c = js[i]
            if in_string:
                if c == "\\":
                    i += 2
                    continue
                if c == in_string:
                    in_string = None
            elif c in ('"', "'", "`"):
                in_string = c
            elif c in ("(", "[", "{"):
                depth += 1
            elif c in (")", "]", "}"):
                depth -= 1
            elif c == "," and depth == 1 and first_top_comma is None:
                # Only the FIRST top-level comma separates callback from delay.
                first_top_comma = i
            i += 1

        if first_top_comma is None:
            delays.append(None)   # no second argument
            continue

        # i now points one past the closing ')'; js[i-1] == ')'
        delay_str = js[first_top_comma + 1 : i - 1].strip()
        delays.append(delay_str)

    return delays


def _find_setTimeout_violations(js: str) -> List[str]:
    """Return error strings for each disallowed setTimeout usage."""
    errs: List[str] = []
    delays = _extract_settimeout_delays(js)

    for delay_str in delays:
        if delay_str is None:
            errs.append(
                "setTimeout call missing an explicit numeric delay argument — "
                "only setTimeout(fn, <literal ms ≤ 500>) is allowed"
            )
        elif not delay_str.isdigit():
            errs.append(
                f"setTimeout delay '{delay_str}' is not a numeric literal — "
                "only literal millisecond values ≤ 500 are allowed (debounce / throttle only)"
            )
        elif int(delay_str) > _MAX_DEBOUNCE_MS:
            errs.append(
                f"setTimeout delay {delay_str}ms exceeds {_MAX_DEBOUNCE_MS}ms — "
                "use event-driven patterns, not timers"
            )
    return errs


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
    (
        r"\bdocument\.(?!createElement|createTextNode)",
        "direct document.* access is not allowed — use container.querySelector() and container.appendChild() instead. "
        "For styles: const s = document.createElement('style'); s.textContent = '...'; container.appendChild(s) — never document.head.",
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

    # setTimeout is allowed only as a bounded debounce — check delays.
    errors.extend(_find_setTimeout_violations(admin_ui_js))

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
                f"field name mismatch. Align both sides to the widgetApiCatalog requestShape."
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
