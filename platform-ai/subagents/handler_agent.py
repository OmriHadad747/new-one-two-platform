"""
Handler Generator — produces the TypeScript route / lib files that drop
into the platform-back handler template.

The handler is the Shopify API authority: it decides independently which
REST/GraphQL calls to make against the architect's contracts. The contracts
tell it WHAT data is needed; the handler picks HOW to fetch it via the
shopify client (see ../lib/shopify.ts).

System prompt: HARNESS_BASE (always) — core-only (file-bundle output
format, req.platform, sql tagged template, platform.* SDK, absolute
rules, logging, cross-cutting Shopify loop rule).

Per-API docs (@shopify/shopify-api client, platform /services/*, npm
packages) are JIT-injected into the USER prompt from
subagents/prompts/capabilities/handler.py based on appContracts.handlerCapabilities.

User-prompt JIT sections:
  - Capability docs for each entry in handlerCapabilities (registry-driven).
  - Trigger-gated sections:
      HARNESS_SECTION_WEBHOOK        — when webhookTopics is non-empty
      HARNESS_SECTION_CRON           — when shopifyPlan.cronSchedule is non-null
      HARNESS_SECTION_STATE_MACHINE  — when appContracts.stateMachine is non-null
      HARNESS_SECTION_CRON_BATCHING  — when appContracts.cronBatching.required is true
      HARNESS_SECTION_WIDGET         — when widgetApiCatalog is non-empty
      HARNESS_SECTION_WIDGET_STOREFRONT — when widgetApiCatalog is []
                                         (storefront app, widget uses public
                                         Shopify storefront API directly)
      HARNESS_SECTION_ADMIN          — when adminApiCatalog is non-empty

Output shape: parse() returns the raw ===FILE:===/===END=== marker
bundle as a string. Downstream consumers (crew.py, static_validation.py,
validator/revision agents) call utils.file_bundle.parse_file_bundle
to turn the string into [{path, contents}, ...].

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from subagents.base import (
    CodegenContext,
    Generator,
    _THINKING_BUDGET_HIGH,
    needs_extended_thinking,
)
from llm_validations.handler_artifact import validate_handler_artifact
from subagents.jit.handler import build_handler_jit_sections
from subagents.prompts.topics.handler import HANDLER as HARNESS_BASE

log = logging.getLogger(__name__)

# Fence for the structured email-metadata sidecar the handler emits
# alongside the file bundle when it calls /services/email/send. See
# subagents/prompts/capabilities/handler.py ("Email metadata sidecar") for the
# contract shown to the model.
_EMAIL_META_FENCE_RE = re.compile(
    r"```email-metadata\s*\n(.*?)\n```",
    re.DOTALL,
)


class HandlerGenerator(Generator):
    name = "handler"
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return (
            "You are an expert TypeScript backend developer writing Shopify "
            "app handlers that run inside the platform-back Express handler "
            "template on Cloud Run.\n\n"
            f"{HARNESS_BASE}"
        )

    def user_prompt(self, ctx: CodegenContext) -> str:
        jit_sections = _build_jit_sections(
            ctx.plan,
            ctx.platform_api_catalog,
            intent_hint=ctx.intent.get("desiredOutcome") or None,
        )
        webhook_contract_block = _format_webhook_contract(ctx.plan)
        cron_contract_block = _format_cron_contract(ctx.plan)
        gaps_block = _format_platform_gaps(ctx.plan)
        widget_catalog_block = _format_widget_catalog(ctx.platform_api_catalog)
        admin_catalog_block = _format_admin_catalog(ctx.plan)
        prior_block = _format_prior_handler(ctx.prior_handler_code)
        # db_contracts, routing_checklist, edge_cases, quality_checklist are
        # placed at the END of the prompt — exact column names and required
        # routes receive the highest model attention here, reducing
        # "lost in the middle" misses.
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
            f"{prior_block}"
            f"{db_contracts_block}"
            f"{routing_checklist}"
            f"{edge_cases_block}"
            f"{quality_checklist}"
            "Emit every TypeScript file the handler needs using the "
            "===FILE: <path>=== / ===END=== markers defined in the harness. "
            "Output ONLY the file bundle (plus the email-metadata sidecar "
            "when and only when the handler calls /services/email/send). "
            "No prose, no markdown fences wrapping the whole response."
        )

    def parse(self, raw: str) -> str:
        """
        Strip the email-metadata sidecar and any stray outer markdown fence,
        and return the rest VERBATIM — the ===FILE:===/===END=== markers
        MUST be preserved so downstream consumers (crew.py,
        static_validation.py, validator_agent, revision_agent) can parse
        individual files via utils.file_bundle.parse_file_bundle.

        The email-metadata sidecar is captured separately in generate()
        before this method runs; we also defensively strip it here so that
        if parse() is called directly by tests, the returned bundle is
        clean either way.
        """
        # 1. Remove the email-metadata sidecar (captured elsewhere).
        stripped = _EMAIL_META_FENCE_RE.sub("", raw).strip()
        # 2. Strip a single outer ``` fence if the model wrapped the entire
        #    response. The inner ===FILE:===/===END=== markers stay as-is.
        stripped = re.sub(r"^```(?:typescript|ts)?\s*\n", "", stripped, count=1)
        stripped = re.sub(r"\n```\s*$", "", stripped, count=1)
        return stripped.strip()

    def generate(self, ctx: CodegenContext) -> Tuple[str, int, int]:
        """
        Overrides Generator.generate() to capture the email-metadata sidecar.

        The handler agent emits TWO things in its response when the handler
        calls /services/email/send: the file bundle and a fenced
        ```email-metadata``` JSON block declaring the `variables` it passed
        and the `starterContent` to seed the Email tab.

        parse() handles the code path (and strips the sidecar out of the
        returned bundle). This override additionally extracts the sidecar
        JSON and stashes it on ctx.handler_email_metadata — an OUTPUT slot
        on CodegenContext the orchestrator reads after this future resolves.
        """
        from models.adapter import get_llm, invoke
        from models.agent_models import get_agent_model

        thinking_budget = (
            _THINKING_BUDGET_HIGH if needs_extended_thinking(ctx.plan) else None
        )

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
        ctx.handler_raw_response = result.content
        return self.parse(result.content), result.input_tokens, result.output_tokens

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        shopify = ctx.plan.get("shopifyPlan", {})
        impl = ctx.plan.get("appContracts") or {}
        return validate_handler_artifact(
            artifact,
            api_plan_topics=shopify.get("webhookTopics") or [],
            widget_catalog=impl.get("widgetApiCatalog"),
            admin_catalog=impl.get("adminApiCatalog") or [],
            declared_capabilities=impl.get("handlerCapabilities") or [],
            db_contracts=impl.get("dbContracts") or [],
            raw_artifact=ctx.handler_raw_response or artifact,
        )


# ── Email-metadata sidecar extraction ──────────────────────────────────────────


def _extract_email_metadata(raw: str) -> Optional[Dict[str, Any]]:
    """
    Pull the ```email-metadata``` fenced JSON block out of the handler
    agent's raw response. Returns the parsed dict, or None when no sidecar
    was emitted (handler does not call /services/email/send) or the block
    could not be parsed.

    Parse failures are logged but do not raise — the pipeline falls back to
    no starter content, which is recoverable (merchant fills in the Email
    tab manually). A loud failure here would be worse than a soft one.
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
    plan: Dict[str, Any],
    platform_api_catalog: List[Dict[str, str]],
    intent_hint: str | None = None,
) -> str:
    """Thin wrapper — delegates to the shared handler JIT assembler."""
    return build_handler_jit_sections(plan, platform_api_catalog, intent_hint=intent_hint)


