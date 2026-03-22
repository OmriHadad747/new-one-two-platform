"""
Harness contract injected verbatim into the handler sub-agent system prompt.

This mirrors /contract/harness-contract.md exactly.
When the harness API changes, update BOTH files.
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
  Example: await ctx.db`INSERT INTO my_table (col) VALUES (${value})`

ctx.payload — the parsed Shopify webhook body (object). For cron jobs this is {}.
  Example: const orderId = ctx.payload.id

ctx.logger.info(msg: string | {key: val}, msg?: string)
ctx.logger.warn(msg)
ctx.logger.error(msg)
  Example: ctx.logger.info({ orderId: 123 }, 'Processing order')

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
"""
