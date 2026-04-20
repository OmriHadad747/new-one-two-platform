"""
Admin-routing handler patterns.

Injected by handler_agent.py's JIT when ``appContracts.adminApiCatalog`` is
non-empty (storefront_backend_admin or backend_admin). Covers ctx.adminPath
routing, ctx.adminBody destructuring, the adminCatalog-as-contract discipline,
and the widget-vs-admin field disambiguation.
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
