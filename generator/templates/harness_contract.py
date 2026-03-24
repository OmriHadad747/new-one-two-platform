"""
Harness contract sections — injected selectively into the handler sub-agent prompt.

HARNESS_BASE is always injected: ctx API surface, Shopify patterns, output format, core rules.

The three conditional sections are injected by handler_agent.py only when the plan requires them:
  HARNESS_SECTION_WEBHOOK       — when webhookTopics is non-empty
  HARNESS_SECTION_STATE_MACHINE — when implementationSpec.stateMachine.needsStateTracking is true
  HARNESS_SECTION_CRON_BATCHING — when implementationSpec.cronBatching.required is true

Keeping the system prompt focused prevents irrelevant rules from competing for attention
with the patterns that actually apply to the feature being generated.
"""

HARNESS_BASE = """
HARNESS CONTRACT — the only APIs available inside handler():
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ctx.shopify.get(path: string) → Promise<any>
  Shopify REST GET. Path is relative to /admin/api/2026-01
  Example: await ctx.shopify.get('/orders.json?status=any&limit=10')

ctx.shopify.post(path: string, body: object) → Promise<any>
  Shopify REST POST/PUT. Use for mutations.
  Example: await ctx.shopify.post('/customers/456.json', { customer: { id: 456, tags: 'VIP' } })
  Note: Shopify PUT endpoints also use shopify.post() — the harness always sends POST.

ctx.db  — postgres.js tagged template (RLS-scoped to this tenant)
  Example: const rows = await ctx.db`SELECT * FROM my_table WHERE id = ${someId}`
  Example: await ctx.db`INSERT INTO my_table (col, tenant_id) VALUES (${value}, ${ctx.tenantId})`
  ID passing: postgres.js handles JS numbers (from Shopify payloads) and strings (from prior DB
  reads of BIGINT columns) correctly. NEVER wrap Shopify IDs in String() — pass them directly:
    ✅ WHERE variant_id = ${variant_id}        // variant_id is a number or already a string
    ❌ WHERE variant_id = ${String(variant_id)} // unnecessary cast, adds confusion

ctx.tenantId — UUID string of the current tenant
  MUST be included as the tenant_id column value in every INSERT statement.

ctx.payload — the parsed Shopify webhook body (object). For cron jobs this is {}.
  Example: const orderId = ctx.payload.id

ctx.logger.info(msg: string | {key: val}, msg?: string)
ctx.logger.warn(msg)
ctx.logger.error(msg)
  Example: ctx.logger.info({ orderId: 123 }, 'Processing order')

ctx.email.send({ to, subject, templateId?, data? }) → Promise<void>
  Send a transactional email to a customer.
    to:         recipient email address (string)
    subject:    email subject line (string)
    templateId: optional provider template ID
    data:       optional template variables, e.g. { firstName, productTitle, price, variantTitle }
  Use this whenever the feature must notify a customer by email.
  Example: await ctx.email.send({ to: entry.customer_email, subject: 'Back in stock!', data: { productTitle, price } })

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHOPIFY API PATTERNS — use these exact approaches:

To find a variant from an inventory item ID (two-step lookup):
  ✅ const { inventory_item } = await ctx.shopify.get(`/inventory_items/${inventoryItemId}.json`)
     const variantId = inventory_item.variant_id
     const { variant } = await ctx.shopify.get(`/variants/${variantId}.json`)
  ❌ NEVER use /variants.json?inventory_item_ids=... — that filter does not exist in the Shopify API
  ❌ NEVER scan /products.json by iterating all results — paginated at 250, silently misses products

To check if a customer has a tag or attribute, fetch the customer directly:
  ✅ await ctx.shopify.get(`/customers/${customerId}.json`)
  ❌ NEVER search /customers.json with a filter and assume completeness

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED OUTPUT FORMAT — exactly this CommonJS module shape:

module.exports = {
  webhookTopics: ['orders/create'],  // array of strings, empty [] for cron-only
  cronSchedule: null,                // cron string e.g. '0 9 * * *' or null
  handler: async function(ctx) {
    // implementation
  }
};
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ABSOLUTE RULES (violations will cause deployment failure):
1.  Output ONLY the JavaScript code — no markdown fences, no explanation
2.  Use module.exports = { webhookTopics, cronSchedule, handler } — exactly this shape
3.  handler MUST be an async function taking a single argument named ctx
4.  NO require() or import() calls — all capabilities come through ctx
5.  NO eval(), Function(), setTimeout(), setInterval(), setImmediate()
6.  NO process.exit(), process.kill(), or process.env access
7.  NO global variable mutation
8.  Handle errors with try/catch — never let the handler throw uncaught exceptions
9.  All ctx.shopify paths MUST be relative (e.g. '/orders.json') — NEVER full URLs
10. NEVER include any http:// or https:// URL anywhere — not in code, not in comments, not in strings.
    This includes ctx.email calls: do NOT put provider URLs in templateId or data fields.
    templateId is a short opaque string like 'd-abc123', never a URL.
11. webhookTopics must exactly match what is listed in the plan
12. For Shopify PUT endpoints (update), use ctx.shopify.post() — not a separate PUT method
13. Every INSERT into a tenant table must include tenant_id: use ctx.tenantId
14. Never silently ignore errors from ctx.db — propagate or return early on failure
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
CRON RATE LIMIT SAFETY — this handler calls Shopify APIs inside a cron loop:

Shopify rate limit: ~2 req/s on Basic, ~4 req/s on Advanced.
Per-item Shopify calls inside a loop = guaranteed throttle errors at any meaningful scale.

Rule: Pre-fetch ALL Shopify data in batches before the loop. The loop body must contain
only DB reads/writes and local logic — zero Shopify API calls inside the loop:
  ✅ // Pre-fetch phase — outside the loop
     const ids = rows.map(r => r.entity_id)
     const chunks = []
     for (let i = 0; i < ids.length; i += BATCH_SIZE) chunks.push(ids.slice(i, i + BATCH_SIZE))
     const dataMap = new Map()
     for (const chunk of chunks) {
       const data = await ctx.shopify.get(`/endpoint.json?ids=${chunk.join(',')}`)
       for (const item of data.items) dataMap.set(item.id, item)
     }
     // Process phase — zero Shopify calls
     for (const row of rows) {
       const item = dataMap.get(row.entity_id)
       if (!item) continue
       // DB writes and local logic only
     }
  ❌ for (const row of rows) { await ctx.shopify.get(...) }  // N sequential calls

Variant/product batch pattern — Shopify has NO batch variant-by-IDs endpoint:
  ❌ for (const variantId of ids) { await ctx.shopify.get(`/variants/${variantId}.json`) }
     // 1–2 calls per variant = rate-limit failure at scale
  ✅ // Batch via products.json, then extract variants (max 250 product IDs per call)
     const productIds = [...new Set(rows.map(r => r.product_id))]
     const variantMap = new Map()  // Map<variant_id, { variant, product }>
     const PRODUCT_BATCH = 250
     for (let i = 0; i < productIds.length; i += PRODUCT_BATCH) {
       const chunk = productIds.slice(i, i + PRODUCT_BATCH)
       const { products } = await ctx.shopify.get(
         `/products.json?ids=${chunk.join(',')}&fields=id,title,variants`
       )
       for (const p of products) {
         for (const v of p.variants) {
           variantMap.set(v.id, { variant: v, product: { id: p.id, title: p.title } })
         }
       }
     }
     // Loop body uses variantMap — zero Shopify calls
     for (const row of rows) {
       const entry = variantMap.get(row.variant_id)
       if (!entry) continue
       // use entry.variant and entry.product
     }
  NOTE: product_id must be stored in the DB table — it is the key for this batch approach.
"""
