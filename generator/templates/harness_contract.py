"""
Harness contract sections — injected selectively into the handler sub-agent prompt.

HARNESS_BASE carries the always-shipped CORE: DB / trigger routing / logger /
output format / absolute rules / cross-cutting Shopify loop rule. It does NOT
include per-API docs anymore — those live in the capability registries
(templates/capabilities/handler.py) and are injected only when the architect
declared the corresponding entry in handlerCapabilities.

Capability-gated sections (injected by handler_agent.py via the handler JIT):
  - Handler platform services (ctx.shopify, ctx.services.email, etc.) and npm
    packages (pdfkit, exceljs, csv, …) — pulled from handler.HANDLER_CAPABILITY_REGISTRY
  - Cross-cutting REST-vs-GraphQL decision guide — injected only when BOTH
    shopify_rest and shopify_graphql are declared (handler.SHOPIFY_REST_VS_GRAPHQL_GUIDE)

Trigger-gated sections (still defined below — injected when the plan requires them):
  HARNESS_SECTION_WEBHOOK       — when webhookTopics is non-empty
  HARNESS_SECTION_STATE_MACHINE — when appContracts.stateMachine is non-null
  HARNESS_SECTION_CRON_BATCHING — when appContracts.cronBatching.required is true
  HARNESS_SECTION_WIDGET        — when the handler serves widget routes
  HARNESS_SECTION_WIDGET_STOREFRONT — when the widget reads storefront directly
  HARNESS_SECTION_ADMIN         — when the handler serves admin-panel routes

Keeping the system prompt focused prevents irrelevant rules from competing for
attention with the patterns that actually apply to the feature being generated.
"""

