# Tech Debt — Post-MVP

Items that are known gaps but deliberately deferred until after MVP. Each entry has the affected files and what needs to happen.

---

## TD-001 — MCP umbrella session: one NPX spawn per pipeline run

**Current state**
The MCP pipeline makes two separate `_call_mcp` calls that each spawn their own NPX process:
1. `prefetch_for_run` — `search_docs_chunks` for api_context (+ `introspect_graphql_schema` when topics cache is cold).
2. `validate_handler_graphql` in `HandlerGenerator.validate()` — `validate_graphql_codeblocks` per retry round.

Each NPX spawn takes ~3–5s. On a run with a cold topics cache + one validation retry, that's 3 separate processes.

**What to do**
Open one MCP session at the start of `_phase_architect` (or at the crew entry point), keep the conversationId in a run-scoped context object, and reuse it for both the prefetch search and the post-handler validation. All MCP calls go through the same process.

**Affected files**
- `platform-ai/shopify_mcp/client.py` — expose a session context object or async session manager.
- `platform-ai/crews/feature_generator/crew.py` — open session once, pass context through to codegen phase.
- `platform-ai/subagents/base.py` — add optional `mcp_session` to `CodegenContext`.
- `platform-ai/subagents/handler_agent.py` — use session context in `validate()`.

**Complexity:** Medium — requires threading a session handle through the pipeline without breaking the sync/async boundary that `_run_async` already manages.

---

## TD-002 — SQL schema validation via Postgres EXPLAIN

**Current state**
Schema alignment is validated by the LLM validator (Q7) which cross-checks handler queries against `dbContracts` and `migration.sql`. LLM validation is probabilistic — it can miss column mismatches or produce false positives. Runtime Postgres errors at deploy-time migration (or worse, at request time) are the only guaranteed catch today.

Handlers reach the DB through the `sql` tagged template imported from [platform-back/templates/handler/src/lib/db.ts](platform-back/templates/handler/src/lib/db.ts) — the connection pins `search_path` to the per-app tenant schema (`tenant_<uuid>_app_<uuid>`), so queries use bare table names. Tables live entirely inside that per-app schema; there is no global `tenant_id` column on business tables (tenant scoping is the schema itself).

**The EXPLAIN approach**
`EXPLAIN` parses and plans a SQL statement without executing it. Postgres rejects unknown column names at parse time, making it a deterministic schema validator:

```sql
-- Extracted from a handler `sql` template literal and parameterised:
EXPLAIN INSERT INTO back_in_stock_subscriptions
  (id, email, product_id, product_title)              -- product_title doesn't exist
VALUES ($1, $2, $3, $4);
-- → ERROR: column "product_title" of relation does not exist
```

**What to do**
1. After generation, spin up a short-lived Postgres instance (Docker or `pg_tmp`-style ephemeral), create the per-app schema, apply `migration.sql` inside it, and pin `search_path` to that schema — mirroring the handler's runtime setup.
2. Extract SQL template literals from `handler.js` by scanning `sql` tagged-template blocks (same general regex approach as the existing `_GQL_TEMPLATE_RE` in [platform-ai/shopify_mcp/client.py](platform-ai/shopify_mcp/client.py), re-targeted at `sql\`` rather than `#graphql`).
3. Replace `${...}` interpolations with positional `$N` placeholders.
4. Run `EXPLAIN <statement>` for each extracted query and collect Postgres errors.
5. Return errors in the same `List[str]` format as `static_errors` so they feed into the existing retry loop.

**When to apply**
Only after the LLM validator passes — EXPLAIN is the deterministic final gate before the artifact is accepted. Skip when `migration.sql` is empty (apps with no DB tables).

**Complexity:** Medium — SQL extraction from template literals is the hard part; the Postgres interaction is straightforward. A `pg_tmp` ephemeral instance adds ~1s overhead per run. Sits alongside the compile check (MVP blockers TD-004) as the second deterministic gate; the two complement each other (tsc catches type drift, EXPLAIN catches schema drift).

