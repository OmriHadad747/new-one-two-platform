# Tech Debt

Items that are known gaps but deliberately deferred. Each entry has the affected files and what needs to happen.

---

## TD-016 — Generator has no unit or integration tests

**Current state**
`generator/` has a single test file (`test_mcp_gql_loop.py`) that exercises the MCP/GraphQL path only.
All validation logic, prompt-building helpers, and pipeline decision functions are untested.
Bugs in these are caught only by live generation runs (expensive, slow, non-deterministic).

**High-value unit test targets** (pure functions, no LLM needed):

`subagents/static_validation.py` — highest ROI, pure `str → List[str]` functions:
- `validate_admin_ui_artifact`: confirm React patterns caught (`import`, `export default`), mount signature required, document.head/body blocked, Polaris tokens accepted
- `validate_widget_artifact`: same shape, widget-specific rules
- `validate_widget_handler_contract` / `validate_admin_handler_contract`: cross-artifact field alignment; easiest to test with fixture pairs of handler + UI code
- `validate_architect_plan`: sentinel, cron syntax, catalog path format, dbContracts tenant_id presence

Generator `parse()` methods (`handler_agent`, `widget_js_agent`, `admin_ui_agent`):
- Strip markdown fences (` ```js ... ``` `)
- Strip leading prose (text before the first JS token)
- **Edge case**: if LLM output starts with a `//` comment, `js_start.start() == 0` so the `if start > 0` guard never fires — import statements immediately after the comment survive into the artifact. This was a contributing root cause of the April-15 React admin_ui incident. A regression test here would have caught it.

`crews/feature_generator/crew.py:_revision_locked_artifacts()`:
- Q3/Q4 only → `{"handler", "migration"}` locked
- Q1/Q2/Q5/Q6/Q7 (any) → `{"migration"}` locked
- Mixed Q1+Q3 → `{"migration"}` locked (backend question takes priority)
- Empty issues → `{"handler", "migration"}` (default)

`crews/feature_generator/crew.py:_plan_codegen_batch()`:
- Coupled-retry heuristic: if handler errors contain a contract marker, dependent UI generators get added to `to_run` even if their own artifacts passed
- Verify `to_run` set is computed correctly given various `error_map` shapes

**High-value integration test targets** (mock LLM responses, no real API calls):

`_phase_validator()` end-to-end with stubbed `run_validator_agent` + `run_revision_agent`:
- Validator finds Q3/Q4 → locking correct → revision accepted → merged artifacts returned
- Validator finds Q1 → handler unlocked → revision accepted → merged artifacts returned
- Revision attempt 1 emits React code → static validation catches it → retry triggered → attempt 2 clean → accepted
- Both revision attempts fail → artifacts saved → `_PipelineAbort` raised

Sequential codegen peer injection (`run_codegen_sequential` with mocked generators):
- Verify `widget_js` generator context receives `peer_handler_code` from phase-2 handler output
- Verify `handler` generator context receives `peer_migration_sql` from phase-1 migration output

**Suggested approach**
- `pytest` with `unittest.mock.patch` to stub LLM calls
- Fixture JS/SQL strings for common valid and invalid artifact patterns
- No new dependencies beyond `pytest` (already likely available) and `pytest-mock`

**Affected files** (when done)
- `generator/tests/` — new directory
- `generator/tests/test_static_validation.py`
- `generator/tests/test_generator_parse.py`
- `generator/tests/test_revision_locking.py`
- `generator/tests/test_plan_codegen_batch.py`
- `generator/tests/test_phase_validator.py` (integration)

**Complexity:** Low for unit tests (no infra). Medium for integration tests (requires clean mock boundaries around LLM calls).

---

## TD-003 — `generation_sessions` has both a bundle blob and legacy typed columns

**Affected files**
- `platform/packages/db/migrations/0001_initial_schema.sql` — defines both `bundle JSONB` and the legacy `generated_code`, `explanation`, `webhook_topics`, `cron_schedule` columns on `generation_sessions`
- `platform/packages/db/src/generation.ts` — `storeBundleInSession` writes to the blob AND derives the legacy columns from it

**What's broken**
The bundle is the source of truth but the legacy columns are kept in sync manually inside `storeBundleInSession` — a forgotten update to that function silently drifts one from the other. Querying or indexing individual bundle fields requires JSON path expressions.