HARNESS_BASE = """
HARNESS CONTRACT — core APIs available inside handler():
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The always-available surface is below. Additional APIs (ctx.shopify.*,
ctx.services.*, ctx.http, ctx.storefront, npm packages) are injected further
down in this prompt based on the capabilities the architect declared in
handlerCapabilities. If an API is not documented anywhere in this prompt,
the architect did not declare it — do NOT call it.

ctx.db  — postgres.js tagged template (RLS-scoped to this tenant)
  Example: const rows = await ctx.db`SELECT * FROM my_table WHERE id = ${someId}`
  Example: await ctx.db`INSERT INTO my_table (col, tenant_id) VALUES (${value}, ${ctx.tenantId})`
  ID passing: postgres.js handles JS numbers (from Shopify payloads) and strings (from prior DB
  reads of BIGINT columns) correctly. NEVER wrap IDs in String() when passing to ctx.db — pass directly:
    ✅ WHERE variant_id = ${variant_id}        // number or string — postgres.js handles both
    ❌ WHERE variant_id = ${String(variant_id)} // unnecessary cast, adds confusion
  Map key normalization: when using IDs as JavaScript Map/object keys, always normalize with
  String() on both sides — Shopify API returns numeric IDs, postgres.js returns strings for BIGINT:
    ✅ dataMap.set(String(item.id), item)       // Shopify → Map
    ✅ dataMap.get(String(row.entity_id))       // DB row → Map lookup

ctx.tenantId — UUID string of the current tenant
  MUST be included as the tenant_id column value in every INSERT statement.

ctx.trigger — how the handler was invoked: 'webhook' | 'cron' | 'widget' | 'admin'
  Use ctx.trigger to branch between code paths. NEVER inspect ctx.payload to infer trigger type.
  Example:
    if (ctx.trigger === 'widget') {
      // handle storefront request via ctx.widgetPath / ctx.widgetBody
    } else if (ctx.trigger === 'admin') {
      // handle Shopify Admin panel request via ctx.adminPath / ctx.adminBody
    } else if (ctx.trigger === 'cron') {
      // handle periodic job
    } else {
      // handle Shopify webhook via ctx.payload
    }

ctx.widgetPath — path segment from the storefront request (e.g. '/signup'). Set only when ctx.trigger === 'widget'.
ctx.widgetBody — parsed request body from the storefront widget. Set only when ctx.trigger === 'widget'.
ctx.adminPath  — path segment from the Admin UI panel (e.g. '/subscribers'). Set only when ctx.trigger === 'admin'.
ctx.adminBody  — parsed request body from the Admin UI panel. Set only when ctx.trigger === 'admin'.

ctx.payload — the parsed Shopify webhook body (object). For cron jobs this is {}.
  Example: const orderId = ctx.payload.id

ctx.logger.info(msg: string | {key: val}, msg?: string)
ctx.logger.warn(msg)
ctx.logger.error(msg)
  Example: ctx.logger.info({ orderId: 123 }, 'Processing order')

ctx.shop — Shopify store info
  ctx.shop.domain  — the store's myshopify.com domain, e.g. "example.myshopify.com"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED OUTPUT FORMAT — exactly this CommonJS module shape:

module.exports = {
  webhookTopics: ['orders/create'],  // array of strings, empty [] for cron-only
  cronSchedule: null,                // cron string e.g. '0 9 * * *' or null
  npmPackages: [],                   // npm packages to install, e.g. ['qrcode@1.5.3', 'jsbarcode@3.11.6', '@xmldom/xmldom@0.8.10']
  handler: async function(ctx) {
    // implementation
  }
};
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ABSOLUTE RULES (violations will cause deployment failure):
1.  Output ONLY the JavaScript code — no markdown fences, no explanation
2.  Use module.exports = { webhookTopics, cronSchedule, npmPackages, handler } — exactly this shape
3.  handler MUST be an async function taking a single argument named ctx
4.  require() is ONLY allowed for packages declared in npmPackages.
    NEVER require() a package that is not in your npmPackages array — it will not be installed.
    Built-in Node.js modules (path, crypto, etc.) do NOT need to be declared.
    ES module import() is NOT allowed — use CommonJS require() only.
5.  NO eval(), Function(), setInterval(), setImmediate()
    setTimeout is allowed ONLY for short rate-limit delays between API calls (≤500ms).
    Example: await new Promise(r => setTimeout(r, 200))  // 200ms pause between loop iterations
6.  NO process.exit(), process.kill(), or process.env access
7.  Handle errors with try/catch — never let the handler throw uncaught exceptions
8.  ctx.shopify.get/post paths MUST be relative (e.g. '/orders.json') — NEVER full URLs
9.  https:// URLs are ONLY allowed as the first argument to ctx.http.call(url, ...).
    NEVER use https:// anywhere else — not in ctx.services.email templateId, not in comments, not in other strings.
    templateId is a short opaque string like 'd-abc123', never a URL.
    For all Shopify API calls use ctx.shopify.get/post/graphql with relative paths.
10. webhookTopics must exactly match what is listed in the plan
11. For Shopify REST PUT endpoints (update), use ctx.shopify.post() — not a separate PUT method
12. Every INSERT into a tenant table must include tenant_id: use ctx.tenantId
13. Never silently ignore errors from ctx.db — propagate or return early on failure
14. For ctx.shopify.graphql, IDs MUST use GID format: `gid://shopify/TypeName/${numericId}`
    NEVER pass raw numeric IDs as GraphQL ID variables.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LOGGING — use ctx.logger at key decision points:
- On trigger entry: log { trigger: ctx.trigger } and relevant payload IDs
- On early exit: log the reason (e.g. "no transition detected", "first observation — baseline set")
- On state transition detected: log prevState and newState
- On claimed rows: log how many rows were claimed
Do NOT log email sending.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHOPIFY API LOOP RULE — applies to every handler path:

NEVER call ctx.shopify inside a per-item loop. Pre-fetch all Shopify data into a
lookup map before any loop. Loop bodies contain only map lookups, DB reads/writes,
and local logic — zero Shopify calls inside loops.
  ✅ Pre-fetch → build map → loop reads map
  ❌ for (const item of items) { await ctx.shopify.get(...) }
"""

# ── Compact API surface ───────────────────────────────────────────────────────
#
# Used by the revision agent: revisions see the prior handler code (which already
# embodies the full patterns from HARNESS_BASE), so the model only needs a crisp
# reminder of what APIs are available and the handful of rules that matter most
# when editing code. Shipping all of HARNESS_BASE to the revision agent wastes
# tokens without improving output quality.

