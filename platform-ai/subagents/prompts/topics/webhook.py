"""
Single source of truth for every webhook rule the agents see.

Public surface:
  WEBHOOK_API_VERSION — Admin GraphQL API version the topic set was sourced from.
  WEBHOOK_TOPICS      — frozenset of every REST-valid topic the architect may
                        choose and that static_validation accepts.
  ARCHITECT           — prompt fragment: webhookTopics format rule + the valid
                        topic list (so the architect picks from a known set, not
                        from training-data memory) + webhookContract shape.
  HANDLER             — implementation rules specific to webhook-handlers.ts
                        (file shape, topic-key match, throw-to-fail semantics).
                        Universal handler rules (claim-then-act, scoping,
                        replay-safe INSERT, bulk-fetch) live in
                        topics.handler.HANDLER under HANDLER INVARIANTS.
                        Template-owned table rules are imported from
                        topics.template_tables.

Add a new template-owned topic / capability? Update WEBHOOK_TOPICS here once;
the architect prompt and static_validation pick it up automatically. Same SSoT
pattern as topics.template_tables.TEMPLATE_OWNED_TABLES.
"""

from subagents.prompts.topics.template_tables import HANDLER as _TEMPLATE_TABLES_HANDLER

# ── Canonical topic set ────────────────────────────────────────────────────────
#
# 194 REST-valid Shopify webhook topics that generated handlers may subscribe
# to. Source: Admin GraphQL `WebhookSubscriptionTopic` enum, API version 2026-04
# (https://shopify.dev/docs/api/admin-graphql/2026-04/enums/WebhookSubscriptionTopic).
#
# Each enum value's `description` field embeds the canonical REST topic in
# slash-form (e.g. `orders/create`). The full enum has 222 values; 218 have a
# REST topic; we exclude 27 of those because they are platform/admin-owned and
# never appear in generated handler code:
#
#   App lifecycle / billing (platform-back owns):
#     app/uninstalled, app/scopes_update,
#     app_purchases_one_time/update,
#     app_subscriptions/update, app_subscriptions/approaching_capped_amount
#   Mandatory GDPR (platform-back owns per Shopify policy):
#     customers/data_request, customers/redact, shop/redact
#   Store-admin configuration (no handler use case):
#     customer_account_settings/update,
#     checkout_and_accounts_configurations/update,
#     delivery_promise_settings/update,
#     locales/{create,destroy,update},
#     domains/{create,destroy,update}
#   Shopify Capital / financial-services internals:
#     finance_app_staff_member/{grant,revoke,update,delete},
#     finance_kyc_information/update
#   Tax-service integrations (third-party tax-app surface only):
#     tax_partners/update, tax_services/{create,update}
#   Async patterns the generator does not teach:
#     bulk_operations/finish (we use synchronous polling in shopify.bulkQuery),
#     audit_events/admin_api_activity (security audit feed)
#
# Refresh procedure: re-introspect the enum from
# https://shopify.dev/admin-graphql-direct-proxy/<version> with a
# `__type(name: "WebhookSubscriptionTopic") { enumValues { name description } }`
# query, parse the slash-form REST topic out of each description, and re-apply
# the 27-topic exclusion set above.

WEBHOOK_API_VERSION: str = "2026-04"