**What to do**
Either:
- (Simple) Drop the legacy columns in a migration and update any code that reads them to read from `bundle->>'...'` instead.
- (Better) Normalize: add proper typed columns for `handler_code TEXT`, `migration_sql TEXT`, `widget_js TEXT`, `merchant_explanation TEXT`, `webhook_topics TEXT[]`, `cron_schedule TEXT` and populate them from the bundle at write time. Drop the `bundle` blob once readers are migrated.

---

## TD-006 — Local-dev widget JS still reads from Postgres

**Status:** Production path done. Local-dev path still reads Postgres.

**Affected files**
- `platform/apps/api/src/routes/widget-js.ts` — branches on `DEPLOY_MODE`; the `cloudrun` branch redirects to GCS, the `local` branch reads `widget_js` from DB and streams it directly
- `platform/packages/db/src/generation.ts` — `resolveWidgetJs` queries `apps.widget_js`

**What's done**
In `cloudrun` mode the route issues a 302 to
`https://storage.googleapis.com/<bucket>/widgets/<appId>/widget.js`, so
storefront traffic in production no longer touches Postgres.

**What remains**
Local dev still reads from Postgres because there's no GCS upload in the
local deployer path. Dev storefront traffic is low enough that the
Postgres read is fine; worth revisiting only if we ever want to run
load tests that mirror production traffic.

**Complexity:** Low — wire fake-gcs-server into the local deploy path so the `cloudrun` branch can also be exercised end-to-end in dev.

---

## TD-008 — MCP umbrella session: one NPX spawn per pipeline run

**Current state**
The MCP pipeline makes two separate `_call_mcp` calls that each spawn their own NPX process:
1. `prefetch_for_run` — `search_docs_chunks` for api_context (+ `introspect_graphql_schema` when topics cache is cold)
2. `validate_handler_graphql` in `HandlerGenerator.validate()` — `validate_graphql_codeblocks` per retry round

Each NPX spawn takes ~3-5s. On a run with a cold topics cache + one validation retry, that is 3 separate processes.

**What to do**
Open one MCP session at the start of `_phase_architect` (or at the crew entry point), keep the conversationId in a run-scoped context object, and reuse it for both the prefetch search and the post-handler validation. All three MCP calls go through the same process.

**Affected files**
- `generator/shopify_mcp/client.py` — expose a session context object or async session manager
- `generator/crews/feature_generator/crew.py` — open session once, pass context through to codegen phase
- `generator/subagents/base.py` — add optional `mcp_session` to `CodegenContext`
- `generator/subagents/handler_agent.py` — use session context in `validate()`

**Complexity:** Medium — requires threading a session handle through the pipeline without breaking the sync/async boundary that `_run_async` already manages.

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

## TD-010 — SQL schema validation via Postgres EXPLAIN

**Current state**
Schema alignment is validated by the LLM validator (Q7) which cross-checks handler INSERTs against
`dbContracts` and `migration.sql`. LLM validation is probabilistic — it can miss column mismatches
or produce false positives. Runtime Postgres errors are the only guaranteed catch today.

**The EXPLAIN approach**
`EXPLAIN` parses and plans a SQL statement without executing it. Postgres rejects unknown column
names at parse time, making it a deterministic schema validator:

```sql
-- Extracted from handler template literal and parameterised:
EXPLAIN INSERT INTO back_in_stock_subscriptions
  (id, tenant_id, email, product_id, product_title)   -- product_title doesn't exist
VALUES ($1, $2, $3, $4, $5);
-- → ERROR: column "product_title" of relation does not exist
```

**What to do**
1. After generation, apply `migration.sql` to a short-lived Postgres instance (Docker or
   `pg_tmp`-style ephemeral).
2. Extract SQL template literals from `handler.js` using the existing `_GQL_TEMPLATE_RE`-style
   regex, but targeting `ctx.db\`` blocks.
3. Replace `${...}` interpolations with positional `$N` placeholders.
4. Run `EXPLAIN <statement>` for each extracted query and collect Postgres errors.
5. Return errors in the same format as static validation so they feed into the retry loop.

**When to apply**
Only after the LLM validator passes — EXPLAIN is the deterministic final gate before the
artifact is accepted. Skip if no `migration.sql` was generated (apps with no DB tables).

**Complexity:** Medium — SQL extraction from template literals is the hard part; the Postgres
interaction is straightforward. A `pg_tmp` ephemeral instance adds ~1s overhead per run.

