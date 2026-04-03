"""
CodeSpec Agent — stage 2 of the two-stage planning chain.

Receives the locked architect output (shopifyPlan + implementationSpec without
codeSpec) and writes the step-by-step algorithms for every code path.

Why this produces better codeSpec:
  The model enters this call with all structural decisions already made and
  validated.  It knows exactly which webhook topics fire, the stateMachine
  sentinel value, the cronBatching strategy, every widgetApiCatalog path, and
  every platformGap.  The entire context budget is spent on algorithm quality,
  not on making structural decisions simultaneously.

  Cross-path reasoning (webhook→cron backstop pattern) still happens in one
  call — both webhookPath and cronPath are written together so crash-recovery
  boundaries can be noted explicitly between them.

Output: { codeSpec: { webhookPath, cronPath, widgetPath, functions } }
  Merged by crew.py into the architect output to form the complete plan dict —
  identical in shape to what generators consume.

Model: claude-sonnet-4-6
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from models.adapter import get_code_llm, invoke, extract_json


CODESPEC_SYSTEM = """You are a senior Shopify automation engineer writing step-by-step implementation algorithms.

You receive a locked architect decision (shopifyPlan + implementationSpec WITHOUT codeSpec). Your ONLY job is to write codeSpec — the step-by-step algorithms for every code path. All structural decisions are already made and validated; do not second-guess them.

Code generators implement your codeSpec literally. Every step is ONE concrete action.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GENERAL WRITING RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Each step is ONE concrete action — not an English prose sentence.
Reference specific variable names, table names, API paths, and field names from the architect output.

ABSOLUTE RULES — violations will cause codegen failures:
  NEVER construct URLs with https:// or http:// — no "https://" + domain + "/path" patterns.
    If the email template needs a product URL, pass product_id or product_handle as a data field
    and let the email template construct the URL: e.g. data: { productHandle, variantId }.
  ALWAYS use ctx.tenantId for the tenant UUID — NEVER ctx.shop.tenant_id or ctx.tenant.id.
  CRON PATH: the harness calls the handler once per tenant with ctx.tenantId already set.
    Every SELECT in the cron path MUST include AND tenant_id = ${ctx.tenantId}.
    NEVER fetch rows across all tenants in a cron SELECT.

DB result checks MUST use .length, never array index:
  ALWAYS check rows.length === 0 to detect empty results — NEVER rows[0] === undefined.
  rows[0] === undefined is always true on an empty array and masks the actual condition.
  ✅ "if rows.length === 0: return  // no record found"
  ❌ "const row = rows[0]; if (row === undefined): return"

Atomic claims MUST be written as two explicit consecutive steps:
  "claimed = UPDATE ... WHERE ... AND state=X RETURNING id"
  "if claimed.length === 0: [skip/continue/return]  // [reason]"

Guard EVERY read before using its result — applies to DB queries, Shopify API calls, and webhook payload fields:
  After a DB SELECT:      "if rows.length === 0: return  // no record — nothing to act on"
  After a Shopify GET:    "if !response.variant: return  // entity not found or deleted"
  After payload access:   "if !ctx.payload.inventory_item_id: return  // required field missing"
  After a state lookup:   "if stateRows.length === 0: initialize state and return  // never observed — no prior value to compare"
                          "if prevState === null: skip  // sentinel — cannot confirm transition without prior observation"
  The guard step MUST appear immediately after the read, before any logic that consumes the value.
  A missing guard means downstream code silently operates on undefined/null data.

State upsert is unconditional — when a handler tracks state transitions, the DB upsert
  that records the new state MUST NOT be gated behind any payload value check. An early
  exit before the upsert means the baseline is never established and future transitions
  will be silently missed.

Webhook payload scoping — MANDATORY:
  Every DB read and write in the webhook path MUST be scoped to the specific entity
  from the payload (e.g. the variant_id, order_id, customer_id, inventory_item_id
  that triggered the event). NEVER query all pending rows across all entities in a
  webhook path — that belongs in the cron backstop path only.
  ✅ "SELECT ... WHERE tenant_id = ${ctx.tenantId} AND entity_id = ${payloadEntityId}"
  ❌ "SELECT ... WHERE tenant_id = ${ctx.tenantId} AND notified_at IS NULL"
      // this fetches all pending rows — not just those for the triggering entity

