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

── Shopify REST ──────────────────────────────────────────────

ctx.shopify.get(path: string) → Promise<any>
  Shopify Admin REST GET. Path is relative to /admin/api/2026-01.
  Example: await ctx.shopify.get('/orders.json?status=any&limit=10')

ctx.shopify.post(path: string, body: object) → Promise<any>
  Shopify Admin REST POST/PUT. Use for REST mutations.
  Example: await ctx.shopify.post('/customers/456.json', { customer: { id: 456, tags: 'VIP' } })
  Note: Shopify PUT endpoints also use shopify.post() — the harness always sends POST.

── Shopify GraphQL ───────────────────────────────────────────

ctx.shopify.graphql(query: string, variables?: object) → Promise<any>
  Shopify Admin GraphQL API — POST to /admin/api/2026-01/graphql.json.
  The harness throws on GraphQL errors — no need to check result.errors.
  The harness unwraps { data: ... } — access fields directly on the result.
  IDs MUST use Shopify Global ID (GID) format: `gid://shopify/TypeName/${numericId}`
    The type name matches the GraphQL schema type: Order, Product, Customer, etc.
    Convert numeric IDs from webhooks and REST responses before use in variables.
  Example:
    const order = await ctx.shopify.graphql(
      `query GetOrder($id: ID!) {
        order(id: $id) {
          id
          fulfillments { trackingInfo { number company } }
          lineItems(first: 50) { nodes { title quantity } }
        }
      }`,
      { id: `gid://shopify/Order/${orderId}` }
    )
    const { fulfillments, lineItems } = order.order
  Pagination: GraphQL uses cursor-based pagination — use edges/node or nodes pattern
    with pageInfo { hasNextPage endCursor } and a variables-based loop.

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

── Email ─────────────────────────────────────────────────────

ctx.email.send({ to, subject, templateId?, data? }) → Promise<void>
  Send a transactional email to a customer. Also available as ctx.services.email.send().
    to:         recipient email address (string)
    subject:    email subject line (string)
    templateId: optional provider template ID (short opaque string like 'd-abc123', NEVER a URL)
    data:       optional template variables, e.g. { firstName, productTitle, price, variantTitle }
  Example: await ctx.email.send({ to: entry.customer_email, subject: 'Back in stock!', data: { productTitle, price } })

── SMS ───────────────────────────────────────────────────────

ctx.services.sms.send({ to, body }) → Promise<void>
  Send an SMS notification. Currently a log stub — logs SMS_SENT; real Twilio integration in Phase 3.
    to:   E.164 phone number, e.g. "+15551234567"
    body: message text (max 160 chars for a single SMS segment)
  Example: await ctx.services.sms.send({ to: customer.phone, body: `Your cart is waiting! ${checkoutUrl}` })
  Note: Always log a human-readable description alongside — the stub does not deliver the message.

── PDF ───────────────────────────────────────────────────────

ctx.services.pdf.generate(html: string) → Promise<Buffer>
  Render an HTML string to a PDF buffer. Currently a log stub — logs PDF_GENERATED; real PDFKit in Phase 3.
  Example:
    const html = `<h1>Order #${order.order_number}</h1><p>${order.line_items.map(i => i.title).join(', ')}</p>`
    const pdfBuffer = await ctx.services.pdf.generate(html)
    // then upload via ctx.services.files or return as a data URI

── CSV ───────────────────────────────────────────────────────

ctx.services.csv.generate(rows, headers?) → string
  Serialize an array of objects to a CSV string. Pure in-process — always real.
    rows:    array of plain objects (one row each)
    headers: optional column ordering; defaults to Object.keys(rows[0])
  Returns the CSV as a string. RFC 4180 compliant — commas and quotes in values are escaped.
  Example:
    const csv = ctx.services.csv.generate(orders, ['id', 'customer_email', 'total_price', 'created_at'])
    // csv is a complete CSV string ready to return or upload

── Files ─────────────────────────────────────────────────────

ctx.services.files.upload(name, content, mimeType?) → Promise<string>
  Upload a file to object storage. Currently a log stub — logs FILE_UPLOADED; real GCS in Phase 3.
  Returns a signed URL valid for 1 hour (stub returns a placeholder URL).
    name:     filename, e.g. "orders-2024-01.csv"
    content:  Buffer or string
    mimeType: optional MIME type, e.g. "text/csv", "application/pdf"
  Example:
    const url = await ctx.services.files.upload('orders.csv', csv, 'text/csv')
    // return the URL to the admin UI for download

── External HTTP ─────────────────────────────────────────────

ctx.http.call(url, options?) → Promise<any>
  Make an authenticated HTTP call to an external API. All calls are logged with tenant context.
    url:            full URL (https:// is ALLOWED here — ctx.http is the only place)
    options.method: HTTP method (default "GET")
    options.headers: additional headers
    options.body:   request body — serialized to JSON automatically
  Throws on non-2xx responses.
  Example:
    const result = await ctx.http.call('https://api.example.com/compress', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer TOKEN' },
      body: { imageUrl: originalUrl }
    })

── Storefront API ────────────────────────────────────────────