**Affected files**
- `generator/subagents/static_validation.py` — add `validate_handler_sql_schema(handler_js, migration_sql)`
- `generator/crews/feature_generator/crew.py` — call after validator phase, before bundle publish

---

## TD-014 — Extend real (FORCE) RLS beyond `generation_sessions`

**Context**
Batch 4 turned on `FORCE ROW LEVEL SECURITY` for `generation_sessions`
only. Every other table in the schema either has `ENABLE` without `FORCE`
(10 tables: `tenants`, `apps`, `app_versions`, `deployed_functions`,
`webhook_subscriptions`, `webhook_invocation_logs`, `tenant_brands`,
`app_email_configs`, `email_deliveries`, `email_suppressions`) or got
`ENABLE` only in Batch 4's migration (5 tables: `widget_invocation_logs`,
`admin_invocation_logs`, `usage_records`, `revision_classifications`,
`billing_events`).

Without `FORCE`, the platform API — which owns the tables — bypasses RLS
entirely on those 15 tables. The `CREATE POLICY` entries are defence-in-
depth for any future non-owner role but fire nowhere today.

**What the forced variant costs**
Every read/write against a force-RLS'd table must run inside
`withTenantContext(tenantId, ...)`. Batch 4 demonstrated the refactor
for generation_sessions: ~10 db functions grew a `tenantId` parameter,
a new `requireAuthedTenantId` helper was added to the auth plugin, and
every route and deployer call site was threaded. For the remaining 15
tables the surface is roughly:
- `packages/db/src/tenants.ts` — ~20 functions (apps, tenants, deployed
  functions, webhook subscriptions, invocation logs).
- `packages/db/src/billing.ts` — ~8 functions.
- `packages/db/src/email.ts` — ~12 functions.
- `packages/db/src/usage.ts` — ~6 functions.
- call-site updates across `apps/api/src/routes/**`.

**What to do**
Incrementally, one table family at a time, mirroring the Batch 4 pattern:

1. Pick a family (e.g. `tenants` + `apps`).
2. Add `FORCE ROW LEVEL SECURITY` in a new migration.
3. Update every db function that touches those tables to take `tenantId`
   and wrap the query in `withTenantContext`.
4. Update call sites to pass the tenantId from `requireAuthedTenantId`
   or existing `requireTenant(req, params.tenantId)` paths.
5. Run the full test suite + smoke-test the local deploy flow.

Batch at a time keeps each PR reviewable. The easy families (email,
billing) don't have the chicken-and-egg lookup problem Batch 4 solved
for `generation_sessions` — every caller already has tenantId in scope.

**Affected files** (when all done)
- All migrations that added RLS without FORCE — updated or re-issued.
- Every function in `packages/db/src/{tenants,billing,email,usage}.ts`.
- Most call sites in `apps/api/src/routes/**`.
- Possibly a new bootstrap helper if any family has a jobId-style
  lookup that doesn't know the tenant yet.

**Complexity:** High — ~60 call sites and a handful of db functions.
Low risk per PR because each family is independent and fail-closed
(a bug returns zero rows rather than cross-tenant data).

---

## TD-017 — Merchant-facing notifications channel for runtime warnings

**Current state**
Several platform-side signals are merchant-actionable but invisible in the UI because the Logs tab
only shows invocation-level rows (`InvocationLogEntry` / `WebhookInvocationLogEntry` — id, path/topic,
status, durationMs, errorMessage, timestamp). Individual `logger.warn` lines emitted inside handlers
or platform services have nowhere to surface.

Concrete first case driving this: `EMAIL_DATA_MANIFEST_DRIFT` in
`platform/packages/harness/src/email-service.ts`. When the handler passes `data` keys that don't match
the generator-declared `apps.email_variables` manifest, the merchant's `{{tokens}}` may render empty.
Today this is warn-logged to the backend sink only — operators see it, merchants never do.

**Why not just extend the Logs tab**
`InvocationLogEntry` is a typed row per invocation. Widening it to carry arbitrary log lines would
bloat every row and mix two audiences (operator debugging vs. merchant action). A separate
Notifications tab keeps the two concerns cleanly split and gives room for filtering, mark-as-read,
and badge counts that don't belong on the Logs tab.