# ── Prompt-building helpers ────────────────────────────────────────────────────


def _format_webhook_contract(plan: Dict[str, Any]) -> str:
    """
    Show the webhookContract so the handler knows exactly what payload
    fields to read and what data it must resolve before writing to the DB.
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
            "Payload fields available on the `payload` argument "
            "(cast as `(payload ?? {}) as <YourShape>`): " + ", ".join(payload_fields)
        )
    if must_produce:
        lines.append(f"Handler must resolve before DB writes: {must_produce}")
    lines.append(
        "Decide which GraphQL queries and mutations to make via the shopify\n"
        "client (see capability docs above) to produce the required data.\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
    return "\n".join(lines)


def _format_cron_contract(plan: Dict[str, Any]) -> str:
    """Show the cronContract so the cron job knows what to resolve per item."""
    contract = (plan.get("appContracts") or {}).get("cronContract")
    if not contract:
        return ""
    must_produce = contract.get("handlerMustProduce") or ""
    if not must_produce:
        return ""
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "CRON CONTRACT (resolved inside the `jobs.main` body in src/routes/cron.ts):\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"Each iteration must resolve: {must_produce}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _format_db_contracts(plan: Dict[str, Any]) -> str:
    """
    Show the DB schema so the handler uses exact table and column names
    in SQL. Surfaces two extras downstream of the architect contract:
      - column-level `enum` lists, so the handler writes ONLY listed values.
      - table-level `singleton: true`, so the handler upserts via
        `ON CONFLICT (singleton) DO UPDATE` and reads via
        `WHERE singleton = true` instead of inventing fake conflict targets.
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
        columns = contract.get("columns") or []
        col_names = [c["name"] for c in columns]
        is_singleton = bool(contract.get("singleton"))
        if is_singleton:
            lines.append(f"  {table}  (singleton config table — exactly one row):")
            lines.append(f"    columns: singleton (BOOLEAN PK), {', '.join(col_names)}")
            lines.append(
                "    READ:   await sql`SELECT ... FROM "
                f"{table} WHERE singleton = true`"
            )
            lines.append(
                "    WRITE:  await sql`INSERT INTO "
                f"{table} (singleton, ...) VALUES (true, ...) "
                "ON CONFLICT (singleton) DO UPDATE SET ...`"
            )
        else:
            lines.append(f"  {table}: {', '.join(col_names)}")
        for col in columns:
            enum_values = col.get("enum")
            if isinstance(enum_values, list) and enum_values:
                literal_list = ", ".join(f"'{v}'" for v in enum_values)
                lines.append(
                    f"    {col['name']} enum — write ONLY these literal "
                    f"values: [{literal_list}]"
                )
    lines.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
    return "\n".join(lines)


