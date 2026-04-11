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

## TD-007 — Wire real email delivery + shared email design system behind `ctx.email.send()`

**Current state**
`ctx.email.send({ to, subject, templateId, data })` exists in the harness contract and is already
used by generated handlers. The current implementation is a log stub — it emits a structured
`EMAIL_SENT` log event with the full delivery intent but does not deliver anything. Additionally,
generated handlers today store raw HTML in DB columns (e.g. `email_body_html`) and compile it
with Handlebars at runtime, meaning merchants are on the hook for authoring cross-client-compatible
email HTML — which they will not do well.

**Affected files**
- `platform/packages/harness/src/build-ctx.ts` — stub implementation of `ctx.email`
- `platform/packages/types/src/harness.ts` — `EmailSendParams` / `EmailClient` contract
- `generator/templates/harness_contract.py` — documents the `ctx.email` API surface
- `generator/subagents/handler_agent.py` — emits handler code that composes email HTML inline

**Scope: one path, Ton-owned, no exceptions**
All Ton-sent emails go through a single pipeline: Resend delivery + MJML block rendering +
merchant brand tokens resolved at send time. There is no hybrid path, no Shopify native
notification patching, no per-app branching in the generator. One mental model for merchants,
one code path in the generator, one analytics surface, one billing model.

**Why not Shopify's email products?**
Investigated and rejected:
1. **Shopify Email (marketing)** — merchant-facing UI in Admin. No programmatic send API.
2. **Customer notifications (transactional)** — fires on ~15 built-in Shopify events only.
   Templates are editable via Admin API but sends cannot be triggered programmatically. Cannot
   schedule follow-ups, cannot do sequences, cannot send on arbitrary events.

Every Shopify app that sends email (Klaviyo, Postscript, Omnisend, Mailchimp, Privy) runs its
own MTA. This is the industry norm and the only workable design.

**Why not even a hybrid (Shopify-native-where-possible + Ton for the rest)?**
Rejected after consideration. The downsides outweigh the one benefit (skipping SPF/DKIM on one
domain):
- **Two merchant mental models** — some emails edited in Ton's admin UI, others in Shopify Admin
  → Notifications. Same merchant, same "email feature," totally different workflows.
- **Blind analytics** — Shopify-native notifications don't report delivery, open, click, or
  bounce events back to Ton. Half the merchant's email activity would be invisible to the
  platform dashboard and billing quota.
- **No unified brand system** — a Shopify-native order confirmation would not use the merchant's
  Ton brand tokens. Their abandoned-cart follow-up would. Brand inconsistency across emails
  from "the same store" is a deal-breaker.
- **Intrusive to merchant config** — patching a merchant's native Shopify Liquid templates
  modifies data they may have customized themselves. Uninstalling Ton leaves orphaned patches.
- **Generator fragility** — classifying each email as "native-eligible" or "Ton-sent" is a
  decision the architect agent can get wrong. A misclassified app is a broken app.
- **No overlap with the catalog anyway** — every email-sending app in `SUPPORTED_APPS_CATALOG.md`
  (Price Drop Alert, Back In Stock, Product Waitlist, Abandoned Cart Recovery, Post-Purchase
  Review Request, Low Inventory Digest, Spin-to-Win, Product Q&A, Order Thank You Email) is an
  email Shopify does not send natively. Even "Order Thank You Email" is an additional branded
  email sent after the order (coupon for next order, cross-sell, brand story), not a replacement
  for Shopify's automatic order confirmation.

**Order confirmation customization is explicitly out of scope.** If a merchant wants to change
their order confirmation email, they do it in Shopify Admin → Settings → Notifications. Ton
does not offer that as an app type and should not generate apps that try to.

**What to do — delivery (provider adapter)**
1. Store provider credentials in Secret Manager (platform-wide sending domain for MVP;
   per-tenant custom domain is a later optimization for merchants who want their own DKIM).
2. Implement a Resend adapter behind `ctx.email.send()` in `build-ctx.ts`.
3. Add delivery status tracking (`email_deliveries` table: provider message id, status, bounce
   reason, opened/clicked) and basic error handling (retry with exponential backoff, dead-letter
   after N attempts).
4. Wire Resend webhooks into the webhook-gateway service to update delivery status rows.
5. Configure SPF / DKIM / DMARC once on the platform sending domain. Merchants never touch DNS.

**What to do — design system (block-based templates)**
The split is ~80% platform / ~20% merchant:

| Layer | Owner | What it contains |
|-------|-------|------------------|
| Rendering engine | Platform | MJML → cross-client HTML at send time |
| Base layout | Platform | Header, footer, spacing, typography, dark-mode fallbacks |
| Block library | Platform | `hero`, `product_grid`, `cta_button`, `order_summary`, `text`, `image`, `divider`, `coupon_code` — each pre-tested in Litmus or similar |
| Brand tokens | Merchant (once) | Logo URL, primary color, secondary color, font family, footer text, support email, unsubscribe URL — stored in new `merchant_brand` table, set during onboarding |
| Content | Merchant (per app) | Subject, block titles, copy, variable bindings — editable in each app's admin UI |
| Escape hatch | Merchant (advanced) | Raw HTML mode for merchants who want full control; warn that cross-client compatibility is on them |

Update `EmailSendParams` to accept either a `blocks: EmailBlock[]` array (default path) or a
`rawHtml: string` (escape hatch). The generator defaults all new apps to blocks. The harness
renders blocks → MJML → HTML using the merchant's brand tokens at send time, not at generation
time, so brand changes propagate instantly without regenerating apps.

**Migration of existing generated apps**
Test-result apps (e.g. `abandoned_cart_recovery`) currently store `email_body_html` as a TEXT
column. Leave them alone — they'll keep working via the raw-HTML escape hatch. New generations
use the block system.

**What to update in the generator**
- `generator/templates/harness_contract.py` — document the new `blocks` parameter and the
  available block types. Remove any guidance about authoring raw email HTML.
- `generator/subagents/handler_agent.py` — stop emitting `email_body_html` columns; emit
  `ctx.email.send({ to, subject, blocks: [...] })` calls with inline block definitions.

**Complexity:** Medium-High — provider adapter + design system + generator changes + delivery
tracking. Split into sub-tickets when picked up:
- **TD-007a** Resend adapter + credential storage + delivery tracking table
- **TD-007b** MJML block library + `merchant_brand` table + brand-token resolution at send time
- **TD-007c** Generator: switch handler emission from raw HTML to blocks
- **TD-007d** Resend webhook ingest for delivery status updates

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
