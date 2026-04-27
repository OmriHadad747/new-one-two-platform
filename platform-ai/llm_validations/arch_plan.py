"""
Architect-plan validation — runs after the architect agent and before any codegen.

Public entry point: validate_architect_plan.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from subagents.prompts.capabilities import (
    ALLOWED_ADMIN_CAPABILITIES,
    ALLOWED_HANDLER_CAPABILITIES,
    ALLOWED_WIDGET_CAPABILITIES,
)
from subagents.prompts.topics.webhook import WEBHOOK_TOPICS as _VALID_WEBHOOK_TOPICS
from utils.static_validations.cron import is_valid_cron as _is_valid_cron
from llm_validations.shopify_ops import validate_op_names as _validate_catalog_ops


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
      14. dbContracts entries must NOT include a tenant_id column (schema
          isolation replaces RLS). Money-holding columns (names ending
          _cents/_amount/_price/_total/…) must use BIGINT, not INTEGER —
          INTEGER overflows at ~$21.47M.
      15. storefront apps must declare widgetTargetTemplates (at least one valid template).
      16. cronBatching, when non-null, must include required=true.
      17. handlerCapabilities, when present, must be an array of strings drawn
          from the handler vocabulary in subagents/prompts/capabilities/handler.py.
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
    valid_topics = _VALID_WEBHOOK_TOPICS
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
    if (
        app_archetype in ("storefront_backend", "storefront_backend_admin")
        and widget_catalog is None
    ):
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
    for catalog_name, catalog in [
        ("widgetApiCatalog", widget_catalog),
        ("adminApiCatalog", admin_catalog),
    ]:
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
        "UUID",
        "BIGINT",
        "BIGSERIAL",
        "INTEGER",
        "INT",
        "SMALLINT",
        "SERIAL",
        "TEXT",
        "VARCHAR",
        "CHAR",
        "CITEXT",
        "BOOLEAN",
        "BOOL",
        "TIMESTAMPTZ",
        "TIMESTAMP",
        "DATE",
        "TIME",
        "INTERVAL",
        "JSONB",
        "JSON",
        "NUMERIC",
        "DECIMAL",
        "REAL",
        "DOUBLE",
        "DOUBLE PRECISION",
        "BYTEA",
    }
    _SHOPIFY_ID_COLS = {
        "variant_id",
        "product_id",
        "order_id",
        "customer_id",
        "inventory_item_id",
        "location_id",
        "fulfillment_id",
        "draft_order_id",
        "discount_id",
    }
    # Money-holding column name suffixes. INTEGER overflows at ~$21.47M in cents —
    # a single enterprise cart or any aggregate SUM() across a busy tenant can hit
    # that ceiling and crash the handler with 'integer out of range'. BIGINT caps
    # at ~$92 quadrillion, so it's the safe default for anything storing currency.
    _MONEY_COL_SUFFIXES = (
        "_cents",
        "_amount",
        "_price",
        "_total",
        "_subtotal",
        "_tax",
        "_fee",
        "_discount",
        "_cost",
        "_refund",
    )

    def _base_type(type_str: str) -> str:
        # Strip parameterisation (VARCHAR(255) → VARCHAR, NUMERIC(10,2) → NUMERIC).
        return type_str.upper().split("(")[0].strip()

    for contract in impl.get("dbContracts") or []:
        table = contract.get("table", "?")
        columns = contract.get("columns") or []
        col_names = {c.get("name", "").lower() for c in columns}
        is_singleton = bool(contract.get("singleton"))
        # Schema isolation replaces RLS (each tenant has its own Postgres
        # schema; the deployer pins search_path at runtime). A tenant_id
        # column is drift from the new model — reject it early, before it
        # reaches the migration generator or the platform-back SQL
        # validator.
        if "tenant_id" in col_names:
            errors.append(
                f"dbContracts table '{table}' declares a tenant_id column — "
                "schema isolation replaces row-level tenant_id. Drop the "
                "column; bare names resolve into the tenant's schema via "
                "search_path at deploy time."
            )
        # Singleton config tables: the migration generator emits a
        # `singleton BOOLEAN PRIMARY KEY` column for the architect; declaring
        # an `id` column or a uniqueConstraint here means the architect did
        # not pick the singleton shape correctly (the upsert pattern would
        # still target the wrong key). Reject early — see Finding 4 in
        # docs/FINDINGS_DEFERRED_4_5_6.md.
        if is_singleton:
            if "id" in col_names:
                errors.append(
                    f"dbContracts table '{table}' has singleton: true but also "
                    "declares an 'id' column — singleton tables MUST NOT have "
                    "an id column. The migration generator emits "
                    "'singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton = true)' "
                    "as the natural primary key."
                )
            if contract.get("uniqueConstraint"):
                errors.append(
                    f"dbContracts table '{table}' has singleton: true but also "
                    "declares uniqueConstraint — the singleton flag pins the "
                    "table to one row by construction; uniqueConstraint must be null."
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
                    f"use BIGINT (or TEXT), NEVER UUID. Internal primary "
                    f"keys use UUID."
                )
            if base == "INTEGER" and any(name.endswith(s) for s in _MONEY_COL_SUFFIXES):
                errors.append(
                    f"dbContracts table '{table}' column '{name}' holds monetary values but uses INTEGER — "
                    f"use BIGINT. INTEGER overflows at ~$21.47M (2,147,483,647 cents); a single "
                    f"enterprise cart or SUM() aggregate above that ceiling crashes the handler with "
                    f"'integer out of range'."
                )
            # Column-level `enum` validation. When declared, it must be a
            # non-empty list of unique non-empty strings, and any DEFAULT
            # literal in `constraints` must be in the enum (or else the row
            # will be rejected by the CHECK constraint at insert time).
            enum_values = col.get("enum")
            if enum_values is not None:
                if not isinstance(enum_values, list) or not enum_values:
                    errors.append(
                        f"dbContracts table '{table}' column '{name}' has "
                        "'enum' set but it is not a non-empty list — drop the "
                        "field or list every allowed string value"
                    )
                else:
                    bad = [v for v in enum_values if not isinstance(v, str) or not v]
                    if bad:
                        errors.append(
                            f"dbContracts table '{table}' column '{name}' enum "
                            f"contains non-string or empty entries: {bad!r}"
                        )
                    if len(set(enum_values)) != len(enum_values):
                        errors.append(
                            f"dbContracts table '{table}' column '{name}' enum "
                            f"contains duplicate values: {enum_values!r}"
                        )
                    constraints_str = col.get("constraints") or ""
                    default_match = re.search(
                        r"\bDEFAULT\s+'([^']+)'", constraints_str, re.IGNORECASE
                    )
                    if default_match and default_match.group(1) not in enum_values:
                        errors.append(
                            f"dbContracts table '{table}' column '{name}' has "
                            f"DEFAULT '{default_match.group(1)}' which is not in "
                            f"enum {enum_values!r} — the CHECK constraint would "
                            "reject every default-valued INSERT"
                        )

    # 15. storefront apps must declare widgetTargetTemplates
    _VALID_TEMPLATES = {
        "product",
        "collection",
        "index",
        "cart",
        "page",
        "blog",
        "article",
        "search",
    }
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

    # 21. shopifyGraphqlOperations — every name must exist in the relevant
    # surface's catalog. The architect picks from the operation index injected
    # into its system prompt; anything outside that index is hallucination
    # and would fail offline GraphQL validation downstream. Catching it here
    # avoids burning a handler-codegen attempt on a contract the handler
    # can't satisfy.
    ops = impl.get("shopifyGraphqlOperations") or {}
    declared_caps = handler_caps if isinstance(handler_caps, list) else []
    if isinstance(ops, dict):
        admin_ops = ops.get("admin") or []
        if not isinstance(admin_ops, list) or any(
            not isinstance(n, str) for n in admin_ops
        ):
            errors.append(
                "shopifyGraphqlOperations.admin must be an array of strings "
                "(operation names from the Shopify Admin GraphQL catalog)"
            )
        else:
            invalid = _validate_catalog_ops("admin", admin_ops)
            for name in invalid:
                errors.append(
                    f"shopifyGraphqlOperations.admin: operation {name!r} is not in the "
                    f"Shopify Admin GraphQL catalog — pick a name from the operation "
                    f"index in the SHOPIFY GRAPHQL section"
                )
            if admin_ops and "shopify_graphql" not in declared_caps:
                errors.append(
                    "shopifyGraphqlOperations.admin is non-empty but 'shopify_graphql' "
                    "is not in handlerCapabilities — declare the capability or empty "
                    "the admin operations list"
                )

        storefront_ops = ops.get("storefront") or []
        if not isinstance(storefront_ops, list) or any(
            not isinstance(n, str) for n in storefront_ops
        ):
            errors.append(
                "shopifyGraphqlOperations.storefront must be an array of strings "
                "(operation names from the Shopify Storefront GraphQL catalog)"
            )
        else:
            invalid = _validate_catalog_ops("storefront", storefront_ops)
            for name in invalid:
                errors.append(
                    f"shopifyGraphqlOperations.storefront: operation {name!r} is not in "
                    f"the Shopify Storefront GraphQL catalog — pick a name from the "
                    f"operation index in the SHOPIFY GRAPHQL section"
                )
            if storefront_ops and "shopify_storefront" not in declared_caps:
                errors.append(
                    "shopifyGraphqlOperations.storefront is non-empty but "
                    "'shopify_storefront' is not in handlerCapabilities — declare the "
                    "capability or empty the storefront operations list"
                )
    elif ops:
        errors.append(
            "shopifyGraphqlOperations must be an object with 'admin' and "
            "'storefront' string-array fields"
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
