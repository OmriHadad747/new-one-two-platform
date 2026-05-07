# Handler template

The reference shape for a per-tenant handler container.
**Hand-written. The generator emits variations of this.** Don't import or
run this directly from anywhere — copy / template into a generated app.

## What's inside

```
src/
  server.ts                       Express bootstrap, mounts routers
  middleware/verify-platform.ts   Verifies Cloud Run ID token from platform-back,
                                  reads X-Tenant-Id / X-App-Id / X-Shop-Domain
  routes/
    admin.ts                      Example merchant-facing admin routes
    webhook.ts                    /webhook/:topic — idempotent dispatch
    widget.ts                     /widget/:path — storefront-facing routes
  lib/
    db.ts                         Tenant-scoped Postgres (search_path)
    platform-call.ts              Outbound /services/* call w/ ID-token mint
  migrate.ts                      Pre-deploy migration runner

migrations/
  0001_template_baseline.sql      Baseline; every handler ships with this
                                  (processed_webhooks, cron_queue, app_config)
```

## Locked guarantees this template enforces

- **Decision 2** — stock libs only (`express`, `postgres`, `@shopify/shopify-api`,
  `google-auth-library`, `jose`). No `@platform/*` SDK wrappers.
- **Decision 3** — one schema per tenant; `db.ts` pins `search_path`.
- **Decision 8** — `processed_webhooks` baseline + idempotency dance baked
  into `webhook.ts`.
- **Decision 9** — migrations run via `pnpm migrate` (a Cloud Run pre-deploy job),
  never on container start.
- **Decision 10 (amended)** — uninstall teardown is owned by the platform
  provisioner: it drops the tenant schema, deletes the Cloud Run service,
  Docker image, and Secret Manager entries. Handler exposes no purge
  endpoint, so an unreachable handler cannot block uninstall.

## Auth

- **Inbound** (platform-back → handler): Google ID token verified by `verifyPlatform`,
  caller email checked against `PLATFORM_SA_EMAIL`. Skipped when
  `CLOUD_RUN_SKIP_AUTH=true` (local dev only).
- **Outbound** (handler → platform-back): `callPlatformService` mints an ID token
  via the Cloud Run metadata server. Same env flag controls skip.

## Run locally

```
pnpm install
pnpm migrate     # provisioner must have created the schema first
pnpm dev
```
