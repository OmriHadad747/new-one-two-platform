"""
Webhook-path handler patterns.

Injected by handler_agent.py's JIT into the USER prompt when
``shopifyPlan.webhookTopics`` is non-empty. Covers the /webhook/:topic
dispatch shape, the template-owned idempotency gate, atomic side-effect
claiming with RETURNING, and the bulk-prefetch discipline for webhooks
that enrich multiple records.

Cron is NOT handled here — scheduled work runs through the handler's
cron-runner (see prompts/handler/_cron.py) via a queue table, not HTTP.
"""

HARNESS_SECTION_WEBHOOK = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WEBHOOK ROUTER — src/routes/webhook.ts

File skeleton (emit via the ===FILE: ... === markers; this is the shape,
fill in the topic dispatch for the topics the architect declared):

  import { Router } from "express";
  import { sql } from "../lib/db.js";

  export const webhookRouter = Router();

  interface WebhookEnvelope {
    webhook_id: string;
    topic: string;
    payload: unknown;
  }

  webhookRouter.post("/:topic", async (req, res) => {
    const { topic } = req.params;
    const env = req.body as Partial<WebhookEnvelope>;

    // ── Idempotency gate — COPY VERBATIM, always first ──────────────────────
    if (typeof env.webhook_id !== "string" || env.webhook_id.length === 0) {
      res.status(400).json({ error: "missing_webhook_id" });
      return;
    }
    const inserted = await sql<Array<{ webhook_id: string }>>`
      INSERT INTO processed_webhooks (webhook_id)
      VALUES (${env.webhook_id})
      ON CONFLICT (webhook_id) DO NOTHING
      RETURNING webhook_id
    `;
    if (inserted.length === 0) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    // ── Topic dispatch ──────────────────────────────────────────────────────
    const payload = (env.payload ?? {}) as Record<string, unknown>;
    try {
      switch (topic) {
        case "<topic_1>":
          // ... topic-specific logic
          break;
        case "<topic_2>":
          // ... topic-specific logic
          break;
        default:
          // Unknown topics still 200 — idempotency gate already ran; replay
          // is not desired.
          break;
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error(
        { requestId: req.platform!.requestId, topic, err: String(err) },
        "webhook failed",
      );
      res.status(500).json({ error: "internal_error" });
    }
  });

RULES:
  - The idempotency block is MANDATORY and must be the first code in the
    route body. The template relies on `processed_webhooks` being populated
    before any side effect runs.
  - Topic list must match the architect's webhookTopics exactly — same
    strings, no additions, no omissions. Unknown topics fall through the
    default arm and still 200 (never 404; that would trigger Shopify retries).
  - Every arm in the switch MUST either finish successfully or throw — the
    router's try/catch maps exceptions to 500. NEVER call res.json() inside
    an arm (the router sends the response after the switch).

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
