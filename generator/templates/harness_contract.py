"""
Harness contract injected verbatim into the handler sub-agent system prompt.

This is the single source of truth for the handler() API surface.
When the harness API changes (build-ctx.ts, types/index.ts), update this file.
"""

HARNESS_CONTRACT = """
HARNESS CONTRACT — the only APIs available inside handler():
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ctx.shopify.get(path: string) → Promise<any>
  Shopify REST GET. Path is relative to /admin/api/2026-01
  Example: await ctx.shopify.get('/orders.json?status=any&limit=10')

ctx.shopify.post(path: string, body: object) → Promise<any>
  Shopify REST POST/PUT. Use for mutations.
  Example: await ctx.shopify.post('/customers/456.json', { customer: { id: 456, tags: 'VIP' } })
  Note: Shopify PUT endpoints also use shopify.post() — the harness always sends POST.
  For actual PUT (update), use: await ctx.shopify.post('/customers/456.json', body)

ctx.db  — postgres.js tagged template transaction (RLS-scoped to this tenant)
  Example: const rows = await ctx.db`SELECT * FROM my_table WHERE id = ${someId}`
  Example: await ctx.db`INSERT INTO my_table (col, tenant_id) VALUES (${value}, ${ctx.tenantId})`

ctx.tenantId — UUID string of the current tenant
  MUST be included as the tenant_id column value in every INSERT statement.
  Example: await ctx.db`INSERT INTO my_table (id, tenant_id, col) VALUES (gen_random_uuid(), ${ctx.tenantId}, ${value})`

ctx.payload — the parsed Shopify webhook body (object). For cron jobs this is {}.
  Example: const orderId = ctx.payload.id

ctx.logger.info(msg: string | {key: val}, msg?: string)
ctx.logger.warn(msg)
ctx.logger.error(msg)
  Example: ctx.logger.info({ orderId: 123 }, 'Processing order')

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHOPIFY API PATTERNS — use these exact approaches:

To find a product from an inventory item ID:
  ✅ const variants = await ctx.shopify.get(`/variants.json?inventory_item_ids=${inventoryItemId}`)
  ❌ NEVER scan /products.json by iterating all results — it is paginated at 250 and will silently miss products

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
1. Output ONLY the JavaScript code — no markdown fences, no explanation
2. Use module.exports = { webhookTopics, cronSchedule, handler } — exactly this shape
3. handler MUST be an async function taking a single argument named ctx
4. NO require() or import() calls — all capabilities come through ctx
5. NO eval(), Function(), setTimeout(), setInterval(), setImmediate()
6. NO process.exit(), process.kill(), or process.env access
7. NO global variable mutation
8. Handle errors with try/catch — never let the handler throw uncaught exceptions
9. webhookTopics must exactly match what is listed in the API plan
10. For Shopify PUT endpoints (update), use ctx.shopify.post() — not a separate PUT method
11. Every INSERT into a tenant table must include tenant_id: use ctx.tenantId
12. INSERT operations that may be triggered more than once (webhooks are at-least-once) must use ON CONFLICT DO NOTHING or an equivalent idempotency guard
13. Never silently ignore errors from ctx.db — if a required DB read/write fails, propagate the error (re-throw or return early without proceeding to downstream side-effects)
14. When performing an external side effect (sending a notification, calling an API) based on DB state, atomically claim the work first using UPDATE ... WHERE <condition> RETURNING *, then only proceed if rows were returned. This prevents double-execution when the webhook fires more than once.
    Example:
      const claimed = await ctx.db`
        UPDATE waitlist SET notified = true, notified_at = NOW()
        WHERE tenant_id = ${ctx.tenantId} AND product_id = ${productId} AND notified = false
        RETURNING customer_id, email
      `;
      for (const row of claimed) { /* send notification */ }
15. When the feature needs to detect a state transition (e.g. inventory going from 0 to available), always read and persist the previous state in a dedicated DB table before acting. Never assume the current value represents a change.
"""
