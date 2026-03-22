"""
Handler Sub-agent — generates the CommonJS handler.js for the harness.

Uses the HARNESS_CONTRACT as the primary constraint. Produces a module.exports
with webhookTopics, cronSchedule, and handler() conforming to the harness interface.

Model: claude-sonnet-4-6 (highest quality for code generation).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from models.adapter import get_code_llm, invoke, extract_code
from templates.harness_contract import HARNESS_CONTRACT

SYSTEM_PROMPT = f"""You are an expert Node.js developer writing Shopify automation handlers.

{HARNESS_CONTRACT}"""


def run_handler_agent(
    intent: Dict[str, Any],
    api_plan: Dict[str, Any],
    previous_errors: Optional[List[str]] = None,
) -> str:
    """
    Generate a CommonJS handler.js from the API plan.

    Args:
        intent: Structured intent from Agent 1.
        api_plan: API plan from Agent 2 (defines webhookTopics and operations).
        previous_errors: Validation errors from a previous attempt (retry path).

    Returns:
        Raw JavaScript string (no markdown fences).
    """
    llm = get_code_llm(max_tokens=2048)

    retry_context = ""
    if previous_errors:
        retry_context = (
            f"\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n"
            + "\n".join(f"- {e}" for e in previous_errors)
            + "\n\nFix ALL listed errors in this new attempt.\n"
        )

    user_prompt = f"""{retry_context}Merchant's goal: {intent.get('desiredOutcome', '')}

API Plan to implement:
{_format_api_plan(api_plan)}

Generate the handler.js module that implements this plan exactly.
Only output JavaScript code — no explanation, no markdown fences."""

    result = invoke(llm, SYSTEM_PROMPT, user_prompt)
    return extract_code(result.content)


def _format_api_plan(api_plan: Dict[str, Any]) -> str:
    import json
    return json.dumps(api_plan, indent=2)
