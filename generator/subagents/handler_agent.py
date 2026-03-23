"""
Handler Generator — produces the CommonJS handler.js for the harness.

Constraints come from two sources:
  - HARNESS_CONTRACT (static):  the platform API surface, absolute rules,
                                Shopify API patterns. Never feature-specific.
  - CodegenContext.strategy (dynamic): feature-specific decisions from the
                                Strategy Agent (state machine, platform gaps,
                                cron batching). Injected into the user prompt.

Model: claude-sonnet-4-6 (prefers_code_model = True)
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from subagents.base import CodegenContext, Generator
from subagents.validation import validate_handler
from templates.harness_contract import HARNESS_CONTRACT

_SYSTEM_PROMPT = f"""You are an expert Node.js developer writing Shopify automation handlers.

{HARNESS_CONTRACT}"""


class HandlerGenerator(Generator):
    name = "handler"
    prefers_code_model = True
    max_tokens = 8192

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return _SYSTEM_PROMPT

    def user_prompt(self, ctx: CodegenContext) -> str:
        retry_block = self.format_retry_block(ctx.previous_errors)
        strategy_block = _format_strategy_block(ctx.strategy)

        return (
            f"{retry_block}"
            f"Merchant's goal: {ctx.intent.get('desiredOutcome', '')}\n\n"
            f"API Plan to implement:\n{json.dumps(ctx.api_plan, indent=2)}\n"
            f"{strategy_block}"
            "Generate the handler.js module that implements this plan exactly.\n"
            "Only output JavaScript code — no explanation, no markdown fences."
        )

    def parse(self, raw: str) -> str:
        text = re.sub(r"^```(?:javascript|js)?\s*", "", raw.strip(), flags=re.MULTILINE)
        text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
        return text.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        return validate_handler(artifact, ctx.api_plan.get("webhookTopics", []))


# ── Private prompt-building helpers ───────────────────────────────────────────


def _format_strategy_block(strategy: Optional[Dict[str, Any]]) -> str:
    """
    Render the strategy brief as a delimited section in the user prompt.
    Each subsection only appears when it contains actionable content, so the
    prompt stays concise for simple features with no gaps or cron.
    """
    if not strategy:
        return ""

    parts: List[str] = [
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "FEATURE CODING BRIEF — apply these decisions exactly:",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ]

    sm = strategy.get("stateMachine")
    if sm and sm.get("needsStateTracking"):
        sentinel = sm.get("unknownSentinel", "null")
        skip_word = "YES" if sm.get("skipWhenUnknown", True) else "NO"
        parts.append(
            f"\nState machine:\n"
            f"  Tracked entity  : {sm.get('trackedEntity', '')}\n"
            f"  Unknown sentinel: {sentinel}  ← use this (not 0, not false) when no prior DB row exists\n"
            f"  Skip when unknown: {skip_word} — {sm.get('skipRationale', '')}"
        )

    gaps = strategy.get("platformGaps") or []
    if gaps:
        lines = "\n".join(f"  - {g['need']}: {g['mitigation']}" for g in gaps)
        parts.append(
            f"\nPlatform gaps (ctx cannot provide these — handle exactly as stated):\n{lines}"
        )

    batching = strategy.get("cronBatching")
    if batching and batching.get("required"):
        parts.append(
            f"\nCron batching (required — never call Shopify APIs inside the per-item loop):\n"
            f"  Endpoint    : {batching.get('batchEndpoint', '')}\n"
            f"  Max per call: {batching.get('maxBatchSize', 50)}\n"
            f"  Instruction : {batching.get('advice', '')}"
        )

    guidance = (strategy.get("handlerGuidance") or "").strip()
    if guidance:
        parts.append(f"\nAdditional guidance:\n  {guidance}")

    parts.append(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
    return "\n".join(parts)
