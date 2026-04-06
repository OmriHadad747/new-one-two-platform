"""
Architect Agent — stage 1 of the two-stage planning chain.

Produces all structural decisions: which Shopify webhooks and APIs the feature
uses, whether a state machine is needed, platform gaps, cron batching strategy,
widget catalog, and schema / UX guidance.

Does NOT produce codeSpec — that is the CodeSpec Agent's job (stage 2).

Why splitting helps:
  All decisions here are bounded and enumerable: pick topics from a known list,
  decide if a state machine is needed (binary), identify gaps against the known
  ctx surface. No creative algorithm writing. The output (~2000–3000 tokens) is
  validated by validate_architect() before any codeSpec tokens are generated,
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
  Use only topics listed in the Shopify API context provided below.
  If no context is available, use only well-known topics for the resources involved.
  CRITICAL — format: topics MUST use lowercase REST format "resource/action" (e.g. "inventory_levels/update").
  Do NOT use GraphQL enum format (SCREAMING_SNAKE_CASE like "INVENTORY_LEVELS_UPDATE" or "VARIANTS_IN_STOCK").
  GraphQL introspection may show WebhookSubscriptionTopic enum values — those are NOT valid here.
  There is NO "variants_in_stock" or similar topic — use "inventory_levels/update" to detect stock changes.

cronSchedule: null unless periodic polling is required. Use standard 5-field cron expression.

operations: Shopify API calls made by the handler, in execution order.
  When the feature detects a state transition, include a "read previous state" operation
  and a "write new state" operation — this signals the migration agent to create the required table.

  ── Protocol selection — choose "rest" or "graphql" for each operation ──
  Prefer "graphql" when:
    • Fetching a resource with deeply nested associations in one round-trip
      (e.g. order + fulfillments + lineItems + customer in a single query)
    • The REST equivalent would require 2 or more sequential calls to assemble needed fields
    • You need precise field selection to avoid over-fetching large payloads
    • Mutations with no REST equivalent: tagsAdd, metafieldsSet, discountCodeBulkAdd, productDeleteMedia
  Prefer "rest" when:
    • Simple CRUD on a single flat resource (get order, update customer, delete image)
    • Batch fetching of the same entity type (/products.json?ids=...)
    • Full-catalog scans — use since_id cursor: /products.json?limit=250&since_id=${sinceId}
    • Deleting resources that have a REST DELETE endpoint (product images, metafields, draft orders)
      → use ctx.shopify.delete('/products/${productId}/images/${imageId}.json')
    • No significant nesting benefit — GraphQL overhead outweighs the gain
  NOTE: REST responses do NOT include HTTP headers in ctx — Link header pagination fails.
    Always use since_id cursor for full-catalog REST scans.
  GraphQL IDs use GID format: "gid://shopify/TypeName/${numericId}"
    Convert numeric IDs from webhooks/REST before passing to GraphQL variables.
    The GID type name matches the GraphQL schema type (Order, Product, Customer, …).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — implementationSpec  (no codeSpec key)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

stateMachine: null if the feature does NOT need to detect state transitions.
  A state machine is needed when the handler must compare the current value to a prior observed value.
  - unknownSentinel is ALWAYS the string "null" — never the number 0, false, or empty string.
    Reason: 0 may be a real valid state (zero inventory is meaningful). null = never observed.
  - skipWhenUnknown is almost always true: cannot confirm a transition without witnessing the start.

platformGaps: What this feature needs that ctx cannot deliver.
  ctx provides (use these — do NOT list them as gaps):
    ctx.shopify.get(path)          — Shopify Admin REST GET
    ctx.shopify.post(path, body)   — Shopify Admin REST POST/PUT
    ctx.shopify.graphql(query, vars) — Shopify Admin GraphQL API (GID IDs required)
    ctx.db                         — Postgres (RLS-scoped to tenant)
    ctx.tenantId / ctx.shop.domain
    ctx.payload, ctx.logger
    ctx.http.call(url, options)    — external HTTP (real; https:// URLs allowed here only)
    ctx.storefront.graphql(...)    — Shopify Storefront API (real)
    ctx.services.email.send(...)   — transactional email (stub → real Phase 3)
    ctx.services.sms.send(...)     — SMS (stub → real Phase 3)
    ctx.services.files.upload(...) — file upload → URL (stub → real Phase 3)
    JS libraries via require()     — qrcode, jsbarcode, sharp, pdfkit, exceljs, csv-parse,
                                     csv-stringify, fast-xml-parser, handlebars, marked,
                                     dayjs, jszip, uuid, slugify (declare in npmPackages)
  ctx does NOT provide: push notifications, Slack, WhatsApp, real-time WebSockets,
  in-process native binaries, GPU processing, or real-time data streams.
  For each genuine gap, specify the exact mitigation the handler should use (usually:
  log full delivery intent with ctx.logger.info so an external integration can consume it).
  Do NOT list email, SMS, PDF, CSV, files, image, qrcode, barcode, or HTTP as platform gaps.

feasibility: CRITICAL — assess whether this app is BUILDABLE with the ctx surface above.
  Set to "feasible" in almost all cases. Set to "blocked" ONLY when:
    • The core value of the app literally cannot be delivered without a capability
      that ctx does NOT provide (e.g. real-time WebSocket push, GPU inference,
      native OS binary execution, live voice/video processing).
    • There is no reasonable mitigation (a stub + logging is NOT a blocked reason).
  Email, SMS, files are available through ctx.services. Image resize, PDF, QR codes,
  barcodes, CSV, Excel, XML, and other document/data work are available as JS libraries
  via require() — declare them in npmPackages. Do NOT mark any of these as blocked.
  When feasibility is "blocked", set blockedReason to a single merchant-friendly
  sentence explaining what's missing (e.g. "This app requires real-time WebSocket
  push notifications, which aren't supported yet.").

cronBatching: Required when the cron path would call Shopify APIs inside a per-item loop.
  Shopify rate limit: ~2 req/s on Basic. N items × K calls per item = throttle at scale.
  Fix: fetch all Shopify data in batches BEFORE the loop. Loop body has zero Shopify calls.
  Important: Shopify has NO batch variant-by-IDs REST endpoint. To batch variant/product data,
  store product_id (BIGINT) in the DB and batch via /products.json?ids=... (max 250), then
  extract variants from product.variants[]. Note this in advice and migrationGuidance.

complexity: "low" | "medium" | "high" — your technical assessment after reviewing the full plan.
  low:    single webhook or simple cron, no state machine, no platform gaps, flat schema.
  medium: multiple webhooks or cron+webhook, OR state machine, OR 1–2 platform gaps, OR batch cron.
  high:   state machine + multiple execution paths, complex cross-resource joins, 3+ platform gaps,
          or a storefront widget with non-trivial backend contract.

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

widgetGuidance: 1-2 UX sentences for the storefront widget (null if appArchetype is backend).
  Focus on UX implications of platformGaps (e.g. "show 'you will be notified' not 'email sent'").

widgetApiCatalog: null for backend apps.
  For storefront_backend / storefront_backend_admin apps: the exact paths the widget will call via host.call().
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
  Widget body fields must only contain data the widget can actually access:
  - form inputs captured by the widget (e.g. customerEmail — the widget sends this, NOT "email")
  - identifiers resolved from the page URL (location.pathname / location.search)
  - identifiers resolved from host.storefront() responses
  - customerId from host.context (null for guests)
  NEVER include server-side-only data the widget cannot know. Example: inventoryItemId must
  be resolved server-side — GET /variants/${variantId}.json → variant.inventory_item_id
  User-identity in responseShape: if a path returns a user-specific boolean (e.g.
  alreadySubscribed, isSignedUp), the handler MUST check by customerId, not email.
  The widget cannot read the customer's email — only customerId is available from host.context.
  Store customer_id BIGINT (Shopify customer ID) in the subscriptions table alongside
  customer_email so both logged-in and guest flows are supported.

storefrontReads: null for backend apps.
  For storefront_backend / storefront_backend_admin apps: list Shopify public endpoints the widget reads directly via
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

adminApiCatalog: REQUIRED (non-null, non-empty) when app archetype is "storefront_backend_admin" or "backend_admin".
  null for all other archetypes (storefront_backend, backend).
  The Admin UI panel embedded in Shopify Admin calls these paths via bridge.call().
  Each path is handled by the same backend handler — ctx.trigger === 'admin'.
  Rules:
  - path MUST start with "/" (e.g. "/list", "/trigger", "/config/get", "/config/save")
    Validation rejects any path without a leading slash.
  - method "GET" = read-only (list data, load config), "POST" = action or mutation
  - responseShape: the EXACT JSON the handler returns on success.
  - Design around what the merchant actually needs — no speculative extras.
  Examples:
    storefront_backend_admin (dashboard): [{ "method": "GET", "path": "/subscribers", "responseShape": { "total": 0, "rows": [] } }]
    backend_admin (admin-triggered action): [{ "method": "POST", "path": "/run", "responseShape": { "processed": 0 } }]

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
        "protocol": "rest",
        "method": "GET" | "POST" | "PUT" | "DELETE",
        "path": "/admin/api/2026-01/...",
        "bodyExample": null
      },
      {
        "step": 2,
        "description": "...",
        "protocol": "graphql",
        "operationType": "query" | "mutation",
        "operationHint": "order(id: $id) { fulfillments { trackingInfo { number company } } }"
      }
    ]
  },
  "implementationSpec": {
    "feasibility": "feasible" | "blocked",
    "blockedReason": null | "Single merchant-friendly sentence — only set when feasibility is 'blocked'",
    "complexity": "low" | "medium" | "high",
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
      { "path": "/products/${handle}.js", "dataUsed": "variant.available — widget extracts handle from location.pathname, variantId from location.search" }
    ],
    "widgetApiCatalog": null | [
      { "method": "POST" | "GET", "path": "/slug", "responseShape": { "fieldName": "exampleValue" } }
    ],
    "adminApiCatalog": null | [
      { "method": "POST" | "GET", "path": "/slug", "responseShape": { "fieldName": "exampleValue" } }
    ]
  }
}"""