HARNESS_API_SURFACE = """
HARNESS API SURFACE — the only APIs available inside handler():
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Shopify:
  ctx.shopify.get(path) / ctx.shopify.post(path, body) / ctx.shopify.delete(path)
    — REST at /admin/api/2026-01. Path is relative.
  ctx.shopify.graphql(query, variables?)
    — Admin GraphQL. IDs use GID format: `gid://shopify/TypeName/${numericId}`.
  ctx.storefront.graphql(query, variables?)
    — public Storefront API (server-side).

Database (postgres.js tagged template, RLS-scoped to ctx.tenantId):
  await ctx.db`SELECT ... WHERE tenant_id = ${ctx.tenantId} AND ...`
  Always pass ctx.tenantId in every INSERT; never String()-wrap IDs.

Trigger routing:
  ctx.trigger           — 'webhook' | 'cron' | 'widget' | 'admin'
  ctx.payload           — Shopify webhook body (object)
  ctx.widgetPath / ctx.widgetBody   — when trigger === 'widget'
  ctx.adminPath  / ctx.adminBody    — when trigger === 'admin'
  ctx.shop.domain       — myshopify.com domain
  ctx.logger.info / warn / error

Services (available on every ctx):
  ctx.services.email.send({ to, data? })    — merchant-configured template
  ctx.services.sms.send({ to, body })
  ctx.services.files.upload(name, content, mimeType?) → signed URL
  ctx.http.call(url, options?)              — https:// to third parties

Required module shape (CommonJS):
  module.exports = {
    webhookTopics: [...], cronSchedule: null | '...',
    npmPackages: [...], handler: async function(ctx) { ... }
  }

Core rules:
  - No fetch(), eval(), Function, setInterval, setImmediate, process.env.
    setTimeout allowed only for small rate-limit pauses (≤500 ms).
  - require() only packages declared in npmPackages (+ Node built-ins).
  - Every INSERT into a tenant table must include tenant_id: ctx.tenantId.
  - Widget/admin routes: route on ctx.widgetPath / ctx.adminPath, return JSON.
  - GraphQL IDs MUST be GID-formatted — never raw numeric.
"""


# ── Conditional sections ───────────────────────────────────────────────────────

HARNESS_SECTION_WEBHOOK = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WEBHOOK PATTERNS — this handler subscribes to at-least-once delivery webhooks:

Rule: INSERT operations triggered by a webhook must guard against replay:
  ✅ await ctx.db`INSERT INTO t (...) VALUES (...) ON CONFLICT (tenant_id, key) DO NOTHING`
  ❌ Plain INSERT — fails or duplicates on webhook replay

Rule: When performing a side effect (notification, tag update, log emission) based on DB
state, atomically claim the work with RETURNING — THEN act on the returned rows.
NEVER emit first and mark after; a crash between those two steps causes double-execution.
  ✅ const claimed = await ctx.db`
       UPDATE my_table SET notified_at = NOW()
       WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${ids}) AND notified_at IS NULL
       RETURNING id, customer_email, customer_first_name
     `
     if (claimed.length === 0) return  // already processed — do not proceed
     for (const row of claimed) { /* emit/log side effect using row data */ }
  ❌ fetch rows → emit side effects → mark as done   (crash window between emit and mark)
  ❌ UPDATE without RETURNING + length check          (allows double-execution on replay)

Rule: Every SELECT in the webhook path MUST be scoped to ctx.tenantId AND to the specific
  entity from the payload. Never query all pending rows across all tenants or all entities.
  ✅ WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variantId}
  ❌ WHERE notified_at IS NULL  // missing tenant_id scope — cross-tenant data leak

Rule: When the webhook handler must enrich data for multiple items found in the DB
(e.g. fetching product details to compose notification emails after a state transition),
apply the same pre-fetch discipline as the cron path — batch ALL Shopify calls before
any loop, never per-item:
  ✅ // 1. Query DB for pending items — include all IDs needed for batch lookup
     const pending = await ctx.db`SELECT DISTINCT variant_id, product_id FROM ... WHERE ...`
     // 2. Collect distinct Shopify entity IDs
     const productIds = [...new Set(pending.map(r => String(r.product_id)))]
     // 3. Batch-fetch Shopify data (max 250 per call for products)
     const infoMap = {}
     for (let i = 0; i < productIds.length; i += 250) {
       const chunk = productIds.slice(i, i + 250)
       const { products } = await ctx.shopify.get(
         `/products.json?ids=${chunk.join(',')}&fields=id,title,handle,variants`
       )
       for (const p of products)
         for (const v of p.variants)
           infoMap[String(v.id)] = { variantTitle: v.title, productTitle: p.title, productHandle: p.handle }
     }
     // 4. Process loop — zero Shopify calls
     for (const row of pending) {
       const info = infoMap[String(row.variant_id)]
       if (!info) continue
       // claim rows and send notifications using info
     }
  ❌ for (const id of ids) { await ctx.shopify.get(`/variants/${id}.json`) }  // N sequential calls
  NOTE: All foreign-key IDs needed for batch lookup (e.g. product_id) MUST be stored
  in the DB table — SELECT them alongside the primary entity ID.
