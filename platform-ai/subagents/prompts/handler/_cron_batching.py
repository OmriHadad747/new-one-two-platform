"""
Batched Shopify iteration patterns.

Injected by handler_agent.py's JIT when ``appContracts.cronBatching.required``
is true — i.e. when the architect has flagged that some route or cron job
in this handler will iterate over a non-trivial set of items and enrich
them with Shopify data. The same rate-limit discipline applies whether
the loop runs in a cron job, a large webhook handler, or an admin route;
this section documents it once.

Forces bulk-prefetch (zero Shopify calls inside the per-item loop),
map-keyed lookups with String() normalization on both sides, and bounded
setTimeout pauses (≤500ms numeric literal) between unavoidable per-item
writes. Other setTimeout shapes are rejected by static validation.
"""

HARNESS_SECTION_CRON_BATCHING = """
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

── Rule 5: Resource-specific notes ───────────────────────────────────────────
  • Variants: there is NO batch variant-by-IDs endpoint. Batch via
    /products.json?ids=... and extract variants from each product — one
    call returns up to 250 products and all their variants.
  • Inventory level: /products.json#inventory_quantity is STALE for
    multi-location stores. For accurate stock use
    /inventory_levels.json?inventory_item_ids=... (max 50 per call) and
    sum `available` across locations per inventory_item_id.
  • Customers/Orders: support /customers.json?ids=... and
    /orders.json?ids=... with limit=250 and since_id for full-catalog
    scans.
"""
