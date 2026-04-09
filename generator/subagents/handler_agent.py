"""
Handler Generator — produces the CommonJS handler.js for the harness.

The Handler is the Shopify API authority: it receives the full MCP api_context
and decides independently which REST/GraphQL calls to make. The Architect's
contracts tell it WHAT data is needed; the api_context tells it WHAT is available
in the Shopify schema.

System prompt: HARNESS_BASE (always) — ctx API surface, output format, core rules.

JIT harness sections — injected into the user prompt only when the plan requires them:
  HARNESS_SECTION_WEBHOOK       — when webhookTopics is non-empty
  HARNESS_SECTION_STATE_MACHINE — when appContracts.stateMachine is non-null
  HARNESS_SECTION_CRON_BATCHING — when appContracts.cronBatching.required is true
  HARNESS_SECTION_WIDGET        — when platform_api_catalog is non-empty
  HARNESS_SECTION_WIDGET_STOREFRONT — when widgetApiCatalog is [] (storefront app, no backend widget routes)
  HARNESS_SECTION_ADMIN         — when adminApiCatalog is non-empty

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from shopify_mcp.client import validate_handler_graphql
from subagents.base import CodegenContext, Generator
from subagents.static_validation import validate_handler_artifact
from templates.harness_contract import (
    HARNESS_BASE,
    HARNESS_SECTION_ADMIN,
    HARNESS_SECTION_CRON_BATCHING,
    HARNESS_SECTION_STATE_MACHINE,
    HARNESS_SECTION_WEBHOOK,
    HARNESS_SECTION_WIDGET,
    HARNESS_SECTION_WIDGET_STOREFRONT,
)


class HandlerGenerator(Generator):
    name = "handler"
    max_tokens = 8192

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return f"You are an expert Node.js developer writing Shopify automation handlers.\n\n{HARNESS_BASE}"

    def user_prompt(self, ctx: CodegenContext) -> str:
        retry_block = self.format_retry_block(ctx.previous_errors)
        jit_sections = _build_jit_sections(ctx.plan, ctx.platform_api_catalog)
        webhook_contract_block = _format_webhook_contract(ctx.plan)
        cron_contract_block = _format_cron_contract(ctx.plan)
        gaps_block = _format_platform_gaps(ctx.plan)
        db_contracts_block = _format_db_contracts(ctx.plan)
        widget_catalog_block = _format_widget_catalog(ctx.platform_api_catalog)
        admin_catalog_block = _format_admin_catalog(ctx.plan)
        api_context_block = _format_api_context(ctx.api_context)
        prior_block = _format_prior_handler(ctx.prior_handler_code)
        routing_checklist = _format_routing_checklist(
            ctx.platform_api_catalog, ctx.plan
        )

        edge_cases_block = _format_edge_cases(ctx.plan)
        quality_checklist = _format_quality_checklist(ctx.plan)

        return (
            f"{retry_block}"
            f"{jit_sections}"
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n\n"
            f"Shopify API plan:\n{json.dumps(ctx.plan.get('shopifyPlan', {}), indent=2)}\n"
            f"{webhook_contract_block}"
            f"{cron_contract_block}"
            f"{gaps_block}"
            f"{db_contracts_block}"
            f"{widget_catalog_block}"
            f"{admin_catalog_block}"
            f"{api_context_block}"
            f"{prior_block}"
            f"{routing_checklist}"
            f"{edge_cases_block}"
            f"{quality_checklist}"
            "Generate the handler.js module. Output ONLY the JavaScript code."
        )

    def parse(self, raw: str) -> str:
        text = re.sub(r"^```(?:javascript|js)?\s*", "", raw.strip(), flags=re.MULTILINE)
        text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
        return text.strip()

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


# ── JIT harness section builder ────────────────────────────────────────────────


def _build_jit_sections(
    plan: Dict[str, Any], platform_api_catalog: List[Dict[str, str]]
) -> str:
    """
    Inject only the harness pattern sections relevant to this specific plan.
    Irrelevant sections are omitted so the model focuses on what applies.
    """
    shopify = plan.get("shopifyPlan") or {}
    impl = plan.get("appContracts") or {}
    sm = impl.get("stateMachine") or {}
    batching = impl.get("cronBatching") or {}

    sections: List[str] = []

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

    return "".join(sections)


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
        lines.append(f"Payload fields to read from ctx.payload: {', '.join(payload_fields)}")
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
    lines = "\n".join(f"  - {g.get('gap', '')}: {g.get('mitigation', '')}" for g in gaps)
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
        "Shopify API calls are wrapped in try/catch with graceful degradation (log + continue, not crash)",
    ]

    if shopify.get("webhookTopics"):
        checks.append(
            "Webhook handler is idempotent — duplicate deliveries of the same event do not create duplicate records or actions"
        )

    if shopify.get("cronSchedule"):
        checks.append(
            "Cron job has a reasonable LIMIT on DB queries and Shopify API calls to prevent processing unbounded rows"
        )

    if impl.get("widgetApiCatalog"):
        checks.append(
            "Widget routes return useful error responses (not just empty {}) when data is missing or the request is invalid"
        )

    if impl.get("adminApiCatalog"):
        checks.append(
            "Admin routes validate input and return clear error messages the UI can display"
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
