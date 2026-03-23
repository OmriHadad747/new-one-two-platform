"""
Feature Strategy Sub-agent — produces a feature-specific coding brief.

Sits between the API plan (Agent 2) and parallel codegen (Agent 3).
Reasons over intent + api_plan to answer questions that static rules cannot:

  1. State machine semantics  — what sentinel means "never seen before"?
                               when should a transition action be skipped?
  2. Platform gaps            — what does this feature need that ctx cannot deliver?
                               what is the correct graceful degradation for each gap?
  3. Cron batching            — which Shopify calls should be batched upfront,
                               at what size, to stay within rate limits?

The brief is injected into the user prompt of every codegen agent so that
all three artifacts (handler, migration, widget) are aligned on the same
implementation decisions before a single line of code is written.

Model: claude-sonnet-4-6 — reasoning quality here cascades directly to all artifacts.
"""
from __future__ import annotations

import json
from typing import Any, Dict

from models.adapter import get_code_llm, invoke, extract_json


STRATEGY_SYSTEM = """You are a senior software architect reviewing a Shopify automation feature plan.

Your job: produce a concise, concrete coding brief for the developers who will implement
this feature. The brief answers questions that static rules cannot — decisions specific
to THIS feature.

Analyze the intent and API plan, then fill in each section below.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. STATE MACHINE  (set to null if the feature does not detect state transitions)

   A feature needs state tracking when it must:
   - detect a change  (e.g. inventory 0 → available, order status change, customer tier upgrade)
   - avoid re-triggering on repeat events beyond simple ON CONFLICT idempotency
   - compare the current value to a prior observed value

   If state tracking is needed, decide:
   a) What entity + column is stored in which DB table?
   b) What is the correct sentinel for a record that has NEVER been seen before?
      Rule: the sentinel is almost always null — not 0, not false, not empty string.
      Reason: 0 might be a real valid state (zero inventory IS meaningful).
              null = "we have no prior observation" and must not be conflated with any real value.
   c) Should the transition action (notification, tag update, etc.) be SKIPPED when
      the previous state is null?
      Answer is almost always yes — you cannot confirm a transition occurred if you
      never witnessed the starting state.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. PLATFORM GAPS  (empty array if ctx can fully deliver what the feature needs)

   ctx provides:
     ctx.shopify.get(path)        Shopify REST GET
     ctx.shopify.post(path, body) Shopify REST POST / PUT
     ctx.db`...`                  Postgres (RLS-scoped to tenant)
     ctx.tenantId                 current tenant UUID
     ctx.payload                  webhook body (empty object for cron)
     ctx.logger                   structured logging

   ctx does NOT provide: email, SMS, push notifications, Slack, external HTTP,
   file storage, or any outbound channel beyond the Shopify API.

   For each thing the feature needs that ctx cannot deliver:
   - Name the gap precisely (e.g. "transactional email to customers")
   - Specify the mitigation: what EXACTLY should the handler code do instead?
     Standard mitigation: log the full delivery intent via ctx.logger.info with all
     recipient data and message content, so an external integration can consume the logs.
     Optionally: use a Shopify customer tag or metafield as a durable pending-delivery flag.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. CRON BATCHING  (set to null if triggerType is "webhook" only)

   Shopify rate limit: ~2 req/s on Basic, ~4 req/s on Advanced.
   A cron processing N items with K sequential Shopify calls per item = N×K total calls.
   At 10 items × 3 calls = 30 calls ≈ 15 seconds at 2 req/s.

   The fix: fetch all Shopify data upfront in batches BEFORE the per-item loop,
   so the loop only executes DB writes and local side-effects.

   Specify:
   - The exact Shopify endpoint to batch and its batch parameter
   - The maximum batch size (examples: inventory_levels = 50 ids, variants = 250 ids)
   - A concrete restructuring instruction for the handler developer

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OUTPUT FORMAT — respond ONLY with this JSON object (no markdown fences):
{
  "stateMachine": {
    "needsStateTracking": true,
    "trackedEntity": "what entity + column is stored and in which DB table",
    "unknownSentinel": "null",
    "skipWhenUnknown": true,
    "skipRationale": "one sentence: why skipping is correct for first-seen records"
  } | null,
  "platformGaps": [
    {
      "need": "short name of what the feature requires",
      "mitigation": "exact instruction for the handler: what to do instead of the missing capability"
    }
  ],
  "cronBatching": {
    "required": true,
    "batchEndpoint": "/inventory_levels.json?inventory_item_ids=<comma-separated-ids>",
    "batchParam": "inventory_item_ids",
    "maxBatchSize": 50,
    "advice": "concrete one-sentence restructuring instruction for the handler developer"
  } | null,
  "handlerGuidance": "2–4 sentences of specific, non-obvious guidance only a code reviewer would catch",
  "migrationGuidance": "1–2 sentences about schema decisions — column nullability, sentinel meaning, index choices",
  "widgetGuidance": "1–2 sentences for the widget developer, or null if this is a backend_only app"
}"""

STRATEGY_USER_TEMPLATE = """Feature intent:
{intent_json}

Shopify API plan:
{api_plan_json}

App archetype: {archetype}

Produce the coding brief for this specific feature."""


def run_strategy_agent(
    intent: Dict[str, Any],
    api_plan: Dict[str, Any],
    app_archetype: str,
) -> Dict[str, Any]:
    """
    Agent 3: Produce a feature-specific coding brief.

    Args:
        intent:        Structured intent from Agent 1 (run_intent_agent).
        api_plan:      Shopify API plan from Agent 2 (run_schema_agent).
        app_archetype: "storefront_ui" | "backend_only"

    Returns:
        Strategy dict with keys: stateMachine, platformGaps, cronBatching,
        handlerGuidance, migrationGuidance, widgetGuidance.
    """
    llm = get_code_llm(max_tokens=2048)
    user = STRATEGY_USER_TEMPLATE.format(
        intent_json=json.dumps(intent, indent=2),
        api_plan_json=json.dumps(api_plan, indent=2),
        archetype=app_archetype,
    )
    for attempt in range(2):
        result = invoke(llm, STRATEGY_SYSTEM, user)
        raw = extract_json(result.content)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            if attempt == 1:
                raise