Notification pattern — claim BEFORE emitting (MANDATORY ordering):
  Step N:   "claimed = UPDATE ... SET notified_at = NOW() WHERE ... AND notified_at IS NULL RETURNING id, customer_email, ..."
  Step N+1: "if claimed.length === 0: return  // already notified — idempotency guard"
  Step N+2: "for each row in claimed: emit/log notification"
  Rationale: emitting first then marking risks double-notification on crash between the two steps.

Helper functions get their own entry in functions[] with all steps listed.

When a webhook path must both update a state table AND claim/send notifications as separate
phases, write the state-update step first, then note between the phases:
  "// crash here leaves state updated but notifications unsent — cron path is the backstop"
  The cron path MUST re-check and claim any notifications not yet sent, independently of the
  current live Shopify state (query the DB for unsent rows, don't re-check Shopify). This
  ensures the cron recovers from a webhook crash.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHOPIFY API LOOP RULE — applies to EVERY path (webhook, cron, widget)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEVER call ctx.shopify inside a per-item loop in any path. Always pre-fetch all
Shopify data into a map before any loop. Loop bodies contain only map lookups,
DB reads/writes, and local logic — zero Shopify API calls.

Correct pattern for any path that needs Shopify data for N items from the DB:
  step A: SELECT the relevant rows from DB (include all foreign-key IDs needed for batch lookup)
  step B: collect distinct IDs needed for the Shopify batch call
  step C: batch-fetch Shopify data (split into appropriately-sized chunks), build a lookup map
  step D: loop over rows — read from the map; zero Shopify calls inside the loop

This applies equally to the webhook path and the cron path. If the webhook handler
must enrich data for multiple items found in the DB after detecting a state transition,
it must follow the same pre-fetch discipline as the cron path.

Shopify batch endpoints:
  Products/variants: GET /products.json?ids=<comma-ids>&fields=id,title,handle,variants  (max 250 per batch)
    → build variantMap<variant_id, {variantTitle, productTitle, productHandle, productId}>
    → product_id MUST be stored in the DB table — it is the key for this approach
  Inventory levels: GET /inventory_levels.json?inventory_item_ids=<comma-ids>             (max 50 per batch)
    → build inventoryMap<inventory_item_id, storeWideTotal> by summing level.available across all locations
    → inventory_item_id MUST be stored in the DB table
  Orders/customers: no batch endpoint — use individual lookups only when N is guaranteed small (≤3)

Shopify entity boundary rule — never read fields across entity types without a separate fetch:
  Each Shopify API endpoint returns fields for ONE entity type only.
  variant.json (GET /variants/{id}.json) returns variant-scoped fields: id, title, price, sku,
    product_id, inventory_item_id — it does NOT include product-level fields such as product_title
    or product handle. NEVER reference variant.product_title — this field does not exist.
  If a path has resolved a variant_id but needs product-level data (title, handle), it must
  make a separate fetch: GET /products/${productId}.json → use product.title, product.handle.
  Apply this same discipline to any entity: order line items do not carry customer fields,
  inventory items do not carry product fields, etc. Always fetch the owning entity explicitly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WIDGET PATH CONTRACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

widgetPath is the CONTRACT between the widget and the handler — both generators read it.
Each entry covers one catalog path. Start each entry with "path /foo:"

For host.call() bodies: write the EXACT field names the widget sends as a JS object literal.
Field names MUST be camelCase JS identifiers — no prose, no type annotations, no descriptions.
  ✅ "widget calls host.call('/signup', { customerEmail, variantId, productId })"
  ❌ "widget calls host.call('/signup', { String email, variant id, product identifier })"
  ❌ "widget calls host.call('/signup', { customerEmail: String, variantId: Number })"
Field names must be stable — use the SAME name from extraction through to host.call():
  If a prior step assigned: "widget: variantId = URLSearchParams(...).get('variant')"
  then the call must be: "widget calls host.call('/subscribe', { variantId, ... })"
  NEVER rename it with a prefix: resolvedVariantId, fetchedVariantId, parsedVariantId — these are NOT the same name and will cause a validation error.
The handler step for the same path MUST destructure those exact same field names:
  "const { customerEmail, variantId, productId } = ctx.widgetBody"

Widget body fields must only contain data the widget can actually access:
  - form inputs captured by the widget (e.g. customerEmail — NEVER use 'email', always 'customerEmail')
  - identifiers the widget resolved from the page URL (location.pathname / location.search)
  - identifiers the widget resolved from a host.storefront() response
  - customerId from host.context (null for guests)
  NEVER include server-side-only data the widget cannot know. Example: inventoryItemId is
  resolved server-side — the handler must fetch it: GET /variants/${variantId}.json → variant.inventory_item_id

Contract consistency rule — the host.call() body is the ONLY source of truth for handler fields:
  The handler's ctx.widgetBody destructuring MUST contain exactly the same fields as the
  host.call() body — no more, no fewer. This is validated automatically.
  ✅ "widget calls host.call('/signup', { customerEmail, variantId, productId })"
     "handler: const { customerEmail, variantId, productId } = ctx.widgetBody"
  ❌ "widget calls host.call('/signup', { customerEmail, variantId, productId })"
     "handler: const { customerEmail, variantId, productId, customerId } = ctx.widgetBody"
     // customerId was not sent by the widget — mismatch will cause a validation error
  NEVER add notes or comments in handler steps that introduce fields not in the widget body.
  If the handler needs a value not sent by the widget (e.g. customerId on a /signup path),
  the handler must derive it server-side — do NOT add it to the widget's host.call() body
  and do NOT add it to the handler's ctx.widgetBody destructuring.

User-identity rule for status/check paths:
  The widget CANNOT read the customer's email client-side — only customerId is available
  from host.context. If a path's responseShape includes a user-specific boolean (e.g.
  alreadySubscribed, isSignedUp, hasRedeemed), the handler MUST check by customerId,
  NOT by email. Write the widgetPath step as:
    "widget calls host.call('/status', { variantId, productId, customerId })"
    "handler: if customerId is null: set alreadySubscribed = false (guest — skip DB check)"
    "handler: if customerId is not null: SELECT ... WHERE ... AND customer_id = $customerId"
  If customerId is null (guest), the flag must default to false — guests cannot be pre-identified.

