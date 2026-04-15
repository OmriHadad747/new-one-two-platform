# Tech Debt

Items that are known gaps but deliberately deferred. Each entry has the affected files and what needs to happen.

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

