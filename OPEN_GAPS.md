# Open Gaps — refactor-to-standalone-app-backends

Snapshot as of `853923f`. Items are grouped by what they block; each entry
names the concrete next action.

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


1. **Admin edge → handler forward** — post to `/admin/:appId/:path` with a valid App Bridge JWT; assert ID-token minted, headers stamped, upstream receives the expected path.
2. **Widget edge → handler forward** — post to `/widget/:appId/:path` with a valid App Proxy signature; assert `X-Customer-Id` present when `logged_in_customer_id` is signed, absent for guests.
3. **`/services/email/send`** — ID-token verified → SA mapped to app → email routed through renderer → delivery row written. Cover: suppressed recipient, quota exhausted (429), missing config (200 skipped).
4. **`/services/email/send-batch`** — 207 Multi-Status; per-item 200/429/500; quota hits stop further sends with accurate `{limit, current}`.
5. **Resend bounce webhook** — Svix HMAC validated, suppression row inserted, delivery status updated.
6. **OAuth install → callback** — full flow writes `tenants` + mints platform JWT + redirects.
7. **Deploy pipeline** — stub Cloud Run + Docker; orchestrator runs all 9 steps; state transitions visible via SSE; `deployed_functions` row written; webhook subscriptions reconciled when `webhookTopics` is set; cron registration attempted when `cronSchedule` is set.
8. **Webhook worker → handler** — enqueue a job via webhook-gateway, worker dequeues, calls handler's `/webhook/:topic` with the new envelope, idempotency gate (`processed_webhooks ON CONFLICT`) blocks the duplicate.
9. **pg_cron smoke** — `scheduleAppCron` against a real Postgres with pg_cron enabled; assert `cron.job` row appears; assert a `cron_queue` row arrives after a tick (requires waiting one cron cycle, so gate this test behind an env flag for selective runs).

### Coverage targets (guidance, not blocking)

- Unit: 70%+ line coverage on the deployer + auth + sa-to-app + email packages.
- Integration: every public `/services/*`, `/admin/*`, `/widget/*`, `/webhook/*` route must have at least one happy-path + one error-path test.

## First end-to-end milestone (admin-only)

Unblocked today. Validation checklist:

1. Start fresh: DB migrated, pg_cron flag on, platform-back deployed, generator running.
2. Install the app on a test Shopify store → OAuth completes → tenant row exists.
3. Generate an admin-only app (e.g. image-review scan) via the dashboard.
4. Click Deploy → watch `/deploy/jobs/:jobId` SSE → all 9 steps succeed.
5. Open the app in Shopify admin → iframe hits `/admin/:appId/*` → handler responds.
6. Trigger an action that calls `/services/email/send` → email arrives at test inbox → `email_deliveries` row in `sent` state.

When this loop passes, the refactor's core thesis is validated and the
archetype-blocking work (widget, webhook, cron) becomes incremental
additions rather than architectural risk.