WEBHOOK_TOPICS: frozenset[str] = frozenset({
    # ── attributed_sessions ────────────────────────────────────────────
    "attributed_sessions/first",
    "attributed_sessions/last",
    # ── carts ──────────────────────────────────────────────────────────
    "carts/create",
    "carts/update",
    # ── channels ───────────────────────────────────────────────────────
    "channels/delete",
    # ── checkouts ──────────────────────────────────────────────────────
    "checkouts/create",
    "checkouts/delete",
    "checkouts/update",
    # ── collection_listings ────────────────────────────────────────────
    "collection_listings/add",
    "collection_listings/remove",
    "collection_listings/update",
    # ── collection_publications ────────────────────────────────────────
    "collection_publications/create",
    "collection_publications/delete",
    "collection_publications/update",
    # ── collections ────────────────────────────────────────────────────
    "collections/create",
    "collections/delete",
    "collections/update",
    # ── companies ──────────────────────────────────────────────────────
    "companies/create",
    "companies/delete",
    "companies/update",
    # ── company_contact_roles ──────────────────────────────────────────
    "company_contact_roles/assign",
    "company_contact_roles/revoke",
    # ── company_contacts ───────────────────────────────────────────────
    "company_contacts/create",
    "company_contacts/delete",
    "company_contacts/update",
    # ── company_locations ──────────────────────────────────────────────
    "company_locations/create",
    "company_locations/delete",
    "company_locations/update",
    # ── customer_groups ────────────────────────────────────────────────
    "customer_groups/create",
    "customer_groups/delete",
    "customer_groups/update",
    # ── customer_payment_methods ───────────────────────────────────────
    "customer_payment_methods/create",
    "customer_payment_methods/revoke",
    "customer_payment_methods/update",
    # ── customers ──────────────────────────────────────────────────────
    "customers/create",
    "customers/delete",
    "customers/disable",
    "customers/enable",
    "customers/merge",
    "customers/purchasing_summary",
    "customers/update",
    # ── customers_email_marketing_consent ──────────────────────────────
    "customers_email_marketing_consent/update",
    # ── customers_marketing_consent ────────────────────────────────────
    "customers_marketing_consent/update",
    # ── discounts ──────────────────────────────────────────────────────
    "discounts/create",
    "discounts/delete",
    "discounts/redeemcode_added",
    "discounts/redeemcode_removed",
    "discounts/update",
    # ── disputes ───────────────────────────────────────────────────────
    "disputes/create",
    "disputes/update",
    # ── draft_orders ───────────────────────────────────────────────────
    "draft_orders/create",
    "draft_orders/delete",
    "draft_orders/update",
    # ── fulfillment_events ─────────────────────────────────────────────
    "fulfillment_events/create",
    "fulfillment_events/delete",
    # ── fulfillment_holds ──────────────────────────────────────────────
    "fulfillment_holds/added",
    "fulfillment_holds/released",
    # ── fulfillment_orders ─────────────────────────────────────────────
    "fulfillment_orders/cancellation_request_accepted",
    "fulfillment_orders/cancellation_request_rejected",
    "fulfillment_orders/cancellation_request_submitted",
    "fulfillment_orders/cancelled",
    "fulfillment_orders/fulfillment_request_accepted",
    "fulfillment_orders/fulfillment_request_rejected",
    "fulfillment_orders/fulfillment_request_submitted",
    "fulfillment_orders/fulfillment_service_failed_to_complete",
    "fulfillment_orders/hold_released",
    "fulfillment_orders/line_items_prepared_for_local_delivery",
    "fulfillment_orders/line_items_prepared_for_pickup",
    "fulfillment_orders/manually_reported_progress_stopped",
    "fulfillment_orders/merged",
    "fulfillment_orders/moved",
    "fulfillment_orders/order_routing_complete",
    "fulfillment_orders/placed_on_hold",
    "fulfillment_orders/progress_reported",
    "fulfillment_orders/rescheduled",
    "fulfillment_orders/scheduled_fulfillment_order_ready",
    "fulfillment_orders/split",
    # ── fulfillments ───────────────────────────────────────────────────
    "fulfillments/create",
    "fulfillments/update",
    # ── inventory_items ────────────────────────────────────────────────
    "inventory_items/create",
    "inventory_items/delete",
    "inventory_items/update",
    # ── inventory_levels ───────────────────────────────────────────────
    "inventory_levels/connect",
    "inventory_levels/disconnect",
    "inventory_levels/update",
    # ── inventory_shipments ────────────────────────────────────────────
    "inventory_shipments/add_items",
    "inventory_shipments/create",
    "inventory_shipments/delete",
    "inventory_shipments/mark_in_transit",
    "inventory_shipments/receive_items",
    "inventory_shipments/remove_items",
    "inventory_shipments/update_item_quantities",
    "inventory_shipments/update_tracking",
    # ── inventory_transfers ────────────────────────────────────────────
    "inventory_transfers/add_items",
    "inventory_transfers/cancel",
    "inventory_transfers/complete",
    "inventory_transfers/ready_to_ship",
    "inventory_transfers/remove_items",
    "inventory_transfers/update_item_quantities",
    # ── locations ──────────────────────────────────────────────────────
    "locations/activate",
    "locations/create",
    "locations/deactivate",
    "locations/delete",
    "locations/update",
    # ── markets ────────────────────────────────────────────────────────
    "markets/create",
    "markets/delete",
    "markets/update",
    # ── markets_backup_region ──────────────────────────────────────────
    "markets_backup_region/update",
    # ── metafield_definitions ──────────────────────────────────────────
    "metafield_definitions/create",
    "metafield_definitions/delete",
    "metafield_definitions/update",
    # ── metaobjects ────────────────────────────────────────────────────
    "metaobjects/create",
    "metaobjects/delete",
    "metaobjects/update",
    # ── order_transactions ─────────────────────────────────────────────
    "order_transactions/create",
    # ── orders ─────────────────────────────────────────────────────────
    "orders/cancelled",
    "orders/create",
    "orders/delete",
    "orders/edited",
    "orders/fulfilled",
    "orders/link_requested",
    "orders/paid",
    "orders/partially_fulfilled",
    "orders/risk_assessment_changed",
    "orders/shopify_protect_eligibility_changed",
    "orders/updated",
    # ── payment_schedules ──────────────────────────────────────────────
    "payment_schedules/due",
    # ── payment_terms ──────────────────────────────────────────────────
    "payment_terms/create",
    "payment_terms/delete",
    "payment_terms/update",
    # ── product_feeds ──────────────────────────────────────────────────
    "product_feeds/create",
    "product_feeds/full_sync",
    "product_feeds/full_sync_finish",
    "product_feeds/incremental_sync",
    "product_feeds/update",
    # ── product_listings ───────────────────────────────────────────────
    "product_listings/add",
    "product_listings/remove",
    "product_listings/update",
    # ── product_publications ───────────────────────────────────────────
    "product_publications/create",
    "product_publications/delete",
    "product_publications/update",
    # ── products ───────────────────────────────────────────────────────
    "products/create",
    "products/delete",
    "products/update",
    # ── profiles ───────────────────────────────────────────────────────
    "profiles/create",
    "profiles/delete",
    "profiles/update",
    # ── publications ───────────────────────────────────────────────────
    "publications/delete",
    # ── refunds ────────────────────────────────────────────────────────
    "refunds/create",
    # ── returns ────────────────────────────────────────────────────────
    "returns/approve",
    "returns/cancel",
    "returns/close",
    "returns/decline",
    "returns/process",
    "returns/reopen",
    "returns/request",
    "returns/update",
    # ── reverse_deliveries ─────────────────────────────────────────────
    "reverse_deliveries/attach_deliverable",
    # ── reverse_fulfillment_orders ─────────────────────────────────────
    "reverse_fulfillment_orders/dispose",
    # ── scheduled_product_listings ─────────────────────────────────────
    "scheduled_product_listings/add",
    "scheduled_product_listings/remove",
    "scheduled_product_listings/update",
    # ── segments ───────────────────────────────────────────────────────
    "segments/create",
    "segments/delete",
    "segments/update",
    # ── selling_plan_groups ────────────────────────────────────────────
    "selling_plan_groups/create",
    "selling_plan_groups/delete",
    "selling_plan_groups/update",
    # ── shipping_addresses ─────────────────────────────────────────────
    "shipping_addresses/create",
    "shipping_addresses/update",
    # ── shop ───────────────────────────────────────────────────────────
    "shop/update",
    # ── subscription_billing_attempts ──────────────────────────────────
    "subscription_billing_attempts/challenged",
    "subscription_billing_attempts/failure",
    "subscription_billing_attempts/success",
    # ── subscription_billing_cycle_edits ───────────────────────────────
    "subscription_billing_cycle_edits/create",
    "subscription_billing_cycle_edits/delete",
    "subscription_billing_cycle_edits/update",
    # ── subscription_billing_cycles ────────────────────────────────────
    "subscription_billing_cycles/skip",
    "subscription_billing_cycles/unskip",
    # ── subscription_contracts ─────────────────────────────────────────
    "subscription_contracts/activate",
    "subscription_contracts/cancel",
    "subscription_contracts/create",
    "subscription_contracts/expire",
    "subscription_contracts/fail",
    "subscription_contracts/pause",
    "subscription_contracts/update",
    # ── tax_summaries ──────────────────────────────────────────────────
    "tax_summaries/create",
    # ── tender_transactions ────────────────────────────────────────────
    "tender_transactions/create",
    # ── themes ─────────────────────────────────────────────────────────
    "themes/create",
    "themes/delete",
    "themes/publish",
    "themes/update",
    # ── variants ───────────────────────────────────────────────────────
    "variants/in_stock",
    "variants/out_of_stock",
})


