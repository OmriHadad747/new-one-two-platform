"""
Handler system prompt — always-on core (HARNESS_BASE).

Parallels prompts/architect/_core.py and prompts/widget/_core.py: this module
holds the always-shipped handler prompt content — ctx.* always-on surface,
required output format, absolute rules, logging, cross-cutting Shopify loop
rule.

Capability-specific API docs (ctx.shopify.*, ctx.services.*, ctx.http,
ctx.storefront, npm packages) are NOT in this file — they live in
templates/capabilities/handler.py and are injected into the USER prompt by
handler_agent.py's JIT based on what the architect declared in
handlerCapabilities. Trigger-gated sections (webhook / cron batching / state
machine / widget routing / admin routing) live in sibling modules in this
package.
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
