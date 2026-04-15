# Tech Debt

Items that are known gaps but deliberately deferred. Each entry has the affected files and what needs to happen.

---

## TD-001 — Generation `meta` is never persisted

**Affected files**
- `generator/crews/feature_generator/crew.py` — publishes `FeatureBundleMessage` with `meta`
- `platform/apps/api/src/routes/generation.ts` — receives the message, drops `meta` before calling `storeBundleInSession`
- `platform/packages/db/src/generation.ts` — `storeBundleInSession` has no `meta` parameter; `generation_sessions` has no `meta` column

**What's broken**
`GenerationMeta` (totalInputTokens, totalOutputTokens, generationMs, agentTrace) is emitted in the Pub/Sub message and streamed to the SSE client, but never written to the database. After the client disconnects the data is gone. There is no way to audit generation costs or timing after the fact, and no per-agent cost breakdown survives.

**What to do**
1. Add a `meta JSONB` column to `generation_sessions` in a new migration.
2. Update `storeBundleInSession` signature to accept `meta?: Record<string, unknown>`.
3. Update the `registerCompletedListener` callbacks in `generation.ts` (POST `/generation` and POST `/generation/:jobId/revise`) to pass `bundleMsg.meta`.

**Relationship to TD-004**: TD-001 gets the full `meta` blob (including `agentTrace[]`) onto `generation_sessions` as the source of truth. TD-004 projects the per-agent trace entries out into a queryable `generation_events` table for cost/latency analytics. Do TD-001 first; TD-004 is easy once the blob is persisted.

---

## TD-002 — Token counts are always 0 in the generator

**Affected files**
- `generator/models/adapter.py` — `invoke()` returns `LLMResponse` with correct token counts
- `generator/crews/feature_generator/crew.py` — `AgentTraceEntry` objects are hardcoded `inputTokens=0, outputTokens=0`; `GenerationMeta` is hardcoded `totalInputTokens=0, totalOutputTokens=0`

**What's broken**
The adapter correctly reads `usage_metadata` from the Anthropic response, but each agent discards the `LLMResponse` wrapper and only returns the parsed result. The crew therefore has no token data to put in the trace.

**What to do**
1. Change each agent's return type to include token counts (e.g. return a `(result, input_tokens, output_tokens)` tuple, or a typed dataclass).
2. Accumulate counts in the crew and fill `AgentTraceEntry` and `GenerationMeta` correctly.
3. Once TD-001 is resolved, the persisted `meta` will also reflect real numbers.

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

## TD-004 — No per-agent cost / latency visibility

**Why it matters**

Anthropic bills per input+output token. Today the platform has no queryable way to answer:

- Which agent is burning the most tokens across all tenants this month?
- Which model (claude-sonnet-4-6 vs claude-opus-4-6 vs claude-haiku-4-5) gives the best $/successful-generation?
- Did the architect prompt revision on 2026-04-10 regress token usage? By how much?
- What's the real unit cost of one generation for tenant X — needed for pricing / margin analysis?
- Which agent retried the most times on the expensive runs?

`usage_records.generations` tracks **count**, not cost. A cheap run and a $5 run look identical. TD-001 persists the full `meta` blob (including `agentTrace[]`) onto `generation_sessions` — that's the write-path source of truth, but aggregating JSONB arrays across thousands of sessions is slow and awkward. We want a normalised rows-per-agent-call table that `GROUP BY agent_name, model, created_at::date` answers the above in O(index-scan) not O(parse-every-json-array).

**What to do**

### 1. New migration — add the `generation_events` projection table

```sql
CREATE TABLE generation_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES generation_sessions(id) ON DELETE CASCADE,
  tenant_id     UUID        NOT NULL REFERENCES tenants(id)             ON DELETE CASCADE,
  job_id        UUID,                                     -- for joining to frontend SSE jobs
  agent_name    TEXT        NOT NULL,                     -- 'product' | 'architect' | 'handler' | 'widget_js' | 'admin_ui' | 'validation' | 'revision' | 'explanation'
  model         TEXT        NOT NULL,                     -- e.g. 'claude-sonnet-4-6'
  provider      TEXT        NOT NULL DEFAULT 'anthropic', -- future-proof for other providers
  input_tokens  INTEGER     NOT NULL DEFAULT 0,
  output_tokens INTEGER     NOT NULL DEFAULT 0,
  latency_ms    INTEGER     NOT NULL DEFAULT 0,
  attempt       INTEGER     NOT NULL DEFAULT 1,           -- non-1 when the agent retried
  status        TEXT        NOT NULL DEFAULT 'success',   -- 'success' | 'failed' | 'retrying'
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_generation_events_session       ON generation_events (session_id);
CREATE INDEX idx_generation_events_tenant_agent  ON generation_events (tenant_id, agent_name, created_at);
CREATE INDEX idx_generation_events_model_created ON generation_events (model, created_at);
CREATE INDEX idx_generation_events_created_at    ON generation_events (created_at DESC);

-- RLS: match the 'ENABLE only' pattern the 5 other service-level tables use
-- (see TD-014 for the full-FORCE sweep). Platform API writes as owner and
-- reads analytics as owner; no tenant-facing surface for this table.
ALTER TABLE generation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY generation_events_isolation ON generation_events
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
```

### 2. Write path — one site only

After TD-001 lands, `storeBundleInSession` receives `meta.agentTrace[]`. In the same transaction that writes `generation_sessions.meta`, fan each trace entry out into a `generation_events` row:

```ts
// platform/packages/db/src/generation.ts — inside storeBundleInSession,
// still under the existing withTenantContext wrap:
if (meta?.agentTrace) {
  for (const entry of meta.agentTrace) {
    await tx`
      INSERT INTO generation_events
        (session_id, tenant_id, job_id, agent_name, model,
         input_tokens, output_tokens, latency_ms, attempt, status)
      VALUES
        (${sessionId}, ${tenantId}, ${jobId}, ${entry.agent}, ${entry.model},
         ${entry.inputTokens}, ${entry.outputTokens}, ${entry.latencyMs},
         ${entry.attempt ?? 1}, ${entry.status ?? 'success'})
    `;
  }
}
```

Failure mode: if the insert throws, the whole `storeBundleInSession` transaction rolls back — that's desirable, we don't want a session persisted with partial event rows. Keep the events insert inside the same `withTenantContext` block.

### 3. One dashboard query per question

Cost by agent this month:
```sql
SELECT agent_name,
       SUM(input_tokens)  AS in_tok,
       SUM(output_tokens) AS out_tok,
       -- per-model pricing lives in code; join to a rates CTE or compute client-side
       COUNT(*)           AS calls
FROM generation_events
WHERE created_at >= date_trunc('month', NOW())
GROUP BY agent_name
ORDER BY out_tok DESC;
```

Cost per tenant:
```sql
SELECT tenant_id,
       SUM(input_tokens + output_tokens) AS total_tokens,
       COUNT(DISTINCT session_id)        AS generations
FROM generation_events
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY tenant_id
ORDER BY total_tokens DESC
LIMIT 20;
```

Regression check after a prompt change:
```sql
SELECT DATE(created_at) AS day,
       AVG(input_tokens + output_tokens) AS avg_tokens
FROM generation_events
WHERE agent_name = 'architect'
  AND created_at >= '2026-04-01'
GROUP BY 1
ORDER BY 1;
```

### Dependencies

- **Blocked on TD-002**: token counts are currently hardcoded to 0 in the crew. Implementing TD-004 before TD-002 populates the table with zeros — no signal.
- **Requires TD-001**: `meta` must reach `storeBundleInSession`. Without it, there's no `agentTrace[]` to fan out.

Do them in order: **TD-002 → TD-001 → TD-004**. TD-004 itself is ~40 lines of SQL + ~15 lines of TS; the engineering weight is on TD-002.

**Affected files**
- `platform/packages/db/migrations/0004_generation_events.sql` — new migration.
- `platform/packages/db/src/generation.ts` — extend `storeBundleInSession` to fan out trace rows.
- `platform/packages/db/src/analytics.ts` (new, optional) — typed helpers for the common queries above so ops dashboards don't hand-write SQL.

**Complexity:** Low once TD-001 + TD-002 are done. Medium total if you count the prerequisites.

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

## TD-013 — Widget-proxy Origin ownership verification

**Context**
The audit's Batch 3 CORS change (`platform/apps/api/src/plugins/cors.ts`)
locks every non-widget route to the `ALLOWED_ORIGINS` allowlist, but the
widget proxy under `/widgets/*` has to reflect **any** `Origin` because
storefronts run on merchant custom domains (`shop.mybrand.com`, etc.) that
can't be enumerated in an env var. That's "option 1" from the audit —
path-scoped open CORS — and it's safe today because:

- the widget client uses `credentials: "omit"` (see
  `shopify-app/extensions/widget-runtime/assets/widget-runtime.js:103, 152`),
  so no cookies cross the boundary;
- the widget handler endpoint is already tied to a specific app
  (`:shop`, `:appId` in the URL) and the data surface is what the merchant
  explicitly built into their widget.

**What's missing**
The server does not verify that the incoming `Origin` actually belongs to
the shop in the URL. Concretely: a page on `https://evil.com` can make
widget calls to `/widgets/acme.myshopify.com/<appId>/widget/subscribe` and
the API will forward the request to the tenant's harness. As merchant
handlers grow, this becomes a lateral attack surface — a malicious page
can invoke whatever the widget handler does (typically signup,
subscription, cart manipulation) without any real-storefront context.

**What to do**
Add server-side origin-ownership verification at the widget-proxy route:

1. Resolve the shop's known storefront domains from a cache populated via
   Shopify's Admin API (`/admin/api/{version}/shop.json` returns the
   `primary_domain` plus any alternate domains configured for the shop).
2. Compare `request.headers.origin` against that set. Reject with 403 if
   it doesn't match.
3. Cache per `(shop, appId)` with a short TTL (e.g. 5 min) — the domain
   list is operator-maintained and rarely changes, but the cache lets us
   absorb the admin API call cost.
4. Keep CORS reflection open at the transport layer — the 403 comes from
   the route handler, not from missing Access-Control-Allow-Origin. That
   preserves good developer ergonomics (local dev, preview domains) while
   closing the misuse path in production.

**Affected files**
- `platform/apps/api/src/routes/widget-js.ts` — add the Origin check inside
  `widgetProxyHandler` before the harness fetch.
- `platform/apps/api/src/lib/shop-domains.ts` — new module that resolves +
  caches the shop's known domains via the Shopify Admin API.
- `platform/packages/db/src/tenants.ts` — expose the cached domain list on
  the Tenant/App row so the common case avoids a Shopify round-trip.

**Interim** (already in place from Batch 3): `/widgets/*` reflects any
origin, no credentials. Widget endpoints should continue to receive only
app-scoped, non-sensitive traffic until this is implemented.

**Complexity:** Medium — one new helper, one route-layer check, plus a
cache. Admin API availability must be handled gracefully (stale cache,
OAuth token expiry).

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