# ── Architect view ─────────────────────────────────────────────────────────────
#
# Architect picks from WEBHOOK_TOPICS, so the list is rendered into the prompt
# below. Embedded inline (no blank line breaks) so the architect_agent's
# `ARCHITECT.split("\n\n", 1)` still cleanly separates the webhookTopics rule
# from the webhookContract rule.

def _render_topic_list() -> str:
    # Group by resource prefix for compactness — the model parses the bracket
    # form unambiguously, and this trims the list to ~40 lines vs. ~200.
    from collections import defaultdict

    grouped: dict[str, list[str]] = defaultdict(list)
    for t in WEBHOOK_TOPICS:
        prefix, _, action = t.partition("/")
        grouped[prefix].append(action)

    lines: list[str] = []
    for prefix in sorted(grouped):
        actions = sorted(grouped[prefix])
        if len(actions) == 1:
            lines.append(f"    {prefix}/{actions[0]}")
        else:
            lines.append(f"    {prefix}/{{{','.join(actions)}}}")
    return "\n".join(lines)


# architect_agent.py splits ARCHITECT on this marker: everything before goes
# under shopifyPlan (field rules), everything after goes under CONTRACTS.
ARCHITECT_SPLIT = "##MASTER-SPLINTER##"

ARCHITECT = (
    "webhookTopics: Subscribe only to topics whose payload fields are actively consumed.\n"
    "  Do NOT subscribe \"just in case\" — unused subscriptions waste quota.\n"
    "  Format MUST be lowercase REST format \"resource/action\" (e.g. \"orders/paid\",\n"
    "  \"inventory_levels/update\"). Do NOT use GraphQL enum format (SCREAMING_SNAKE_CASE).\n"
    f"  Pick from this list ONLY (Shopify Admin API {WEBHOOK_API_VERSION}; topics outside\n"
    "  this set fail validation — `{a,b,c}` is shorthand for `prefix/a`, `prefix/b`,\n"
    "  `prefix/c`):\n"
    f"{_render_topic_list()}"
    + ARCHITECT_SPLIT
    + "\nwebhookContract: Required when webhookTopics is non-empty. Declares what the handler\n"
    "  must have ready before writing to the DB.\n"
    "  - payloadFields: specific top-level fields from the Shopify webhook payload\n"
    "    (arriving as the `payload` argument to the topic handler in\n"
    "    src/routes/webhook-handlers.ts) that the handler reads. List ONLY fields the\n"
    "    handler actually uses — every field listed must appear in handlerMustProduce.\n"
    "    Do not list fields that are read but then discarded.\n"
    "  - handlerMustProduce: a plain English statement of what data the handler must\n"
    "    resolve before executing DB writes. Every field named in payloadFields must\n"
    "    be referenced here. State WHAT is needed — do NOT specify HOW to fetch\n"
    "    it from Shopify. The Handler agent decides the implementation."
)

