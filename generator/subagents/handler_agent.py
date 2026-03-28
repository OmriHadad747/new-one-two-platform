"""
Handler Generator — produces the CommonJS handler.js for the harness.

System prompt: HARNESS_BASE (always) — ctx API surface, output format, core rules.

JIT harness sections (Change 3): injected into the user prompt only when the plan
requires them, keeping the context window focused on what actually applies:
  HARNESS_SECTION_WEBHOOK       — when webhookTopics is non-empty
  HARNESS_SECTION_STATE_MACHINE — when implementationSpec.stateMachine.needsStateTracking
  HARNESS_SECTION_CRON_BATCHING — when implementationSpec.cronBatching.required
  HARNESS_SECTION_WIDGET        — when platform_api_catalog is non-empty (storefront_ui apps)

The codeSpec from the Planner is rendered as a numbered algorithm the generator
implements literally — no interpretation, no gap-filling.

Model: claude-sonnet-4-6 (prefers_code_model = True)
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.validation import validate_handler
from templates.harness_contract import (
    HARNESS_BASE,
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

        return (
            f"{retry_block}"
            f"{jit_sections}"
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n\n"
            f"Shopify API plan:\n{json.dumps(ctx.plan.get('shopifyPlan', {}), indent=2)}\n"
            f"{gaps_block}"
            f"{catalog_block}"
            f"{spec_block}"
            "Generate the handler.js module. Output ONLY the JavaScript code."
        )

    def parse(self, raw: str) -> str:
        text = re.sub(r"^```(?:javascript|js)?\s*", "", raw.strip(), flags=re.MULTILINE)
        text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
        return text.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        topics = ctx.plan.get("shopifyPlan", {}).get("webhookTopics", [])
        return validate_handler(artifact, topics)


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
    functions: List[Dict[str, Any]] = code_spec.get("functions") or []

    if not webhook_path and not cron_path and not widget_path and not functions:
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


def _format_platform_gaps(plan: Dict[str, Any]) -> str:
    """Render platformGaps so the handler knows what to do instead of missing ctx capabilities."""
    gaps = (plan.get("implementationSpec") or {}).get("platformGaps") or []
    if not gaps:
        return ""
    lines = "\n".join(f"  - {g['need']}: {g['mitigation']}" for g in gaps)
    return f"\nPlatform limitations (ctx cannot provide these — handle exactly as stated):\n{lines}\n"
