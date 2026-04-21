# MVP Plan — Small Shopify App Generator

## Architecture (current shape)

Three repos, three runtimes:

- **`platform-ai/`** — Python generator. Architect → handler/migration codegen → validator → revision. Publishes `generation.completed` to Pub/Sub.
- **`platform-back/`** — TypeScript edge + services. Owns OAuth, deployer, webhook ingest, `/services/*` capabilities, signed-proxy `/admin/:appId/*` and `/widget/:appId/*` routes.
- **`platform-front/`** — Merchant dashboard.

Each generated app deploys as **its own Cloud Run container** built from `platform-back/templates/handler/`. The container is a standalone Node/Express service: per-tenant Postgres schema, pinned dependencies, frozen on deploy. Platform-back is a signed proxy in front; handlers never run "inside" the platform.

```
Shopify ──► /admin/:appId/*  ─┐
        ──► /widget/:appId/* ─┼─► platform-back edge ─► handler-<tenant>-<app>.run.app
        ──► webhook-gateway ──┘                              │
                                                              ▼
                                          handler ─► /services/email/send  (etc.)
                                                  ─► Postgres (own schema)
                                                  ─► @shopify/shopify-api
```

Auth: Cloud Run IAM both directions (Google ID tokens). No shared HMAC secrets between platform and handler.

---

## What the Generator Produces

Generator writes per-app code only:

- `src/routes/{webhook,admin,widget,cron}.ts` — route handlers (whichever the archetype needs)
- `migrations/0002_*.sql` — feature schema (the template ships `0001_processed_webhooks.sql` + `cron_queue`)
- Optional `src/lib/*.ts` helpers
- Email starter content + variable manifest (when the app sends email)

Everything else is template-owned and frozen across all generated apps:
HTTP server, inbound auth middleware, DB connection with tenant `search_path`, Shopify client (REST + GraphQL + pagination + 401-retry token cache), cron runner (claim + lease + retry + LISTEN/NOTIFY), platform-call helper, migration runner.

In-flight refactor: lifting webhook idempotency-and-dispatch and the `/services/*` call pattern out of generated code into the template — see [`TEMPLATE_PROMOTIONS.md`](../TEMPLATE_PROMOTIONS.md).

---

## Platform Services (`/services/*`)

Handlers call platform-back over HTTP for capabilities that need shared credentials, billing, or quotas. Auth is the handler's Cloud Run service-account ID token, verified by platform-back and mapped to `(tenantId, appId)` via `apps.handler_sa_email`.

| Endpoint | Status |
|---|---|
| `/services/email/send` + `/send-batch` | Live (Resend, suppression, quota, rendering, delivery log) |
| `/services/shopify/access-token` | Live (cron-path token fetch) |
| `/services/files/upload` | Not built — add when first archetype needs it |
| `/services/sms/send` | Not built |
| `/services/events` | Not built (cross-tenant analytics sink) |

Response taxonomy is uniform across services: `200` with `{delivered, reason}` for handled cases (sent / suppressed / config-missing / provider-failed), `429` for quota stop, `4xx` for caller bugs, `5xx` for transient platform problems. The handler `try`s exactly one stop signal per service (e.g. `QuotaExceeded` for email).

For capabilities that don't need shared platform credentials (PDF, CSV, image processing, dates, slugs, etc.), the handler installs ordinary npm packages from a security-checked allowlist (see `platform-back/packages/deployer/src/npm-allowlist.ts`).

---

## App Categories

| Category | Surface | Status |
|---|---|---|
| **C — Backend only** (webhook, cron, scheduled jobs) | `/webhook/*` + `/cron` | **Live**. First milestone target. |
| **D — Backend + Admin UI** | adds admin UI bundle | Backend live. Admin UI deferred to UI Phase. |
| **A — Storefront widget + Backend** | adds widget bundle | Backend ready. Widget bundle deferred to UI Phase. |
| **B — Storefront widget + Backend + Admin UI** | both bundles | Both deferred to UI Phase. |

