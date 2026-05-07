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

Refresh procedure: re-run
  python platform-ai/catalogs/scripts/refresh_shopify_webhook_catalog.py <version>
which pulls per-topic JSON Schemas + descriptions from gadget-inc/shopify-
webhook-schemas. WEBHOOK_TOPICS below is then derived from the catalog minus
the platform-owned exclusion list, so the picker never sees topics whose
handling lives in platform-back rather than generated app code.
"""

from catalogs.shopify_webhooks import (
    LATEST_WEBHOOK_API_VERSION,
    load_topic_names,
)
from subagents.prompts.topics.template_tables import HANDLER as _TEMPLATE_TABLES_HANDLER

# ── Canonical topic set ────────────────────────────────────────────────────────
#
# REST-valid Shopify webhook topics that generated handlers may subscribe to.
# The catalog (sourced from Shopify docs via gadget-inc/shopify-webhook-schemas)
# carries every topic + payload schema; we filter out platform/admin-owned
# topics here so the picker only sees what generated code is allowed to handle.
#
# Each entry in `_PLATFORM_OWNED_EXCLUSIONS` has a one-line reason — keep that
# discipline when adding new exclusions so a future reader can audit the policy.

WEBHOOK_API_VERSION: str = LATEST_WEBHOOK_API_VERSION

_PLATFORM_OWNED_EXCLUSIONS: frozenset[str] = frozenset(
    {
        # App lifecycle / billing — platform-back owns these.
        "app/uninstalled",
        "app/scopes_update",
        "app_purchases_one_time/update",
        "app_subscriptions/update",
        "app_subscriptions/approaching_capped_amount",
        # Mandatory GDPR — platform-back owns per Shopify policy.
        "customers/data_request",
        "customers/redact",
        "shop/redact",
        # Store-admin configuration — no generated-handler use case.
        "customer_account_settings/update",
        "checkout_and_accounts_configurations/update",
        "delivery_promise_settings/update",
        "locales/create",
        "locales/destroy",
        "locales/update",
        "domains/create",
        "domains/destroy",
        "domains/update",
        # Shopify Capital / financial-services internals.
        "finance_app_staff_member/grant",
        "finance_app_staff_member/revoke",
        "finance_app_staff_member/update",
        "finance_app_staff_member/delete",
        "finance_kyc_information/update",
        # Tax-service integrations — third-party tax-app surface only.
        "tax_partners/update",
        "tax_services/create",
        "tax_services/update",
        # Async patterns the generator does not teach.
        "bulk_operations/finish",
        "audit_events/admin_api_activity",
    }
)

WEBHOOK_TOPICS: frozenset[str] = (
    load_topic_names(WEBHOOK_API_VERSION) - _PLATFORM_OWNED_EXCLUSIONS
)


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
    '  Do NOT subscribe "just in case" — unused subscriptions waste quota.\n'
    '  Format MUST be lowercase REST format "resource/action" (e.g. "orders/paid",\n'
    '  "inventory_levels/update"). Do NOT use GraphQL enum format (SCREAMING_SNAKE_CASE).\n'
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
