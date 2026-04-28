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
      5.  storefront apps must declare widgetApiCatalog (non-null; [] is valid
          for pure storefront-read widgets).
      6.  Admin archetypes must have a non-empty adminApiCatalog; non-admin
          archetypes must not.
      7.  No path parameters (:id, :run_id) in widgetApiCatalog or
          adminApiCatalog paths.
      8.  stateMachine.unknownSentinel must be the string "null" when
          stateMachine is set.
      9.  dbContracts column rules:
            a. NO tenant_id column (schema isolation replaces RLS).
            b. Shopify entity ID columns (variant_id, product_id, order_id,
               customer_id, …) use BIGINT or TEXT, never UUID.
            c. Money columns (names ending _cents/_amount/_price/_total/…)
               use BIGINT — never INTEGER (overflow), never FLOAT/DOUBLE/REAL
               (drift), never TEXT/NUMERIC/DECIMAL (no SUM/range filter).
            d. Money columns must have a sibling `currency` column on the
               same table (else SUMs silently mix denominations).
            e. Platform-owned email-template column names (email_subject,
               email_body, email_body_template, email_cta_label, email_cta_url,
               email_from_name) are forbidden on app-owned tables.
            f. Singleton tables MUST NOT declare an `id` column or a
               uniqueConstraint.
            g. Column-level `enum`, when set, is a non-empty list of unique
               non-empty strings; any DEFAULT literal in `constraints` must
               be in the enum list.
      10. When stateMachine.unknownSentinel == "null", the tracked-state
          column in dbContracts MUST be NULLABLE.
      11. storefront apps must declare widgetTargetTemplates (at least one
          valid template).
      12. cronBatching, when non-null, must include required=true.
      13. handlerCapabilities is REQUIRED (non-null) and drawn from the
          handler vocabulary in subagents/prompts/capabilities/handler.py.
      14. widgetCapabilities is null for non-storefront archetypes and an
          array from the widget vocabulary for storefront archetypes.
      15. adminCapabilities is null for non-admin archetypes and an array
          from the admin vocabulary for admin archetypes (registry empty today).
      16. emailSpec must be a non-null object { type, purpose } when "email"
          is in handlerCapabilities, and null otherwise.
      17. shopifyGraphqlOperations names must be in the closed Admin/Storefront
          GraphQL operation indexes; non-empty admin/storefront ops require the
          matching shopify_graphql / shopify_storefront capability declared.

    Paranoid presence/format checks (path-starts-with-`/`, requestShape /
    responseShape presence, stateMachine field presence, valid-PG-type set,
    complexity enum, feasibility enum, edgeCases length, range-label
    transitions, etc.) are intentionally NOT enforced — see ARCH_RULES.md.
    The frontier model emits these correctly ~always given the prompt
    instructions; if it ever drifts, the bug_finder LLM validator and
    downstream codegen / tsc / migration generator surface the impact.
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

    # 6. Admin archetypes must declare a non-empty adminApiCatalog;
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

    # 7. Catalog path + method shape — no path parameters, non-empty path
    #    starting with '/', length within the wire-format budget, and
    #    method ∈ {GET, POST}. The harness routes on exact string equality
    #    (so ':param' never matches) and the served bundle's `__PLATFORM_CATALOG__`
    #    prelude carries (path, method) per row — Pydantic CatalogEntry +
    #    Zod CatalogEntrySchema both reject empty / oversized paths and
    #    methods outside {GET, POST}, so failing those at architect-emit
    #    time keeps the codegen retry loop in scope; without this gate, an
    #    invalid catalog would pass through codegen and dead-letter at the
    #    Pub/Sub subscriber instead.
    _PATH_PARAM = re.compile(r"/:[\w]+")
    _MAX_PATH_LEN = 512
    _ALLOWED_METHODS = {"GET", "POST"}
    for catalog_name, catalog in [
        ("widgetApiCatalog", widget_catalog),
        ("adminApiCatalog", admin_catalog),
    ]:
        for entry in catalog:
            path = entry.get("path", "")
            if not isinstance(path, str) or not path:
                errors.append(
                    f"{catalog_name} entry has missing/empty `path` — every "
                    "catalog row must declare a non-empty path starting with '/'."
                )
                continue
            if not path.startswith("/"):
                errors.append(
                    f"{catalog_name} path {path!r} must start with '/'."
                )
            if len(path) > _MAX_PATH_LEN:
                errors.append(
                    f"{catalog_name} path is {len(path)} chars (max "
                    f"{_MAX_PATH_LEN}). The bundle wire-format / subscriber "
                    "Zod schema rejects longer paths."
                )
            if _PATH_PARAM.search(path):
                errors.append(
                    f"{catalog_name} path {path!r} contains a path parameter — "
                    "the harness routes on exact string equality, so ':param' segments will never match. "
                    "Use a flat path and put the identifier in requestShape instead: "
                    f"e.g. '{_PATH_PARAM.sub('', path)}/action' with requestShape: {{\"id\": \"string\"}}"
                )
            method = entry.get("method")
            if method is not None:
                if not isinstance(method, str) or method.upper() not in _ALLOWED_METHODS:
                    errors.append(
                        f"{catalog_name} path {path!r} declares method "
                        f"{method!r} — must be 'GET' or 'POST'. The "
                        "method-aware SDK and the cross-handler validator "
                        "branch on this value; anything else silently "
                        "downgrades to POST and the catalog declaration "
                        "becomes a lie at runtime."
                    )

    # 8. stateMachine.unknownSentinel must be the string "null" when stateMachine is set
    sm = impl.get("stateMachine")
    if sm and isinstance(sm, dict):
        sentinel = sm.get("unknownSentinel")
        if sentinel != "null":
            errors.append(
                f"stateMachine.unknownSentinel is {sentinel!r} — must be the string "
                f'"null" (not the number 0, not false, not empty string). '
                f"Reason: 0 is a valid real state value; null means never observed."
            )

    # 9. dbContracts column rules: tenant_id forbidden, Shopify ID cols not
    #     UUID, money cols BIGINT only (with currency sibling), email-template
    #     cols rejected, singleton shape, column-level enum + DEFAULT
    #     membership. (Valid-PG-type set check dropped as paranoid — frontier
    #     models emit canonical PG types ~always; downstream migration
    #     generator surfaces bogus types when they slip through.)
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
    # Email-template fields are merchant-edited via Ton's Email tab (platform-
    # owned `app_email_configs` table). If the architect re-declares them on
    # an app-owned table, the handler writes one place while the merchant
    # edits another — silent data divergence with no easy detection.
    _EMAIL_TEMPLATE_COLS = {
        "email_subject",
        "email_body",
        "email_body_template",
        "email_cta_label",
        "email_cta_url",
        "email_from_name",
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
                continue
            base = _base_type(type_str)
            if name in _SHOPIFY_ID_COLS and base == "UUID":
                errors.append(
                    f"dbContracts table '{table}' column '{name}' is a Shopify entity ID — "
                    f"use BIGINT (or TEXT), NEVER UUID. Internal primary "
                    f"keys use UUID."
                )
            # Money columns: BIGINT only. INTEGER overflows at ~$21.47M;
            # FLOAT/DOUBLE/REAL drift (0.1 + 0.2 ≠ 0.3 → customer charged the
            # wrong amount); TEXT/NUMERIC/DECIMAL can't be SUMmed or range-
            # filtered cleanly; BIGSERIAL is an auto-incrementing sequence,
            # not a value type. The handler is taught to parse Shopify's
            # decimal strings into integer cents before INSERT.
            is_money_col = any(name.endswith(s) for s in _MONEY_COL_SUFFIXES)
            if is_money_col and base != "BIGINT":
                errors.append(
                    f"dbContracts table '{table}' column '{name}' holds monetary values but uses {base} — "
                    f"use BIGINT (integer minor units). FLOAT/DOUBLE/REAL drift (0.1+0.2 ≠ 0.3 → "
                    f"customer charged the wrong amount); INTEGER overflows at ~$21.47M; "
                    f"TEXT/NUMERIC/DECIMAL can't be SUMmed or range-filtered cleanly."
                )
            # Money columns must be paired with a sibling `currency` column on
            # the same table — otherwise SUM() aggregates silently mix USD/EUR
            # and reports/billing logic produce wrong numbers with no error.
            if is_money_col and "currency" not in col_names:
                errors.append(
                    f"dbContracts table '{table}' column '{name}' is a money column but the "
                    f"table has no `currency` sibling column — aggregations will silently mix "
                    f"denominations (USD/EUR/etc.). Add `currency TEXT NOT NULL` so SUM/GROUP BY "
                    f"can be denomination-safe."
                )
            # Email-template fields are platform-owned (merchant edits them
            # in Ton's Email tab → app_email_configs). Re-declaring them on
            # an app-owned table creates two writers and silent divergence.
            if name in _EMAIL_TEMPLATE_COLS:
                errors.append(
                    f"dbContracts table '{table}' column '{name}' is a platform-owned email-template "
                    f"field. Merchants edit these via Ton's Email tab (app_email_configs); declaring "
                    f"them on an app-owned table means handler writes never reflect what the merchant "
                    f"sees. Drop the column; if you need feature behavior driven by email content, "
                    f"render handler logic from the platform-owned template instead."
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

    # 10. Cross-section: when stateMachine.unknownSentinel == "null", the
    #     tracked-state column in dbContracts MUST be NULLABLE. The whole
    #     "first event = unknown" semantic depends on the column accepting
    #     NULL; a NOT NULL constraint either crashes the INSERT or forces a
    #     non-null sentinel value that contradicts the state-machine.
    if (
        sm
        and isinstance(sm, dict)
        and sm.get("unknownSentinel") == "null"
        and sm.get("trackedField")
    ):
        tracked = str(sm["trackedField"]).lower()
        for contract in impl.get("dbContracts") or []:
            for col in contract.get("columns") or []:
                if (col.get("name") or "").lower() != tracked:
                    continue
                constraints = (col.get("constraints") or "").upper()
                # NOT NULL is the failure case; bare "NOT NULL" or "NOT NULL DEFAULT …".
                if re.search(r"\bNOT\s+NULL\b", constraints):
                    errors.append(
                        f"dbContracts table '{contract.get('table', '?')}' column "
                        f"'{tracked}' is the stateMachine.trackedField with "
                        f'unknownSentinel="null", but its constraints declare NOT NULL '
                        f"({constraints!r}). The 'first event' semantic stores NULL until "
                        f"the first observation — drop NOT NULL (or change unknownSentinel)."
                    )

    # 11. storefront apps must declare widgetTargetTemplates
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

    # 12. cronBatching, when non-null, must include required=true
    batching = impl.get("cronBatching")
    if batching is not None and isinstance(batching, dict):
        if batching.get("required") is not True:
            errors.append(
                "cronBatching is missing required field 'required: true' — "
                "when cronBatching is declared, set required=true so the handler "
                "knows to inject the bulk-fetch pattern"
            )

    # 13. handlerCapabilities — closed-vocabulary array, REQUIRED (non-null).
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

    # 14. widgetCapabilities — present only for storefront archetypes.
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

    # 15. adminCapabilities — present only for admin archetypes.
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

    # 16. emailSpec — coupled to handlerCapabilities.
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

    # 17. shopifyGraphqlOperations — every name must exist in the relevant
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
