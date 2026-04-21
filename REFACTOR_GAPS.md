# Refactor Gap Analysis

**Branches compared**
- **OLD (authoritative)**: `claude/architect-required-capabilities` — single-harness architecture, under `platform/`
- **NEW (current)**: `feature/refactor-to-standalone-app-backends` — per-app Cloud Run services, under `platform-back/`

**Goal of this doc.** Enumerate every feature the refactor silently dropped so we can
schedule catch-up work deliberately. Not every gap must be closed before shipping —
some features (billing, compliance webhooks) were never end-to-end live on OLD either.
The list is grouped by area, then sorted into three tiers at the bottom.

> Out of scope here: doc drift (`docs/*.md` may still describe OLD behaviour),
> prompt-system changes, and UI-only cleanup.

---

## 1. Dashboard API routes — `apps/api/src/routes/`

OLD `platform/apps/api/src/routes/tenants.ts` bundled tenant + app CRUD into one
router. That file has **no counterpart** on NEW. Every call the dashboard makes
under `/tenants/...` currently 404s.

### Tenant-level (missing on NEW)

- **POST `/tenants`** — create tenant
  - OLD: `platform/apps/api/src/routes/tenants.ts:104`
  - Impact: onboarding blocked; no way to materialise a tenant row from the dashboard.
  - Architecture: stays a single backend call; the per-app refactor didn't change tenant-shape.

- **GET `/tenants/:tenantId`** — fetch tenant row (plan, shop domain, subscription state)
  - OLD: `tenants.ts:123`
  - Impact: dashboard root page cannot load; plan/upgrade affordances hide.

- **GET `/tenants/:tenantId/stats`** — aggregate stats widget
  - OLD: `tenants.ts:140`
  - Impact: stats cards on the dashboard show nothing.
  - Architecture: per-app Cloud Run means stats are now scattered; the route needs a DB-side aggregator.

- **GET `/tenants/:tenantId/logs`** — all webhook invocations across this tenant
  - OLD: `tenants.ts:479`
  - Impact: tenant-level audit log view empty.

### App-level (missing on NEW)

- **GET `/tenants/:tenantId/apps`** — list apps for tenant
  - OLD: `tenants.ts:158`
  - Impact: app picker / sidebar list is empty even if apps exist in DB.

- **POST `/tenants/:tenantId/apps`** — create app (provision SA, row, shell)
  - OLD: `tenants.ts:176`
  - Impact: cannot create apps from the UI.
  - Architecture: NEW must also call `provisionHandlerSa` up front (per-app SA) before first deploy.

- **GET `/tenants/:tenantId/apps/:appId`** — fetch single app (name, archetype, status, email cfg, etc.)
  - OLD: `tenants.ts:224`
  - Impact: app-detail page is blank.
  - Architecture: `db.getAppById` signature must change from `(appId)` back to `(tenantId, appId)` for defence-in-depth.

- **PATCH `/tenants/:tenantId/apps/:appId`** — rename + status flip (active/inactive/deleted)
  - OLD: `tenants.ts:245`
  - Impact: can't rename, deactivate, or soft-delete from the UI.
  - Architecture: status change has to drive `teardownApp` / `reactivateApp` in the deployer (below).

- **DELETE `/tenants/:tenantId/apps/:appId`** — permanent delete (hard)
  - OLD: `tenants.ts:311`
  - Impact: UI trash-icon → Permanent Delete 404s today.
  - Architecture: on NEW this must delete the per-app SA + Cloud Run service + cron registrations + GCS files (see §4) + rollback tenant-scoped tables (see §6). Much larger than on OLD.

- **GET `/tenants/:tenantId/apps/:appId/widget-logs`**
  - OLD: `tenants.ts:328`
  - Impact: widget log view empty.

- **GET `/tenants/:tenantId/apps/:appId/admin-logs`**
  - OLD: `tenants.ts:346`
  - Impact: admin log view empty.

- **GET `/tenants/:tenantId/apps/:appId/theme-templates`** — list injectable themes
  - OLD: `tenants.ts:365`
  - Impact: theme injection UI can't load templates.
  - Architecture: wraps a Shopify REST call — candidate for `/services/shopify` instead of `/tenants/...`.