# ── Handler view ───────────────────────────────────────────────────────────────

HANDLER = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WEBHOOK HANDLERS — src/routes/webhook-handlers.ts

The template owns the webhook router (idempotency gate, dispatch, response
writes). You author ONLY the handlers data file.

File skeleton (emit via ===FILE: ... === markers):

  import type { Request } from "express";
  import type { WebhookHandler } from "./webhook-handlers.js";
  import { sql } from "../lib/db.js";

  // Import whatever else your handlers need (platform, shopify, etc.)

  export const webhookHandlers: Record<string, WebhookHandler> = {
    "<topic_1>": async (payload, req) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      // ... topic-specific business logic
    },
    "<topic_2>": async (payload, req) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      // ... topic-specific business logic
    },
  };

RULES:
  - Topic keys must match the architect's webhookTopics exactly — same
    strings, no additions, no omissions.
  - Each handler is `(payload: unknown, req: Request) => Promise<void>`.
    The template router handles envelope parsing, idempotency, and all
    res.json() calls — never write to `res` inside a handler.
  - Handlers throw to signal failure (the router maps throws → 500).
    Never swallow errors that should surface as retries.

%TEMPLATE_TABLES_HANDLER%
""".replace("%TEMPLATE_TABLES_HANDLER%", _TEMPLATE_TABLES_HANDLER)
