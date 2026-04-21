"""
Single source of truth for every webhook rule the agents see.

Views:
  ARCHITECT — plan rules: webhookTopics format + webhookContract shape.
  HANDLER   — implementation rules: webhook-handlers.ts shape, atomic
              side-effect claiming, scoping, prefetch discipline.
"""

# ── Architect view ─────────────────────────────────────────────────────────────

ARCHITECT = """\
webhookTopics: Subscribe only to topics whose payload fields are actively consumed.
  Do NOT subscribe "just in case" — unused subscriptions waste quota.
  Format MUST be lowercase REST format "resource/action" (e.g. "orders/paid", "inventory_levels/update").
  Do NOT use GraphQL enum format (SCREAMING_SNAKE_CASE).

webhookContract: Required when webhookTopics is non-empty. Declares what the handler
  must have ready before writing to the DB.
  - payloadFields: specific top-level fields from the Shopify webhook payload
    (arriving as the `payload` argument to the topic handler in
    src/routes/webhook-handlers.ts) that the handler reads. List ONLY fields the
    handler actually uses — every field listed must appear in handlerMustProduce.
    Do not list fields that are read but then discarded.
  - handlerMustProduce: a plain English statement of what data the handler must resolve
    before executing DB writes. Every field named in payloadFields must be referenced here.
    State WHAT is needed — do NOT specify HOW to fetch it from Shopify. The Handler agent
    decides the implementation using the API context it receives.\
"""

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
  - Do NOT import or call anything related to idempotency or
    processed_webhooks — the template router already handles that.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WEBHOOK BODY PATTERNS — atomic side effects, scoping, prefetch

Rule: INSERT operations driven by webhook payload must survive replay.
The webhook_id idempotency gate dedupes at the envelope level, but inner
business INSERTs should still be defensive in case of partial-failure
retry patterns:
  ✅ await sql`INSERT INTO <table_1> (<field_1>, <field_2>) VALUES (${v1}, ${v2}) ON CONFLICT (<unique_key>) DO NOTHING`
  ❌ Plain INSERT that duplicates on partial-failure retry.

Rule: When performing a side effect (email, tag update, external call)
based on DB state, atomically claim the work with RETURNING — THEN act on
the returned rows. NEVER emit the side effect first and mark-as-done
after; a crash between those steps double-executes.
  ✅ const claimed = await sql`
       UPDATE <table_1> SET <sent_at_col> = NOW()
       WHERE <entity_id_col> = ANY(${ids}) AND <sent_at_col> IS NULL
       RETURNING <entity_id_col>, <field_1>, <field_2>
     `;
     if (claimed.length === 0) return;   // already processed
     for (const row of claimed) {
       /* emit side effect using row data */
     }
  ❌ fetch rows → emit side effects → mark done     (double-exec window)
  ❌ UPDATE without RETURNING + length check        (allows double-exec)

Rule: Every SELECT in the webhook path MUST be scoped to the specific
entity from the payload. NEVER query every pending row globally. The
tenant boundary is enforced by search_path (the DB only sees this
tenant's schema); but inside the schema you still need to scope to the
right entity.
  ✅ WHERE <entity_id_col> = ${payload.id}
  ❌ WHERE <sent_at_col> IS NULL    // unscoped — processes every row in the tenant's table

Rule: When the webhook must enrich multiple items with Shopify data
(e.g. fetching product details for a notification email after a state
transition), apply the same bulk-prefetch discipline as cron jobs:
bulk-fetch all Shopify data before the loop, zero Shopify calls inside it.
See the BATCHED SHOPIFY RATE LIMIT SAFETY section for the full pattern
and String() key-normalization rules.
"""
