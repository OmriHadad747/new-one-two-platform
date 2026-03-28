"""
Planner Agent — single model call replacing the former Schema Agent + Strategy Agent.

Why merged:
  The codeSpec (step-by-step algorithm per code path) requires simultaneous knowledge of:
    1. Which Shopify APIs the feature uses         (formerly Schema Agent's domain)
    2. How to implement patterns in the harness    (formerly Strategy Agent's domain)
    3. How webhook and cron paths interact         (cross-domain — neither agent saw this)

  Split agents handled (1) and (2) in sequence but couldn't reason about (3). A single
  Sonnet call sees the full picture and produces a coherent codeSpec where, for example,
  the cron path's atomic claim explicitly guards against the webhook path having already
  processed the same state transition.

Input:  prompt + intent + schema_fragments + app_archetype
Output: plan dict — { shopifyPlan, implementationSpec }

  shopifyPlan:
    webhookTopics, cronSchedule, operations

  implementationSpec:
    stateMachine, platformGaps, cronBatching,
    codeSpec { webhookPath[], cronPath[], functions[] },
    migrationGuidance, widgetGuidance, widgetApiCatalog

Model: claude-sonnet-4-6 — reasoning quality here cascades directly to all generated artifacts.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from models.adapter import get_code_llm, invoke, extract_json


PLANNER_SYSTEM = """You are a senior Shopify automation architect. Your output is consumed directly by code generators — be precise and concrete, not vague.

You produce a two-section plan: the Shopify API surface (shopifyPlan) and the implementation spec (implementationSpec).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1 — shopifyPlan
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

webhookTopics: Only subscribe to a topic if its payload fields are actively read in the handler.
  Do NOT subscribe "just in case" — unused subscriptions waste quota.
  Valid topics: orders/create, orders/updated, orders/cancelled, orders/paid,
                products/create, products/update, products/delete,
                customers/create, customers/update, customers/delete,
                inventory_levels/update, inventory_items/update, app/uninstalled

cronSchedule: null unless periodic polling is required. Use standard 5-field cron expression.

operations: Shopify API calls made by the handler, in execution order.
  When the feature detects a state transition, include a "read previous state" operation
  and a "write new state" operation — this signals the migration agent to create the required table.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — implementationSpec
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

stateMachine: null if the feature does NOT need to detect state transitions.
  A state machine is needed when the handler must compare the current value to a prior observed value.
  - unknownSentinel is ALWAYS "null" — never 0, false, or empty string.
    Reason: 0 may be a real valid state (zero inventory is meaningful). null = never observed.
  - skipWhenUnknown is almost always true: cannot confirm a transition without witnessing the start.

platformGaps: What this feature needs that ctx cannot deliver.
  ctx provides: ctx.shopify.get/post, ctx.db (Postgres), ctx.tenantId, ctx.payload, ctx.logger,
                ctx.email.send({ to, subject, templateId?, data? }).
  ctx does NOT provide: SMS, push, Slack, external HTTP, file storage.
  For each gap, specify the exact mitigation the handler should use (usually: log full delivery
  intent with ctx.logger.info so an external integration can consume it).
  Note: email is available via ctx.email.send() — do NOT list email as a platformGap.

cronBatching: Required when the cron path would call Shopify APIs inside a per-item loop.
  Shopify rate limit: ~2 req/s on Basic. N items × K calls per item = throttle at scale.
  Fix: fetch all Shopify data in batches BEFORE the loop. Loop body has zero Shopify calls.
  Important: Shopify has NO batch variant-by-IDs endpoint. To batch variant/product data,
  store product_id (BIGINT) in the DB and batch via /products.json?ids=... (max 250), then
  extract variants from product.variants[]. Document this in codeSpec.functions[] with exact steps.

