# MVP Plan — Small Shopify App Generator

## What it is

A platform that generates, deploys, and operates small-to-medium Shopify apps from a prompt. Each generated app is a standalone Node service with its own Postgres schema, running in its own Cloud Run container. The platform acts as a signed proxy for inbound traffic and provides shared capabilities (email, Shopify auth, file storage) to handlers over HTTP.

---

## Critical components

```
platform-ai/      Python generator — architect → codegen → validator → revision
platform-back/    TypeScript edge + services
  apps/api            fastify — /admin/:appId/*, /widget/:appId/*, /services/*, OAuth, deploy
  apps/webhook-gateway Shopify HMAC → BullMQ
  apps/worker         BullMQ drain → HTTP to handler
  packages/deployer   9-step orchestrator (SA → build → migrate → Cloud Run → cron/webhook register)
  packages/db         shared Postgres, per-tenant schemas
  packages/email      Resend + MJML renderer + suppression/quota
  templates/handler/  the reference container shipped into every tenant
platform-front/   merchant dashboard
```

### Handler template — what it owns

Fixed across every generated app:

- Express server boot + graceful shutdown
- `verifyPlatform` middleware (Google ID token → `req.platform`)
- DB connection with `search_path = tenant_<uuid>, public`
- Shopify client: REST + GraphQL + pagination + 401-retry token cache
- Cron runner: `FOR UPDATE SKIP LOCKED` + lease/sweeper + LISTEN/NOTIFY
- `callPlatformService({path, body})` — typed `platform.*` SDK in flight (see `TEMPLATE_PROMOTIONS.md`)
- Migration runner (template migration 0001 + per-app migrations)

### Generator — what it writes per app

- `src/routes/{webhook,admin,widget,cron}.ts` (whichever the archetype needs)
- `migrations/0002_*.sql` (per-app feature schema)
- Optional `src/lib/*.ts` helpers
- Email starter content + variable manifest (email-using apps)

### Platform services (`/services/*`)

Handler calls platform-back over HTTP with its Cloud Run SA ID token.

| Endpoint | Status |
|---|---|
| `/services/email/send` + `/send-batch` | Live |
| `/services/shopify/access-token` | Live (cron-path token fetch) |
| `/services/files/upload` | Not built |
| `/services/events` | Not built |

Uniform response shape: `200 {delivered, reason?}` for handled cases, `429` for quota stop, `4xx` for caller bugs, `5xx` for transient platform problems.

---

## Architecture decisions

Core invariants that shape the rest of the system.

1. **One Cloud Run container per (tenant, app).** Physical isolation, no shared runtime, noisy-neighbor-free. Handler is a frozen artifact on deploy.

2. **Shared Postgres, schema per tenant (`tenant_<uuid>`).** Logical DB isolation via role-scoped `search_path`. No per-tenant Postgres instances until an enterprise customer demands it.

3. **Cloud Run IAM both directions.** Platform-back → handler uses the edge's SA ID token; handler → `/services/*` uses the handler's SA ID token. No shared HMAC secrets between the two tiers.

4. **Three inbound trust domains, one middleware each.**
   - `/webhook/*` — Shopify HMAC, verified at the gateway
   - `/admin/:appId/*` — App Bridge session JWT, verified at the edge
   - `/widget/:appId/*` — App Proxy HMAC, verified at the edge
   Each domain maps to a single signature type; no mixing.

5. **Tenant identity never comes from the request body or URL.** Always derived from verified upstream signatures or from the caller's SA identity.

6. **Two-layer webhook idempotency.** BullMQ `jobId = webhook_id` at enqueue; `INSERT INTO processed_webhooks ON CONFLICT DO NOTHING` at the handler. Survives Redis eviction and Shopify's 48h retry window.

7. **pg_cron owns scheduling.** Deployer calls `cron.schedule(...)` at deploy time; each tick does one `INSERT INTO tenant_xxx.cron_queue + NOTIFY`; the handler's runner wakes via `LISTEN`. Generator never touches `cron.*`.

8. **Standard libraries over bespoke wrappers.** `@shopify/shopify-api`, `postgres`, native `fetch`, stock `mjml` — pinned in the handler's `package.json`. No `@platform/shopify-client` SDK to maintain. The platform SDK surface is limited to things that can't exist in an npm package: `platform.*` over HTTP for shared-credential services.

9. **Template owns mechanics; generator owns business logic.** The split is strictest where it's cleanest (cron jobs map, Shopify pagination). Drift from that pattern (webhook dispatch, `/services/*` calls) is being closed — see `TEMPLATE_PROMOTIONS.md`.

10. **Signed headers, not forwarded tokens.** Platform-back verifies Shopify's JWT/HMAC once at the edge, then forwards to the handler with its own signed headers + ID token. The handler never sees a Shopify token's TTL concerns.

---

## Supported app scopes

The generator targets small-to-medium Shopify apps — apps a single developer could build in a day to a week. Four archetypes:

| Archetype | What it does | Triggers | Surfaces |
|---|---|---|---|
| **A — Storefront + Backend** | Widget on product/cart/etc. pages, backend config + events | Widget fetches via App Proxy; webhook events optional | `/widget/*`, `/webhook/*` |
| **B — Storefront + Backend + Admin UI** | Widget + merchant admin dashboard | + admin UI actions | All three |
| **C — Backend only** | Automated — runs on webhooks or a schedule | `/webhook/*`, cron | No UI |
| **D — Backend + Admin UI** | Merchant-facing dashboard or control panel | Admin UI actions | `/admin/*` |

### What "small-to-medium" means

**In scope:**
- Single-tenant logic per app (no multi-shop federation)
- Synchronous request-response + cron-scheduled batches
- Shopify REST/GraphQL consumption, webhook processing
- Transactional email, file generation (PDF/CSV/images)
- Postgres state up to ~10 tables, a few million rows per tenant
- Jobs that fit in a single Cloud Run container with a 30s request timeout (cron batches iterate; single ticks stay short)

**Out of scope for MVP:**
- Real-time (WebSockets, server-sent to storefront)
- Heavy background processing (video transcoding, ML inference)
- Multi-day workflows with complex state machines (possible but not the sweet spot)
- Anything requiring per-tenant custom infrastructure

When the architect determines an app concept needs a capability outside this surface, the pipeline fails before codegen with `errorCode: "platform_limitation"` and a merchant-facing reason. No retry prompt; the frontend surfaces a "not supported yet" state.

### Deployable today

- Category C apps (backend only — webhook + cron). Admin-only milestone covers the admin trust-domain plumbing for Category D's backend half.

### Deferred to UI phase

- Categories A and B need the widget bundle delivery path (CDN + App Proxy integration).
- Categories B and D need the embedded admin UI bundle (React + App Bridge shell).

Backend routes for all four categories already work end-to-end; what's missing is the per-app UI bundle generation + delivery. Bundle contract (`widgetModule`, `adminUiModule`) already has slots reserved for it.

Full app catalog: **[Supported Apps Catalog](./SUPPORTED_APPS_CATALOG.md)**.