ctx.storefront.graphql(query, variables?) → Promise<any>
  Shopify Storefront API (public GraphQL). Uses the Storefront Access Token stored at OAuth time.
  The harness unwraps { data: ... } — access fields directly on the result.
  Use this for publicly available storefront data the handler needs server-side.
  Note: Widget code uses host.storefront() for client-side reads — ctx.storefront is for the handler.
  Example:
    const data = await ctx.storefront.graphql(
      `query GetProduct($handle: String!) {
        productByHandle(handle: $handle) { id title variants(first: 10) { nodes { id availableForSale } } }
      }`,
      { handle: productHandle }
    )

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
4.  NO require() or import() calls — the harness runtime has NO node_modules.
    There is no sharp, axios, lodash, or any other npm package available at runtime.
    Use ONLY capabilities exposed through ctx — they cover all MVP app types:
      ctx.services.image.resize(url, {width, height, fit?}) → Promise<Buffer>
      ctx.services.image.analyze(url) → Promise<{width, height, format, sizeBytes}>
      ctx.services.qrcode.generate(text, {size?, format?}) → Promise<Buffer|string>
      ctx.services.barcode.generate(value, {format?, width?, height?}) → Promise<string> (SVG)
      ctx.services.pdf.generate(html) → Promise<Buffer>
      ctx.services.csv.generate(rows, headers?) → string
      ctx.services.files.upload(name, content, mimeType?) → Promise<string>
      ctx.services.email.send({to, subject, body}) → Promise<void>
      ctx.services.sms.send({to, body}) → Promise<void>
      ctx.http.call(url, {method?, headers?, body?}) → Promise<unknown>
5.  NO eval(), Function(), setTimeout(), setInterval(), setImmediate()
6.  NO process.exit(), process.kill(), or process.env access
7.  NO global variable mutation
8.  Handle errors with try/catch — never let the handler throw uncaught exceptions
9.  ctx.shopify.get/post paths MUST be relative (e.g. '/orders.json') — NEVER full URLs
10. https:// URLs are ONLY allowed as the first argument to ctx.http.call(url, ...).
    NEVER use https:// anywhere else — not in ctx.email templateId, not in comments, not in other strings.
    templateId is a short opaque string like 'd-abc123', never a URL.
    For all Shopify API calls use ctx.shopify.get/post/graphql with relative paths.
11. webhookTopics must exactly match what is listed in the plan
12. For Shopify REST PUT endpoints (update), use ctx.shopify.post() — not a separate PUT method
13. Every INSERT into a tenant table must include tenant_id: use ctx.tenantId
14. Never silently ignore errors from ctx.db — propagate or return early on failure
15. For ctx.shopify.graphql, IDs MUST use GID format: `gid://shopify/TypeName/${numericId}`
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
           variantMap.set(String(v.id), { variant: v, product: { id: p.id, title: p.title } })
         }
       }
     }
     // Loop body uses variantMap — zero Shopify calls
     // KEY TYPE NOTE: Shopify API returns variant_id as a number; postgres.js returns BIGINT
     // columns as strings. Always use String() on both sides of Map.set/get to avoid misses.
     for (const row of rows) {
       const entry = variantMap.get(String(row.variant_id))
       if (!entry) continue
       // use entry.variant and entry.product
     }
  NOTE: product_id must be stored in the DB table — it is the key for this batch approach.

Inventory level batch pattern — use this when checking stock in a cron path.
inventory_quantity from /products.json is unreliable for multi-location stores:
  ❌ if (variantData.inventory_quantity <= 0) continue  // stale for multi-location
  ✅ // Pre-fetch inventory levels — always accurate; sums across all locations
     const inventoryItemIds = [...new Set(rows.map(r => r.inventory_item_id))]
     const inventoryMap = new Map()  // Map<inventory_item_id, storeWideTotal>
     const INV_BATCH = 50
     for (let i = 0; i < inventoryItemIds.length; i += INV_BATCH) {
       const chunk = inventoryItemIds.slice(i, i + INV_BATCH)
       const { inventory_levels } = await ctx.shopify.get(
         `/inventory_levels.json?inventory_item_ids=${chunk.join(',')}`
       )
       for (const level of (inventory_levels || [])) {
         const prev = inventoryMap.get(level.inventory_item_id) || 0
         inventoryMap.set(level.inventory_item_id, prev + (level.available || 0))
       }
     }
     // Loop body checks inventoryMap — zero inventory API calls inside the loop
     // KEY TYPE NOTE: Shopify API returns inventory_item_id as a number; postgres.js returns
     // BIGINT columns as strings. Use String() on both sides to ensure Map.get() matches:
     //   inventoryMap.set(String(level.inventory_item_id), ...)
     //   inventoryMap.get(String(row.inventory_item_id))
     for (const row of rows) {
       const storeWideTotal = inventoryMap.get(row.inventory_item_id) || 0
       if (storeWideTotal <= 0) continue
       // proceed with notification
     }
  NOTE: inventory_item_id must be stored in the DB table — it is the key for this batch approach.
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

Rule: Use the exact field names from the widgetPath codeSpec — the planner defines the
  contract and both the widget and handler are generated from it. Do not rename fields.

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