**Open product question (resolve before building)**
What do we tell the merchant to do when they see a drift notification?
  - "Run a revision on this app" (triggers a regen that aligns the manifest).
  - Inform-only — the next regen will self-heal.
  - "Edit the Email tab — some of your {{tokens}} may render empty."

Surface-only is acceptable for the initial rollout; telemetry on hit rate will tell us whether a
remediation path is worth the complexity.

**What to do**
1. New table `app_notifications (id, tenant_id, app_id, event, severity, payload jsonb, seen_at, created_at)` with RLS.
2. Write path: every platform-side `logger.warn` event that is merchant-actionable also inserts a row.
   Wrap the dual-write in a small helper (`emitNotification(logger, { event, severity, payload })`)
   so call sites can't drift between log and row.
3. Read path: `GET /tenants/:tid/apps/:aid/notifications` with pagination + a `PATCH .../seen` endpoint.
4. New Notifications tab on `AppDetailPage` alongside Logs/Email/Settings; badge unread count on the tab label.

**Affected files** (when done)
- `platform/packages/db/migrations/00NN_app_notifications.sql` — new table + RLS.
- `platform/packages/db/src/notifications.ts` — new module.
- `platform/packages/harness/src/email-service.ts` — dual-write at the drift warn-log site.
- `platform/apps/api/src/routes/notifications.ts` — new route.
- `platform-front/src/pages/AppDetailPage.tsx` — new tab + badge.
- `platform-front/src/types/dashboard.ts` — `AppNotification` type.

**Complexity:** Medium. The DB + API + UI pieces are each straightforward; the cross-cutting
ergonomics (helper + consistent event taxonomy) is what takes the extra time.

---

## TD-018 — `ctx.shopify` has no built-in 429 retry

**Current state**
`ctx.shopify.get/post` in `platform/packages/harness/src/shopify-client.ts` makes the HTTP call
and returns — nothing handles a 429 response or the `Retry-After` header. Handlers that call
Shopify in a loop (cron bulk-fetch, per-item enrichment) will surface 429s as raw failures the
moment a store's bucket runs out. The LLM has no prompt guidance here either, so it sometimes
invents half-right backoff (the `setTimeout`-in-a-loop regression on the abandoned-cart gen was
exactly this shape before static validation caught it).

**Why this is platform, not prompt**
"Wait and try again" is infrastructure — nothing domain-specific. Every handler that hits
Shopify needs it; putting it in the client fixes it once for every current and future app and
removes a class of LLM-drift bugs.

**What to do**
In `shopify-client.ts`, wrap `get`/`post` with retry discipline:
- Honour `Retry-After` when present (seconds or HTTP-date).
- Exponential backoff + jitter when absent (e.g. 500ms → 1s → 2s → 4s, capped).
- Cap at 3-4 retries total, then throw a typed `ShopifyRateLimitError` so handlers can log it.
- Apply to 429 and 5xx (at least 502/503/504 — transient).

Once landed, add a hard rule to the handler prompt: *"`ctx.shopify` handles 429/5xx retries
internally. Never add `setTimeout`, sleep loops, or retry wrappers around `ctx.shopify` calls."*
That stops the LLM from writing competing backoff logic.

**MVP note**
Deferrable until a real store hits the ceiling — current target is <250 items/run where no
429 is expected. Log as platform work, not prompt work.

**Affected files**
- `platform/packages/harness/src/shopify-client.ts` — add retry wrapper around fetch.
- `platform/packages/types/src/harness.ts` — add `ShopifyRateLimitError` if typed error is exposed.
- `generator/subagents/prompts/handler/` — add the "do not retry" rule after the platform change ships.

**Complexity:** Low — one file, well-defined contract (honour `Retry-After`, exponential fallback).

---

## TD-019 — Pre-revision validator scan of the prior bundle

**Current state**
On a revision run (`request.priorBundle` present), `crews/feature_generator/crew.py`
goes straight from architect → `run_revision_agent` (on the prior code + new plan +
merchant feedback) → static validation → LLM validator. The validator agent
(`run_validator_agent`, Part A targeted checks + Part B open review) runs
**only on the NEW artifacts** — the prior deployed bundle is never scanned
for latent bugs before the revision starts.