**Affected files**
- `platform-ai/subagents/static_validation.py` — add `validate_handler_sql_schema(handler_js, migration_sql)`.
- `platform-ai/crews/feature_generator/crew.py` — call after the LLM validator phase, before bundle publish.

---

## TD-003 — Merchant-facing notifications channel for runtime warnings

**Current state**
Several platform-side signals are merchant-actionable but invisible in the UI because the Logs tab only shows invocation-level rows (`InvocationLogEntry` / `WebhookInvocationLogEntry` in `platform-front/src/types/dashboard.ts` — id, path/topic, status, durationMs, errorMessage, timestamp). Individual `logger.warn` lines emitted inside handlers or platform services have nowhere to surface.

Concrete first case driving this: `EMAIL_DATA_MANIFEST_DRIFT` in `platform-back/packages/email/src/sender.ts`. When the handler passes `data` keys that don't match the generator-declared `apps.email_variables` manifest, the merchant's `{{tokens}}` may render empty. Today this is `logger.warn`'d to the backend sink only — operators see it, merchants never do.

**Why not just extend the Logs tab**
`InvocationLogEntry` is a typed row per invocation. Widening it to carry arbitrary log lines would bloat every row and mix two audiences (operator debugging vs. merchant action). A separate Notifications tab keeps the two concerns cleanly split and gives room for filtering, mark-as-read, and badge counts that don't belong on the Logs tab.

**Open product question (resolve before building)**
What do we tell the merchant to do when they see a drift notification?
  - "Run a revision on this app" (triggers a regen that aligns the manifest).
  - Inform-only — the next regen will self-heal.
  - "Edit the Email tab — some of your {{tokens}} may render empty."

Surface-only is acceptable for the initial rollout; telemetry on hit rate will tell us whether a remediation path is worth the complexity.

**What to do**
1. New table `app_notifications (id, tenant_id, app_id, event, severity, payload jsonb, seen_at, created_at)`. Tenant scoping is enforced in application code (same pattern as the other platform tables — `requireTenant` + explicit `tenant_id` predicates); no FORCE-RLS dance needed.
2. Write path: every platform-side `logger.warn` event that is merchant-actionable also inserts a row. Wrap the dual-write in a small helper (`emitNotification(logger, { event, severity, payload })`) so call sites can't drift between log and row. First adopter: the `EMAIL_DATA_MANIFEST_DRIFT` site in `platform-back/packages/email/src/sender.ts`.
3. Read path: `GET /tenants/:tid/apps/:aid/notifications` with pagination + a `PATCH .../seen` endpoint.
4. New Notifications tab on `AppDetailPage` alongside Logs/Email/Settings; badge unread count on the tab label.

**Affected files** (when done)
- `platform-back/packages/db/migrations/00NN_app_notifications.sql` — new table.
- `platform-back/packages/db/src/notifications.ts` — new module (read/write helpers + the `emitNotification` dual-write wrapper).
- `platform-back/packages/email/src/sender.ts` — dual-write at the `EMAIL_DATA_MANIFEST_DRIFT` warn-log site.
- `platform-back/apps/api/src/routes/notifications.ts` — new route, registered under `/tenants/:tenantId/...`.
- `platform-front/src/pages/AppDetailPage.tsx` — new tab + badge.
- `platform-front/src/types/dashboard.ts` — `AppNotification` type.

**Complexity:** Medium. The DB + API + UI pieces are each straightforward; the cross-cutting ergonomics (helper + consistent event taxonomy across every future warn-level signal) is what takes the extra time.

---