- **POST `/tenants/:tenantId/apps/:appId/inject-theme`** — inject test theme
  - OLD: `tenants.ts:394`
  - Impact: widget-test flow blocked.

- **DELETE `/tenants/:tenantId/apps/:appId/inject-theme`** — remove test theme
  - OLD: `tenants.ts:443`
  - Impact: dummy themes pile up in merchant stores.

### NEW routes not in OLD (informational, no gap)

- `/services/email`, `/services/files`, `/services/shopify` — per-refactor service layer
- `/apps/:appId/generations/:jobId/deploy` — new deploy-bridge using persisted `generations` row
- `/webhook/resend` — Resend delivery webhook handler

---

## 2. Frontend → backend orphaned calls

Every line in `platform-front/src/lib/api.ts` that targets a missing NEW route:

| Frontend call | Resolves to | NEW status |
|---|---|---|
| `api.tenants.get` | `GET /tenants/:id` | missing |
| `api.tenants.create` | `POST /tenants` | missing |
| `api.tenants.stats` | `GET /tenants/:id/stats` | missing |
| `api.tenants.logs` | `GET /tenants/:id/logs` | missing |
| `api.apps.list` | `GET /tenants/:tid/apps` | missing |
| `api.apps.get` | `GET /tenants/:tid/apps/:aid` | missing |
| `api.apps.create` | `POST /tenants/:tid/apps` | missing |
| `api.apps.rename` | `PATCH /tenants/:tid/apps/:aid` | missing |
| `api.apps.setStatus` | `PATCH /tenants/:tid/apps/:aid` | missing |
| `api.apps.delete` | `PATCH .../apps/:aid` status=deleted | missing |
| `api.apps.permanentDelete` | `DELETE /tenants/:tid/apps/:aid` | missing |
| `api.apps.widgetLogs` | `GET .../apps/:aid/widget-logs` | missing |
| `api.apps.adminLogs` | `GET .../apps/:aid/admin-logs` | missing |
| `api.apps.getThemeTemplates` | `GET .../apps/:aid/theme-templates` | missing |
| `api.apps.injectTheme` | `POST .../apps/:aid/inject-theme` | missing |
| `api.apps.deleteInjectedTheme` | `DELETE .../apps/:aid/inject-theme` | missing |
| `api.billing.usage` | `GET /billing/usage/:id` | missing (see §7) |
| `api.billing.subscribe` | `POST /billing/subscribe` | missing |
| `api.billing.cancel` | `POST /billing/cancel/:id` | missing |
| `api.billing.plans` / dashboard / analytics | `GET /billing/*` | missing |

The practical read: **the dashboard mostly cannot reach the backend** outside of
OAuth, deploy, email config, and the generation lifecycle. Whatever the UI
renders today is coming from OAuth-minted JWT state + stale caches.

---

## 3. Deployer lifecycle functions — `packages/deployer/src/`

NEW exports granular steps (`buildAndPushImage`, `deployToCloudRun`,
`provisionHandlerSa`, `writeHandlerSaEmail`, `runMigrations`, `registerWebhooks`,
`scheduleAppCron`) tied together by `startDeploy` in `orchestrator.ts`. That
covers the happy deploy path. What's gone:

- **`teardownApp(tenantId, appId)`** — stop serving, keep row
  - OLD: `platform/packages/deployer/src/index.ts`
  - Need on NEW: unregister Shopify webhooks + `deleteCloudRunService` + `unscheduleAppCron` + `deleteServiceAccount` (per-app SA is new to this branch).
  - Impact: PATCH status=inactive has no infra-side effect; SA + Cloud Run service keep running.

- **`reactivateApp(tenantId, appId)`** — reverse of teardown
  - OLD: `platform/packages/deployer/src/index.ts`
  - Need on NEW: re-provision SA (idempotent) + re-deploy the most recent `deployed_functions` image + re-register webhooks + re-schedule cron.
  - Impact: soft-deleted apps are one-way until this lands.
  - Wrinkle: NEW's deploy orchestrator rebuilds the image from scratch; reactivation should redeploy the existing image (no rebuild). Needs a `deployExistingImage` fast path.

