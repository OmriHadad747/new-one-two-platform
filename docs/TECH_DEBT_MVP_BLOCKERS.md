# Tech Debt — MVP Blockers

Items that must land before MVP launch. Each entry has the affected files and what needs to happen.

---

## TD-009 — Cron scheduling: Cloud Scheduler integration not yet implemented

**Current state**
`cronSchedule` is generated, stored in the DB, and passed through the deployer metadata — but
nothing ever fires it. Cron apps deploy successfully but never execute.

**What to do**
In `platform/packages/deployer/src/index.ts`, after writing the deployed function, call
`@google-cloud/scheduler` to create/update a Cloud Scheduler job pointing at
`${functionUrl}/invoke` with a synthetic payload `{ topic: 'cron', tenantId, appId }`.
On redeploy: update the existing job. On app delete: delete the job.
Local dev (`DEPLOY_MODE=local`): skip Scheduler creation entirely — trigger `/invoke` manually.

When this lands, the harness-runtime `InvokeRequestSchema` (apps/harness-runtime/src/server.ts) will need to accept the cron-synthetic shape — either as a schema union or by making the Shopify-specific fields (`shopifyWebhookId`, `rawBodyBase64`, `headers`, `receivedAt`) optional with `topic === "cron"` as the discriminator.

**Scale ceiling:** Cloud Scheduler supports 4,000 jobs/project. Fine for MVP and growth.
Beyond that, migrate to a single internal cron-dispatcher service that polls the DB and
enqueues to the existing BullMQ queue — same worker, no new execution infrastructure.

---

## TD-021 — platform-front deploy-progress UI

**Current state**
The legacy `platform/` runs deploys synchronously inside `deployFeatureBundle` and the dashboard waits on the HTTP response. In the new `platform-back/` architecture, per-app deploys are async: `POST /apps/:appId/deploy` will return a `{ jobId }` immediately and the dashboard is expected to poll or open an SSE on `GET /deploy/jobs/:jobId` for progress events. Cloud Run deploys take 1–3 minutes — too long for a sync request.

The platform-back side of this contract is on the phase-1 plan (step 2: provisioning). The `platform-front` side has nothing yet — there's no "Deploy" button wired to the new endpoint, no progress view, no terminal-state routing.

**What to do**
- Add a "Deploy" button on `AppDetailPage` (or wherever app actions live), wired to `POST /apps/:appId/deploy`.
- On 200, store the returned `jobId` and switch to a streaming-progress view.
- Render the progress steps (build context → image build → SA grant → migration job → Cloud Run deploy → DB writes), each with a per-step state (pending / running / done / failed).
- On terminal `success`, route to the deployed-app screen. On terminal `failed`, route to an error log view.
- Match the transport `platform-front` already uses for generation progress (likely SSE) so the existing connection / re-connection plumbing can be reused.

**Affected files** (when done)
- `platform-front/src/pages/AppDetailPage.tsx` — Deploy button + progress view.
- `platform-front/src/api/deploy.ts` (or equivalent) — typed wrapper around `POST /apps/:appId/deploy` and the progress stream.
- `platform-front/src/types/dashboard.ts` — `DeployJob`, `DeployStep`, `DeployStepStatus` types.

**Complexity:** Low — same shape as the existing generation-progress UI. Blocked on platform-back shipping the deploy endpoint + job-id stream first.

---

## TD-022 — Shopify uninstall + GDPR compliance webhooks not wired

**Current state**
Neither the OLD nor the NEW branch handles any of the Shopify lifecycle / compliance webhooks:
- `app/uninstalled` — no handler; when a merchant uninstalls, platform state is never cleaned up.
- `shop/redact` — no handler; GDPR shop-data redaction requests are silently dropped.
- `customer/redact` — no handler; GDPR customer-data redaction requests are silently dropped.

A "tenant hard-delete admin tool" also doesn't exist — there is no way to wipe a tenant's data from the platform.

**Why it matters**
`shop/redact` and `customer/redact` are **required by Shopify** to pass app review for public or unlisted distribution. Without them the app cannot be listed. `app/uninstalled` is needed to keep billing state and GCS storage in sync when a merchant leaves.

**What to do**
1. Register the three webhook topics in the OAuth install flow (Shopify requires them to be declared at install time).
2. Add a `/webhook/shopify` route (or extend the gateway) to receive HMAC-verified Shopify app lifecycle webhooks.
3. `app/uninstalled` handler: cancel the Shopify subscription (if any), call `teardownApp` + `permanentDeleteApp` for each app, and mark the tenant inactive.
4. `shop/redact` handler: delete tenant row + all associated data (same as tenant hard-delete). Must run within 30 days of the request per Shopify policy.
5. `customer/redact` handler: forward to each of the tenant's handler Cloud Run services so app-layer customer data can be scrubbed.
6. Implement a `deleteTenant(tenantId)` helper in `@platform-back/deployer` that orchestrates: `permanentDeleteApp` for each app → GCS tenant-prefix wipe → DB tenant row delete (cascades).

**Priority**
Custom distribution (current mode) → low. Public/unlisted Shopify listing → blocks app review.