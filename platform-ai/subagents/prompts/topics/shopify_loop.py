"""
Single source of truth for the Shopify bulk-prefetch rule.

Two views — one per consumer, imported directly:

  ARCHITECT  — architect prompt: when to set cronBatching.required and what it means.
  HANDLER    — handler prompt: full implementation guide with code patterns.

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

Shopify GraphQL uses a cost-based rate limit (50 pts/sec, 1000 pt bucket).
Per-item Shopify calls inside a loop exhaust the budget quickly and cause
throttle errors at any meaningful scale — fan them out in advance. The
platform helpers handle backoff/retry on throttle internally; you do not
need to check cost fields or sleep after Shopify calls — just avoid
making per-item calls to begin with.

── Rule 1: Bulk-prefetch reads BEFORE the loop ───────────────────────────────
Pre-fetch every piece of Shopify data the loop needs in a handful of
batched GraphQL queries, then loop over results with zero Shopify calls
in the body. Works for ANY resource (orders, products, variants, customers,
inventory, fulfillments, metafields, etc.).

  ✅ GENERIC PATTERN — moderate data sets (up to a few thousand items):
     Use shopify.graphqlPaginate — the platform helper manages cursors;
     you supply the query and the connectionPath.

     // 1. Bulk-fetch all required Shopify data before the loop
     const dataMap = new Map<string, unknown>();  // key = GID string
     for await (const nodes of shopify.graphqlPaginate(
       `query Fetch<Type>s($cursor: String) {
          <connectionField>(first: 250, after: $cursor, query: "<filter>") {
            pageInfo { hasNextPage endCursor }
            edges { node { id <field_1> <field_2> } }
          }
        }`,
       {},
       "<connectionField>",
     )) {
       for (const item of nodes as Array<{ id: string }>) {
         dataMap.set(item.id, item);
       }
     }

     // 2. Loop body — map lookup only; ZERO Shopify calls
     for (const row of rows) {
       const item = dataMap.get(`gid://shopify/<Type>/${row.<shopify_id_col>}`);
       if (!item) continue;  // skip rows Shopify did not return
       /* DB writes, local decisions, email sends */
     }

  ✅ VERY LARGE data sets (100k+ rows) or cost-prohibitive list reads:
     Use shopify.bulkQuery instead — same async-iterator shape, but it kicks off
     a Shopify bulk operation and streams JSONL. See the shopify_graphql
     capability docs for the call form.

  ❌ for (const row of rows) { await shopify.graphql(...) }   // N sequential calls
  ❌ Hand-rolled `do { cursor } while(cursor)` over shopify.graphql — use graphqlPaginate.

── Rule 2: Map key normalization ─────────────────────────────────────────────
GraphQL returns GID strings; postgres.js returns BIGINT columns as
strings. ALWAYS build map keys consistently — either convert numeric IDs
to GIDs on both sides, or use String() on both sides if comparing raw IDs:
  ✅ dataMap.set(item.id, item);                              // GID → Map
     dataMap.get(`gid://shopify/<Type>/${row.<shopify_id_col>}`);  // DB row → Map lookup
  ❌ Mixing raw numeric + GID string keys → silent misses at runtime.

── Rule 3: Required IDs must live in the DB ──────────────────────────────────
Whatever ID you use to look up Shopify data (<shopify_id_col>) MUST be
stored on the DB row. SELECT it alongside the primary entity ID; don't
try to resolve it from Shopify inside the loop.

── Rule 4: Per-item WRITES — prefer batch mutations ──────────────────────────
Some resources have no batch mutation (per-order tag updates, per-entity
metafield writes). Prefer a batch mutation whenever one exists
(e.g. `metafieldsSet` accepts an array). Fall back to per-item mutations
ONLY when the architect plan has declared this as a platformGaps entry.

  ✅ Batch when available:
     await shopify.graphql(
       `mutation Set($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { message } }
        }`,
       { metafields: rows.map(r => ({ ownerId: r.gid, namespace: "...", key: "...", value: r.value, type: "..." })) },
     );

  ✅ Per-item fallback when no batch API exists:
     for (const row of rows) {
       await shopify.graphql(
         `mutation TagsAdd($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { userErrors { message } }
          }`,
         { id: `gid://shopify/<Type>/${row.id}`, tags: [<tag_1>] },
       );
     }

  Do NOT add manual sleeps / `setTimeout` between Shopify calls — the
  platform helper handles throttle-aware backoff internally. Calls that
  hit Shopify's cost-based rate limiter are retried transparently; you
  just issue the call.
"""
