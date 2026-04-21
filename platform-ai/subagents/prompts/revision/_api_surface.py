"""
Revision agent compact API surface.

The revision agent sees the prior handler code in its user prompt, which
already embodies the full patterns from HARNESS_BASE. Re-sending the whole
harness contract would waste tokens without improving output quality, so
revisions get this crisp reminder of what APIs exist plus the handful of
absolute rules that matter most when editing code.

Capability content is fully registry-driven — no hardcoded signature or
rule prose lives in this file:
  - Per-capability signatures render from HANDLER_SERVICES via
    render_registry() (uses each Capability.short line).
  - Per-capability usage rules render from HANDLER_CAPABILITY_REGISTRY via
    render_usage_rules() (uses each Capability.usage_rule line, if set).

Adding a new platform service or rule is a single registry edit in
templates/capabilities/handler.py; both blocks below update automatically.

Hardcoded blocks below (Database, Request context, Required file shape,
Core rules) are platform invariants that are not capability-scoped and
have no registry counterpart.

Not used by the handler generator itself — initial handler generation uses
HARNESS_BASE (see prompts/handler/_core.py) plus capability-gated docs
from the handler registry. This file lives under prompts/revision/ because
the revision agent is its sole consumer.
"""

from templates.capabilities import render_registry, render_usage_rules
from templates.capabilities.handler import HANDLER_CAPABILITY_REGISTRY, HANDLER_SERVICES


# Per-capability signatures — rendered from HANDLER_SERVICES (platform
# services + shopify client surface; npm packages are library declarations,
# not APIs callable through a single object, so they belong in the handler's
# full docs JIT, not here).
_SERVICE_SIGNATURES = render_registry(HANDLER_SERVICES, indent="  ")

# Per-capability usage rules — one-liner disciplines for capabilities that
# declare them (paginate, paginateGql, sharp/pdfkit/exceljs disk-writes).
_CAPABILITY_RULES = render_usage_rules(HANDLER_CAPABILITY_REGISTRY)
_CAPABILITY_RULES_BLOCK = (
    f"\nCapability usage rules:\n{_CAPABILITY_RULES}\n" if _CAPABILITY_RULES else ""
)

HARNESS_API_SURFACE = f"""
HARNESS API SURFACE — the APIs available inside generated handler files:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Handler platform services — declared per-app in handlerCapabilities:
{_SERVICE_SIGNATURES}

Database (postgres.js tagged template, search_path pinned to this tenant's
schema at connection time):
  import {{ sql }} from "../lib/db.js";
  await sql`SELECT ... FROM <table> WHERE <col> = ${{value}}`;
  No tenant_id column — schema isolation replaces RLS. No schema
  qualifiers on table names — bare names resolve into the tenant schema.

Request context (inside an Express route — webhook / admin / widget):
  req.platform.tenantId    — UUID string
  req.platform.appId       — UUID of the deployed app
  req.platform.shopDomain  — <shop>.myshopify.com
  req.platform.requestId   — per-request id for log correlation
  req.platform.accessToken — Shopify access token (optional, stamped on
                             HTTP calls; absent on cron ticks)

Cron jobs (src/routes/cron.ts) run OUTSIDE a request — no req.platform.
A job function receives only (payload: unknown) and imports `sql` /
`platform` / `shopifyClientFor` the same way routes do.

Platform services (email):
  import {{ platform, QuotaExceeded }} from "../lib/platform.js";
  const result = await platform.email.send({{ to, data }});
  result.delivered → success; delivered:false → soft failure (log, continue);
  throws QuotaExceeded on monthly quota hit.
  Never hand-roll fetch() or callPlatformService() to reach /services/*.

Shopify admin REST / GraphQL / storefront:
  import {{ shopifyClientFor }} from "../lib/shopify.js";
  const shopify = await shopifyClientFor(req.platform!);
  await shopify.rest.get("/<resource>.json?...");
  await shopify.graphql(query, variables);
  for await (const page of shopify.rest.paginate("<resource>.json")) ...

Required file shape:
  src/routes/webhook-handlers.ts — exports const webhookHandlers (Record<string, WebhookHandler>)
  src/routes/admin.ts            — exports const adminRouter
  src/routes/widget.ts           — exports const widgetRouter
  src/routes/cron.ts             — exports const jobs: Record<string, JobFn>
                                   (Phase 2 convention: one job named "main")
  FORBIDDEN: src/routes/webhook.ts — template-owned; never emit this file

Core rules:
  - ESM only. No require(), no module.exports.
  - No ctx.* anywhere — that's pre-Phase-2 vocabulary.
  - No eval(), new Function(), setInterval, setImmediate,
    process.exit/kill. setTimeout allowed only with a numeric-literal
    delay ≤500ms — between unavoidable per-item Shopify writes.
  - Package imports are architect-gated via handlerCapabilities: all
    authorized packages ship in the template's package.json, but the
    declaration is the gate.
  - GraphQL IDs MUST be GID-formatted — never raw numeric.
  - Never overwrite template-owned files (server.ts, middleware/*,
    lib/{{db,platform-call,shopify,cron-runner}}.ts, the baseline
    migration, package.json, tsconfig.json, Dockerfile).
{_CAPABILITY_RULES_BLOCK}"""