_ARCHITECT_USER_TEMPLATE = """{error_block}Merchant request: {prompt}

Feature intent:
{intent_json}

App archetype: {archetype}
{api_context_section}
Produce the structural plan (no codeSpec)."""


def run_architect_agent(
    prompt: str,
    intent: Dict[str, Any],
    app_archetype: str,
    api_context: str,
    validation_errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Architect Agent: produces shopifyPlan + implementationSpec (WITHOUT codeSpec).

    Parameters
    ----------
    prompt:
        Original merchant prompt.
    intent:
        Parsed intent from run_intent_agent().
    app_archetype:
        "storefront_backend" | "storefront_backend_admin" | "backend" | "backend_admin"
    api_context:
        Live Shopify API context from fetch_api_context() — REST endpoints,
        GraphQL schema, webhook topics. Empty string if MCP unavailable.
    validation_errors:
        Errors from validate_architect() on a prior attempt, or None.

    Returns
    -------
    dict with keys: shopifyPlan, implementationSpec
    implementationSpec does NOT contain a codeSpec key.
    """
    error_block = ""
    if validation_errors:
        lines = "\n".join(f"  - {e}" for e in validation_errors)
        error_block = (
            f"PREVIOUS ATTEMPT FAILED ARCHITECT VALIDATION:\n{lines}\n"
            f"Fix ALL listed errors in this attempt.\n\n"
        )

    api_context_section = (
        f"\nShopify API context (use this as ground truth for topics, endpoints, and field names):\n"
        f"{api_context}\n"
        if api_context
        else ""
    )

    user = _ARCHITECT_USER_TEMPLATE.format(
        error_block=error_block,
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
        archetype=app_archetype,
        api_context_section=api_context_section,
    )

    llm = get_code_llm(max_tokens=3000)
    current_user = user
    for attempt in range(2):
        result = invoke(llm, ARCHITECT_SYSTEM, current_user)
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
