"""
Compact handler API surface — used by the revision agent.

The revision agent sees the prior handler code in its user prompt, which
already embodies the full patterns from HARNESS_BASE. Re-sending the whole
harness contract would waste tokens without improving output quality, so
revisions get this crisp reminder of what APIs exist plus the handful of
absolute rules that matter most when editing code.

Per-capability "do it this way" rules are not hard-coded here — they are
JIT-rendered from the handler registry via render_api_surface_rules() so
the registry stays the single source of truth. Add an api_surface_usage_rule
to a Capability and it shows up below; remove it and it disappears.

Not used by the handler generator itself — initial handler generation uses
HARNESS_BASE (see _core.py) plus capability-gated docs from the handler
registry (templates/capabilities/handler.py).
"""

from templates.capabilities import render_api_surface_rules
from templates.capabilities.handler import HANDLER_CAPABILITY_REGISTRY


_CAPABILITY_RULES = render_api_surface_rules(HANDLER_CAPABILITY_REGISTRY)

# Prefix with a labeled header only when at least one capability declares a rule.
_CAPABILITY_RULES_BLOCK = (
    f"\nCapability usage rules:\n{_CAPABILITY_RULES}\n" if _CAPABILITY_RULES else ""
)

HARNESS_API_SURFACE = f"""
HARNESS API SURFACE — the only APIs available inside handler():
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Shopify:
  ctx.shopify.get(path) / ctx.shopify.post(path, body) / ctx.shopify.delete(path)
    — REST at /admin/api/2026-01. Path is relative.
  ctx.shopify.paginate(path, params?)
    — async generator over REST list endpoints; handles Link-header cursors.
  ctx.shopify.graphql(query, variables?)
    — Admin GraphQL. IDs use GID format: `gid://shopify/TypeName/${{numericId}}`.
  ctx.shopify.paginateGql(query, vars, connectionPath)
    — async generator over Relay connections; handles pageInfo/endCursor.
  ctx.storefront.graphql(query, variables?)
    — public Storefront API (server-side).

Database (postgres.js tagged template, RLS-scoped to ctx.tenantId):
  await ctx.db`SELECT ... WHERE tenant_id = ${{ctx.tenantId}} AND ...`
  Always pass ctx.tenantId in every INSERT; never String()-wrap IDs.

Trigger routing:
  ctx.trigger           — 'webhook' | 'cron' | 'widget' | 'admin'
  ctx.payload           — Shopify webhook body (object)
  ctx.widgetPath / ctx.widgetBody   — when trigger === 'widget'
  ctx.adminPath  / ctx.adminBody    — when trigger === 'admin'
  ctx.shop.domain       — myshopify.com domain
  ctx.logger.info / warn / error

Services (available on every ctx):
  ctx.services.email.send({{ to, data? }})    — merchant-configured template
  ctx.services.sms.send({{ to, body }})
  ctx.services.files.upload(name, content, mimeType?) → signed URL
  ctx.http.call(url, options?)              — https:// to third parties

Required module shape (CommonJS):
  module.exports = {{
    webhookTopics: [...], cronSchedule: null | '...',
    npmPackages: [...], handler: async function(ctx) {{ ... }}
  }}

Core rules:
  - No fetch(), eval(), Function, setInterval, setImmediate, process.env.
    setTimeout allowed only for small rate-limit pauses (≤500 ms).
  - require() only packages declared in npmPackages (+ Node built-ins).
  - Every INSERT into a tenant table must include tenant_id: ctx.tenantId.
  - Widget/admin routes: route on ctx.widgetPath / ctx.adminPath, return JSON.
  - GraphQL IDs MUST be GID-formatted — never raw numeric.
{_CAPABILITY_RULES_BLOCK}"""
