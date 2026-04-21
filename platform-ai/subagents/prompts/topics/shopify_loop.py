"""
Single source of truth for the Shopify bulk-prefetch rule.

Three views — one per consumer, imported directly:

  ARCHITECT  — architect prompt: when to set cronBatching.required and what it means.
  HANDLER    — handler prompt: full implementation guide with code patterns.
  VALIDATOR  — validator Q5 prose: what to check and how to flag violations.

The rule is universal: no Shopify calls inside a per-item loop, ever. cronBatching
is the architect's way of declaring "this app has a loop that needs the full pattern".
"""

# ── Architect view ─────────────────────────────────────────────────────────────

ARCHITECT = """\
cronBatching: Required when the cron job iterates over a set of items and each item
  would otherwise trigger a Shopify API call. Declare this so the handler knows to
  pre-fetch all Shopify data in bulk before the loop begins.
  When non-null, MUST include "required": true.
  Scope: cronBatching applies to the READ phase only — bulk-fetching the Shopify data
  needed to decide what to do. Per-item Shopify WRITE calls inside the loop are acceptable
  and unavoidable when no batch write API exists for the mutation being performed.
  When per-item writes are unavoidable: add a platformGaps entry acknowledging this:
    { "gap": "No batch write API for <resource> — each item requires individual Shopify API calls",
      "mitigation": "Pre-fetch all required read data before the loop; per-item write calls inside the loop are unavoidable for this resource type" }\
"""

ARCHITECT_SHAPE = """\
cronBatching (non-null):
  { "required": true, "description": "What data is bulk-fetched before the loop and why." }\
"""

# ── Handler view ───────────────────────────────────────────────────────────────

HANDLER = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BATCHED SHOPIFY RATE LIMIT SAFETY — iterating over items that touch Shopify:

Shopify rate limit: ~2 req/s on Basic, ~4 req/s on Advanced. Per-item
Shopify calls inside a loop cause throttle errors at any meaningful scale
— fan them out in advance.

── Rule 1: Bulk-prefetch reads BEFORE the loop ───────────────────────────────
Pre-fetch every piece of Shopify data the loop needs in a handful of
batched calls, then loop over results with zero Shopify calls in the
body. Works for ANY resource (orders, products, variants, customers,
inventory, fulfillments, metafields, etc.).

  ✅ GENERIC PATTERN — substitute <shopify_resource>, <field_*> as needed:
     // 1. Collect distinct Shopify IDs the loop will need (from DB or elsewhere)
     const ids = [...new Set(rows.map(r => r.<shopify_id_col>))];

     // 2. Batch-fetch in chunks (Shopify's typical cap is 250 per call)
     const BATCH = 250;
     const dataMap = new Map();   // key = String(shopify_id) → value = entity
     for (let i = 0; i < ids.length; i += BATCH) {
       const chunk = ids.slice(i, i + BATCH);
       const resp = await <shopify_client>.rest.get(
         `/<shopify_resource>.json?ids=${chunk.join(',')}&fields=<field_list>`,
       );
       for (const item of (resp.<shopify_resource> ?? [])) {
         dataMap.set(String(item.id), item);
       }
     }

     // 3. Loop body — pure local logic + DB writes, ZERO Shopify calls
     for (const row of rows) {
       const item = dataMap.get(String(row.<shopify_id_col>));
       if (!item) continue;
       /* DB writes, local decisions, email sends, etc. */
     }

  ❌ for (const row of rows) { await <shopify_client>.rest.get(...) }   // N sequential calls

── Rule 2: Map key normalization ─────────────────────────────────────────────
Shopify API returns numeric IDs; postgres.js returns BIGINT columns as
strings. ALWAYS wrap both sides of Map.set/Map.get with String() so
lookups match:
  ✅ dataMap.set(String(item.id), item);           // Shopify → Map
     dataMap.get(String(row.<shopify_id_col>));    // DB row → Map lookup
  ❌ Mixing numeric + string keys → silent misses at runtime.

── Rule 3: Required IDs must live in the DB ──────────────────────────────────
Whatever ID you use to look up Shopify data (<shopify_id_col>) MUST be
stored on the DB row. SELECT it alongside the primary entity ID; don't
try to resolve it from Shopify inside the loop.

── Rule 4: Per-item WRITES — unavoidable, so throttle them ───────────────────
Some resources have no batch write API (tag updates per order, metafield
writes per entity, image replacement). When the loop must issue a
per-item Shopify write, add a small bounded pause between iterations to
stay under the rate limit. setTimeout is allowed for this ONLY with a
numeric-literal delay ≤500ms — static validation rejects
missing/non-literal/>500ms delays.

  ✅ for (const row of rows) {
       await <shopify_client>.rest.post(`/<shopify_resource>/${row.id}.json`, { ... });
       await new Promise(r => setTimeout(r, 200));   // 200ms ≈ 5 req/s ceiling
     }
  ❌ Tight write loop with no delay → 429 throttle errors at scale.
  ❌ Computed or >500ms delays are rejected — the 500ms cap is enforced.

  Prefer bulk APIs whenever one exists; fall back to this pattern only
  when the architect plan has declared this as a platformGaps entry.
  Mention the reason in your implementation comment.
"""

# ── Validator view ─────────────────────────────────────────────────────────────

VALIDATOR = (
    "Q5 — BATCHED SHOPIFY FETCH PATTERN (q5_cron_bulk_fetch)\n"
    "The plan declares cronBatching.required=true. When a handler path iterates over\n"
    "a non-trivial set of items and enriches each with Shopify data, it MUST bulk-\n"
    "fetch before the loop.\n"
    "Check every file in the handler bundle — the long-loop may live in\n"
    "src/routes/cron.ts (jobs.main body), src/routes/webhook-handlers.ts (a large enrichment\n"
    "path), or a helper in src/lib/*.ts:\n"
    "  a) Is all required Shopify data fetched in one or a few batched calls via\n"
    "     `shopify.rest.paginate(...)` / batched `shopify.rest.get('/<resource>.json?ids=...')`\n"
    "     / `shopify.graphqlPaginate(...)` BEFORE the main iteration loop begins?\n"
    "  b) Does the loop body avoid making any `shopify.rest.*` / `shopify.graphql(...)`\n"
    "     calls per-item?\n"
    "Set aligned=false if the handler makes per-item Shopify calls inside the loop\n"
    "instead of bulk-fetching first. Name the specific file, loop, and API call pattern."
)
