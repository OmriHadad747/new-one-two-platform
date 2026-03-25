# Tech Debt

Items that are known gaps but deliberately deferred. Each entry has the affected files and what needs to happen.

---

## TD-008 — Revision generation ignores `priorBundle`; strategy not stored in bundle

**Affected files**
- `platform/apps/api/src/routes/generation.ts` — `/revise` endpoint reads `session.bundle` from DB and passes it as `priorBundle` in the new `GenerationRequest` (lines 294–308) ✅
- `generator/contract/validators.py` — `GenerationRequest.priorBundle` field is received by the generator ✅
- `generator/crews/feature_generator/crew.py` — `request.priorBundle` is never read; every revision runs as a fresh generation ❌
- `generator/subagents/strategy_agent.py` — produces a strategy brief but it is discarded after use ❌
- `contract/feature-bundle.schema.json` — `Bundle` has no `strategy` field ❌

**What's broken**

Two linked gaps:

1. **`priorBundle` is ignored.** The API correctly retrieves the prior bundle from DB and forwards it to the generator, but the crew never reads `request.priorBundle`. Every revision is a cold start — the generator sees only the augmented prompt (`original + "Merchant feedback: ..."`) with no knowledge of what code already exists. This produces unnecessary regressions: a merchant asking to "change the notification message" gets the entire handler rewritten from scratch rather than a targeted edit.

2. **Strategy is not persisted.** The Strategy Agent's brief (state machine decisions, platform gaps, cron batching advice) is used during generation and then discarded. It is not stored in the bundle, so revisions cannot build on prior architectural decisions. A revision might generate a different state machine sentinel or different batching strategy for no reason other than the strategy agent reasoning from scratch.

**What to do**

Step 1 — Store strategy in the bundle:
- Add `strategy` as an optional field to `Bundle` in `contract/feature-bundle.schema.json`, `contract/validators.py`, and the TypeScript types in `platform/packages/types/`.
- In `crew.py`, include `strategy` in the `Bundle` before publishing.

Step 2 — Consume `priorBundle` in the generator:
- In `crew.py`, after the intent and schema agents, check if `request.priorBundle` is present.
- If present, pass the prior strategy (from `priorBundle["strategy"]`) and prior artifacts to the Strategy Agent so it can make decisions aware of what already exists — or skip re-running strategy entirely if the intent and API plan match the prior run.
- Pass the prior code artifacts to each codegen agent as additional context: "here is the current handler — make only the changes needed to satisfy the feedback". This is a targeted-edit prompt rather than a full rewrite.

Step 3 — Update the revise endpoint (optional):
- The endpoint currently infers `appArchetype` from whether `widgetModule` is present in the prior bundle (line 295–298). Once strategy is stored, the archetype could be read directly from the bundle instead of being inferred.

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
The adapter correctly reads `usage_metadata` from the Anthropic response, but each agent (`run_intent_agent`, `run_schema_agent`, etc.) discards the `LLMResponse` wrapper and only returns the parsed result. The crew therefore has no token data to put in the trace.

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

## TD-007 — Wire real email provider behind `ctx.email.send()`

**Current state**
`ctx.email.send({ to, subject, templateId, data })` exists in the harness contract and is already
used by generated handlers. The current implementation is a log stub — it emits a structured
`EMAIL_SENT` log event with the full delivery intent but does not deliver anything.

**Affected files**
- `platform/packages/harness/src/build-ctx.ts` — stub implementation of `ctx.email`
- `generator/templates/harness_contract.py` — documents the `ctx.email` API surface

**What to do**
Replace the stub with a real provider adapter (Resend, SendGrid, Postmark, etc.):
1. Store provider credentials in Secret Manager per-tenant (or platform-wide for MVP).
2. Implement a provider adapter behind `ctx.email.send()` in `build-ctx.ts`.
3. Add delivery status tracking and basic error handling (retry / dead-letter).
4. The harness contract and all generated handlers require zero changes — the API surface is already correct.

**Complexity:** Medium — provider adapter + tenant credential storage + error handling.

---

## TD-009 — Clarification Agent (pre-flight Q&A before planning)

**What's missing**
The current flow is fire-and-forget: the merchant submits a prompt and the Planner reasons
about ambiguities on its own. For questions that can't be resolved from the prompt alone
(e.g. "do you have multiple locations?", "which email provider are you using?"), the Planner
either picks a default or adds a platformGap. A Clarification Agent would ask 1–3 targeted
questions before planning, then feed the answers directly into the Planner as resolved context.

**Why deferred**
Requires breaking the fire-and-forget generation flow into a two-phase interactive flow:
1. Job starts → Clarification Agent returns questions → job enters `waiting_for_clarification` state
2. Merchant answers → job resumes → Planner runs with answers in context

This touches the full stack: new job states in the DB, new API endpoints
(`GET /generation/:jobId/questions`, `POST /generation/:jobId/answers`), pubsub contract
changes, and frontend support for the Q&A step.

**Affected files (when implemented)**
- `platform/apps/api/src/routes/generation.ts` — new endpoints for questions/answers
- `platform/packages/db/` — new job state + answers storage
- `platform/packages/pubsub-client/src/schemas.ts` — new message types
- `generator/crews/feature_generator/crew.py` — new pre-planning phase
- `generator/crews/feature_generator/agents.py` — new clarification agent
- Frontend (not yet built)

**Complexity:** Medium-High — full-stack flow change, new job lifecycle state.

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
