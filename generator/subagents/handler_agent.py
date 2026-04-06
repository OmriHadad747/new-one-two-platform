"""
Handler Generator — produces the CommonJS handler.js for the harness.

System prompt: HARNESS_BASE (always) — ctx API surface, output format, core rules.

JIT harness sections (Change 3): injected into the user prompt only when the plan
requires them, keeping the context window focused on what actually applies:
  HARNESS_SECTION_WEBHOOK       — when webhookTopics is non-empty
  HARNESS_SECTION_STATE_MACHINE — when implementationSpec.stateMachine.needsStateTracking
  HARNESS_SECTION_CRON_BATCHING — when implementationSpec.cronBatching.required
  HARNESS_SECTION_WIDGET        — when platform_api_catalog is non-empty (storefront_backend / storefront_backend_admin apps)

The codeSpec from the Planner is rendered as a numbered algorithm the generator
implements literally — no interpretation, no gap-filling.

Model: claude-sonnet-4-6 (prefers_code_model = True)
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.validation import validate_handler_artifact
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
    prefers_code_model = True
    max_tokens = 8192

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return f"You are an expert Node.js developer writing Shopify automation handlers.\n\n{HARNESS_BASE}"

    def user_prompt(self, ctx: CodegenContext) -> str:
        retry_block = self.format_retry_block(ctx.previous_errors)
        jit_sections = _build_jit_sections(ctx.plan, ctx.platform_api_catalog)
        spec_block = _format_code_spec(ctx.plan)
        gaps_block = _format_platform_gaps(ctx.plan)
        catalog_block = _format_widget_catalog(ctx.platform_api_catalog)
        admin_catalog_block = _format_admin_catalog(ctx.plan)
        prior_block = _format_prior_handler(ctx.prior_handler_code)
        field_contracts_block = _format_field_contracts(ctx.plan)
        routing_checklist = _format_routing_checklist(ctx.platform_api_catalog, ctx.plan)

        return (
            f"{retry_block}"
            f"{jit_sections}"
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n\n"
            f"Shopify API plan:\n{json.dumps(ctx.plan.get('shopifyPlan', {}), indent=2)}\n"
            f"{gaps_block}"
            f"{catalog_block}"
            f"{admin_catalog_block}"
            f"{spec_block}"
            f"{field_contracts_block}"
            f"{prior_block}"
            f"{routing_checklist}"
            "Generate the handler.js module. Output ONLY the JavaScript code."
        )

    def parse(self, raw: str) -> str:
        text = re.sub(r"^```(?:javascript|js)?\s*", "", raw.strip(), flags=re.MULTILINE)
        text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
        return text.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        topics = ctx.plan.get("shopifyPlan", {}).get("webhookTopics", [])
        impl = ctx.plan.get("implementationSpec") or {}
        widget_catalog = impl.get("widgetApiCatalog") or []
        admin_catalog = impl.get("adminApiCatalog") or []
        return validate_handler_artifact(artifact, topics, widget_catalog, admin_catalog)


# ── JIT harness section builder (Change 3) ────────────────────────────────────


def _build_jit_sections(plan: Dict[str, Any], platform_api_catalog: List[Dict[str, str]]) -> str:
    """
    Inject only the harness pattern sections relevant to this specific plan.
    Irrelevant sections are omitted so the model focuses on what applies.
    """
    shopify = plan.get("shopifyPlan") or {}
    impl = plan.get("implementationSpec") or {}
    sm = impl.get("stateMachine") or {}
    batching = impl.get("cronBatching") or {}

    sections: List[str] = []

    if shopify.get("webhookTopics"):
        sections.append(HARNESS_SECTION_WEBHOOK)

    if sm.get("needsStateTracking"):
        sections.append(HARNESS_SECTION_STATE_MACHINE)

    if batching.get("required") or shopify.get("webhookTopics"):
        sections.append(HARNESS_SECTION_CRON_BATCHING)

    if platform_api_catalog:
        sections.append(HARNESS_SECTION_WIDGET)

    storefront_reads = (plan.get("implementationSpec") or {}).get("storefrontReads") or []
    widget_guidance = (plan.get("implementationSpec") or {}).get("widgetGuidance") or ""
    if storefront_reads or "host.storefront" in widget_guidance:
        sections.append(HARNESS_SECTION_WIDGET_STOREFRONT)

    admin_catalog = (plan.get("implementationSpec") or {}).get("adminApiCatalog") or []
    if admin_catalog:
        sections.append(HARNESS_SECTION_ADMIN)

    return "".join(sections)


# ── Prompt-building helpers ────────────────────────────────────────────────────


def _format_code_spec(plan: Dict[str, Any]) -> str:
    """
    Render the codeSpec from implementationSpec as a numbered algorithm.
    The generator implements this literally — no interpretation required.
    """
    impl = plan.get("implementationSpec") or {}
    code_spec = impl.get("codeSpec") or {}

    webhook_path: List[str] = code_spec.get("webhookPath") or []
    cron_path: List[str] = code_spec.get("cronPath") or []
    widget_path: List[str] = code_spec.get("widgetPath") or []
    admin_path: List[str] = code_spec.get("adminPath") or []
    functions: List[Dict[str, Any]] = code_spec.get("functions") or []

    if not webhook_path and not cron_path and not widget_path and not admin_path and not functions:
        return ""

    parts: List[str] = [
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "IMPLEMENTATION SPEC — implement exactly as described, step by step:",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ]

    if webhook_path:
        steps = "\n".join(f"  {i + 1}. {s}" for i, s in enumerate(webhook_path))
        parts.append(f"\nWebhook handler path:\n{steps}")

    if cron_path:
        steps = "\n".join(f"  {i + 1}. {s}" for i, s in enumerate(cron_path))
        parts.append(f"\nCron handler path:\n{steps}")

    if widget_path:
        steps = "\n".join(f"  {i + 1}. {s}" for i, s in enumerate(widget_path))
        parts.append(f"\nWidget handler path (ctx.trigger === 'widget'):\n{steps}")

    if admin_path:
        steps = "\n".join(f"  {i + 1}. {s}" for i, s in enumerate(admin_path))
        parts.append(f"\nAdmin UI handler path (ctx.trigger === 'admin'):\n{steps}")

    if functions:
        parts.append("\nHelper functions:")
        for fn in functions:
            fn_steps = "\n".join(
                f"    {i + 1}. {s}" for i, s in enumerate(fn.get("steps") or [])
            )
            parts.append(f"  {fn['name']}:\n{fn_steps}")

    parts.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
    return "\n".join(parts)


def _format_widget_catalog(catalog: List[Dict[str, Any]]) -> str:
    """
    Show the widget API catalog with response shapes so the handler returns exact field names.
    Mirrors what the widget generator sees — both sides must agree on these shapes.
    """
    if not catalog:
        return ""
    lines = []
    for e in catalog:
        shape = e.get("responseShape")
        shape_str = f" → return {shape}" if shape else ""
        lines.append(f"  {e['method']} {e['path']}{shape_str}")
    return (
        "\nWidget API catalog (handler MUST return the exact responseShape for each path):\n"
        + "\n".join(lines)
        + "\n"
    )


def _format_admin_catalog(plan: Dict[str, Any]) -> str:
    """Show the admin API catalog so the handler returns exact responseShapes for admin paths."""
    catalog = (plan.get("implementationSpec") or {}).get("adminApiCatalog") or []
    if not catalog:
        return ""
    lines = []
    for e in catalog:
        shape = e.get("responseShape")
        shape_str = f" → return {shape}" if shape else ""
        lines.append(f"  {e.get('method', 'POST')} {e['path']}{shape_str}")
    return (
        "\nAdmin UI catalog (handler MUST return the exact responseShape for each admin path):\n"
        + "\n".join(lines)
        + "\n"
    )


def _format_prior_handler(prior_code: Any) -> str:
    """
    Inject the currently deployed handler as context for revision runs.
    The model should treat the feedback-augmented prompt as a diff spec and
    apply targeted changes — not regenerate from scratch.
    """
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


def _format_platform_gaps(plan: Dict[str, Any]) -> str:
    """Render platformGaps so the handler knows what to do instead of missing ctx capabilities."""
    gaps = (plan.get("implementationSpec") or {}).get("platformGaps") or []
    if not gaps:
        return ""
    lines = "\n".join(f"  - {g['need']}: {g['mitigation']}" for g in gaps)
    return f"\nPlatform limitations (ctx cannot provide these — handle exactly as stated):\n{lines}\n"


def _format_field_contracts(plan: Dict[str, Any]) -> str:
    """
    Extract field contracts from the validated codeSpec and surface them as a
    dedicated, immutable section the handler must follow exactly.

    For each widgetApiCatalog path that sends a body:
      const { field1, field2 } = ctx.widgetBody   ← exact names, no synonyms

    For each adminApiCatalog path that sends a body:
      const { field1, field2 } = ctx.adminBody    ← exact names, no synonyms

    These are extracted from the same codeSpec steps both generators read —
    using exactly these names is the only way validation passes.
    """
    from subagents.validation import extract_widget_field_contracts, extract_admin_field_contracts

    impl = plan.get("implementationSpec") or {}
    widget_path: List[str] = (impl.get("codeSpec") or {}).get("widgetPath") or []
    admin_path: List[str] = (impl.get("codeSpec") or {}).get("adminPath") or []

    widget_contracts = extract_widget_field_contracts(widget_path)
    admin_contracts = extract_admin_field_contracts(admin_path)

    if not widget_contracts and not admin_contracts:
        return ""

    lines = [
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "FIELD CONTRACTS — destructure ctx.widgetBody / ctx.adminBody with EXACTLY these names.",
        "Using any synonym, abbreviation, or different name will fail validation.",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ]
    for path, fields in sorted(widget_contracts.items()):
        lines.append(f"  {path}:  const {{ {', '.join(fields)} }} = ctx.widgetBody")
    for path, fields in sorted(admin_contracts.items()):
        lines.append(f"  {path}:  const {{ {', '.join(fields)} }} = ctx.adminBody")
    lines.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
    return "\n".join(lines)


def _format_routing_checklist(
    widget_catalog: List[Dict[str, Any]],
    plan: Dict[str, Any],
) -> str:
    """
    Emit a pre-generation routing checklist as the last thing the model sees.

    Lists every ctx.widgetPath route that MUST appear in the generated handler.
    This prevents the common failure where the model writes all business logic
    but omits the trigger dispatch scaffold entirely.

    Only emitted when at least one catalog is non-empty — backend-only apps
    (no widget, no admin) have no routes to check and get no checklist.
    """
    admin_catalog: List[Dict[str, Any]] = (
        (plan.get("implementationSpec") or {}).get("adminApiCatalog") or []
    )
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
            shape = entry.get("responseShape", "")
            lines.append(f"  ✓ if (ctx.widgetPath === '{path}')  →  return {shape}")

    if admin_catalog:
        lines.append("Inside  if (ctx.trigger === 'admin') { ... }:")
        for entry in admin_catalog:
            path = entry.get("path", "")
            shape = entry.get("responseShape", "")
            lines.append(f"  ✓ if (ctx.widgetPath === '{path}')  →  return {shape}")

    lines.append(
        "Validation rejects the handler if ANY of these branches is missing.\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
    return "\n".join(lines) + "\n"
