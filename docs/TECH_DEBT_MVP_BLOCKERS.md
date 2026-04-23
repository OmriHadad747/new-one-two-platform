# Tech Debt — MVP Blockers

Items that must land before MVP launch. Each entry has the affected files and what needs to happen.

---

## TD-001 — platform-front deploy-progress UI

**Current state**
Per-app deploys are async on the backend: `POST /apps/:appId/deploy` returns `202 { jobId }` immediately ([platform-back/apps/api/src/routes/deploy.ts:61,131](platform-back/apps/api/src/routes/deploy.ts#L61)), and `GET /deploy/jobs/:jobId` streams live progress as SSE ([platform-back/apps/api/src/routes/deploy.ts:70,142](platform-back/apps/api/src/routes/deploy.ts#L70)). Cloud Run deploys take 1–3 minutes — too long for a sync request, which is why the contract is built this way.

The dashboard side is empty: no "Deploy" button wired to `POST /apps/:appId/deploy`, no progress view subscribed to the SSE stream, no terminal-state routing.

**What to do**
- Add a "Deploy" button on `AppDetailPage` (or wherever app actions live), wired to `POST /apps/:appId/deploy`.
- On 202, store the returned `jobId` and open the SSE stream at `GET /deploy/jobs/:jobId`.
- Render the progress steps (build context → image build → SA grant → migration job → Cloud Run deploy → DB writes), each with a per-step state (pending / running / done / failed).
- On terminal `success`, route to the deployed-app screen. On terminal `failed`, route to an error log view.
- Reuse the SSE transport plumbing `platform-front` already uses for generation progress — same connection/reconnection patterns apply.

**Affected files** (when done)
- `platform-front/src/pages/AppDetailPage.tsx` — Deploy button + progress view.
- `platform-front/src/api/deploy.ts` (or equivalent) — typed wrapper around `POST /apps/:appId/deploy` and the progress stream.
- `platform-front/src/types/dashboard.ts` — `DeployJob`, `DeployStep`, `DeployStepStatus` types.

**Complexity:** Low — same shape as the existing generation-progress UI. The backend side is already live.

---

## TD-002 — Shopify uninstall + GDPR compliance webhooks not wired

**Current state**
None of the Shopify lifecycle / compliance webhook topics are handled today:
- `app/uninstalled` — no handler; when a merchant uninstalls, platform state is never cleaned up.
- `shop/redact` — no handler; GDPR shop-data redaction requests are silently dropped.
- `customer/redact` — no handler; GDPR customer-data redaction requests are silently dropped.

A "tenant hard-delete" helper also doesn't exist — there's no way to wipe a tenant's data from the platform, even via admin tooling. (Per-app teardown is in place via `teardownApp` and `permanentDeleteApp` in [platform-back/packages/deployer/src/lifecycle.ts](platform-back/packages/deployer/src/lifecycle.ts); what's missing is the tenant-wide equivalent.)

**Why it matters**
`shop/redact` and `customer/redact` are **required by Shopify** to pass app review for public or unlisted distribution. Without them the app cannot be listed. `app/uninstalled` is needed to keep billing state and tenant schemas / GCS storage in sync when a merchant leaves.

**What to do**
1. Register the three webhook topics in the OAuth install flow (Shopify requires them to be declared at install time). Install flow lives in [platform-back/apps/api/src/routes/oauth.ts](platform-back/apps/api/src/routes/oauth.ts).
2. Add a Shopify lifecycle webhook route (e.g. under the existing `/webhook/` prefix — see [platform-back/apps/api/src/routes/webhook/](platform-back/apps/api/src/routes/webhook/)) that receives HMAC-verified Shopify app lifecycle webhooks.
3. `app/uninstalled` handler: cancel the Shopify subscription (if any), call `teardownApp` + `permanentDeleteApp` for every app owned by the tenant, and mark the tenant inactive.
4. `shop/redact` handler: hard-delete the tenant and all its data (same blast radius as the new `deleteTenant` helper). Must run within 30 days of the request per Shopify policy.
5. `customer/redact` handler: forward to each of the tenant's handler Cloud Run services so app-layer customer data can be scrubbed.
6. Implement a `deleteTenant(tenantId)` helper in [platform-back/packages/deployer/src/lifecycle.ts](platform-back/packages/deployer/src/lifecycle.ts) that orchestrates: `permanentDeleteApp` for each app → GCS tenant-prefix wipe → DB tenant row delete (cascades through `apps`, `app_versions`, etc. via `ON DELETE CASCADE`).

**Priority**
Custom distribution (current mode) → low. Public/unlisted Shopify listing → blocks app review.

---

## TD-003 — Shopify client has no built-in 429 retry

**Current state**
Handlers get a Shopify client via `const shopify = await shopifyClientFor(req.platform); shopify.rest.get(...)` (template at `platform-back/templates/handler/src/lib/shopify.ts`). The client is a thin wrapper around `@shopify/shopify-api`'s REST/GraphQL methods — it owns token resolution and a one-shot 401 refresh path, but does **nothing** for 429 responses or the `Retry-After` header. The upstream SDK doesn't retry on rate limits either; it exposes the headers but leaves retry policy to the caller.

Handlers that call Shopify in a loop (cron bulk-fetch, per-item enrichment) surface 429s as raw failures the moment a store's bucket runs out. The LLM has no prompt guidance here either, so it occasionally invents half-right backoff (the `setTimeout`-in-a-loop regression on the abandoned-cart gen was exactly this shape before static validation caught it).

**Why this is platform, not prompt**
"Wait and try again" is infrastructure — nothing domain-specific. Every handler that hits Shopify needs it; putting it in the client fixes it once for every current and future app and removes a class of LLM-drift bugs.

**What to do**
In `platform-back/templates/handler/src/lib/shopify.ts`, wrap the `rest` / `graphql` wrappers with retry discipline:
- Honour `Retry-After` when present (seconds or HTTP-date).
- Exponential backoff + jitter when absent (e.g. 500ms → 1s → 2s → 4s, capped).
- Cap at 3–4 retries total, then throw a typed `ShopifyRateLimitError` so handlers can log it.
- Apply to 429 and transient 5xx (502/503/504).

Once landed, add a hard rule to the handler prompt: *"`shopify.rest` / `shopify.graphql` handle 429/5xx retries internally. Never add `setTimeout`, sleep loops, or retry wrappers around Shopify calls."* That stops the LLM from writing competing backoff logic.

**Affected files**
- `platform-back/templates/handler/src/lib/shopify.ts` — add retry wrapper around the SDK's `rest` / `graphql` calls (keep the existing 401 refresh path intact).
- `platform-back/packages/types/src/...` — add `ShopifyRateLimitError` if the typed error is surfaced across the template boundary.
- `platform-ai/subagents/prompts/handler/` — add the "do not retry" rule after the platform change ships.

**Complexity:** Low — one file, well-defined contract (honour `Retry-After`, exponential fallback). Lives inside the template, so redeploys pick up the new behaviour without regenerating handlers.

---

## TD-004 — Compile the generated handler during generation; feed errors back into the chain

**Current state**
`platform-ai/crews/feature_generator/crew.py:_phase_validator()` validates the generated handler with two non-compile gates:
1. **Static validation** (`platform-ai/subagents/static_validation.py`) — regex rules for forbidden patterns (React in widgets/admin, `document.*` misuse, sentinel/schema checks).
2. **LLM validator** (`run_validator_agent`) — semantic review + cross-artifact contract checks.

Neither runs the TypeScript compiler. Genuine type errors — wrong argument shape to `shopify.rest.get(...)`, a missing import, a stale `ctx.*` method name, a bad `await` — are only caught at deploy time inside the Cloud Run image build (~1–3 min per attempt), surfacing as a failed deploy rather than a retryable validation error. Each miss costs a revision round-trip for the merchant and a deploy budget for us.

The template already has everything a compile step needs: [platform-back/templates/handler/tsconfig.json](platform-back/templates/handler/tsconfig.json) + [package.json](platform-back/templates/handler/package.json) with the full `@shopify/shopify-api`, `postgres`, and platform-provided types installed. A fresh clone of the template with the generated handler + migration dropped in compiles in 2–4s with `tsc --noEmit`.

**Why MVP, not post-MVP**
The MVP promise is "describe a feature → platform generates, deploys, and it works." A generator that emits type-broken code one time in five turns that promise into "describe a feature → wait 3 minutes → see a deploy error → revise → wait 3 more minutes." Compile errors are the most common deterministic LLM-drift failure and are precisely the kind of feedback the revision agent can fix in one attempt — deferring this past MVP means shipping a flaky first-run experience that revision polish can't paper over.

**What to do**
1. Add a `_phase_compile(artifacts)` step in `crew.py` after static validation and before the LLM validator. On first failure, feed the `tsc` errors (file:line:message) into the existing revision loop — same shape as `static_errors`, so the revision agent already knows how to consume it.
2. Implement `compile_handler_artifact(handler_js, migration_sql)` in a new `platform-ai/subagents/compile_check.py`:
   - Create a temp dir, copy the handler template (or mount its read-only node_modules via symlink to avoid the install cost each run).
   - Write the generated handler into `src/` and any generator-declared types.
   - Run `tsc --noEmit --pretty false` with a short timeout; parse stdout into a `List[str]` of `file:line: message` entries.
   - Return `[]` on success, error strings on failure.
3. Cap at 2 compile-retry rounds (matching the existing revision retry budget). Persist failure artifacts into the same `_save_revision_failure` sink as other revision failures.
4. Gate behind an env flag initially (`ENABLE_COMPILE_CHECK`) so we can toggle off if tsc overhead blows the crew budget in production.

**Affected files** (when done)
- `platform-ai/subagents/compile_check.py` — new module: sandboxed tsc runner + output parser.
- `platform-ai/crews/feature_generator/crew.py` — new `_phase_compile` hooked into `_phase_validator`; compile errors merged into the existing retry `error_map`.
- `platform-ai/subagents/revision_agent.py` — extend the revision prompt to accept compile-error entries (same shape as static-validation errors; likely a one-line prompt section).
- `platform-ai/config.py` — `ENABLE_COMPILE_CHECK` flag.
- `platform-ai/Dockerfile` — ensure a Node runtime + the template's `node_modules` (or a pre-warmed pnpm store) are available to the generation worker.

**Complexity:** Medium. The tsc invocation + output parse is straightforward; the work is (a) keeping the sandboxed compile cheap (pre-warmed `node_modules` is the difference between 3s and 30s per run) and (b) making the error format legible enough for the revision agent to act on without hallucinating fixes for lines that aren't the real root cause.