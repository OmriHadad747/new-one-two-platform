# Tech Debt

Items that are known gaps but deliberately deferred. Each entry has the affected files and what needs to happen.

---

## TD-001 — Generation `meta` is never persisted

**Affected files**
- `generator/crews/feature_generator/crew.py` — publishes `FeatureBundleMessage` with `meta`
- `platform/apps/api/src/routes/generation.ts` — receives the message, drops `meta` before calling `storeBundleInSession`
- `platform/packages/db/src/index.ts` — `storeBundleInSession` has no `meta` parameter

**What's broken**
`GenerationMeta` (totalInputTokens, totalOutputTokens, generationMs, agentTrace) is emitted in the Pub/Sub message and streamed to the SSE client, but never written to the database. After the client disconnects the data is gone. There is no way to audit generation costs or timing after the fact.

**What to do**
1. Add a `meta JSONB` column to `generation_sessions` in a new migration.
2. Update `storeBundleInSession` signature to accept `meta?: Record<string, unknown>`.
3. Update the `registerCompletedListener` callback in `generation.ts` (POST `/generation` and POST `/generation/:jobId/revise`) to pass `bundleMsg.meta`.

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

## TD-003 — `generation_sessions` bundle fields are a single JSONB blob

**Affected files**
- `platform/packages/db/migrations/0006_pubsub_bundle.sql` — adds a single `bundle JSONB` column
- `platform/packages/db/src/index.ts` — `storeBundleInSession` writes the whole bundle as one blob

**What's broken**
All bundle content (`widgetModule`, `handlerModule`, `dbMigration`, `explanation`) lives in one opaque JSONB column. Querying or indexing individual fields requires parsing the blob. The legacy phase-3 columns (`generated_code`, `explanation`, `webhook_topics`, `cron_schedule`) are now duplicated data — the bundle is the source of truth but the columns must be kept in sync manually.

**What to do**
Either:
- (Simple) Keep the blob, drop the legacy columns, and update any code that reads them to read from `bundle->>'...'` instead.
- (Better) Normalize: add proper typed columns for `handler_code TEXT`, `migration_sql TEXT`, `widget_js TEXT`, `merchant_explanation TEXT`, `webhook_topics TEXT[]`, `cron_schedule TEXT` and populate them from the bundle at write time. Drop the `bundle` blob once readers are migrated.

---

## TD-004 — `generation_events` table is never written to

**Affected files**
- `platform/packages/db/src/index.ts` — `insertGenerationEvent` exists but is never called
- `platform/packages/db/migrations/0005_phase3.sql` — defines the `generation_events` table for per-agent LLM cost tracking

**What's broken**
The `generation_events` table was designed to hold one row per LLM call (agent name, model, tokens, latency). It is never populated. There is no per-agent cost visibility in the database.

**What to do**
Once TD-002 is resolved (agents return token counts), call `insertGenerationEvent` from the crew after each agent completes, using the data already present in `AgentTraceEntry`.

---

## TD-006 — Widget JS is served from Postgres; needs GCS in production

**Affected files**
- `platform/apps/api/src/routes/widget-js.ts` — reads `widget_js` from DB and streams it directly
- `platform/packages/db/src/index.ts` — `resolveWidgetJs` queries `apps.widget_js`
- `platform/packages/deployer/src/index.ts` — `updateAppWidgetJs` writes the raw JS string to Postgres

**What's wrong**
`GET /widgets/:shop/:appId.js` reads the raw JS out of `apps.widget_js` (Postgres TEXT column) on every request. Cache-Control is `max-age=5`, so at any real storefront traffic volume this becomes a Postgres read per page load. It also means widget JS is capped at Postgres row limits and bypasses the existing GCS bundle infrastructure.

**What to do**
1. In the deployer, upload widget JS to GCS as a public object at a deterministic path: `gs://<bucket>/widgets/<appId>.js`. Set `Cache-Control: public, max-age=3600` on the object.
2. In `widget-js.ts`, replace the Postgres read with a `302` redirect to `https://storage.googleapis.com/<bucket>/widgets/<appId>.js`. GCS serves the file directly to the browser — no separate CDN product needed, Google's infrastructure handles global distribution.
3. On re-deploy, overwrite the same GCS path. The 1-hour browser cache means stale widgets are served for at most an hour after a deploy — acceptable for most use cases.

**Interim** (already in place): the 5-second `max-age` keeps Postgres load manageable for low traffic. Switch to GCS before going to production scale.

**Complexity:** Low — follows the existing `gcsBundlePath` pattern already used for handler bundles.

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