codeSpec: THE MOST IMPORTANT SECTION.
  Step-by-step algorithm for each code path. Code generators implement this literally.

  Writing rules:
  - Each step is ONE concrete action — not an English prose sentence
  - Reference specific variable names, table names, API paths, and field names
  - Atomic claims MUST be written as two explicit steps:
      "claimed = UPDATE ... WHERE ... AND state=X RETURNING id"
      "if claimed.length === 0: [skip/continue/return]  // [reason]"
  - State transition guards MUST be explicit:
      "if prevState === null: [skip] // never observed — cannot confirm transition"
  - Notification pattern — claim BEFORE emitting (MANDATORY ordering):
      Step N:   "claimed = UPDATE ... SET notified_at = NOW() WHERE ... AND notified_at IS NULL RETURNING id, customer_email, ..."
      Step N+1: "if claimed.length === 0: return  // already notified — idempotency guard"
      Step N+2: "for each row in claimed: emit/log notification"
      Rationale: emitting first then marking risks double-notification on crash between the two steps.
  - Helper functions get their own entry in functions[] with all steps listed
  - When a webhook path must both update a state table AND claim/send notifications as separate
    steps, write the state-update step first, then explicitly note between steps:
    "// crash here leaves state updated but notifications unsent — cron path is the backstop"
    The cron path MUST be designed to re-check and claim any notifications not yet sent,
    independently of the current live inventory/state (i.e. query the DB for unsent rows,
    don't re-check Shopify state). This ensures the cron recovers from a webhook crash.

  webhookPath: steps for the webhook handler path ([] if triggerType is cron-only)
  cronPath:    steps for the cron handler path ([] if triggerType is webhook-only)
  widgetPath:  steps for each widget API path ([] for backend_only apps).
    This is the CONTRACT between the widget and the handler — both generators read it.
    Writing rules for widgetPath:
    - Each entry covers one catalog path. Start the step with "path /foo:"
    - For host.call() bodies: write the EXACT field names the widget sends, e.g.
        "widget calls host.call('/signup', { customerEmail, variantId, productId })"
      The handler step for the same path MUST destructure those exact same field names:
        "const { customerEmail, variantId, productId } = ctx.widgetBody"
    - Only include fields available in host.context (variantId, productId, customerId)
      or from user input (e.g. customerEmail from a form). Never include IDs the widget
      cannot know (e.g. inventoryItemId) — the handler resolves those server-side:
        "resolve inventoryItemId: GET /variants/${variantId}.json → variant.inventory_item_id"
    - ALWAYS end each path's steps with a response shape line, e.g.:
        "path /signup: handler returns { ok: true } on success; widget checks result.ok"
        "path /status: handler returns { inStock: bool, isSignedUp: bool }; widget reads result.inStock"
      The response shape MUST match widgetApiCatalog[path].responseShape exactly.
  functions:   shared helper functions

migrationGuidance: 1-2 sentences on schema decisions — column nullability, sentinel meaning, indexes.
  If stateMachine is set, state column MUST be NULLABLE (null = never observed).
  CRITICAL: Shopify entity IDs (variant_id, product_id, order_id, customer_id, inventory_item_id)
  are numeric integers — always specify BIGINT or TEXT for these columns, NEVER UUID.
  Only tenant_id and internal record primary keys use UUID.
  CRITICAL: Tables that store one record per customer per Shopify entity (signup, subscription,
  opt-in) MUST have a UNIQUE constraint — not just an index — on the natural deduplication key
  (typically tenant_id, entity_id, customer_email). A plain index does not prevent duplicate rows.
  Use CONSTRAINT uq_<table>_<key> UNIQUE (...). This enables ON CONFLICT DO NOTHING inserts.

widgetGuidance: 1-2 UX sentences for the storefront widget (null if appArchetype is backend_only).
  Focus on UX implications of platformGaps (e.g. "show 'you will be notified' not 'email sent'").

widgetApiCatalog: null for backend_only apps.
  For storefront_ui apps: the exact paths the widget will call via host.call().
  Decide based on what this specific feature requires — do not add speculative extras.
  Rules:
  - path must start with "/" and be a short slug (e.g. "/signup", "/status", "/redeem")
  - method "POST" = mutation (writes to DB), "GET" = read-only query
  - The runtime always sends HTTP POST regardless of method — method is semantic intent only
  - Only include paths the widget will actually call in the generated code
  - responseShape: the EXACT JSON object the handler returns on success. Both the handler
    and widget generators receive this and must use these exact field names — no aliases,
    no renames. Error responses always use { error: "short_slug" } — do not list errors here.
  Widget body contract — when writing codeSpec for widget paths, use these exact field names:
  - customerEmail (the user's email — the widget sends this, NOT "email")
  - variantId, productId, customerId (camelCase from host.context — always available)
  - inventoryItemId is NOT sent by the widget — if needed, the handler must resolve it:
    GET /variants/${variantId}.json → variant.inventory_item_id

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — respond ONLY with this JSON (no markdown fences, no explanation):
{
  "shopifyPlan": {
    "webhookTopics": [],
    "cronSchedule": null,
    "operations": [
      {
        "step": 1,
        "description": "...",
        "type": "query" | "mutation",
        "method": "GET" | "POST" | "PUT" | "DELETE",
        "path": "/admin/api/2026-01/...",
        "bodyExample": null
      }
    ]
  },
  "implementationSpec": {
    "stateMachine": null | {
      "needsStateTracking": true,
      "trackedEntity": "which column on which table tracks which entity",
      "unknownSentinel": "null",
      "skipWhenUnknown": true,
      "skipRationale": "one sentence: why first-seen records must be skipped"
    },
    "platformGaps": [
      { "need": "short name", "mitigation": "exact instruction for the handler code" }
    ],
    "cronBatching": null | {
      "required": true,
      "batchEndpoint": "/path?param=<comma-ids>",
      "batchParam": "param_name",
      "maxBatchSize": 50,
      "advice": "one sentence: what to pre-fetch and how to build the lookup map"
    },
    "codeSpec": {
      "webhookPath": ["step 1", "step 2"],
      "cronPath": ["step 1", "step 2"],
      "widgetPath": ["path /signup: widget calls host.call('/signup', { customerEmail, variantId, productId })", "path /signup: handler: const { customerEmail, variantId, productId } = ctx.widgetBody"],
      "functions": [
        { "name": "fnName", "steps": ["step 1", "step 2"] }
      ]
    },
    "migrationGuidance": "...",
    "widgetGuidance": null,
    "widgetApiCatalog": null | [
      { "method": "POST" | "GET", "path": "/slug", "responseShape": { "fieldName": "exampleValue" } }
    ]
  }
}"""

_PLANNER_USER_TEMPLATE = """{error_block}Merchant request: {prompt}

Feature intent:
{intent_json}

App archetype: {archetype}
{schema_section}{jit_notes}Produce the complete plan."""

# ── JIT contextual notes keyed on intent resources ────────────────────────────

_JIT_NOTE_INVENTORY = """
⚠ Inventory multi-location note (inject because this feature uses inventory):
  inventory_levels/update fires once PER LOCATION — ctx.payload.available is that
  location's quantity only, not the store-wide total. To avoid false-positive
  notifications (item restocked at one location but still globally zero), the
  handler should call GET /inventory_levels.json?inventory_item_ids=<id> after
  detecting a per-location restock, sum available across all locations, and only
  trigger if the store-wide total transitions from 0 to positive.
  Include this as a platformGap with the above mitigation.
"""

_JIT_NOTE_VARIANTS_CRON = """
⚠ Variant/product cron batching note (inject because this feature uses products in a cron path):
  Shopify has NO batch variant-by-IDs endpoint — GET /variants/{id}.json inside a loop
  is N sequential Shopify API calls and WILL hit rate limits at scale.

  Correct pattern — batch via products.json then extract variants:
  1. Store product_id (BIGINT) in the DB table alongside variant_id.
     Add "store product_id BIGINT alongside variant_id to support batch product fetching" to migrationGuidance.
  2. In the cron path, collect all unique product_ids from the DB result.
  3. Batch-fetch: GET /products.json?ids=<comma-ids>&fields=id,title,variants (max 250 per batch).
  4. Build variantMap: Map<variant_id, {variant, product}> by iterating product.variants[].
  5. Loop body uses variantMap only — zero Shopify calls inside the loop.
  Write this as a concrete function in codeSpec.functions[] (e.g. batchFetchProductVariantData)
  with all steps naming the exact variables, fields, and batch size (250).
"""

_JIT_NOTE_INVENTORY_CRON = """
⚠ Inventory cron stock-check note (inject because this feature uses inventory in a cron path):
  Do NOT use variant.inventory_quantity from /products.json — this field is unreliable for
  multi-location stores. It can be stale or incorrect when stock exists at only some locations.

  Correct pattern — batch via inventory_levels.json:
  1. Store inventory_item_id (BIGINT) in the DB table alongside variant_id.
     Add "store inventory_item_id BIGINT to support batch inventory level fetching" to migrationGuidance.
  2. In the cron pre-fetch phase, collect all unique inventory_item_ids from pending DB rows.
  3. Batch-fetch: GET /inventory_levels.json?inventory_item_ids=<comma-ids> (max 50 per batch).
  4. Build inventoryMap: Map<inventory_item_id, storeWideTotal> by summing level.available
     across all location entries for each inventory_item_id.
  5. Loop body uses inventoryMap — zero Shopify inventory calls inside the loop.
  Write this as a concrete function in codeSpec.functions[] (e.g. batchFetchInventoryLevels)
  with all steps naming the exact variables, fields, and batch size (50).
"""


def _build_jit_notes(intent: Dict[str, Any]) -> str:
    """Inject contextual guidance into the planner prompt based on what resources the intent uses."""
    resources = [r.lower() for r in (intent.get("resources") or [])]
    trigger = intent.get("triggerType", "")
    notes: List[str] = []
    if "inventory" in resources:
        notes.append(_JIT_NOTE_INVENTORY)
    if "inventory" in resources and trigger in ("cron", "both"):
        notes.append(_JIT_NOTE_INVENTORY_CRON)
    if "products" in resources and trigger in ("cron", "both"):
        notes.append(_JIT_NOTE_VARIANTS_CRON)
    return "".join(notes)


def run_planner_agent(
    prompt: str,
    intent: Dict[str, Any],
    app_archetype: str,
    schema_fragments: str,
    validation_errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Merged Planner Agent: produces shopifyPlan + implementationSpec in one call.

    Args:
        prompt:            Original merchant prompt (gives the Planner full context).
        intent:            Parsed intent from Agent 1 (run_intent_agent).
        app_archetype:     "storefront_ui" | "backend_only"
        schema_fragments:  Shopify API doc snippets for the relevant resources.
        validation_errors: Errors from validate_plan() on a prior attempt, or None.

    Returns:
        plan dict with keys: shopifyPlan, implementationSpec
        For storefront_ui apps, implementationSpec includes widgetApiCatalog.
    """
    error_block = ""
    if validation_errors:
        lines = "\n".join(f"  - {e}" for e in validation_errors)
        error_block = (
            f"PREVIOUS ATTEMPT FAILED PLAN VALIDATION:\n{lines}\n"
            f"Fix ALL listed errors in this attempt.\n\n"
        )

    schema_section = (
        f"\nRelevant Shopify API schema:\n{schema_fragments}\n"
        if schema_fragments
        else ""
    )

    jit_notes = _build_jit_notes(intent)

    user = _PLANNER_USER_TEMPLATE.format(
        error_block=error_block,
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
        archetype=app_archetype,
        schema_section=schema_section,
        jit_notes=jit_notes,
    )

    llm = get_code_llm(max_tokens=8192)
    for attempt in range(2):
        result = invoke(llm, PLANNER_SYSTEM, user)
        raw = extract_json(result.content)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            if attempt == 1:
                raise
