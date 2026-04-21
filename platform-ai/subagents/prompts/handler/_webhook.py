"""
Webhook-path handler patterns.

Injected by handler_agent.py's JIT into the USER prompt when
``shopifyPlan.webhookTopics`` is non-empty. Covers the webhook-handlers
data-file shape, atomic side-effect claiming with RETURNING, and the
bulk-prefetch discipline for webhooks that enrich multiple records.

Cron is NOT handled here — scheduled work runs through the handler's
cron-runner (see prompts/handler/_cron.py) via a queue table, not HTTP.
"""

HARNESS_SECTION_WEBHOOK = """
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
transition), batch ALL Shopify calls before any loop, never per-item.
See the batched-Shopify section (same rules apply here as in cron jobs):
  ✅ // 1. Query DB for pending items; include all IDs needed for batch lookup
     const pending = await sql`SELECT DISTINCT <shopify_id_col>, <other_id_col> FROM <table_1> WHERE ...`;
     // 2. Collect distinct Shopify entity IDs
     const ids = [...new Set(pending.map(r => String(r.<shopify_id_col>)))];
     // 3. Batch-fetch Shopify data (up to 250 per call for most resources)
     const infoMap = new Map();
     for (let i = 0; i < ids.length; i += 250) {
       const chunk = ids.slice(i, i + 250);
       const resp = await <shopify_client>.rest.get(
         `/<shopify_resource>.json?ids=${chunk.join(',')}&fields=<field_list>`,
       );
       for (const item of (resp.<shopify_resource> ?? [])) {
         infoMap.set(String(item.id), item);
       }
     }
     // 4. Process loop — zero Shopify calls
     for (const row of pending) {
       const info = infoMap.get(String(row.<shopify_id_col>));
       if (!info) continue;
       /* claim + act using info */
     }
  ❌ for (const row of pending) { await <shopify_client>.rest.get(`/<shopify_resource>/${row.<shopify_id_col>}.json`) }

  NOTE: All foreign-key IDs needed for batch lookup MUST live on the DB
  row — SELECT them alongside the primary ID.
"""