def _format_widget_catalog(catalog: List[Dict[str, Any]]) -> str:
    """
    Show the widget API catalog with requestShape and responseShape so the
    handler destructures req.body with the exact field names and returns
    the exact shape.
    """
    if not catalog:
        return ""
    lines = ["\nWidget API catalog (implement each route in src/routes/widget.ts):"]
    for e in catalog:
        method = (e.get("method") or "POST").upper()
        path = e.get("path", "")
        req = e.get("requestShape", "{}")
        resp = e.get("responseShape", "{}")
        lines.append(f"  {method} /widget{path}")
        lines.append(f"    receive:  const {{ ... }} = req.body  →  {req}")
        lines.append(f"    return:   {resp}")
    return "\n".join(lines) + "\n"


def _format_admin_catalog(plan: Dict[str, Any]) -> str:
    """
    Show the admin API catalog with requestShape and responseShape so the
    handler destructures req.body with the exact field names and returns
    the exact shape.
    """
    catalog = (plan.get("appContracts") or {}).get("adminApiCatalog") or []
    if not catalog:
        return ""
    lines = ["\nAdmin UI catalog (implement each route in src/routes/admin.ts):"]
    for e in catalog:
        method = (e.get("method") or "POST").upper()
        path = e.get("path", "")
        req = e.get("requestShape", "{}")
        resp = e.get("responseShape", "{}")
        lines.append(f"  {method} /admin{path}")
        lines.append(f"    receive:  const {{ ... }} = req.body  →  {req}")
        lines.append(f"    return:   {resp}")
    return "\n".join(lines) + "\n"