"""

HARNESS_SECTION_STATE_MACHINE = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATE TRANSITION PATTERNS — this handler detects state changes across events:

Rule: null means "never observed" — it is NOT a real state value. Never fire the
transition action when prevState is null:
  ✅ const isTransition = prevState !== null && prevState === FROM && current === TO
  ❌ const isTransition = prevState === FROM && current === TO  // fires on null→TO too

Rule: In the cron path, atomically claim the transition with RETURNING and check row
count before acting — the webhook path may have already processed the same transition:
  ✅ const claimed = await ctx.db`
       UPDATE state_table
       SET state_col = ${newVal}, updated_at = NOW()
       WHERE tenant_id = ${ctx.tenantId} AND entity_id = ${id} AND state_col = ${prevVal}
       RETURNING id
     `
     if (claimed.length === 0) continue  // webhook already handled this — skip
  ❌ UPDATE without RETURNING + length check — cron and webhook paths double-fire
"""

HARNESS_SECTION_CRON_BATCHING = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRON RATE LIMIT SAFETY — this handler iterates over a set of items and touches Shopify:

Shopify rate limit: ~2 req/s on Basic, ~4 req/s on Advanced. Per-item Shopify calls
inside a loop cause throttle errors at any meaningful scale — fan them out in advance.

── Rule 1: Bulk-prefetch reads BEFORE the loop ───────────────────────────────
Pre-fetch every piece of Shopify data the loop needs in a handful of batched calls,
then loop over the results with zero Shopify calls in the body. Works for ANY resource
(orders, products, variants, customers, inventory, fulfillments, metafields, etc.).

  ✅ GENERIC PATTERN — replace <resource>/<field> with the Shopify resource you need:
     // 1. Collect distinct Shopify IDs the loop will need (from DB or another source)
     const ids = [...new Set(rows.map(r => r.<shopify_id_field>))]

     // 2. Batch-fetch in chunks (Shopify's typical cap is 250 per call)
     const BATCH = 250
     const dataMap = new Map()  // key = String(shopify_id) → value = the entity
     for (let i = 0; i < ids.length; i += BATCH) {
       const chunk = ids.slice(i, i + BATCH)
       const resp = await ctx.shopify.get(
         `/<resource>.json?ids=${chunk.join(',')}&fields=id,<other_fields>`
       )
       for (const item of (resp.<resource> || [])) {
         dataMap.set(String(item.id), item)
       }
     }

     // 3. Loop body — pure local logic + DB writes, ZERO Shopify calls
     for (const row of rows) {
       const item = dataMap.get(String(row.<shopify_id_field>))
       if (!item) continue
       // DB writes, local decisions, email sends, etc.
     }

  ❌ for (const row of rows) { await ctx.shopify.get(...) }   // N sequential calls

── Rule 2: Map key normalization ─────────────────────────────────────────────
Shopify API returns numeric IDs; postgres.js returns BIGINT columns as strings.
ALWAYS wrap both sides of Map.set/Map.get with String() so lookups match:
  ✅ dataMap.set(String(item.id), item)          // Shopify → Map
     dataMap.get(String(row.shopify_entity_id))  // DB row → Map lookup
  ❌ Mixing numeric + string keys → silent misses at runtime.

── Rule 3: Required IDs must live in the DB ──────────────────────────────────
Whatever ID you use to look up Shopify data (product_id, inventory_item_id,
customer_id, order_id, …) MUST be stored on the DB row. SELECT it alongside
the primary entity ID; don't try to resolve it from Shopify inside the loop.

── Rule 4: Per-item WRITES — unavoidable, so throttle them ───────────────────
Some resources have no batch write API (e.g. tag updates, metafield writes on
per-entity basis, image replacement). When the loop must issue a per-item
Shopify write, add a small pause between iterations to stay under the rate limit:

  ✅ for (const row of rows) {
       await ctx.shopify.post(`/<resource>/${row.id}.json`, { ... })
       await new Promise(r => setTimeout(r, 200))   // 200 ms ≈ 5 req/s ceiling
     }
  ❌ Tight write loop with no delay → 429 throttle errors at scale.

  When per-item writes are unavoidable, the architect plan records this as a
  platformGaps entry — mention the reason in your implementation comment.

── Rule 5: Resource-specific notes ───────────────────────────────────────────
  • Variants: there is NO batch variant-by-IDs endpoint. Batch via
    /products.json?ids=... and extract variants from each product — one call
    returns up to 250 products and all their variants.
  • Inventory level: /products.json#inventory_quantity is STALE for multi-location
    stores. For accurate stock use /inventory_levels.json?inventory_item_ids=...
    (max 50 per call) and sum `available` across locations per inventory_item_id.
  • Customers/Orders: support /customers.json?ids=... and /orders.json?ids=...
    with limit=250 and since_id for full-catalog scans.
