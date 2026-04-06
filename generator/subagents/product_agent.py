"""
Product Agent — Agent 1 of the FeatureGenerator pipeline.

Two entry points:
  run_product_agent()         — one-shot: translate a merchant prompt into a feature spec.
  run_product_agent_analyze() — multi-turn: interactive clarification loop used by the
                                /analyze API endpoint before generation is triggered.

Model: claude-haiku (fast; purely classification + JSON extraction, no code generation).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from models.adapter import get_llm, invoke, invoke_conversation, extract_json


# ─── One-shot product agent ───────────────────────────────────────────────────

PRODUCT_SYSTEM = """You are a senior product manager specializing in Shopify store automation.

Your job: translate the merchant's request into a precise product feature specification — what it does, who it serves, what Shopify resources it touches, and how complex it is to build.

OUTPUT FORMAT — respond ONLY with this JSON object (no markdown fences):
{
  "triggerTypes": ["webhook", "cron", "admin", "widget"],
  "resources": ["inventory", "orders", "customers", "products", "discounts"],
  "desiredOutcome": "one sentence describing the merchant-visible behavior",
  "cronSchedule": null | "cron expression",
  "appCategory": "storefront_backend" | "storefront_backend_admin" | "backend" | "backend_admin"
}

TRIGGER TYPE RULES:
- "webhook" — reacts to Shopify events in the background (orders/create, inventory_levels/update, etc.)
- "cron"    — runs on a schedule (nightly, hourly, daily batch jobs)
- "admin"   — the merchant manually controls it via a button or dashboard in Shopify Admin
- "widget"  — a customer interacts with it on the storefront (subscribe button, loyalty widget, etc.)
- Multiple triggers are common: a cron job that also has an admin dashboard uses ["cron", "admin"]
- A webhook handler that also has an admin panel for viewing results uses ["webhook", "admin"]

APP CATEGORY RULES — choose based on what the feature needs at runtime:
- "storefront_backend_admin": widget on storefront + backend + admin dashboard (e.g. loyalty program, back-in-stock with subscriber management)
- "storefront_backend":       widget on storefront + backend, NO admin dashboard needed
- "backend_admin":            NO storefront widget; merchant needs a dashboard to view data, configure settings, or manually trigger actions (e.g. bulk editor, image optimizer with run button + log, notification manager)
- "backend":                  NO widget, NO admin dashboard — fully automatic (pure webhook reaction with no merchant UI)

CATEGORY DECISION GUIDE:
- If the merchant wants to VIEW results, manage records, configure settings, or trigger runs manually → needs "admin" in triggerTypes AND "backend_admin" or "storefront_backend_admin" appCategory
- If the app runs automatically on a schedule AND the merchant would want to see logs/stats or run it manually → use ["cron", "admin"] triggers and "backend_admin" category
- If the app reacts to webhooks AND the merchant would want to see a history or manage records → add "admin" trigger and "backend_admin" category
- ONLY use "backend" when the feature is a pure background automation with zero merchant-facing UI (e.g. auto-tag orders, send a single webhook notification — no dashboard, no config, no history view)

RESOURCE RULES:
- Only include resources the feature actually reads or writes
- "inventory" for stock levels, "orders" for order data, "customers" for customer records, "products" for product catalog, "discounts" for discount codes/price rules

OUTPUT RULES:
- cronSchedule: set to a standard 5-field cron string only if "cron" is in triggerTypes, otherwise null
- desiredOutcome: describe from the merchant's or customer's perspective, not the implementation
- Output ONLY the JSON object — no markdown fences, no explanation"""


def run_product_agent(prompt: str) -> Dict[str, Any]:
    """Agent 1: Parse merchant prompt into a product feature specification."""
    llm = get_llm(max_tokens=512)
    result = invoke(llm, PRODUCT_SYSTEM, f"Merchant request: {prompt}")
    raw = extract_json(result.content)
    return json.loads(raw)


# ─── Interactive analyze mode ─────────────────────────────────────────────────

PRODUCT_ANALYZE_SYSTEM = """You are a senior product manager for Shopify store automation.

Your job: understand the merchant's request and either ask a single clarification question or produce a complete feature specification.

OUTPUT FORMAT — respond ONLY with one of these JSON objects (no markdown fences):

If you need clarification:
{
  "status": "needs_clarification",
  "question": "Your specific question here"
}

If you understand the request:
{
  "status": "ready",
  "summary": "2-3 sentence plain-English description for the merchant: what triggers it, what it does, what the merchant or customer will notice.",
  "intent": {
    "triggerTypes": ["webhook", "cron", "admin", "widget"],
    "resources": ["orders", "inventory", "customers", "products", "discounts"],
    "desiredOutcome": "one sentence",
    "cronSchedule": null,
    "appCategory": "storefront_backend | storefront_backend_admin | backend | backend_admin"
  }
}

CLARIFICATION RULES:
- Ask clarification ONLY if you cannot determine the trigger, desired outcome, or main Shopify resource
- One question per response, never more
- Off-topic or non-Shopify requests: guide the merchant with a clarifying question toward a concrete Shopify app concept
- When the request is clear, go directly to "ready" — do not ask unnecessary questions

TRIGGER TYPE RULES:
- "webhook" — reacts to Shopify events; "cron" — runs on schedule; "admin" — merchant controls/views in Shopify Admin; "widget" — customer interacts on storefront
- Multiple triggers are normal: ["cron", "admin"] for a scheduled job with a dashboard

APP CATEGORY RULES:
- "storefront_backend_admin": widget + backend + admin dashboard
- "storefront_backend":       widget + backend, no admin dashboard
- "backend_admin":            no widget; merchant needs a dashboard, config screen, or manual trigger
- "backend":                  no widget, no admin UI — pure background automation only

CATEGORY DECISION GUIDE:
- Any app where the merchant views data, manages records, configures settings, or triggers runs → "backend_admin" (or "storefront_backend_admin" if it also has a widget)
- Cron jobs that process the whole store usually benefit from a "run now" button and status log → use ["cron", "admin"] and "backend_admin"
- Reserve "backend" for simple fire-and-forget automations with zero merchant UI"""


def run_product_agent_analyze(history: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Multi-turn product agent for the interactive analyze endpoint.
    history: list of {"role": "user"|"assistant", "content": str}
    Returns either {"status": "needs_clarification", "question": "..."} or
    {"status": "ready", "summary": "...", "intent": {...}}.
    """
    llm = get_llm(max_tokens=512)
    result = invoke_conversation(llm, PRODUCT_ANALYZE_SYSTEM, history)
    raw = extract_json(result.content)
    return json.loads(raw)