## TD-004 — Pre-revision validator scan of the prior bundle

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
1. In `platform-ai/crews/feature_generator/crew.py`, add a `_prerevision_validator_scan(base_ctx)` helper that assembles the prior bundle as a pseudo-`artifacts` dict and calls `run_validator_agent` on it. Filter results to Part B HIGH-confidence open findings only.
2. Wire it into `_phase_codegen` just before the `is_revision_first_attempt` branch fires, capturing the findings once per run.
3. In `platform-ai/subagents/revision_agent.py`, extend `_build_user_prompt` with a new kwarg `pre_existing_issues: List[Dict] | None`. Render under a `PRE-EXISTING ISSUES — fix alongside the merchant's request` header between the merchant-feedback block and the validator-retry block, with explicit priority ordering ("Merchant feedback takes priority; address these only if compatible with the merchant's intent").
4. Skip the scan when `base_ctx.prior_handler_code` is None (first-run generation — nothing to scan).

**Affected files**
- `platform-ai/crews/feature_generator/crew.py` — new helper + one call site.
- `platform-ai/subagents/revision_agent.py` — new kwarg + prompt section.

**Complexity**
Low — everything plugs into existing components (`run_validator_agent`
already supports arbitrary artifact dicts; `_build_user_prompt` already
composes multiple issue blocks). The hard part is the product call on
how strictly the revision agent should prioritize merchant intent over
pre-scanned findings — document that as a rule in the revision prompt,
then measure.

---

## TD-005 — `host.on` / `bridge.on` page-level event surface + widget `unmount` hook

