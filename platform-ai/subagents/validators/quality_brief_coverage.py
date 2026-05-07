"""
quality_brief_coverage — verifies every explicit requirement in the user's
qualityBrief is addressed somewhere in the artifacts.

Haiku, no thinking. Skipped entirely when ctx.intent.qualityBrief is empty —
the harness in subagents/validators/base.py omits this slot from the
ThreadPoolExecutor when there's nothing to check.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from models.adapter import extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.base import CodegenContext
from subagents.validators.base import (
    ValidatorRunResult,
    _normalize_findings,
    _now_ms,
)

log = logging.getLogger(__name__)


_FINDINGS_CAP = 8
_MAX_OUTPUT_TOKENS = 1500


SYSTEM_PROMPT = """\
The user provided a `qualityBrief` — explicit feature requirements like "send a follow-up email at T+24h", "show subscriber count as social proof", "throttle to 5 sends per shopper per day". Your job is to verify that EACH explicit requirement is addressed somewhere in the architect plan or handler implementation.

You are given the `qualityBrief` text, the architect plan, and the handler bundle.

For each EXPLICIT requirement (concrete behavior, threshold, deadline, UX detail) in the brief, decide whether the artifacts implement it. If a requirement is NOT addressed, return one finding identifying which sentence of the brief is unmet and where it would have to be implemented.

Skip implicit / stylistic requirements ("nice UI", "clean code"). Only flag concrete unmet items.

OUTPUT FORMAT — return JSON only:

{
  "findings": [
    {
      "artifact": "plan" | "handler" | "db" | "widget_js" | "admin_ui",
      "location": "<plan field or handler file:symbol>",
      "issue": "<one sentence: which brief requirement is missing>",
      "failure_mode": "<one sentence: what the merchant or shopper sees as a result>",
      "confidence": "high"
    }
  ]
}

Cap findings at 8. Return only HIGH confidence findings. Empty findings array is the expected output when every brief requirement is met.
"""


def _build_user_prompt(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> str:
    """
    Render the per-run user prompt: qualityBrief + plan summary + handler bundle.
    """
    quality_brief = ((ctx.intent or {}).get("qualityBrief") or "").strip()
    plan = ctx.plan or {}

    brief_block = (
        "QUALITY BRIEF (user requirements)\n══════════════════════════════════\n\n"
        + quality_brief
    )

    plan_block = "ARCHITECT PLAN\n══════════════\n\n" + json.dumps(plan, indent=2)

    handler = artifacts.get("handler") or "(missing)"

    artifacts_lines = [
        "ARTIFACTS",
        "═════════",
        "",
        "── handler bundle ──",
        handler,
    ]

    if is_storefront:
        widget = artifacts.get("widget_js") or "(missing)"
        artifacts_lines.extend(["", "── widget.js ──", widget])

    if is_admin_ui:
        admin = artifacts.get("admin_ui") or "(missing)"
        artifacts_lines.extend(["", "── admin_ui.js ──", admin])

    artifacts_block = "\n".join(artifacts_lines)

    return "\n\n".join([brief_block, plan_block, artifacts_block])


def run_quality_brief_coverage_validator(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> ValidatorRunResult:
    """
    Run the qualityBrief coverage check. Fail-open on any error.
    The harness in base.py only invokes this when qualityBrief is non-empty.
    """
    t0 = _now_ms()
    model = get_agent_model("quality_brief_coverage")
    llm = get_llm(model=model, max_tokens=_MAX_OUTPUT_TOKENS)
    user = _build_user_prompt(artifacts, ctx, is_storefront, is_admin_ui)

    in_tok = 0
    out_tok = 0
    try:
        response = invoke(llm, SYSTEM_PROMPT, user)
        in_tok = response.input_tokens
        out_tok = response.output_tokens
        raw = extract_json(response.content)
        result: Any = json.loads(raw)
    except Exception as exc:
        log.warning(
            "quality_brief_coverage: failed to get/parse response (%s) — fail-open",
            exc,
        )
        return ValidatorRunResult(
            validator="quality_brief_coverage",
            input_tokens=in_tok,
            output_tokens=out_tok,
            latency_ms=_now_ms() - t0,
            error=str(exc),
        )

    raw_findings = result.get("findings") if isinstance(result, dict) else None
    findings = _normalize_findings(
        raw_findings, "quality_brief_coverage", _FINDINGS_CAP
    )

    return ValidatorRunResult(
        validator="quality_brief_coverage",
        findings=findings,
        input_tokens=in_tok,
        output_tokens=out_tok,
        latency_ms=_now_ms() - t0,
    )