def _format_platform_gaps(plan: Dict[str, Any]) -> str:
    """Render platformGaps so the handler knows how to handle missing capabilities."""
    gaps = (plan.get("appContracts") or {}).get("platformGaps") or []
    if not gaps:
        return ""
    lines = "\n".join(
        f"  - {g.get('gap', '')}: {g.get('mitigation', '')}" for g in gaps
    )
    return f"\nPlatform limitations (implement exactly as stated):\n{lines}\n"


def _format_prior_handler(prior: Any) -> str:
    """
    Inject the currently deployed handler for revision runs.

    Accepts either:
      - str — legacy single-file handler.js (pre-phase-2 bundles). Rendered
        as-is under a single pseudo-path.
      - List[{path, contents}] — new file bundle. Rendered with each
        file under its ===FILE:=== / ===END=== markers so the model sees
        the exact shape it will re-emit.

    Empty / None → no section (first-run generation, nothing to revise).
    """
    if not prior:
        return ""
    rendered = _render_prior_files(prior)
    if not rendered:
        return ""
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "REVISION RUN — currently deployed handler source:\n"
        "(Apply the merchant feedback above as targeted changes to these files.\n"
        " Preserve all logic that is NOT related to the reported issue.\n"
        " Re-emit every file via its own ===FILE:===/===END=== markers.)\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{rendered}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _render_prior_files(prior: Any) -> str:
    """Render prior_handler_code as a marker-style file listing, or fall back."""
    if isinstance(prior, list):
        parts: List[str] = []
        for entry in prior:
            if not isinstance(entry, dict):
                continue
            path = entry.get("path") or "src/routes/handler.ts"
            contents = entry.get("contents") or ""
            parts.append(f"===FILE: {path}===\n{contents}\n===END===")
        return "\n".join(parts)
    if isinstance(prior, str):
        # Legacy single-file bundle — show it as one pseudo-file. The model
        # will still re-emit via the new marker format because the output-
        # format section of HARNESS_BASE mandates it.
        return f"===FILE: src/routes/legacy-handler.js===\n{prior}\n===END==="
    return ""


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
        "Every DB write handles the case where the record already exists "
        "(UPSERT or check-then-insert where appropriate)",
        "Every customer-facing response includes meaningful data or error "
        "messages, not empty objects",
    ]

    if shopify.get("webhookTopics"):
        checks.append(
            "Webhook handler is idempotent — the template's processed_webhooks "
            "gate dedupes the envelope, but business INSERTs still use "
            "ON CONFLICT guards so partial-failure retries don't duplicate"
        )

    if impl.get("widgetApiCatalog"):
        checks.append(
            "Widget routes return useful error responses (not just empty {}) "
            "when data is missing or the request is invalid"
        )

    if shopify.get("cronSchedule"):
        checks.append(
            "Cron jobs are idempotent — the template runs each job up to 3 "
            "times on failure; side effects must be guarded so a retry does "
            "not double-execute work the previous attempt already completed"
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
        "ROUTING CHECKLIST — your handler MUST register ALL of these routes:",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ]

    if widget_catalog:
        lines.append("In src/routes/widget.ts:")
        for entry in widget_catalog:
            method = (entry.get("method") or "POST").lower()
            path = entry.get("path", "")
            resp = entry.get("responseShape", "")
            lines.append(
                f'  ✓ widgetRouter.{method}("{path}", async (req, res) => '
                f"…)  →  res.json({resp})"
            )

    if admin_catalog:
        lines.append("In src/routes/admin.ts:")
        for entry in admin_catalog:
            method = (entry.get("method") or "POST").lower()
            path = entry.get("path", "")
            resp = entry.get("responseShape", "")
            lines.append(
                f'  ✓ adminRouter.{method}("{path}", async (req, res) => '
                f"…)  →  res.json({resp})"
            )

    lines.append(
        "Validation rejects the handler if ANY of these routes is missing.\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
    return "\n".join(lines) + "\n"
