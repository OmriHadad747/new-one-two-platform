# Open Gaps — refactor-to-standalone-app-backends

Snapshot as of `853923f`. Items are grouped by what they block; each entry
names the concrete next action.

## Archetype-blocking gaps

These block specific handler archetypes from being deployable end-to-end.
The first admin-only app (with email + optional cron) is NOT blocked by
anything in this section.

### Widget archetype — storefront token provisioning
- **Where:** `platform-back/apps/api/src/routes/oauth.ts` explicitly defers this (commit `00cb7da`: *"Deferred: storefront API token (widget archetype, phase 4)"*).
- **What's missing:** OAuth install flow must exchange for a Shopify Storefront API access token and store it under a Secret Manager name recorded on the tenant row. The handler's `shopifyClientFor(...)` already knows how to read it for storefront calls; it just has nothing to read.
- **Impact:** widgets that hit the Storefront API (cart read, product lookups, etc.) will fail with a missing-token error until this lands.

### Webhook archetype — Shopify webhook re-registration
- **Where:** same OAuth commit defers *"webhook re-registration (webhook archetype, phase 3)"*.
- **What's missing:** on install and on every app version change that alters `handlerModule.webhookTopics`, the platform must (re)register the topics with Shopify so events actually arrive at the webhook-gateway. Today the gateway is ready to receive; nothing tells Shopify to send.
- **Impact:** webhook-archetype handlers deploy cleanly but receive zero traffic.

## Non-blocking gaps

### Platform services not yet built
- `/services/files/upload`
- `/services/sms/send`
- `/services/events` (cross-tenant analytics sink)

None required for admin-only. Add when the first archetype that needs them lands. The email service is the reference pattern — copy the route shape, the SA-to-app auth, and the 200/429/4xx/5xx response taxonomy.

### Persisted deploy job state
- **Where:** `platform-back/packages/deployer/src/orchestrator.ts:18` — *"Job state lives in-process (Map keyed by jobId). Lost on restart."*
- **Impact:** if platform-back restarts mid-deploy or scales to multiple replicas, SSE subscribers lose the stream. The deploy itself still completes; only progress visibility is affected.
- **Fix:** persist to a `deploy_jobs` table and have the SSE handler poll + wake on NOTIFY when subscribed across replicas.

## Deployment / infra adjustments

### Enable pg_cron at the Postgres instance level
- The migration now runs `CREATE EXTENSION IF NOT EXISTS pg_cron`, but the extension itself requires `shared_preload_libraries` to include `pg_cron` at the server level. That cannot be set from SQL.
- **Cloud SQL (Postgres):** set `cloudsql.enable_pg_cron=on` via gcloud or Terraform, then restart the instance. The extension goes live on restart; migration 0001 picks it up.
- **Self-hosted:** edit `postgresql.conf`: `shared_preload_libraries = 'pg_cron'` and restart.
- **Verification:** `SELECT * FROM pg_extension WHERE extname = 'pg_cron';` returns one row once the flag is on and the migration has run.
- **Until this is enabled:** cron-archetype apps deploy successfully but never tick (the `schedule_cron` step will fail when `cron.schedule` is called against a DB without the extension).

### Cloud Run handler ingress
- Current: `INGRESS_TRAFFIC_ALL` with IAM-only authorization (Cloud Run checks invoker role on every request).
- **Action:** add a one-line comment in `platform-back/packages/deployer/src/cloud-run-ops.ts` explaining why IAM alone is the security boundary, so future readers don't "tighten" it without understanding the model.
- **Optional:** tighten to `ingress=internal` + VPC connector if handlers never need direct public callers. Not required for MVP.

### platform-back SA email env var
- `platform-back/packages/deployer/src/orchestrator.ts:319` reads `PLATFORM_BACK_SA_EMAIL` from env and passes it to handlers as `PLATFORM_SA_EMAIL` (used by `verify-platform` middleware to enforce caller identity).
- **Action:** document required prod env vars in `platform-back/README.md` — at minimum: `DATABASE_URL`, `PLATFORM_URL`, `PLATFORM_BACK_SA_EMAIL`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `JWT_SECRET`, `RESEND_API_KEY`, `EMAIL_UNSUBSCRIBE_SECRET`, `GCP_PROJECT`.
- **Missing in prod = silent 403** on every `/services/*` call until it's set; fail-fast at boot (already done for a few vars, not all) would surface it earlier.

## Test coverage / CI

The refactor has compiled clean throughout, but there is currently no
automated test suite in the new `platform-back/` workspace. CI should
enforce the below before any merge to `main` after the refactor branch
lands.

### Unit tests — platform-back packages
Priority order (the first three are the highest-leverage):

1. **`packages/deployer/src/cron-scheduler.ts`**
   - Rejects malformed tenant schema / cron expression / derived channel.
   - Builds the correct `cron.schedule` args and per-tick command string.
   - `unscheduleAppCron` returns `{ removed: false }` when no job exists.
