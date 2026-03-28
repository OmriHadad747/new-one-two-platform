"""
Architect Agent — stage 1 of the two-stage planning chain.

Produces all structural decisions: which Shopify webhooks and APIs the feature
uses, whether a state machine is needed, platform gaps, cron batching strategy,
widget catalog, and schema / UX guidance.

Does NOT produce codeSpec — that is the CodeSpec Agent's job (stage 2).

Why splitting helps:
  All decisions here are bounded and enumerable: pick topics from a known list,
  decide if a state machine is needed (binary), identify gaps against the known
  ctx surface.  No creative algorithm writing.  The output (~2000–3000 tokens)
  is validated by validate_architect() before any codeSpec tokens are generated,
  so structural failures are caught cheaply and do not waste a codespec retry.

Output: { shopifyPlan, implementationSpec }  — WITHOUT implementationSpec.codeSpec.

Model: claude-sonnet-4-6
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from models.adapter import get_code_llm, invoke, extract_json


ARCHITECT_SYSTEM = """You are a senior Shopify automation architect. Your output is consumed by a CodeSpec agent that writes step-by-step algorithms — your job is structural decisions only, not algorithms.

Produce a two-section plan: the Shopify API surface (shopifyPlan) and the implementation spec (implementationSpec). Do NOT include a codeSpec key — the CodeSpec agent writes that separately against your locked decisions.

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
SECTION 2 — implementationSpec  (no codeSpec key)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

stateMachine: null if the feature does NOT need to detect state transitions.
  A state machine is needed when the handler must compare the current value to a prior observed value.
  - unknownSentinel is ALWAYS the string "null" — never the number 0, false, or empty string.
    Reason: 0 may be a real valid state (zero inventory is meaningful). null = never observed.
  - skipWhenUnknown is almost always true: cannot confirm a transition without witnessing the start.

platformGaps: What this feature needs that ctx cannot deliver.
  ctx provides: ctx.shopify.get/post, ctx.db (Postgres), ctx.tenantId, ctx.payload, ctx.logger,
                ctx.email.send({ to, subject, templateId?, data? }).
  ctx does NOT provide: SMS, push notifications, Slack, external HTTP, file storage.
  For each gap, specify the exact mitigation the handler should use (usually: log full delivery
  intent with ctx.logger.info so an external integration can consume it).
  Note: email is available via ctx.email.send() — do NOT list email as a platformGap.

cronBatching: Required when the cron path would call Shopify APIs inside a per-item loop.
  Shopify rate limit: ~2 req/s on Basic. N items × K calls per item = throttle at scale.
  Fix: fetch all Shopify data in batches BEFORE the loop. Loop body has zero Shopify calls.
  Important: Shopify has NO batch variant-by-IDs endpoint. To batch variant/product data,
  store product_id (BIGINT) in the DB and batch via /products.json?ids=... (max 250), then
  extract variants from product.variants[]. Note this in advice and migrationGuidance.

migrationGuidance: 1-2 sentences on schema decisions — column nullability, sentinel meaning, indexes.
  If stateMachine is set, state column MUST be NULLABLE (null = never observed).
  CRITICAL: Shopify entity IDs (variant_id, product_id, order_id, customer_id, inventory_item_id)
  are numeric integers — always specify BIGINT or TEXT for these columns, NEVER UUID.
  Only tenant_id and internal record primary keys use UUID.
  CRITICAL: customer_id in storefront-facing tables (subscriptions, opt-ins, wishlists, any table
  a widget POSTs into) MUST be BIGINT (nullable — no NOT NULL constraint). The widget's customerId
  from host.context is null for guest visitors; a NOT NULL constraint causes INSERT failures for
  all guest submissions.
  CRITICAL: Tables that store one record per customer per Shopify entity (signup, subscription,
  opt-in) MUST have a UNIQUE constraint — not just an index — on the natural deduplication key
  (typically tenant_id, entity_id, customer_email). Use CONSTRAINT uq_<table>_<key> UNIQUE (...).
  This enables ON CONFLICT DO NOTHING inserts.

widgetGuidance: 1-2 UX sentences for the storefront widget (null if appArchetype is backend_only).
  Focus on UX implications of platformGaps (e.g. "show 'you will be notified' not 'email sent'").