"""

HARNESS_SECTION_WIDGET = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WIDGET ROUTING — this handler receives storefront requests from the widget:

When ctx.trigger === 'widget', the storefront called host.call(path, body).
  ctx.widgetPath — the path the widget called (e.g. '/signup', '/status')
  ctx.widgetBody — the body the widget sent (object)

Rule: Route on ctx.widgetPath inside the widget branch. Always return a value.
  ✅ if (ctx.trigger === 'widget') {
       if (ctx.widgetPath === '/signup') {
         const { customerEmail, variantId, productId } = ctx.widgetBody
         await ctx.db`INSERT INTO ... ON CONFLICT DO NOTHING`
         return { ok: true }
       }
       if (ctx.widgetPath === '/status') {
         const [row] = await ctx.db`SELECT ... WHERE tenant_id = ${ctx.tenantId} AND ...`
         return { status: row ? row.status : 'not_signed_up' }
       }
       return { error: 'unknown path' }
     }
  ❌ if (!ctx.payload || Object.keys(ctx.payload).length === 0) { ... }
     // NEVER use payload emptiness to detect cron or widget — use ctx.trigger

Rule: Use the exact field names from widgetApiCatalog requestShape — the Architect defines
  the contract and both the widget and handler are generated from it. Do not rename fields.

Rule: The widget can only send what host.context provides (variantId, productId, customerId)
  plus user input. IDs not in host.context must be resolved server-side:
  ✅ const { variant } = await ctx.shopify.get(`/variants/${variantId}.json`)
     const inventoryItemId = variant.inventory_item_id

Rule: Widget paths must match the platformApiCatalog exactly.
  The catalog lists every path the widget may call. Do not handle paths not in the catalog.
  Do not invent paths — only handle paths listed in the catalog provided.

Rule: Widget responses are returned directly to the storefront — keep them small and JSON-safe.
  CRITICAL: Return EXACTLY the responseShape from the widget API catalog — never rename fields.
  The widget generator sees the same catalog and checks the exact field names listed there.
  Never return raw DB rows or internal state.
"""

HARNESS_SECTION_ADMIN = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ADMIN UI ROUTING — this handler receives requests from the Shopify Admin panel:
  Applies to: storefront_backend_admin and backend_admin archetypes.

When ctx.trigger === 'admin', the embedded Admin UI panel called bridge.call(path, body).
  ctx.adminPath — the path the panel called (e.g. '/list', '/run', '/config/save')
  ctx.adminBody — the body the panel sent (object, or {} for body-less calls)

CRITICAL RULE: Every path listed in the adminApiCatalog MUST have a corresponding
  `ctx.adminPath === '<path>'` branch inside the `ctx.trigger === 'admin'` block.
  Missing even one path is a validation error. The catalog is the contract — implement all of it.

CRITICAL RULE: ALWAYS use ctx.adminPath and ctx.adminBody — NEVER ctx.widgetPath or ctx.widgetBody
  inside the `ctx.trigger === 'admin'` branch. Those are for widget triggers only.

Rule: Log on every admin invocation entry so routing decisions appear in logs:
  ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke')

Rule: Route on ctx.adminPath inside the admin branch. Always return a value.
  ✅ if (ctx.trigger === 'admin') {
       ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke')
       if (ctx.adminPath === '/list') {
         const rows = await ctx.db`SELECT ... WHERE tenant_id = ${ctx.tenantId} LIMIT 50`
         return { total: rows.length, rows }
       }
       if (ctx.adminPath === '/run') {
         // perform the action
         return { processed: N }
       }
       ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path')
       return { error: 'unknown path' }
     }

Rule: Always scope DB reads in admin paths to ctx.tenantId.
Rule: For write operations (trigger, config save), log the action with ctx.logger.info.
Rule: Return the EXACT responseShape from the adminApiCatalog — never rename fields.
"""

HARNESS_SECTION_WIDGET_STOREFRONT = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WIDGET STOREFRONT READS — widget fetches Shopify public data directly:

The widget uses host.storefront(relativePath) to read public Shopify storefront data
without involving the backend handler. The handler is NOT called for these reads.

  host.storefront(relativePath) → Promise<any>
  Fetches public Shopify storefront endpoints (same-origin, no auth required).
  Common paths:
    '/products/${handle}.js'           → full product JSON including variants[].available
    '/collections/${handle}.js'        → collection with products
    '/cart.js'                         → current cart state

When ctx.trigger === 'widget', the handler only handles host.call() paths from the
widgetApiCatalog. It does NOT handle host.storefront() requests — those go directly
to Shopify. Do not add handler code to proxy storefront data.
"""
