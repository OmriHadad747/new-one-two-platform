"""
Explanation Agent — Agent 6 (final) of the FeatureGenerator pipeline.

Receives the complete generated artifacts and writes:
  1. A merchant-facing explanation (2-3 paragraphs, zero jargon)
  2. A technical summary JSON for the platform dashboard

Model: claude-haiku (fast; writing task, no code generation).
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict

from models.adapter import get_llm, invoke, extract_json


EXPLANATION_SYSTEM = """You are writing feature explanations for non-technical Shopify merchants.

Write two outputs:

1. merchantFacing: A clear, friendly explanation (2-3 paragraphs).
   LANGUAGE RULES — strictly no technical jargon:
   - No "webhook", "database", "API", "Lambda", "cron", "GraphQL", "REST", "SQL", "JSON", "async"
   - No "deploy", "trigger", "handler", "ctx", "module", "schema", "migration"
   - Replace with plain language: "webhook" → "Shopify notification", "database" → "your store's records",
     "cron job" → "automatic daily/hourly task", "deploy" → "activate"

   CONTENT RULES — explain all three angles:
   a) What happens automatically and when (triggers, schedule)
   b) What the customer sees or does (for widget apps)
   c) What the merchant can see, configure, or control in their admin dashboard (for admin apps)
      — mention specific settings if the handler reads config from the DB (e.g. email subject, thresholds)
      — if there's a "run now" button or manual trigger, mention it explicitly
   d) Any known limitations — phrase as practical notes, not technical caveats:
      - Email/SMS: "requires an email service to be connected" (not "ctx.services.email is stubbed")
      - File upload: "files are saved and a download link is returned"
      - If a feature is configurable, mention that the merchant can adjust settings from the dashboard

2. technical: A JSON summary for the platform dashboard.

OUTPUT FORMAT — respond ONLY with this JSON object (no markdown fences):
{
  "merchantFacing": "...",
  "technical": {
    "webhookTopics": ["..."],
    "dbTables": ["..."],
    "estimatedMonthlyExecutions": 200,
    "estimatedMonthlyCost": "$0.002"
  }
}

IMPORTANT: Ensure all double quotes inside string values are escaped as \\". Invalid JSON will be rejected."""

EXPLANATION_USER_TEMPLATE = """Feature intent:
{intent_json}

Shopify API plan:
{shopify_plan_json}

Storefront widget: {widget_summary}
Handler subscribes to: {webhook_topics}
Cron schedule: {cron_schedule}
Admin dashboard: {admin_summary}
DB tables created: {db_tables}{platform_gaps_section}

Write the merchant explanation and technical summary."""


def run_explanation_agent(
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    widget_js_code: str,
    handler_code: str,
    migration_sql: str,
) -> Dict[str, Any]:
    """Agent 6: Generate merchant explanation + technical summary."""
    shopify_plan = plan.get("shopifyPlan", {})
    impl_spec = plan.get("implementationSpec", {})

    db_tables = re.findall(r"CREATE\s+TABLE\s+(\w+)", migration_sql, re.IGNORECASE)
    webhook_topics = shopify_plan.get("webhookTopics", [])
    cron_schedule = shopify_plan.get("cronSchedule") or "none"

    widget_summary = (
        "custom storefront widget (AI-generated ES module)"
        if widget_js_code and widget_js_code.strip()
        else "none (backend-only app)"
    )

    # Summarize admin UI presence from intent
    app_category = intent.get("appCategory", "")
    has_admin = "admin" in app_category or "admin" in intent.get("triggerTypes", [])
    admin_summary = (
        "yes — merchant dashboard embedded in Shopify Admin"
        if has_admin
        else "none"
    )

    platform_gaps_section = ""
    gaps = impl_spec.get("platformGaps") or []
    if gaps:
        lines = "\n".join(f"  - {g['need']}: {g['mitigation']}" for g in gaps)
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

    llm = get_llm(max_tokens=2048)
    for attempt in range(2):
        result = invoke(llm, EXPLANATION_SYSTEM, user)
        raw = extract_json(result.content)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            if attempt == 1:
                raise
            # Retry with a hint — most common cause is unescaped quotes in merchantFacing
            user = (
                user
                + '\n\nPREVIOUS ATTEMPT RETURNED INVALID JSON. Ensure all double quotes inside string values are escaped as \\".'
            )
