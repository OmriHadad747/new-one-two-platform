"""
Agent definitions for the FeatureGenerator crew.

Agent 1 — Intent Agent
Agent 2 — Schema & API Planning Agent (includes schema fragment loading)
Agent 6 — Explanation Agent

Agents 3 (strategy), 4 (codegen), and 5 (validation) live in their own modules
under subagents/ because they require more complex logic: strategy has its own
prompt structure, codegen uses the Generator ABC + registry pattern for
parallelism, and validation is pure static analysis with no LLM involvement.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from models.adapter import get_llm, invoke, extract_json

# ─── Schema fragment loader ───────────────────────────────────────────────────

FRAGMENTS_DIR = Path(__file__).parent.parent.parent / "templates" / "schema_fragments"

RESOURCE_MAP = {
    "inventory": "inventory.json",
    "orders": "orders.json",
    "customers": "customers.json",
    "products": "products.json",
    "discounts": "discounts.json",
}


def load_schema_fragments(resources: List[str]) -> str:
    fragments = []
    for resource in resources:
        filename = RESOURCE_MAP.get(resource.lower())
        if filename:
            path = FRAGMENTS_DIR / filename
            if path.exists():
                fragments.append(path.read_text())
    return "\n\n".join(fragments) if fragments else ""


# ─── Agent 1: Intent ──────────────────────────────────────────────────────────

INTENT_SYSTEM = """You are an expert at understanding merchant requirements for Shopify store automation.

Your job: parse the merchant's prompt into a structured feature specification.

OUTPUT FORMAT — respond ONLY with this JSON object (no markdown fences):
{
  "triggerType": "webhook" | "cron" | "both",
  "resources": ["inventory", "orders", "customers", "products", "discounts"],
  "desiredOutcome": "one sentence describing the feature",
  "complexity": "low" | "medium" | "high",
  "cronSchedule": null | "cron expression"
}

Rules:
- triggerType is "webhook" if the feature reacts to Shopify events
- triggerType is "cron" if it runs on a schedule
- resources: only include what the feature actually touches
- desiredOutcome: be specific, name the user-facing behavior
- cronSchedule: set to a cron string only if triggerType is "cron" or "both"
- Output ONLY the JSON object"""


def run_intent_agent(prompt: str) -> Dict[str, Any]:
    """Agent 1: Parse merchant prompt into StructuredIntent."""
    llm = get_llm(max_tokens=512)
    result = invoke(llm, INTENT_SYSTEM, f"Merchant request: {prompt}")
    raw = extract_json(result.content)
    return json.loads(raw)


# ─── Agent 2: Schema & API Planning ──────────────────────────────────────────

SCHEMA_SYSTEM_TEMPLATE = """You are an expert Shopify developer mapping feature requirements to the exact Shopify API surface.

Given a structured feature intent and relevant Shopify API schema fragments, produce a precise API plan.

{schema_fragments_section}

OUTPUT FORMAT — respond ONLY with this JSON object (no markdown fences):
{{
  "webhookTopics": ["inventory_levels/update"],
  "cronSchedule": null,
  "operations": [
    {{
      "step": 1,
      "description": "What this step does",
      "type": "query" | "mutation",
      "method": "GET" | "POST" | "PUT" | "DELETE",
      "path": "/admin/api/2026-01/...",
      "bodyExample": null | {{ ... }}
    }}
  ]
}}

Rules:
- webhookTopics: ONLY include topics whose payload is actively used to drive business logic. If a topic's data is not read or acted on in the handler, do not subscribe to it.
- Operations describe the backend handler's Shopify API calls in execution order
- Platform API catalog paths (for the App Block frontend) are separate from these
- When the feature must detect a state transition (e.g. out-of-stock → in-stock, status change), include an explicit operation to read the previous state from a DB table and write the new state. Label this operation with "store" or "read previous state" so the migration agent generates the required table.
- Output ONLY the JSON object"""

SCHEMA_USER_TEMPLATE = """Feature intent:
{intent_json}

Platform API catalog (for App Block frontend calls):
{catalog}

Generate the API plan for the backend handler."""


def run_schema_agent(
    intent: Dict[str, Any],
    platform_api_catalog: List[Dict[str, str]],
) -> Dict[str, Any]:
    """Agent 2: Map intent to Shopify API plan."""
    resources = intent.get("resources", [])
    schema_fragments = load_schema_fragments(resources)

    schema_fragments_section = (
        f"Relevant Shopify API schema fragments:\n{schema_fragments}"
        if schema_fragments
        else ""
    )

    system = SCHEMA_SYSTEM_TEMPLATE.format(
        schema_fragments_section=schema_fragments_section
    )

    catalog_str = "\n".join(f"  {e.method} {e.path}" for e in platform_api_catalog)
    user = SCHEMA_USER_TEMPLATE.format(
        intent_json=json.dumps(intent, indent=2),
        catalog=catalog_str,
    )

    llm = get_llm(max_tokens=2048)
    result = invoke(llm, system, user)
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

API plan:
{api_plan_json}

Storefront widget: {widget_summary}
Handler subscribes to: {webhook_topics}
DB tables created: {db_tables}{platform_gaps_section}

Write the merchant explanation and technical summary."""


def run_explanation_agent(
    intent: Dict[str, Any],
    api_plan: Dict[str, Any],
    widget_js_code: str,
    handler_code: str,
    migration_sql: str,
    strategy: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Agent 5: Generate merchant explanation + technical summary."""
    import re

    # Extract table names from migration SQL
    db_tables = re.findall(r"CREATE\s+TABLE\s+(\w+)", migration_sql, re.IGNORECASE)
    webhook_topics = api_plan.get("webhookTopics", [])

    widget_summary = (
        "custom storefront widget (AI-generated ES module)"
        if widget_js_code and widget_js_code.strip()
        else "none (backend-only app)"
    )

    # Surface platform gaps so the explanation can mention known limitations
    platform_gaps_section = ""
    gaps = (strategy or {}).get("platformGaps") or []
    if gaps:
        lines = "\n".join(f"  - {g['need']}: {g['mitigation']}" for g in gaps)
        platform_gaps_section = f"\n\nKnown platform limitations:\n{lines}"

    user = EXPLANATION_USER_TEMPLATE.format(
        intent_json=json.dumps(intent, indent=2),
        api_plan_json=json.dumps(api_plan, indent=2),
        widget_summary=widget_summary,
        webhook_topics=webhook_topics,
        db_tables=db_tables,
        platform_gaps_section=platform_gaps_section,
    )

    llm = get_llm(max_tokens=1024)
    result = invoke(llm, EXPLANATION_SYSTEM, user)
    raw = extract_json(result.content)
    return json.loads(raw)