widgetApiCatalog: null for backend_only apps.
  For storefront_ui apps: the exact paths the widget will call via host.call().
  Decide based on what this specific feature requires — do not add speculative extras.
  Before adding any path: ask "can the widget get this data from host.storefront() instead?"
  If yes → add to storefrontReads, not widgetApiCatalog.
  Only add to widgetApiCatalog if the path requires backend involvement.
  Rules:
  - path must start with "/" and be a short slug (e.g. "/signup", "/status", "/redeem")
  - method "POST" = mutation (writes to DB), "GET" = read-only query
  - The runtime always sends HTTP POST regardless of method — method is semantic intent only
  - Only include paths the widget will actually call in the generated code
  - responseShape: the EXACT JSON object the handler returns on success. Both the handler
    and widget generators receive this and must use these exact field names — no aliases,
    no renames. Error responses always use { error: "short_slug" } — do not list errors here.
  Widget body contract (used by the CodeSpec agent when writing widgetPath steps):
  - customerEmail (the user's email — the widget sends this, NOT "email")
  - variantId, productId, customerId (camelCase from host.context — always available)
  - inventoryItemId is NOT sent by the widget — if needed, the handler must resolve it:
    GET /variants/${variantId}.json → variant.inventory_item_id
  User-identity in responseShape: if a path returns a user-specific boolean (e.g.
  alreadySubscribed, isSignedUp), the handler MUST check by customerId, not email.
  The widget cannot read the customer's email — only customerId is available from host.context.
  Store customer_id BIGINT (Shopify customer ID) in the subscriptions table alongside
  customer_email so both logged-in and guest flows are supported.

storefrontReads: null for backend_only apps.
  For storefront_ui apps: list Shopify public endpoints the widget reads directly via
  host.storefront() — data the widget can fetch without a backend call.
  Use this instead of widgetApiCatalog entries when the data is publicly available
  from Shopify's storefront (no auth, no DB, no Admin API needed).
  Rules:
  - Include only if the widget actually needs this data to render or make decisions
  - path: relative Shopify storefront path, may include ${host.context.X} placeholders
  - dataUsed: one-line description of what field(s) the widget reads and why
  Classification guide — use host.storefront() for:
    ✅ product/variant availability (available boolean, inventory_quantity)
    ✅ product details (title, price, description, images, variants)
    ✅ collection data, cart state
  Use host.call() (backend) for:
    ✅ any data stored in your DB (subscriptions, points, state)
    ✅ customer-specific state (alreadySubscribed, hasRedeemed, loyaltyPoints)
    ✅ Admin-API-only data (order history, customer tags, fulfillments)
    ✅ any write operation (signup, redeem, update)
  CRITICAL: Do NOT add a widgetApiCatalog path whose sole purpose is to proxy publicly
  available Shopify storefront data. That is a wasted backend call.

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
    "migrationGuidance": "...",
    "widgetGuidance": null,
    "storefrontReads": null | [
      { "path": "/products/${host.context.productHandle}.js", "dataUsed": "variant.available — to decide whether to show the button" }
    ],
    "widgetApiCatalog": null | [
      { "method": "POST" | "GET", "path": "/slug", "responseShape": { "fieldName": "exampleValue" } }
    ]
  }
}"""

_ARCHITECT_USER_TEMPLATE = """{error_block}Merchant request: {prompt}

Feature intent:
{intent_json}

App archetype: {archetype}
{schema_section}{jit_notes}Produce the structural plan (no codeSpec)."""

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
  Set cronBatching.required = true with batchEndpoint "/products.json?ids=<comma-ids>&fields=id,title,variants"
  and maxBatchSize 250.
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
  Set cronBatching.required = true with batchEndpoint "/inventory_levels.json?inventory_item_ids=<comma-ids>"
  and maxBatchSize 50.
"""


def _build_jit_notes(intent: Dict[str, Any]) -> str:
    """Inject contextual guidance into the architect prompt based on intent resources."""
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


def run_architect_agent(
    prompt: str,
    intent: Dict[str, Any],
    app_archetype: str,
    schema_fragments: str,
    validation_errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Architect Agent: produces shopifyPlan + implementationSpec (WITHOUT codeSpec).

    Args:
        prompt:            Original merchant prompt.
        intent:            Parsed intent from run_intent_agent().
        app_archetype:     "storefront_ui" | "backend_only"
        schema_fragments:  Shopify API doc snippets for the relevant resources.
        validation_errors: Errors from validate_architect() on a prior attempt, or None.

    Returns:
        architect_output dict with keys: shopifyPlan, implementationSpec
        implementationSpec does NOT contain a codeSpec key.
    """
    error_block = ""
    if validation_errors:
        lines = "\n".join(f"  - {e}" for e in validation_errors)
        error_block = (
            f"PREVIOUS ATTEMPT FAILED ARCHITECT VALIDATION:\n{lines}\n"
            f"Fix ALL listed errors in this attempt.\n\n"
        )

    schema_section = (
        f"\nRelevant Shopify API schema:\n{schema_fragments}\n"
        if schema_fragments
        else ""
    )

    jit_notes = _build_jit_notes(intent)

    user = _ARCHITECT_USER_TEMPLATE.format(
        error_block=error_block,
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
        archetype=app_archetype,
        schema_section=schema_section,
        jit_notes=jit_notes,
    )

    llm = get_code_llm(max_tokens=3000)
    for attempt in range(2):
        result = invoke(llm, ARCHITECT_SYSTEM, user)
        raw = extract_json(result.content)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            if attempt == 1:
                raise