**Opportunity**
Part B of the validator is designed to catch deploy-blocking bugs static
rules don't already cover (races, missing pagination, numeric overflow,
orphaned state, unsafe DB driver assumptions). Running it once on the
**prior bundle** at the start of a revision pipeline, then feeding the
HIGH-confidence findings into `run_revision_agent`'s user prompt under a
"PRE-EXISTING ISSUES TO ALSO FIX" section, lets one revision cycle fix
both the merchant's reported issue AND any latent bugs that would
otherwise surface as the merchant's *next* revision request.

**Why this is worth paying for**
Revisions are unlimited on every plan, so the merchant doesn't pay per
cycle — we do. Collapsing "merchant reports bug A → revision fixes A →
merchant trips over bug B → revises again" into one cycle is a direct
margin win on the unlimited-revision tier (see `docs/BILLING.md` —
revisions are the dominant cost-of-service risk for Growth/Pro plans).

**Costs**
- One extra validator call per revision run (~$0.05–0.10 with Sonnet +
  extended thinking; ~8s wall time). Negligible relative to the full
  revision cost; clearly cheaper than a second revision round-trip.
- Slight complexity: need to ensure merchant's explicit feedback still
  takes priority over pre-scanned findings, so the revision agent never
  "fixes" something the merchant intentionally left alone. Mitigation:
  only HIGH-confidence Part B findings, labelled clearly as secondary
  to merchant intent in the revision prompt.

**What to do**
1. In `crews/feature_generator/crew.py`, add a `_prerevision_validator_scan(base_ctx)`
   helper that assembles the prior bundle as a pseudo-`artifacts` dict and
   calls `run_validator_agent` on it. Filter results to Part B HIGH-confidence
   open findings only.
2. Wire it into `_phase_codegen` just before the `is_revision_first_attempt`
   branch fires, capturing the findings once per run.
3. In `subagents/revision_agent.py`, extend `_build_user_prompt` with a new
   kwarg `pre_existing_issues: List[Dict] | None`. Render under a
   `PRE-EXISTING ISSUES — fix alongside the merchant's request` header
   between the merchant-feedback block and the validator-retry block, with
   explicit priority ordering ("Merchant feedback takes priority; address
   these only if compatible with the merchant's intent").
4. Skip the scan when `base_ctx.prior_handler_code` is None (first-run
   generation — nothing to scan).

**Affected files**
- `generator/crews/feature_generator/crew.py` — new helper + one call site.
- `generator/subagents/revision_agent.py` — new kwarg + prompt section.
- Possibly `generator/subagents/prompts/revision/_core.py` — a one-line
  header constant if we want the section name to live there.

**Complexity**
Low — everything plugs into existing components (`run_validator_agent`
already supports arbitrary artifact dicts; `_build_user_prompt` already
composes multiple issue blocks). The hard part is the product call on
how strictly the revision agent should prioritize merchant intent over
pre-scanned findings — document that as a rule in the revision prompt,
then measure.

---

## TD-015 — Revision failure artifacts saved to /tmp only

**Current state**
When the revision agent produces structurally invalid code after two attempts,
`_phase_validator()` in `crew.py` saves the bad artifacts (code + validation errors)
to `/tmp/revision_validation_failures/<timestamp>_<job_id>.json`. `/tmp` is ephemeral
— the file disappears when the Cloud Run container exits, making post-mortem analysis
unreliable in production.

**What to do**
Replace or augment the `/tmp` write in `_save_revision_failure()` with a durable sink:

- **GCS (preferred):** upload the JSON to a dedicated bucket, e.g.
  `gs://<project>-generation-failures/revision/<timestamp>_<job_id>.json`.
  Add the bucket name to settings (env var `REVISION_FAILURE_BUCKET`).
  Use the same GCS client already present in the codebase.
- **DB alternative:** insert a row into a `generation_failures` table
  (`job_id`, `timestamp`, `failure_type`, `errors JSONB`, `artifacts JSONB`).
  Lets you query failure patterns across runs without downloading files.

The local CLI path (`chat_local.py`) already writes to
`generator/cli/test_results/revision_failures/` which is persistent — no change needed there.

**Affected files**
- `generator/crews/feature_generator/crew.py` — `_save_revision_failure()`: add GCS/DB upload after the local write (keep `/tmp` as fallback if the upload fails)
- `generator/config.py` (or equivalent settings module) — add `REVISION_FAILURE_BUCKET` setting
- Possibly a new migration if the DB route is chosen

**Complexity:** Low — the GCS upload pattern is already used elsewhere in the codebase.
