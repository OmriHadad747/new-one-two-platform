"""
Handler Generator — produces the CommonJS handler.js for the harness.

The Handler is the Shopify API authority: it receives the full MCP api_context
and decides independently which REST/GraphQL calls to make. The Architect's
contracts tell it WHAT data is needed; the api_context tells it WHAT is available
in the Shopify schema.

System prompt: HARNESS_BASE (always) — core-only (DB, trigger routing, logger,
output format, absolute rules, loop rule). Per-API docs (ctx.shopify, ctx.services,
ctx.http, ctx.storefront, npm packages) are JIT-injected into the USER prompt
from templates/capabilities/handler.py based on appContracts.handlerCapabilities.

User-prompt JIT sections:
  - Capability docs for each entry in handlerCapabilities (registry-driven).
  - SHOPIFY_REST_VS_GRAPHQL_GUIDE only when BOTH shopify_rest AND shopify_graphql
    are declared — no point showing a choose-one guide if only one is used.
  - Trigger-gated sections (unchanged):
      HARNESS_SECTION_WEBHOOK        — when webhookTopics is non-empty
      HARNESS_SECTION_STATE_MACHINE  — when appContracts.stateMachine is non-null
      HARNESS_SECTION_CRON_BATCHING  — when appContracts.cronBatching.required is true
      HARNESS_SECTION_WIDGET         — when platform_api_catalog is non-empty
      HARNESS_SECTION_WIDGET_STOREFRONT — when widgetApiCatalog is [] (storefront app, no backend widget routes)
      HARNESS_SECTION_ADMIN          — when adminApiCatalog is non-empty

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from shopify_mcp.client import validate_handler_graphql
from subagents.base import CodegenContext, Generator, _THINKING_BUDGET_HIGH
from subagents.static_validation import validate_handler_artifact
from templates.capabilities.handler import (
    HANDLER_CAPABILITY_REGISTRY,
    SHOPIFY_REST_VS_GRAPHQL_GUIDE,
)
from subagents.prompts.handler import (
    HARNESS_BASE,
    HARNESS_SECTION_ADMIN,
    HARNESS_SECTION_CRON_BATCHING,
    HARNESS_SECTION_STATE_MACHINE,
    HARNESS_SECTION_WEBHOOK,
    HARNESS_SECTION_WIDGET,
    HARNESS_SECTION_WIDGET_STOREFRONT,
)

log = logging.getLogger(__name__)

# Fence for the structured email-metadata sidecar the handler emits after the
# JS code when it calls ctx.services.email.send. See
# templates/capabilities/handler.py ("Email metadata sidecar") for the contract
# shown to the model.
_EMAIL_META_FENCE_RE = re.compile(
    r"```email-metadata\s*\n(.*?)\n```",
    re.DOTALL,
)


class HandlerGenerator(Generator):
    name = "handler"
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return f"You are an expert Node.js backend developer writing server side shopify applications.\n\n{HARNESS_BASE}"

    def user_prompt(self, ctx: CodegenContext) -> str:
        jit_sections = _build_jit_sections(ctx.plan, ctx.platform_api_catalog)
        webhook_contract_block = _format_webhook_contract(ctx.plan)
        cron_contract_block = _format_cron_contract(ctx.plan)
        gaps_block = _format_platform_gaps(ctx.plan)
        widget_catalog_block = _format_widget_catalog(ctx.platform_api_catalog)
        admin_catalog_block = _format_admin_catalog(ctx.plan)
        api_context_block = _format_api_context(ctx.api_context)
        prior_block = _format_prior_handler(ctx.prior_handler_code)
        # db_contracts, routing_checklist, edge_cases, quality_checklist are placed
        # at the END of the prompt — exact column names and required routes receive
        # the highest model attention here, reducing "lost in the middle" misses.
        db_contracts_block = _format_db_contracts(ctx.plan)
        routing_checklist = _format_routing_checklist(
            ctx.platform_api_catalog, ctx.plan
        )
        edge_cases_block = _format_edge_cases(ctx.plan)
        quality_checklist = _format_quality_checklist(ctx.plan)

        return (
            f"{jit_sections}"
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n\n"
            f"Shopify API plan:\n{json.dumps(ctx.plan.get('shopifyPlan', {}), indent=2)}\n"
            f"{webhook_contract_block}"
            f"{cron_contract_block}"
            f"{gaps_block}"
            f"{widget_catalog_block}"
            f"{admin_catalog_block}"
            f"{api_context_block}"
            f"{prior_block}"
            f"{db_contracts_block}"
            f"{routing_checklist}"
            f"{edge_cases_block}"
            f"{quality_checklist}"
            "Generate the handler.js module. Output ONLY the JavaScript code."
        )

    def parse(self, raw: str) -> str:
        # Strip any email-metadata sidecar first so it doesn't leak into the
        # code artifact. The sidecar is captured separately in generate().
        stripped = _EMAIL_META_FENCE_RE.sub("", raw).strip()
        text = re.sub(r"^```(?:javascript|js)?\s*", "", stripped, flags=re.MULTILINE)
        text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
        return text.strip()

    def generate(self, ctx: CodegenContext) -> Tuple[str, int, int]:
        """
        Overrides Generator.generate() to capture the email-metadata sidecar.

        The handler agent emits TWO things in its response when the handler
        calls ctx.services.email.send: the JS code, and a fenced
        ```email-metadata``` JSON block declaring the `variables` it passed
        and the `starterContent` to seed the Email tab.

        parse() handles the code path (and strips the sidecar out of the code
        artifact). This override additionally extracts the sidecar JSON and
        stashes it on ctx.handler_email_metadata — an OUTPUT slot on
        CodegenContext the orchestrator reads after this future resolves.
        """
        from models.adapter import get_llm, invoke
        from models.agent_models import get_agent_model

        complexity = (ctx.plan.get("appContracts") or {}).get("complexity", "low")
        thinking_budget = _THINKING_BUDGET_HIGH if complexity == "high" else None

        llm = get_llm(
            model=get_agent_model(self.name),
            max_tokens=self.max_tokens,
            thinking_budget=thinking_budget,
        )
        retry_suffix = self._format_retry_suffix(ctx.previous_errors)
        result = invoke(
            llm,
            self.system_prompt(),
            self.user_prompt(ctx),
            retry_suffix=retry_suffix,
        )

        ctx.handler_email_metadata = _extract_email_metadata(result.content)
        return self.parse(result.content), result.input_tokens, result.output_tokens

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        topics = ctx.plan.get("shopifyPlan", {}).get("webhookTopics", [])
        impl = ctx.plan.get("appContracts") or {}
        widget_catalog = impl.get("widgetApiCatalog") or []
        admin_catalog = impl.get("adminApiCatalog") or []
        batching = impl.get("cronBatching") or {}
        sm = impl.get("stateMachine")
        errors = validate_handler_artifact(
            artifact,
            topics,
            widget_catalog,
            admin_catalog,
            cron_batching_required=bool(batching.get("required")),
            has_state_machine=bool(sm and isinstance(sm, dict)),
        )
        errors += validate_handler_graphql(artifact)
        return errors


# ── Email-metadata sidecar extraction ──────────────────────────────────────────


def _extract_email_metadata(raw: str) -> Optional[Dict[str, Any]]:
    """
    Pull the ```email-metadata``` fenced JSON block out of the handler agent's
    raw response. Returns the parsed dict, or None when no sidecar was emitted
    (handler does not call ctx.services.email.send) or the block could not
    be parsed.

    Parse failures are logged but do not raise — the pipeline falls back to
    no starter content, which is recoverable (merchant fills in the Email tab
    manually). A loud failure here would be worse than a soft one.
    """
    match = _EMAIL_META_FENCE_RE.search(raw)
    if not match:
        return None
    body = match.group(1).strip()
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as err:
        log.warning(
            "handler emitted email-metadata block that is not valid JSON: %s", err
        )
        return None
    if not isinstance(parsed, dict):
        log.warning(
            "handler email-metadata block parsed to %s, expected object",
            type(parsed).__name__,
        )
        return None
    return parsed


# ── JIT harness section builder ────────────────────────────────────────────────


def _build_jit_sections(
    plan: Dict[str, Any], platform_api_catalog: List[Dict[str, str]]
) -> str:
    """
    Inject only the harness pattern sections relevant to this specific plan.
    Irrelevant sections are omitted so the model focuses on what applies.

    Assembly order:
      1. Capability docs (registry-driven) — one block per declared
         handlerCapabilities entry. This is where ctx.shopify.*, ctx.services.*,
         ctx.http, ctx.storefront, and npm-package docs come from now.
      2. SHOPIFY_REST_VS_GRAPHQL_GUIDE — injected only when BOTH shopify_rest
         and shopify_graphql are declared. The choose-one decision guide has
         no value for handlers that use only one.
      3. Trigger-gated sections (webhook / state machine / cron batching /
         widget / admin routing) — unchanged.
    """
    shopify = plan.get("shopifyPlan") or {}
    impl = plan.get("appContracts") or {}
    sm = impl.get("stateMachine") or {}
    batching = impl.get("cronBatching") or {}

    sections: List[str] = []

    # 1. Capability docs, preserving the registry's declared order so the
    #    assembled prompt is stable (cache-friendly) for the same cap set.
    declared = set(impl.get("handlerCapabilities") or [])
    for cap_name, cap in HANDLER_CAPABILITY_REGISTRY.items():
        if cap_name in declared and cap.docs:
            sections.append(cap.docs)

    # 2. REST vs GraphQL joint decision guide — only when both are declared.
    if "shopify_rest" in declared and "shopify_graphql" in declared:
        sections.append(SHOPIFY_REST_VS_GRAPHQL_GUIDE)

    # 3. Trigger-gated sections (unchanged).
    if shopify.get("webhookTopics"):
        sections.append(HARNESS_SECTION_WEBHOOK)

    if sm and isinstance(sm, dict):
        sections.append(HARNESS_SECTION_STATE_MACHINE)

    if batching.get("required"):
        sections.append(HARNESS_SECTION_CRON_BATCHING)

    if platform_api_catalog:
        sections.append(HARNESS_SECTION_WIDGET)

    # widgetApiCatalog == [] means storefront app with no backend widget routes →
    # widget reads exclusively from Shopify's public storefront API
    if impl.get("widgetApiCatalog") is not None and not platform_api_catalog:
        sections.append(HARNESS_SECTION_WIDGET_STOREFRONT)

    admin_catalog = impl.get("adminApiCatalog") or []
    if admin_catalog:
        sections.append(HARNESS_SECTION_ADMIN)

    return "\n\n".join(sections) + ("\n\n" if sections else "")


# ── Prompt-building helpers ────────────────────────────────────────────────────


def _format_webhook_contract(plan: Dict[str, Any]) -> str:
    """
    Show the webhookContract so the handler knows exactly what payload fields to
    read and what data it must resolve before writing to the DB.
    """
    contract = (plan.get("appContracts") or {}).get("webhookContract")
    if not contract:
        return ""
    payload_fields = contract.get("payloadFields") or []
    must_produce = contract.get("handlerMustProduce") or ""
    lines = [
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "WEBHOOK CONTRACT:",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ]
    if payload_fields:
        lines.append(
            f"Payload fields to read from ctx.payload: {', '.join(payload_fields)}"
        )
    if must_produce:
        lines.append(f"Handler must resolve before DB writes: {must_produce}")
    lines.append(
        "Use the Shopify API context below to decide which REST/GraphQL calls\n"
        "to make in order to produce the required data.\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
    return "\n".join(lines)


def _format_cron_contract(plan: Dict[str, Any]) -> str:
    """Show the cronContract so the cron handler knows what to resolve per batch item."""
    contract = (plan.get("appContracts") or {}).get("cronContract")
    if not contract:
        return ""
    must_produce = contract.get("handlerMustProduce") or ""
    if not must_produce:
        return ""
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "CRON CONTRACT:\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"Handler must resolve per batch item: {must_produce}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _format_db_contracts(plan: Dict[str, Any]) -> str:
    """
    Show the DB schema so the handler uses exact table and column names in SQL.
    """
    contracts = (plan.get("appContracts") or {}).get("dbContracts") or []
    if not contracts:
        return ""
    lines = [
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "DB SCHEMA — use these exact table and column names in all SQL:",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ]
    for contract in contracts:
        table = contract.get("table", "?")
        columns = [c["name"] for c in (contract.get("columns") or [])]
        lines.append(f"  {table}: {', '.join(columns)}")
    lines.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
    return "\n".join(lines)


def _format_widget_catalog(catalog: List[Dict[str, Any]]) -> str:
    """
    Show the widget API catalog with requestShape and responseShape so the handler
    destructures ctx.widgetBody with the exact field names and returns the exact shape.
    """
    if not catalog:
        return ""
    lines = ["\nWidget API catalog (implement each route exactly as specified):"]
    for e in catalog:
        req = e.get("requestShape", "{}")
        resp = e.get("responseShape", "{}")
        lines.append(f"  {e['method']} {e['path']}")
        lines.append(f"    receive:  const {{ ... }} = ctx.widgetBody  →  {req}")
        lines.append(f"    return:   {resp}")
    return "\n".join(lines) + "\n"


def _format_admin_catalog(plan: Dict[str, Any]) -> str:
    """
    Show the admin API catalog with requestShape and responseShape so the handler
    destructures ctx.adminBody with the exact field names and returns the exact shape.
    """
    catalog = (plan.get("appContracts") or {}).get("adminApiCatalog") or []
    if not catalog:
        return ""
    lines = ["\nAdmin UI catalog (implement each route exactly as specified):"]
    for e in catalog:
        req = e.get("requestShape", "{}")
        resp = e.get("responseShape", "{}")
        lines.append(f"  {e.get('method', 'POST')} {e['path']}")
        lines.append(f"    receive:  const {{ ... }} = ctx.adminBody  →  {req}")
        lines.append(f"    return:   {resp}")
    return "\n".join(lines) + "\n"


def _format_api_context(api_context: Any) -> str:
    """
    Inject the live Shopify API context so the handler can decide which
    REST/GraphQL calls to make to produce the data required by the contracts.
    """
    if not api_context:
        return ""
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "SHOPIFY API CONTEXT — webhook payload shapes and resource schemas.\n"
        "Use this to decide which REST/GraphQL calls to make and how to\n"
        "traverse the response to produce the data declared in the contracts above.\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{api_context}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _format_platform_gaps(plan: Dict[str, Any]) -> str:
    """Render platformGaps so the handler knows what to do instead of missing ctx capabilities."""
    gaps = (plan.get("appContracts") or {}).get("platformGaps") or []
    if not gaps:
        return ""
    lines = "\n".join(
        f"  - {g.get('gap', '')}: {g.get('mitigation', '')}" for g in gaps
    )
    return f"\nPlatform limitations (implement exactly as stated):\n{lines}\n"


def _format_prior_handler(prior_code: Any) -> str:
    """Inject the currently deployed handler.js for revision runs."""
    if not prior_code:
        return ""
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "REVISION RUN — currently deployed handler.js:\n"
        "(Apply the merchant feedback above as targeted changes to this code.\n"
        " Preserve all logic that is NOT related to the reported issue.)\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{prior_code}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _format_edge_cases(plan: Dict[str, Any]) -> str:
    """Render architect-declared edge cases so the handler addresses each one."""
    cases = (plan.get("appContracts") or {}).get("edgeCases") or []
    if not cases:
        return ""
    lines = "\n".join(f"  - {c}" for c in cases)
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "EDGE CASES — your handler MUST handle each of these scenarios:\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{lines}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _format_quality_checklist(plan: Dict[str, Any]) -> str:
    """Emit a quality self-check as the last section before the generation instruction."""
    shopify = plan.get("shopifyPlan") or {}
    impl = plan.get("appContracts") or {}

    checks = [
        "Every DB write handles the case where the record already exists (UPSERT or check-then-insert where appropriate)",
        "Every customer-facing response includes meaningful data or error messages, not empty objects",
    ]

    if shopify.get("webhookTopics"):
        checks.append(
            "Webhook handler is idempotent — duplicate deliveries of the same event do not create duplicate records or actions"
        )

    if impl.get("widgetApiCatalog"):
        checks.append(
            "Widget routes return useful error responses (not just empty {}) when data is missing or the request is invalid"
        )

    lines = "\n".join(f"  ✓ {c}" for c in checks)
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "QUALITY CHECKLIST — verify your handler satisfies ALL of these:\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{lines}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _format_routing_checklist(
    widget_catalog: List[Dict[str, Any]],
    plan: Dict[str, Any],
) -> str:
    """
    Emit a pre-generation routing checklist as the last thing the model sees.
    Lists every route that MUST appear in the generated handler.
    Only emitted when at least one catalog is non-empty.
    """
    admin_catalog: List[Dict[str, Any]] = (plan.get("appContracts") or {}).get(
        "adminApiCatalog"
    ) or []
    if not widget_catalog and not admin_catalog:
        return ""

    lines = [
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "ROUTING CHECKLIST — your handler MUST include ALL of these branches:",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ]

    if widget_catalog:
        lines.append("Inside  if (ctx.trigger === 'widget') { ... }:")
        for entry in widget_catalog:
            path = entry.get("path", "")
            resp = entry.get("responseShape", "")
            lines.append(f"  ✓ if (ctx.widgetPath === '{path}')  →  return {resp}")

    if admin_catalog:
        lines.append("Inside  if (ctx.trigger === 'admin') { ... }:")
        for entry in admin_catalog:
            path = entry.get("path", "")
            resp = entry.get("responseShape", "")
            lines.append(f"  ✓ if (ctx.adminPath === '{path}')  →  return {resp}")

    lines.append(
        "Validation rejects the handler if ANY of these branches is missing.\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
    return "\n".join(lines) + "\n"
