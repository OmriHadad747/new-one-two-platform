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

## TD-007 — No email sending capability in generated handlers

**Affected files**
- `generator/templates/harness_contract.py` — defines the ctx API surface available to handlers
- `generator/subagents/handler_agent.py` — generates handler code; will hallucinate a Shopify email endpoint if not constrained

**What's missing**
Generated handlers that need to notify customers (back-in-stock, order alerts, etc.) have no legitimate email-sending primitive. Shopify's Admin API has no general-purpose transactional email endpoint. The LLM tends to hallucinate `/emails.json` which doesn't exist, causing silent failures.

**Shopify's legitimate options (and why they don't fit):**
- **Shopify Email** — a marketing tool for campaigns, not transactional sends. No API to trigger per-customer emails programmatically.
- **Customer notifications** (`POST /customers/{id}/send_invite.json`) — only sends account invitations.
- **Draft order invoice** (`POST /draft_orders/{id}/send_invoice.json`) — triggers an order-related email, not a general notification.
- None of these are appropriate for arbitrary transactional notifications.

**What to do**
Integrate a 3rd-party transactional email provider (Resend, SendGrid, Postmark, etc.) at the platform level and expose it as `ctx.email.send({ to, subject, text })` in the harness contract. The provider credentials would be stored in Secret Manager per-tenant or platform-wide. This keeps generated handlers clean and provider-agnostic.

---

## TD-005 — Shopify access tokens expire every 24 hours but are stored as static secrets

**Affected files**
- `platform/packages/harness/src/build-ctx.ts` — reads `SHOPIFY_ACCESS_TOKEN_SECRET_NAME` and passes it to `buildShopifyClient`
- `platform/packages/harness/src/shopify-client.ts` — fetches the token from Secret Manager once at request time, no refresh logic
- `platform/packages/deployer/src/index.ts` — sets `SHOPIFY_ACCESS_TOKEN_SECRET_NAME` as a static env var on the harness container

**What's broken**
Shopify's new Dev Dashboard (mandatory as of January 2026) issues access tokens via the OAuth 2.0 client credentials grant. Tokens expire after 24 hours. The current design stores a single static token in GCP Secret Manager and never refreshes it — harness containers will start returning `401 Unauthorized` from the Shopify Admin API after the token expires.

**What to do**
1. Store `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` in Secret Manager instead of (or alongside) the access token.
2. In `shopify-client.ts`, implement a token refresh: POST to `https://{shopDomain}/admin/oauth/access_token` with `grant_type=client_credentials` before making API calls.
3. Cache the token in-memory with its expiry (`expires_in` is 86399 seconds) and only re-fetch when within a refresh window (e.g. < 5 minutes remaining).
4. For local dev: re-run the token exchange curl and update `SHOPIFY_ACCESS_TOKEN` in `.env` every 24 hours until the refresh logic is implemented.
