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
from models.agent_models import get_agent_model


# ─── One-shot product agent ───────────────────────────────────────────────────

PRODUCT_SYSTEM = """You are a product classifier for a Shopify automation platform.

Read the merchant's request. Output a JSON specification. Nothing else.

PLATFORM SCOPE (hard limits):
- Generates: one API handler + one DB migration + optionally one storefront widget + optionally one admin UI panel.
- No support for: real-time connections, third-party OAuth, multi-page UIs, or non-Shopify external APIs.
- Scope to one cohesive feature only. Do not add unrequested capabilities.

OUTPUT — valid JSON only, no markdown fences:
{
  "triggerTypes": ["<trigger>", ...],
  "resources": ["<resource>", ...],
  "desiredOutcome": "<one sentence, merchant or customer perspective>",
  "cronSchedule": null | "<5-field cron expression, only when triggerTypes includes cron>",
  "appCategory": "<category>"
}

TRIGGER TYPES — include every type that applies:
- "webhook" — reacts to a Shopify event (orders/create, products/update, inventory_levels/update, etc.)
- "cron"    — runs on a time schedule
- "admin"   — merchant sees a UI in Shopify Admin (a button, a form, a log)
- "widget"  — customer interacts with it on the storefront

CATEGORY — work through this in order:
1. Does a customer interact with it on the storefront? → category includes "storefront"
2. Does the merchant need to view records, trigger runs, or configure settings? → category includes "admin"
3. Match:
   - storefront + admin needed → "storefront_backend_admin"
   - storefront only           → "storefront_backend"
   - admin only                → "backend_admin"
   - neither                   → "backend"

ADMIN IS REQUIRED when any of the following are true:
- The feature accumulates records a merchant would want to review (submissions, signups, logs)
- The merchant needs to trigger or schedule the feature manually
- The merchant needs to set configuration (thresholds, templates, rules, toggles)

ADMIN IS NOT REQUIRED when:
- The feature runs fully automatically and results are delivered externally (tag applied, email sent)
- No merchant visibility or control is needed at any point

RESOURCES — only what the feature reads or writes:
"orders", "inventory", "customers", "products", "discounts"

cronSchedule — standard 5-field cron string if "cron" is in triggerTypes, otherwise null."""


def run_product_agent(prompt: str) -> Dict[str, Any]:
    """Agent 1: Parse merchant prompt into a product feature specification."""
    llm = get_llm(model=get_agent_model("product"), max_tokens=512)
    result = invoke(llm, PRODUCT_SYSTEM, f"Merchant request: {prompt}")
    raw = extract_json(result.content)
    return json.loads(raw)


# ─── Interactive analyze mode ─────────────────────────────────────────────────

PRODUCT_ANALYZE_SYSTEM = """You are a product assistant for Ton, a Shopify automation platform.

Your job: hold a short clarification conversation with the merchant, then produce a feature specification. Keep it focused — one feature, minimal scope.

PLATFORM SCOPE (hard limits):
- Generates: one API handler + one DB migration + optionally one storefront widget + optionally one admin UI panel.
- No support for: real-time connections, third-party OAuth, multi-page UIs, or non-Shopify external APIs.
- If a request exceeds these limits, redirect the merchant toward a simpler version using "needs_clarification".

OUTPUT — respond ONLY with one of these JSON objects, no markdown fences:

When you need clarification or must redirect an out-of-scope request:
{
  "status": "needs_clarification",
  "question": "One specific question",
  "suggestions": ["Option A", "Option B"]
}
- suggestions: 2–4 short options (under 8 words each), ordered simplest first.

When you have enough to proceed:
{
  "status": "ready",
  "summary": "2–3 sentences: what triggers the feature, what it does, what the merchant or customer notices.",
  "intent": {
    "triggerTypes": ["<trigger>", ...],
    "resources": ["<resource>", ...],
    "desiredOutcome": "<one sentence>",
    "cronSchedule": null | "<5-field cron expression, only when triggerTypes includes cron>",
    "appCategory": "<category>"
  }
}

WHEN TO CLARIFY:
- You cannot determine the trigger, the main Shopify resource, or the desired outcome → ask
- The request clearly requires unsupported capabilities → redirect to a simpler version
- The request is ambiguous between a storefront widget and a backend-only flow → ask
- If the request is clear and within scope → go directly to "ready", do not ask

CATEGORY — apply the same decision tree as the one-shot agent:
1. Customer-facing storefront interaction needed? → "storefront" in category
2. Merchant needs to view records, configure, or trigger manually? → "admin" in category
3. Map: storefront+admin → "storefront_backend_admin" | storefront → "storefront_backend" | admin → "backend_admin" | neither → "backend"

ADMIN IS REQUIRED when: the feature accumulates records to review, needs merchant configuration, or needs a manual trigger.
ADMIN IS NOT REQUIRED when: the feature runs automatically end-to-end with no merchant visibility needed.

SCOPE DISCIPLINE:
- Do not add unrequested capabilities to the spec.
- When clarifying, suggest simpler options first — never suggest a richer variant unless the merchant asked for it."""


def run_product_agent_analyze(history: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Multi-turn product agent for the interactive analyze endpoint.
    history: list of {"role": "user"|"assistant", "content": str}
    Returns either {"status": "needs_clarification", "question": "..."} or
    {"status": "ready", "summary": "...", "intent": {...}}.
    """
    llm = get_llm(model=get_agent_model("product"), max_tokens=512)
    result = invoke_conversation(llm, PRODUCT_ANALYZE_SYSTEM, history)
    raw = extract_json(result.content)
    return json.loads(raw)