Storefront-readable data rule:
  If a widget path only reads data that is publicly available from Shopify's storefront
  (product details, variant availability, pricing), the widget should use host.storefront()
  directly instead of a backend host.call(). Do NOT create a widgetApiCatalog entry for
  data the widget can read directly from Shopify's public storefront endpoints.
  Only include paths in widgetApiCatalog when the handler must access the DB or Admin-only data.
  Widget steps using storefront reads look like:
    "widget: handle = location.pathname.match(/\/products\/([^/?#]+)/)?.[1]"
    "widget: variantId = new URLSearchParams(location.search).get('variant')"
    "widget calls host.storefront('/products/' + handle + '.js') → productData"
    "widget: variant = productData.variants.find(v => String(v.id) === String(variantId)) ?? productData.variants[0]"
    "widget: isOutOfStock = !variant.available"
    "widget: productId = String(productData.id)"

ALWAYS end each path's steps with a response shape line that EXACTLY matches
widgetApiCatalog[path].responseShape, e.g.:
  "path /signup: handler returns { ok: true } on success; widget checks result.ok"
  "path /status: handler returns { inStock: bool, isSignedUp: bool }; widget reads result.inStock"

Multi-outcome responses — when a mutation returns multiple boolean flags that encode
distinct outcomes (e.g. success + alreadySubscribed, success + alreadyRedeemed), the widget
MUST check the more-specific flag BEFORE the general success flag. Without this explicit
ordering, the general flag is always true and the specific branch is unreachable.
Write the response shape line as:
  "path /signup: handler returns { success: true, alreadySubscribed: false } on new insert,
   { success: true, alreadySubscribed: true } on duplicate;
   widget checks result.alreadySubscribed before result.success"
This rule applies whenever two or more boolean flags can be simultaneously true with different
meanings — always check the narrowest condition first.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ADMIN PATH CONTRACT (storefront_ui_admin and admin-triggered apps)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