2. **`packages/deployer/src/sa-provisioner.ts`**
   - `nextHandlerSaCounter` handles zero / skipped counters correctly.
   - `provisionHandlerSa` is idempotent when the SA already exists (409).
3. **`packages/deployer/src/service-namer.ts`**
   - `handlerSaEmail` respects the 30-char Cloud Run SA limit across edge cases.
   - `sanitizeShopPrefix` strips non-legal chars deterministically.
4. **`apps/api/src/lib/shopify-session-token.ts`** — signature valid / invalid / expired / wrong audience.
5. **`apps/api/src/lib/shopify-app-proxy.ts`** — signature valid / invalid, timestamp skew window, array-param canonicalization.
6. **`apps/api/src/lib/sa-to-app.ts`** — TTL eviction, explicit invalidation, null-not-cached.
7. **`packages/email/src/sender.ts`** — quota throw, suppression skip, missing-config skip, provider-failed outcome.
8. **`packages/deployer/src/sql-validator.ts`** — forbidden patterns caught; `makeIdempotent` rewrites correctly.

### Integration tests — platform-back apps
Run against a disposable Postgres + a mocked Resend + a mocked Cloud Run
client. Not run on every commit, but required on the PR that merges the
refactor branch.

1. **Admin edge → handler forward** — post to `/admin/:appId/:path` with a valid App Bridge JWT; assert ID-token minted, headers stamped, upstream receives the expected path.
2. **Widget edge → handler forward** — post to `/widget/:appId/:path` with a valid App Proxy signature; assert `X-Customer-Id` present when `logged_in_customer_id` is signed, absent for guests.
3. **`/services/email/send`** — ID-token verified → SA mapped to app → email routed through renderer → delivery row written. Cover: suppressed recipient, quota exhausted (429), missing config (200 skipped).
4. **`/services/email/send-batch`** — 207 Multi-Status; per-item 200/429/500; quota hits stop further sends with accurate `{limit, current}`.
5. **Resend bounce webhook** — Svix HMAC validated, suppression row inserted, delivery status updated.
6. **OAuth install → callback** — full flow writes `tenants` + mints platform JWT + redirects.
7. **Deploy pipeline** — stub Cloud Run + Docker; orchestrator runs all 8 steps; state transitions visible via SSE; `deployed_functions` row written; cron registration attempted when `cronSchedule` is set.
8. **Webhook worker → handler** — enqueue a job via webhook-gateway, worker dequeues, calls handler's `/webhook/:topic` with the new envelope, idempotency gate (`processed_webhooks ON CONFLICT`) blocks the duplicate.
9. **pg_cron smoke** — `scheduleAppCron` against a real Postgres with pg_cron enabled; assert `cron.job` row appears; assert a `cron_queue` row arrives after a tick (requires waiting one cron cycle, so gate this test behind an env flag for selective runs).

### CI pipeline additions

Add to `.github/workflows/` (or equivalent):

1. **`platform-back-lint-and-typecheck.yml`** — runs on every PR touching `platform-back/**`:
   - `pnpm install --frozen-lockfile`
   - `pnpm -r build` (catches type regressions across the workspace)
   - `pnpm -r lint`
2. **`platform-back-unit.yml`** — same trigger:
   - `pnpm -r test` (unit tests, no external services)
3. **`platform-back-integration.yml`** — triggered on PRs to `main` or explicit label:
   - Spins up Postgres with pg_cron enabled (Docker service).
   - Spins up a fake Resend server (node mock) + fake Cloud Run client.
   - Runs integration suite.
4. **`platform-ai-tests.yml`** — Python generator's existing pytest suite; runs on PRs that touch `platform-ai/**`.

### Coverage targets (guidance, not blocking)

- Unit: 70%+ line coverage on the deployer + auth + sa-to-app + email packages.
- Integration: every public `/services/*`, `/admin/*`, `/widget/*`, `/webhook/*` route must have at least one happy-path + one error-path test.

## First end-to-end milestone (admin-only)

Unblocked today. Validation checklist:

1. Start fresh: DB migrated, pg_cron flag on, platform-back deployed, generator running.
2. Install the app on a test Shopify store → OAuth completes → tenant row exists.
3. Generate an admin-only app (e.g. image-review scan) via the dashboard.
4. Click Deploy → watch `/deploy/jobs/:jobId` SSE → all 8 steps succeed.
5. Open the app in Shopify admin → iframe hits `/admin/:appId/*` → handler responds.
6. Trigger an action that calls `/services/email/send` → email arrives at test inbox → `email_deliveries` row in `sent` state.

When this loop passes, the refactor's core thesis is validated and the
archetype-blocking work (widget, webhook, cron) becomes incremental
additions rather than architectural risk.