**Current state**
Both the widget and admin_ui prompts permit `document.addEventListener` (widget prompt at [platform-ai/subagents/prompts/core/widget.py:50-52](platform-ai/subagents/prompts/core/widget.py#L50-L52) explicitly allows it for visibilitychange / scroll / outside-click / cart events). Generators reach for it freely. Neither the widget `host` ([widget-runtime.js:125](platform-shopify-app/extensions/widget-runtime/assets/widget-runtime.js#L125)) nor the admin `bridge` ([platform-shopify-admin/src/types.ts:16-32](platform-shopify-admin/src/types.ts#L16-L32)) exposes an `.on(...)` escape hatch that would let the shell track listeners and dispose them on teardown.

**Why this is more acute after the refactor**
1. **Widget re-mounts on every URL change.** The new runtime at [widget-runtime.js:86-91](platform-shopify-app/extensions/widget-runtime/assets/widget-runtime.js#L86-L91) listens to `urlchange` and calls `runMount()` again whenever the storefront URL changes (variant switches, SPA navigation). `runMount()` wipes `container.innerHTML = ""` but does **nothing** about listeners the prior mount attached to `document` / `window`. Every navigation adds another copy of the same listener — the theme-page hop case is no longer hypothetical, it's the default.
2. **Widget contract has no `unmount`.** The widget-side mount signature is `mount(container, host)` only ([widget.py:18](platform-ai/subagents/prompts/core/widget.py#L18), [widget_js_agent.py:5](platform-ai/subagents/widget_js_agent.py#L5)). Even if the generator wanted to clean up, it has no callback the runtime will invoke. The admin side does have an optional `unmount(container)` ([types.ts:38-39](platform-shopify-admin/src/types.ts#L38-L39)) and `ModuleFrame` does call it, but the bridge doesn't offer a disposer surface so admin modules using `document.addEventListener` leak too.
3. **No structured cleanup for the LLM.** Pairing every `addEventListener` with a matching `removeEventListener` at the right time is exactly the kind of bookkeeping that drifts across revisions.

**What to do**
Ship three coordinated changes:

1. **Add `host.on` to the widget runtime** in [platform-shopify-app/extensions/widget-runtime/assets/widget-runtime.js](platform-shopify-app/extensions/widget-runtime/assets/widget-runtime.js): wrap `document.addEventListener` / `window.addEventListener` inside `buildHost({...})`, stash disposers in a per-mount `Set`, drain the set before each `runMount()` call and on future unmount hooks.
2. **Add a widget `unmount` hook** to the contract. Extend `runMount` to call `widgetModule.unmount?.()` before the next mount if present, and update the widget prompt at [platform-ai/subagents/prompts/core/widget.py](platform-ai/subagents/prompts/core/widget.py) to declare and encourage it (but keep it optional — unmount isn't always needed, and `host.on`-based cleanup is the preferred path).
3. **Add `bridge.on` to the admin bridge** in [platform-shopify-admin/src/components/AdminShell.tsx](platform-shopify-admin/src/components/AdminShell.tsx) (`makeBridge` factory) + [types.ts](platform-shopify-admin/src/types.ts). Same disposer-set pattern; drain on app switch in [ModuleFrame.tsx](platform-shopify-admin/src/components/ModuleFrame.tsx) right before `mod.unmount?.(container)` fires.

Baseline API shape (identical across surfaces):
```js
const off = host.on("visibilitychange", (ev) => { ... });
const off = host.on("scroll", onScroll, { passive: true });
const off = host.on("cart:update", handler);   // document-dispatched events
off();                                          // manual disposal if needed
                                                // otherwise auto-disposed on unmount
```

Once landed:
- Add "use `host.on` / `bridge.on` for page-level events — never `document.addEventListener`" to the widget and admin prompts.
- Tighten [platform-ai/subagents/static_validation.py](platform-ai/subagents/static_validation.py): flag `document.addEventListener` without a matching `removeEventListener`, then once telemetry confirms the host surface covers the legitimate cases, move `addEventListener` onto the widget/admin denylist outright.

**Affected files**
- `platform-shopify-app/extensions/widget-runtime/assets/widget-runtime.js` — add `host.on` + disposer drain + `widgetModule.unmount?.()` on re-mount.
- `platform-shopify-admin/src/components/AdminShell.tsx` — add `bridge.on` to the `makeBridge` factory.
- `platform-shopify-admin/src/components/ModuleFrame.tsx` — drain bridge disposers on app switch.
- `platform-shopify-admin/src/types.ts` — extend `AdminBridge` with `on(event, cb, options?)`.
- `platform-ai/subagents/prompts/core/widget.py` — document `host.on`, declare the optional `unmount` hook, remove `document.addEventListener` from the allowed list once the shell ships.
- `platform-ai/subagents/prompts/core/admin.py` (or its equivalent for the admin module prompt) — document `bridge.on`.
- `platform-ai/subagents/static_validation.py` — widget/admin `addEventListener` rule.

**Complexity:** Low-Medium. Disposer plumbing is ~30 lines per surface. The coordination cost is the cross-cutting rollout: the host surface must ship before the prompts forbid `document.addEventListener`, otherwise existing generated widgets that already use it stop validating.

---

## TD-006 — Revision failure artifacts saved to /tmp only

**Current state**
When the revision agent produces structurally invalid code after two attempts, `_phase_validator()` in [platform-ai/crews/feature_generator/crew.py](platform-ai/crews/feature_generator/crew.py) saves the bad artifacts (code + validation errors) to `/tmp/revision_validation_failures/<timestamp>_<job_id>.json` via `_save_revision_failure()`. `/tmp` is ephemeral — the file disappears when the Cloud Run container exits, making post-mortem analysis unreliable in production.

**What to do**
Replace or augment the `/tmp` write with a durable sink:

- **GCS (preferred):** upload the JSON to a dedicated bucket, e.g. `gs://<project>-generation-failures/revision/<timestamp>_<job_id>.json`. Add the bucket name to settings (env var `REVISION_FAILURE_BUCKET`). Use the same GCS client already used elsewhere in `platform-ai/` for file storage.
- **DB alternative:** insert a row into a `generation_failures` table (`job_id`, `timestamp`, `failure_type`, `errors JSONB`, `artifacts JSONB`). Lets you query failure patterns across runs without downloading files.

The local CLI path ([platform-ai/cli/chat_local.py](platform-ai/cli/chat_local.py)) already writes to `platform-ai/cli/test_results/revision_failures/` which is persistent — no change needed there.

**Affected files**
- `platform-ai/crews/feature_generator/crew.py` — `_save_revision_failure()`: add GCS/DB upload after the local write (keep `/tmp` as fallback if the upload fails).
- `platform-ai/config.py` — add `REVISION_FAILURE_BUCKET` setting.
- Possibly a new migration in `platform-back/packages/db/migrations/` if the DB route is chosen.

**Complexity:** Low — the GCS upload pattern is already used elsewhere in the codebase.

---

## TD-007 — Architect supports only ONE cron schedule per app

**Current state**
The architect's plan carries `cronSchedule: Optional[str]` — exactly one cron expression ([platform-ai/contract/validators.py:94](platform-ai/contract/validators.py#L94)). The handler template's cron runner polls `cron_queue` and dispatches on `job_name`, so it already supports N named jobs. The deployer's [platform-back/packages/deployer/src/cron-scheduler.ts](platform-back/packages/deployer/src/cron-scheduler.ts) registers one pg_cron schedule per app via a stable job name. The generator is held to one tick (`jobs = { main: async (payload) => {...} }`) only because the architect has no field for a set of schedules.

**What this blocks**
Apps with legitimately multiple scheduled tasks must either (a) cram all logic behind a single cron tick and branch internally (awkward, one-schedule-fits-all) or (b) be rejected at the architect stage as "unsupported." Both are compromises.

**What to do**
Replace `cronSchedule: Optional[str]` with `cronJobs: List[{name: str, schedule: str}]` on the plan. Architect emits one entry per scheduled task; generator's jobs map gets one key per entry; deployer registers one pg_cron entry per job (each inserting into `cron_queue` with the matching `job_name`).

**Affected files** (when done)
- `platform-ai/subagents/prompts/core/architect.py` — cron section in the architect's system prompt.
- `platform-ai/contract/validators.py` — plan schema: swap `cronSchedule` for `cronJobs`.
- `platform-ai/subagents/handler_agent.py` — pass the jobs list to the handler prompt instead of a single `cronSchedule`.
- `platform-ai/subagents/prompts/topics/cron.py` — handler jobs-map prompt accepts multiple entries.
- `platform-ai/subagents/migration_agent.py` — emit one migration row per job (if the migration needs to enumerate them).
- `platform-back/packages/deployer/src/cron-scheduler.ts` — register N schedules per app (today it registers one); add parallel `unscheduleAppCron` teardown for each.

**Complexity:** Low-Medium — the runtime already supports N jobs; the deployer's `scheduleAppCron` needs a small loop, and the architect-field + prompt expansion is straightforward.

---

## TD-008 — API rate limiter is per-instance, not distributed

**Current state**
`platform-back/apps/api` uses an in-memory `@fastify/rate-limit` store on the three public route groups (`/oauth/*`, `/widget/*`, `/email/u/*`). With Cloud Run's `maxScale: 10`, each instance enforces its own independent counter — a flood of 10 × 100 req/min = 1 000 req/min effective limit before any IP is rejected. Limits also reset silently when an instance is replaced.

The webhook-gateway already uses Redis-backed rate limiting (ioredis is a direct dep there). The API does not have ioredis and adding it solely for rate limiting was deferred.

**What to do**
1. Add `ioredis` as a dep to `platform-back/apps/api`.
2. Create a shared Redis client in `src/server.ts` using the same `REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_TLS` env vars the gateway uses.
3. Pass the client as `redis` to each `@fastify/rate-limit` registration in the three scoped public-route plugins.
4. Close the client in the `closeServer` / shutdown handler.

**Affected files**
- `platform-back/apps/api/package.json` — add `ioredis`.
- `platform-back/apps/api/src/server.ts` — construct shared Redis client, pass to rate-limit registrations.

**Complexity:** Low — mechanical dep addition + client wiring; no logic changes.