"""
Revision agent compact API surface.

The revision agent sees the prior handler code in its user prompt, which
already embodies the full patterns from HARNESS_BASE. Re-sending the whole
harness contract would waste tokens without improving output quality, so
revisions get this crisp reminder of what APIs exist plus the handful of
absolute rules that matter most when editing code.

Capability content is fully registry-driven — no hardcoded signature or
rule prose lives in this file:
  - Per-capability signatures render from HANDLER_SERVICES via render_registry()
    (uses each Capability.short line).
  - Per-capability usage rules render from HANDLER_CAPABILITY_REGISTRY via
    render_usage_rules() (uses each Capability.usage_rule line, if set).
Adding a new ctx.* service or rule is a single registry edit in
templates/capabilities/handler.py; both blocks below update automatically.

Hardcoded blocks below (Database, Trigger routing, Required module shape,
Core rules) are platform invariants that are not capability-scoped and have
no registry counterpart.

Not used by the handler generator itself — initial handler generation uses
HARNESS_BASE (see prompts/handler/_core.py) plus capability-gated docs
from the handler registry. This file lives under prompts/revision/ because
the revision agent is its sole consumer.
"""

from templates.capabilities import render_registry, render_usage_rules
from templates.capabilities.handler import HANDLER_CAPABILITY_REGISTRY, HANDLER_SERVICES


# Per-capability signatures — rendered from HANDLER_SERVICES (ctx.* platform
# services only; npm packages are library declarations, not APIs callable
# through ctx, so they belong in the handler's full docs JIT, not here).
_SERVICE_SIGNATURES = render_registry(HANDLER_SERVICES, indent="  ")

# Per-capability usage rules — one-liner disciplines for capabilities that
# declare them (paginate, paginateGql, sharp/pdfkit/exceljs disk-writes).
_CAPABILITY_RULES = render_usage_rules(HANDLER_CAPABILITY_REGISTRY)
_CAPABILITY_RULES_BLOCK = (
    f"\nCapability usage rules:\n{_CAPABILITY_RULES}\n" if _CAPABILITY_RULES else ""
)

HARNESS_API_SURFACE = f"""
HARNESS API SURFACE — the only APIs available inside handler():
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Handler platform services (ctx.*) — declared per-app in handlerCapabilities:
{_SERVICE_SIGNATURES}

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