- **`permanentDeleteApp(tenantId, appId)`** — full removal
  - OLD: `platform/packages/deployer/src/index.ts:451`
  - Need on NEW: `teardownApp` + GCS files batch-delete + tenant-table rollback (see §6) + `hardDeleteApp` row cascade.
  - Impact: UI's DELETE button is a no-op; storage, SAs, Cloud Run services, Docker images leak forever.

- **`unregisterShopifyWebhooks(...)`** — used by teardown / delete / redeploy cleanup
  - OLD: `platform/packages/deployer/src/shopify-webhook-registrar.ts:143`
  - Need on NEW: add to `webhook-registrar.ts` next to the existing `registerWebhooks`.

- **`deleteDockerImage(imageName)` / `getAppVersionSemvers(appId)`**
  - OLD: Artifact Registry cleanup called during permanent delete.
  - Need on NEW: add to `build-image.ts` + `db/generations.ts` (or `handlers.ts`).
  - Impact: every deleted app leaves its image tags in Artifact Registry — cost-only, not GDPR.
  - Priority: low.

- **`rollbackTenantMigration(tenantId, sql)`** — reverse an app's schema SQL
  - OLD: `platform/packages/deployer/src/index.ts`
  - Need on NEW: see §6 — this is the hard one.

### NEW helpers that already exist (don't re-invent)

- `deleteCloudRunService(appId)` — `cloud-run-ops.ts:135` ✅
- `deleteServiceAccount(accountId)` — `iam-ops.ts:105` ✅
- `unscheduleAppCron(input)` — `cron-scheduler.ts` ✅
- `grantCloudRunInvoker` — `iam-ops.ts` ✅

---

## 4. GCS files cleanup — new concern in the refactor

Files service landed **after** the architect branch so there's no prior art.

- **Eager GCS cleanup on app delete** — missing entirely
  - Needs: `SELECT gcs_object FROM files WHERE tenant_id=$1 AND app_id=$2` → batch-delete from GCS with bounded concurrency (~50) → let the cascade drop the rows.
  - Must run *before* the `hardDeleteApp` cascade wipes the `files` rows (we need `gcs_object`).
  - Rationale: FK cascade drops DB rows but GCS objects persist → GDPR hole + cost.
  - Existing helper: `deleteObject(gcsObject)` in `@platform-back/files` — single-object. Needs a batched wrapper.

- **Tenant-level GCS cleanup** — also missing
  - When the tenant row itself is deleted (not yet a flow; see §5), the same pattern applies at tenant scope.

---

## 5. Uninstall / compliance webhooks

Neither OLD nor NEW is fully wired here, but the refactor didn't regress anything
— both are empty. Listed so we don't forget:

- **`app/uninstalled` webhook handler** — not present on either branch
- **`shop/redact` (GDPR)** — not present
- **`customer/redact` (GDPR)** — not present
- **Tenant hard-delete admin tool** — not present

Priority depends on whether we're going public with Shopify review or staying
custom-distribution. Custom distribution → low priority. Public listing → Shopify
requires the two redact webhooks to pass review.

---

## 6. Tenant-schema lifecycle — the awkward one

This is the blocker the user called out. Shape of the problem:

- NEW `migration-runner.ts` creates schemas named `tenant_<uuid>` and applies app-authored SQL into them (`CREATE SCHEMA IF NOT EXISTS tenant_...; SET search_path; <migration sql>`).
- Multiple apps under the same tenant share that schema, so **dropping the schema on app-delete would nuke sibling apps' tables**.
- OLD had `rollbackTenantMigration(tenantId, sqlForThisApp)` — it ran the app's migration SQL *in reverse*. That worked because OLD stored the migration SQL on the `app_versions` row.
- NEW doesn't store per-app migration SQL anywhere accessible at teardown time — `generations.bundle` JSON has `dbMigration`, but:
  1. only for the most recent generation (revisions replace it),
  2. the SQL is forward-only with no reverse SQL stored,
  3. the deployer currently doesn't persist the executed migration anywhere queryable.