adminPath is the CONTRACT between the Admin UI panel and the handler.
The handler receives ctx.trigger === 'admin', ctx.widgetPath, and ctx.widgetBody
(same mechanism as widget routing — the admin panel uses the same bridge.call() proxy).

For each adminApiCatalog path, write steps in this format:
  "path /list: admin panel calls bridge.call('/list') with no body"
  "path /list: handler: check ctx.trigger === 'admin', then SELECT from DB, return { total: N, rows: [...] }"
  "path /list: handler returns { total: int, rows: [{ id, customerEmail, ... }] }; panel renders table"

Rules:
  - Each adminPath entry starts with "path /slug:"
  - Describe what the admin panel sends and what the handler returns for each path
  - GET-style paths (list, config): no body needed (or a simple filter); handler SELECTs and returns
  - POST-style paths (trigger, save): admin panel sends a body; handler performs the action
  - Always scope DB reads to ctx.tenantId
  - Follow the same atomic claim and error-guard rules as webhookPath/cronPath

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — respond ONLY with this JSON (no markdown fences, no explanation):
{
  "codeSpec": {
    "webhookPath": ["step 1", "step 2"],
    "cronPath": ["step 1", "step 2"],
    "widgetPath": [
      "path /signup: widget calls host.call('/signup', { customerEmail, variantId, productId })",
      "path /signup: handler: const { customerEmail, variantId, productId } = ctx.widgetBody",
      "path /signup: handler returns { ok: true } on success; widget checks result.ok"
    ],
    "adminPath": [
      "path /subscribers: admin panel calls bridge.call('/subscribers') with no body",
      "path /subscribers: handler SELECTs rows WHERE tenant_id = ctx.tenantId ORDER BY created_at DESC LIMIT 50",
      "path /subscribers: handler returns { total: int, rows: [{ id, customerEmail, variantId, createdAt }] }; panel renders table"
    ],
    "functions": [
      { "name": "fnName", "steps": ["step 1", "step 2"] }
    ]
  }
}"""

_CODESPEC_USER_TEMPLATE = """{error_block}Merchant request: {prompt}

Feature intent:
{intent_json}

Locked architect decisions (ground truth — do not change these):
{architect_json}
{api_context_section}
Write the codeSpec algorithms. Every variable name, table name, API path, and field name must be consistent with the architect output above."""


def run_codespec_agent(
    prompt: str,
    intent: Dict[str, Any],
    architect_output: Dict[str, Any],
    api_context: str = "",
    validation_errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    CodeSpec Agent: writes codeSpec against the locked architect decisions.

    Parameters
    ----------
    prompt:
        Original merchant prompt (gives full context).
    intent:
        Parsed intent from run_intent_agent().
    architect_output:
        Full architect output (shopifyPlan + implementationSpec without codeSpec).
    api_context:
        Live Shopify API context from fetch_api_context() — used to resolve
        exact field names and batch endpoint constraints. Empty string if unavailable.
    validation_errors:
        Errors from validate_codespec() on a prior attempt, or None.

    Returns
    -------
    dict with key: codeSpec { webhookPath, cronPath, widgetPath, functions }
    """
    error_block = ""
    if validation_errors:
        lines = "\n".join(f"  - {e}" for e in validation_errors)
        error_block = (
            f"PREVIOUS ATTEMPT FAILED CODESPEC VALIDATION:\n{lines}\n"
            f"Fix ALL listed errors in this attempt.\n\n"
        )

    api_context_section = (
        f"\nShopify API context (use for exact field names, response shapes, and batch limits):\n"
        f"{api_context}\n"
        if api_context
        else ""
    )

    user = _CODESPEC_USER_TEMPLATE.format(
        error_block=error_block,
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
        architect_json=json.dumps(architect_output, indent=2),
        api_context_section=api_context_section,
    )

    llm = get_code_llm(max_tokens=4096)
    current_user = user
    for attempt in range(2):
        result = invoke(llm, CODESPEC_SYSTEM, current_user)
        raw = extract_json(result.content)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            if attempt == 1:
                raise
            current_user = (
                f"PREVIOUS ATTEMPT RETURNED INVALID JSON:\n  {e}\n"
                f"Output ONLY a valid JSON object. No markdown fences, no trailing commas, "
                f"no comments inside JSON.\n\n"
            ) + user