Categories A, B, D are unblocked on the *backend* side — `/widget/:appId/*` and `/admin/:appId/*` proxy routes work end-to-end. What's missing is the per-app UI bundle (widget JS for storefront, React module for embedded admin shell). UI archetype templates are the next major frontier; bundle contract already has `widgetModule` / `adminUiModule` slots reserved for it.

Full app catalog: **[Supported Apps Catalog](./SUPPORTED_APPS_CATALOG.md)**.

---

## Monetization

| Plan | Price | App limit | Categories unlocked |
|---|---|---|---|
| **Free** | $0/mo | 1 app | A only (when widgets ship) |
| **Starter** | $15/mo | 3 apps | A + C |
| **Growth** | $35/mo | 10 apps | A + B + C + D |

While categories A/B/D are backend-only-deployable, paid plans gate by intended category, not delivered surface — so the gate logic lands once and unblocks UI archetypes as they ship.

**Phase 3 add-on:** usage charges on top of subscriptions — Email $0.001/send (1k included), SMS $0.05/send (100 included on Growth). PDF/CSV always free (no marginal cost).

---

## Execution Phases

### Phase 0 — Architecture refactor ✅ (done)

`ctx.*`-injected harness retired. Standalone-handler model live: per-tenant Cloud Run, per-tenant Postgres schema, signed edges, Cloud Run IAM both directions, pg_cron for scheduling, BullMQ-backed webhook dispatch with two-layer idempotency. Generator retargeted off `ctx.*` onto the template surface.

### Phase 1 — Backend-only end-to-end (in progress)

First Category-C app installed → generated → deployed → executed → email sent. Validates the full loop. Checklist in [`OPEN_GAPS.md`](../OPEN_GAPS.md).

### Phase 2 — Template promotions

Lift webhook dispatch + `/services/*` call pattern into the template (see [`TEMPLATE_PROMOTIONS.md`](../TEMPLATE_PROMOTIONS.md)). Shrinks generator prompts ~15–25%, shrinks generated code ~30%.

### Phase 3 — Webhook + cron archetypes

Generate and deploy real Category-C apps end-to-end. Validate the cron tick path against pg_cron in prod.

### Phase 4 — UI archetypes

Reintroduce `widgetModule` and `adminUiModule` in the bundle contract. Build the parallel templates:

- **`admin-ui-template`** — React + Polaris + App Bridge, fetch-to-`/admin/:appId/*`, served from the handler container or a CDN bucket.
- **`widget-template`** — vanilla JS + App Proxy fetch, delivered via CDN or Shopify theme extension.

Same template-owns-mechanics / generator-owns-business-logic split as the handler. Unblocks Categories A, B, D's UI surfaces.

### Phase 5 — Remaining `/services/*`

Build `/services/files/upload`, `/services/sms/send`, `/services/events` as archetypes demand them. Email is the reference implementation.

### Phase 6 — Billing + App Store launch

Shopify `RecurringApplicationCharge`, plan storage, gating wiring. Submit listing for review.

### Later — Expand

Usage billing (email, SMS), wider catalog, `ctx.queue`-equivalent if a real archetype needs it (it might not; pg_cron + handler routes cover most fan-out cases today).

---

## Expert Assist — Human in the Loop

When the generator can't get a merchant's app live on its own, a certified Shopify developer steps in.

- **On-demand:** "Get expert help" button appears after repeated validation failures or revisions without a deploy.
- **Auto-detected:** platform watches struggle signals (N failed generations, M revisions, age threshold) and proactively offers help.
- **Developer role:** read-only session link with prompt history, generated code, validation errors. They make small surgical edits or write precise revision prompts the merchant couldn't. They guide the generator — they don't replace it.

Charged per session (credit-based). Merchants who never get stuck pay nothing extra. Platform-certified developers, not a freelance marketplace.

**Auto-discovery follow-up:** track which app types, prompts, or merchant segments consistently need human help, feed that signal back into prompts and validation rules.

---

## The Core Bet

A merchant paying $19/mo for "Notify Me," $29/mo for "Sales Pop," and $15/mo for "Announcement Bar" — three separate apps totalling $63/mo — will immediately see the value in paying $35/mo for a platform that generates all three (and more) from a prompt.