### Three realistic solutions

**A. Persist the migration SQL forward AND reverse on `deployed_functions` (or `app_versions`).**
   Generator produces both directions; deployer stores both; teardown reads the latest
   reverse SQL and runs it. Aligns with OLD's mental model. Generator changes needed
   (prompts + validator + bundle schema). Medium effort.

**B. Record DDL diffs in a `tenant_schema_changelog` table during `runMigrations`.**
   Intercept `CREATE TABLE` / `ALTER TABLE` and log enough metadata to reverse them.
   Teardown reads the log and issues `DROP TABLE` / reverse `ALTER`. No generator
   change. Low-effort for table creation; brittle for complex migrations (indexes,
   triggers, constraints with FKs between apps).

**C. Hard-segregate per-app tables with a naming prefix + drop-by-prefix on teardown.**
   Generator prompt already emits `CREATE TABLE <table_name>` without prefix — would
   need to enforce `CREATE TABLE app_<appId>_<name>` in static validation.
   Teardown runs `DROP TABLE` for everything matching `app_<appId>_%` in the tenant
   schema. Simple, robust, but requires a breaking change to table-naming convention.
   Any existing deployed app that has un-prefixed tables stays orphaned.

**D (fallback). Leak them.** On app-delete, leave tenant tables in place. Rely on
   tenant-level cleanup when the tenant itself gets deleted (which is also not
   implemented — see §5). Quota-visible but not GDPR-visible as long as data
   stays in `tenant_<tenantId>` schema.

**Recommendation.** Start with **A** — it matches the generator's existing bundle
shape and requires only additive work. Prompt the generator to produce a `rollback`
SQL block alongside `dbMigration`; store both on `deployed_functions`; teardown
reads and runs. Has the side benefit of being the right mechanism for a future
"revert to previous version" affordance.

---

## 7. DB helpers — `packages/db/src/`

Missing exports needed to make the routes above work:

- **`updateAppStatus(appId, status)`** — backs PATCH
- **`hardDeleteApp(appId)`** — handles the 2 `ON DELETE RESTRICT` FKs (`webhook_subscriptions.deployed_function_id`, `deployed_functions.app_version_id`): delete `webhook_subscriptions` → `deployed_functions` → `apps` in that order, then cascades handle the rest (`files`, `app_versions`, `generations`, logs)
- **`getActiveWebhookSubscriptionsForApp(appId)`** — feeds `unregisterShopifyWebhooks` on teardown + redeploy
- **`getAppVersionSemvers(appId)`** — feeds `deleteDockerImage` during permanent delete
- **`getLatestMigrationSqlForApp(appId)`** — required by §6-A (or replaced by that work's new schema)
- **`getAppById(tenantId, appId)`** — current signature is `(appId)` only; switch to tenant-scoped so a compromised caller can't read other tenants' rows
- **`listAppsForTenant(tenantId)`** — backs GET apps list
- **`createApp(tenantId, ...)`** — backs POST apps

### Generation analytics (used by billing dashboard — §8)

- `trackGeneration(tenantId)` — missing
- `trackRevision(tenantId)` — missing
- `storeRevisionClassification(...)` — missing
- Migration schema has a `revision_classifications` table for this — helper not wired.

---

## 8. Billing plumbing

Everything under `/billing/*` is gone on NEW. `docs/BILLING.md` describes this
surface as "Wired" but that doc predates the refactor. Routes missing:

- `GET /billing/plans` — list plans + current
- `GET /billing/usage/:tenantId` — current-period counters vs limits
- `POST /billing/subscribe` — mint Shopify confirmation URL
- `GET /billing/callback` — Shopify post-approval redirect
- `POST /billing/cancel/:tenantId` — downgrade to free
- `POST /billing/webhook` — `APP_SUBSCRIPTIONS_UPDATE` handler (HMAC-verified)
- `GET /billing/dashboard/:tenantId` — aggregated view
- `GET /billing/analytics/:tenantId` — revision classification breakdown

Impact: no upgrade/downgrade flow. Any merchant on the dashboard today stays
whatever plan the `billing_plan` column says (defaults to `free`).

Priority depends on whether we want to charge anyone for MVP. If yes → Tier 1.
If custom-distribution / comped tenants only → Tier 3.

---

## 9. OAuth flow — mostly intact

OAuth (`/oauth/install`, `/oauth/callback`) is ported. Gaps observed:

- OLD had a "link to dashboard with JWT" final step. NEW does the same but relies
  on `DASHBOARD_URL` env, which is set differently per environment. Not a functional
  gap — just worth confirming each env file has it right.
- OAuth does not write a tenant with plan-appropriate defaults (since §1 POST
  `/tenants` is missing, OAuth is currently the **only** tenant-creation path —
  should be confirmed).

---

## 10. Email service

Mostly ported with the same contract on `/email/*`. The addition of
`/services/email/*` is a NEW-only surface for in-handler programmatic sends.

- ✅ config GET/PUT/test/stats — ported
- ✅ brand GET/PUT — ported
- ✅ `/email/u/*` (unsubscribe) — registered in `server.ts` as `emailPublicRoutes`
- ✅ `/webhook/resend` — NEW, not in OLD
- ✅ `/services/email/send` + `/send-batch` — NEW

No regressions spotted.

---

## 11. Widget / admin proxy

Both `/widget/*` and `/admin/*` wildcard proxies are ported. Per-app Cloud Run
means each call now routes to a different URL (resolved via
`deployed_functions.function_url`) — the proxy logic handles that fine.

No gaps identified.

---

## 12. Webhook gateway — `apps/webhook-gateway/`

Core receiver + queue + idempotency + quota is ported. Noted drift:

- Log-field volume is lower on NEW vs OLD (fewer correlation fields in structured
  logs) — observability nuance, not functional.
- Retry policy (backoff + max-attempts) — verify on both branches that the logic
  matches. Not audited here.

---

## 13. Tests

Not audited line-by-line. Obvious coverage drops:

- Nothing maps to OLD's `routes/tenants.test.ts` because the routes don't exist.
- Deployer has per-function tests (sa-provisioner, cron-scheduler, sql-validator,
  service-namer) but **no lifecycle test** covering teardown/reactivate/permanent-delete.
- `files-service.integration.test.ts` is actually a route-contract test (all
  mocks) — flagged in prior review.

---

## 14. Files service — open issues

These surfaced reviewing commits `9a1233a` (resumable upload) and `0cd2e4a`
(tests) against `docs/FILES_INTEGRATION.md`. Items covered elsewhere in this
doc (§4 GCS cleanup on app-delete; §13 the "integration" tests are all mocks)
are omitted here — do not duplicate-fix.

### Correctness / security

- **Resumable path doesn't actually reserve quota.** `create-upload-url`
  pre-checks `getTenantStorageUsage(tenantId) + expectedSizeBytes > limit`,
  but `getTenantStorageUsage` only sums `status='active'` rows — `pending`
  rows (reserved-but-not-finalized uploads) are invisible. Two concurrent
  `create-upload-url` calls both read usage=X, both insert pending rows of
  ~600 MiB against a 1 GiB cap, and a third call right after still sees
  usage=X and accepts another 600 MiB. Fix: include `'pending'` in the
  usage sum, or do an atomic reserve. Files: `packages/db/src/files.ts:200-209`,
  `apps/api/src/routes/services/files.ts:416-430`.

- **Quota race on the inline path.** Same shape as above but on `/upload`:
  `getTenantStorageUsage` + decision + GCS put + DB insert with no lock,
  so concurrent uploads that each fit can collectively overflow. Fix: atomic
  `INSERT … WHERE (SELECT SUM…) + new.size_bytes ≤ limit`, or
  `pg_advisory_xact_lock(tenantId)`. Files: `apps/api/src/routes/services/files.ts:218-232`.

- **No compensating GCS delete on DB-insert failure.** Inline path writes
  to GCS, then inserts the DB row. If the insert fails, the code logs
  `"object now orphaned"` and returns 500 — the GCS object stays forever
  (until a future orphan sweeper that doesn't exist for the inline path).
  Fix: best-effort `deleteObject(gcsObject)` in the catch.
  File: `apps/api/src/routes/services/files.ts:231-239`.

- **`finalize-upload` trusts GCS-reported size blindly.** Handler reserves
  10 MiB, PUTs 9 MiB of *different* content than intended — nothing checks.
  Not a "bug" exactly; the contract is "whatever GCS accepted is truth."
  Worth either a code comment acknowledging this, or an MD5/sha verification
  against a handler-supplied hash. File: `apps/api/src/routes/services/files.ts:550-563`.

- **`finalizeFile` race on double-finalize.** Two concurrent finalize calls
  both pass the SELECT, both run the UPDATE. Current outcome is harmless
  (same size) but if the GCS object were replaced between calls, the
  second update would clobber. Fix: advisory lock keyed on `fileId`.
  File: `packages/db/src/files.ts:91-111`.

### SDK / handler contract

- **`QuotaExceeded` reuses email-quota semantics on files path.** SDK does
  `throw new QuotaExceeded(e.limitBytes, e.usedBytes, null)` but the class
  constructor emits `"Monthly quota exceeded (${limit})"` and names its
  third field `resetsAt` — neither applies to a non-resetting storage
  quota. Logs will say "Monthly quota exceeded" for a permanent storage
  cap. Fix: a dedicated `StorageQuotaExceeded` class, or add `kind:
  "email" | "storage"` + a neutral message. File:
  `templates/handler/src/lib/platform.ts:3-12, 113, 129, 170`.

- **SDK resumable path: `PayloadTooLarge` fallback is a magic number.**
  `throw new PayloadTooLarge(((body as { limitBytes?: number }).limitBytes
  ?? RESUMABLE_THRESHOLD_BYTES * 20))`. The backend's Zod 400 for oversize
  returns `{ error: "invalid_request", details }` without `limitBytes`, so
  the fallback (`25 MiB * 20 = 500 MiB-ish`) always fires. Fix either side:
  backend returns `{ error: "payload_too_large", limitBytes: MAX_RESUMABLE_BYTES }`
  on oversize (matching inline-path 413), or SDK imports/duplicates
  `MAX_RESUMABLE_BYTES` for the fallback. File:
  `templates/handler/src/lib/platform.ts:174-179`.

- **SDK resumable path has no rollback on PUT / finalize failure.** If the
  PUT to GCS fails after `create-upload-url` succeeded, the `pending` row
  holds quota until orphan-GC sweeps it (up to 2 h later). Fix: add
  `/cancel-upload` backend route + SDK try/finally that calls it on PUT/
  finalize error. File: `templates/handler/src/lib/platform.ts:195-217`.

- **Threshold boundary off-by-one.** SDK switches at `< 25 MiB` (resumable
  for exact-25 MiB); backend inline route rejects `> MAX_FILE_BYTES` (allows
  exact-25 MiB). Picks different paths for the same exact-boundary buffer.
  Pick one boundary and align. Files:
  `templates/handler/src/lib/platform.ts:91,99`;
  `apps/api/src/routes/services/files.ts:212`.

### Orphan GC

- **GC runs on every replica with no locking.** `getStalePendingFiles` is
  `SELECT … ORDER BY created_at LIMIT 200` — every replica reads the same
  200 rows and races on `deleteObject`. GCS's `ignoreNotFound: true` saves
  us from hard failure, but every replica still burns a round trip per
  row. Fix: `SELECT … FOR UPDATE SKIP LOCKED` or claim via `UPDATE …
  RETURNING`. Low severity at single-replica; the inline code comment
  "SQL is idempotent … duplicates are harmless" is misleading.
  File: `apps/api/src/lib/files-orphan-gc.ts:24-25,70-95`.

- **First GC sweep is delayed by a full interval (1 h).** The comment says
  "first sweep after a short delay so app boot finishes" but the code only
  calls `setInterval` — which fires at T+1h, not at boot. Restart-heavy
  environments never sweep. Fix: kick an initial sweep on `startOrphanGc`
  after a ~60s delay. File: `apps/api/src/lib/files-orphan-gc.ts:45-62`.

### Billing / UX polish

- **`files_uploaded` usage counter never incremented.** `usage_records`
  has a `files_uploaded INTEGER` column (migration:391) but upload
  handlers never `incrementUsage(tenantId, 'files_uploaded')`. Billing
  dashboard will always show 0. Fix: call `incrementUsage` alongside the
  successful insert. File: `apps/api/src/routes/services/files.ts:262-300, 586-595`.

- **All downloads forced as `Content-Disposition: attachment`.** Signing
  hard-codes attachment for every MIME, including `image/{png,jpeg,webp}`.
  Admin UIs rendering images inline can't. Fix: take a `disposition:
  "attachment" | "inline"` hint in `signReadUrl`, or default images to
  `inline`. File: `packages/files/src/index.ts:104`.

### Minor

- **Fastify's own 413 doesn't match the spec shape.** Requests over the
  40 MiB route-level bodyLimit are rejected by Fastify's default error
  handler as `{ code, message }`, not `{ error: "payload_too_large",
  limitBytes }`. SDK constructs `new PayloadTooLarge(undefined)`. Fix:
  translate in `setErrorHandler`, or map `undefined → MAX_FILE_BYTES` in
  the SDK. File: `apps/api/src/server.ts:99-123`.

- **`Buffer.from(base64)` never throws — catch block is dead.** Node
  silently drops invalid chars, so malformed base64 produces wrong bytes
  rather than a 400. Low severity; spec doesn't mandate strict validation.
  Either delete the catch, or validate with a regex up front.
  File: `apps/api/src/routes/services/files.ts:168-174`.

- **Always-on handler prompt mentions `QuotaExceeded` without distinguishing
  email vs storage.** While capability docs for `files` are JIT-injected,
  the always-on SDK section lists `QuotaExceeded` generically — see the
  semantics mismatch above. Adjust prompt when the class is clarified.
  File: `platform-ai/subagents/prompts/topics/handler.py:163-177`.

---

## Tiered punch list

**Tier 1 — blocks the UI working at all**
1. Port `/tenants/...` router: tenant CRUD + app CRUD (§1)
2. Tenant-scope the `getAppById` signature (§7)
3. `hardDeleteApp` + `updateAppStatus` + `getActiveWebhookSubscriptionsForApp` DB helpers (§7)
4. Deployer `teardownApp` + `permanentDeleteApp` (§3)
5. GCS cleanup step in `permanentDeleteApp` (§4)
6. Tenant-schema rollback mechanism — pick path A/B/C (§6)
7. Wire PATCH soft-delete (status=deleted → teardownApp) + DELETE hard-delete

**Tier 2 — observability + reactivation**
8. widget-logs / admin-logs / tenant-logs routes (§1)
9. `reactivateApp` + `deployExistingImage` fast path (§3)
10. Theme-template + inject-theme routes (§1) — consider relocating to `/services/shopify`
11. `stats` aggregator route (§1)
12. Lifecycle tests for teardown / reactivate / permanent-delete (§13)

**Tier 3 — billing, compliance, cost**
13. Billing routes + `trackGeneration` / `trackRevision` / `storeRevisionClassification` DB helpers (§7, §8)
14. `app/uninstalled` + `shop/redact` + `customer/redact` webhook handlers (§5)
15. Tenant hard-delete admin tool (§5)
16. Artifact Registry cleanup: `deleteDockerImage` + `getAppVersionSemvers` (§3)
17. Idempotency for `runMigrations` re-runs (§6, nice-to-have)

---

## Suggested next moves

1. **Close §6 first with path A.** Everything in Tier 1 downstream of
   `permanentDeleteApp` depends on having a schema rollback story. Until that's
   picked, DELETE /apps can only be shipped in "leak tenant tables" mode.
2. **Port `/tenants/...` router as one focused commit.** Most of Tier 1 lands
   together; keeps review scope tight. Generator/prompt changes deferred.
3. **Hold on billing and compliance webhooks.** Neither blocks dog-fooding.
   Schedule after Tier 1 ships.
