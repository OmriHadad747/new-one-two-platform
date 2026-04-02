"""
Agent definitions for the FeatureGenerator crew.

Agent 1 — Product Agent        (run_product_agent)
Agent 6 — Explanation Agent    (run_explanation_agent)

Agents 2–3 (Architect + CodeSpec) live in subagents/architect_agent.py and
subagents/codespec_agent.py respectively. Agents 4–5 (CodeGen + Validation)
are orchestrated directly by crew.py via the generator registry.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List

from models.adapter import get_llm, invoke, extract_json
from mcp import client as mcp_client

# ─── API context loader ───────────────────────────────────────────────────────


def fetch_api_context(resources: List[str], intent_description: str = "") -> str:
    """
    Return live Shopify API context for the given resources via the Dev MCP server.

    Calls the Shopify Dev MCP server (via npx) to fetch REST endpoint docs,
    GraphQL schema types, and webhook payload shapes for each resource.
    Results are cached to mcp/cache/ for 24 hours.
    Returns an empty string if MCP is unavailable — agents proceed without context.
    Never raises.

    Parameters
    ----------
    resources:
        Resource names from Intent output (e.g. ["orders", "inventory"]).
    intent_description:
        Optional one-liner from Intent.desiredOutcome — improves doc relevance.
    """
    if not resources:
        return ""
    return mcp_client.prefetch_for_run(resources, intent_description)


# ─── Agent 1: Intent ──────────────────────────────────────────────────────────

PRODUCT_SYSTEM = """You are a senior product manager specializing in Shopify store automation.

Your job: translate the merchant's request into a precise product feature specification — what it does, who it serves, what Shopify resources it touches, and how complex it is to build.

OUTPUT FORMAT — respond ONLY with this JSON object (no markdown fences):
{
  "triggerType": "webhook" | "cron" | "both",
  "resources": ["inventory", "orders", "customers", "products", "discounts"],
  "desiredOutcome": "one sentence describing the merchant-visible behavior",
  "cronSchedule": null | "cron expression",
  "appArchetype": "storefront_ui" | "backend_only"
}

Rules:
- triggerType is "webhook" if the feature reacts to Shopify events
- triggerType is "cron" if it runs on a schedule
- resources: only include what the feature actually reads or writes
- desiredOutcome: describe the outcome from the merchant's or customer's perspective, not the implementation
- cronSchedule: set to a cron string only if triggerType is "cron" or "both"
- appArchetype is "storefront_ui" if the feature requires a customer-facing UI element embedded in the storefront (e.g. a signup form, widget, or button on a product/cart page); otherwise "backend_only"
- Output ONLY the JSON object"""


def run_product_agent(prompt: str) -> Dict[str, Any]:
    """Agent 1: Parse merchant prompt into a product feature specification."""
    llm = get_llm(max_tokens=512)
    result = invoke(llm, PRODUCT_SYSTEM, f"Merchant request: {prompt}")
    raw = extract_json(result.content)
    return json.loads(raw)


# ─── Agent 5: Explanation ─────────────────────────────────────────────────────

EXPLANATION_SYSTEM = """You are writing feature explanations for non-technical Shopify merchants.

Write two outputs:
1. merchantFacing: A clear, friendly explanation of the feature (2-3 paragraphs).
   - No technical jargon (no "webhook", "database", "API", "Lambda", etc.)
   - Explain what the customer sees, what happens when they interact with it,
     and what the merchant can configure.
   - If known limitations are listed, mention them briefly in plain language
     (e.g. "Note: to send email notifications, this feature requires an email service
     like Klaviyo or SendGrid to be connected to your store.").
2. technical: A JSON summary of the technical details for the platform dashboard.

OUTPUT FORMAT — respond ONLY with this JSON object (no markdown fences):
{
  "merchantFacing": "...",
  "technical": {
    "webhookTopics": ["..."],
    "dbTables": ["..."],
    "estimatedMonthlyExecutions": 200,
    "estimatedMonthlyCost": "$0.002"
  }
}"""

EXPLANATION_USER_TEMPLATE = """Feature intent:
{intent_json}

Shopify API plan:
{shopify_plan_json}

Storefront widget: {widget_summary}
Handler subscribes to: {webhook_topics}
DB tables created: {db_tables}{platform_gaps_section}

Write the merchant explanation and technical summary."""


def run_explanation_agent(
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    widget_js_code: str,
    handler_code: str,
    migration_sql: str,
) -> Dict[str, Any]:
    """Agent 5: Generate merchant explanation + technical summary."""
    shopify_plan = plan.get("shopifyPlan", {})
    impl_spec = plan.get("implementationSpec", {})

    db_tables = re.findall(r"CREATE\s+TABLE\s+(\w+)", migration_sql, re.IGNORECASE)
    webhook_topics = shopify_plan.get("webhookTopics", [])

    widget_summary = (
        "custom storefront widget (AI-generated ES module)"
        if widget_js_code and widget_js_code.strip()
        else "none (backend-only app)"
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
        webhook_topics=webhook_topics,
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
