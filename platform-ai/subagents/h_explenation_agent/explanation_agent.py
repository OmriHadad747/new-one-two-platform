"""
Explanation Agent — Agent 6 (final) of the FeatureGenerator pipeline.

Receives the complete generated artifacts and writes:
  1. A merchant-facing explanation (2-3 paragraphs, zero jargon)
  2. A technical summary JSON for the platform dashboard

System prompt and user template live in subagents/prompts/explanation/
(EXPLANATION_BASE + EXPLANATION_USER_TEMPLATE).

Model: claude-haiku (fast; writing task, no code generation).
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Tuple

from models.adapter import get_llm, invoke, extract_json
from models.agent_models import get_agent_model
from subagents.h_explenation_agent.explanation import EXPLANATION_BASE, EXPLANATION_USER_TEMPLATE


def run_explanation_agent(
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    storefront_code: str,
    db_sql: str,
) -> Tuple[Dict[str, Any], int, int]:
    """
    Agent 6: Generate merchant explanation + technical summary.
    Returns (explanation_dict, input_tokens, output_tokens).
    """
    shopify_plan = plan.get("shopifyPlan", {})
    impl_spec = plan.get("appContracts", {})

    db_tables = re.findall(r"CREATE\s+TABLE\s+(\w+)", db_sql, re.IGNORECASE)
    webhook_topics = shopify_plan.get("webhookTopics", [])
    cron_schedule = shopify_plan.get("cronSchedule") or "none"

    widget_summary = (
        "custom storefront widget (AI-generated ES module)"
        if storefront_code and storefront_code.strip()
        else "none (backend-only app)"
    )

    admin_catalog = impl_spec.get("adminApiCatalog") or []
    admin_summary = (
        "yes — merchant dashboard embedded in Shopify Admin"
        if admin_catalog
        else "none"
    )

    platform_gaps_section = ""
    gaps = impl_spec.get("platformGaps") or []
    if gaps:
        lines = "\n".join(
            f"  - {g.get('gap', '')}: {g.get('mitigation', '')}" for g in gaps
        )
        platform_gaps_section = f"\n\nKnown platform limitations:\n{lines}"

    user = EXPLANATION_USER_TEMPLATE.format(
        intent_json=json.dumps(intent, indent=2),
        shopify_plan_json=json.dumps(shopify_plan, indent=2),
        widget_summary=widget_summary,
        webhook_topics=webhook_topics or "none",
        cron_schedule=cron_schedule,
        admin_summary=admin_summary,
        db_tables=db_tables,
        platform_gaps_section=platform_gaps_section,
    )

    llm = get_llm(model=get_agent_model("explanation"), max_tokens=2048)
    total_in = 0
    total_out = 0
    for attempt in range(2):
        result = invoke(llm, EXPLANATION_BASE, user)
        total_in += result.input_tokens
        total_out += result.output_tokens
        raw = extract_json(result.content)
        try:
            return json.loads(raw), total_in, total_out
        except json.JSONDecodeError:
            if attempt == 1:
                raise
            # Retry with a hint — most common cause is unescaped quotes in merchantFacing
            user = (
                user
                + '\n\nPREVIOUS ATTEMPT RETURNED INVALID JSON. Ensure all double quotes inside string values are escaped as \\".'
            )
