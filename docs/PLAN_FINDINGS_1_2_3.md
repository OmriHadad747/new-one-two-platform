# Plan — Findings 1, 2, 3

Source: evaluation of generated bundle at
`platform-ai/cli/test_results/2026-04-23T23-24-56_recover-abandoned-carts-by-sending-timely/`.
Findings 4, 5, 6 are deferred — tracked in `FINDINGS_DEFERRED_4_5_6.md`.

## Scope

- **Finding 1** — Cron handler crashes on first invocation (`shopifyClientFor` misuse: missing `await`, fake context via `as any`).
- **Finding 2** — Admin "Run detection now" throws at runtime (handler writes directly to `cron_queue` with a fabricated `run_at` column).
- **Finding 3** — Cron polled the wrong Shopify endpoint (no schema binding between architect and handler; REST is legacy anyway). Resolution: **remove Shopify REST entirely**, go GraphQL-only.

No generated apps in the wild. Safe to delete rather than migrate.

---

## Finding 1 — Correct `shopifyClientFor` call shape ✅ SHIPPED

### Problem

Handler generated:

```ts
const shopify = shopifyClientFor({ tenantId: "", appId: "", shopDomain: ..., requestId: "cron-main" } as any);
```

Three bugs: no `await` (so `shopify` is a `Promise`), hand-constructed context, `as any` hides the type mismatch. Cron crashes on first run (`undefined.paginate`).

### Root cause

No explicit call-convention rule in the handler prompt. `shopifyClientFor`'s signature accepted a broad union, so the model invented one. `as any` erases the compile-time signal.

### Shipped

**Template:** `ShopifyClientContext` narrowed to `{ shopDomain: string; accessToken?: string }` only; `PlatformContext` import removed. `req.platform!` still satisfies the signature structurally. `tsc --noEmit` passes.

**Prompt:** the Shopify GraphQL capability doc (rewritten as part of Finding 3) explicitly documents the two allowed call forms:
- HTTP path: `const shopify = await shopifyClientFor(req.platform!);`
- Cron path: `const shopify = await shopifyClientFor();`

Plus hard rules: always `await`; never hand-construct a context; never `as any` near the call.

No custom regex validator — `tsc --noEmit` post-generation (TD below) is the structural catch.

### TD note — `tsc --noEmit` post-generation gate

Track alongside existing TD-004. Runs `tsc` on the generated handler source before the bundle is marked successful. Fails the run on any type error. This gate alone would have caught Finding 1's missing `await`. Worth landing next — it's the most general backstop we have for codegen bugs.

---

## Finding 2 — `enqueueJob` helper; stop direct `cron_queue` writes ✅ SHIPPED

### Problem

Admin `POST /run` ([admin.ts:199](platform-ai/cli/test_results/2026-04-23T23-24-56_recover-abandoned-carts-by-sending-timely/src/routes/admin.ts#L199)):

```sql
INSERT INTO cron_queue (job_name, payload, run_at, status, created_at)
VALUES ('main', '{}'::jsonb, NOW(), 'pending', NOW())
ON CONFLICT DO NOTHING
```

`cron_queue` IS a real template-provided table (from `platform-back/templates/handler/migrations/`), but its schema has no `run_at` column. Runtime error when the merchant clicks the button.

### Root cause

Two-layer failure:
1. The handler was asked to write to a template-owned table with no abstraction. It guessed the column shape wrong.
2. The LLM validator (Q1) flagged `cron_queue` as a missing table, which is a **false positive** — Q1 only saw the per-app migration, not template-provided tables. The revision agent burned ~130s + ~39k tokens trying to fix a non-bug, never noticed the real bug (`run_at`), and returned `no_output`. Pipeline silently marked SUCCESS.

### Shipped

**Template helper** (`platform-back/templates/handler/src/lib/cron-enqueue.ts`): new `enqueueJob(jobName, payload)` export. Handler code never sees the `cron_queue` schema — one call triggers a job; template cron-runner dispatches on the next poll tick.

**Single-source-of-truth prompt topic** (`platform-ai/subagents/prompts/topics/template_tables.py`): owns the rule that `cron_queue` + `processed_webhooks` are template-owned (no direct reads/writes), teaches `enqueueJob`, and holds the canonical column sets. Exports two views — `HANDLER` (injected into cron.py and webhook.py via placeholder replacement) and `VALIDATOR` (prepended to validator Part A).

**Consumer prompts:** `cron.py` and `webhook.py` HANDLER blocks inject the shared rule via `%TEMPLATE_TABLES_HANDLER%` placeholder. Validator `PART_A_HEADER` prepends the shared VALIDATOR view; Q1 and Q7 reference it in-line. No duplicated prose across files.

**Validator behavior now:** Q1 no longer flags `cron_queue` / `processed_webhooks` references as missing-table errors (false-positive class killed). Q7 catches real column bugs — a handler INSERT with `run_at` on `cron_queue` is flagged with the specific mismatch.

**Immediate execution only.** Delayed `enqueueJob(name, payload, { runAt })` is a tracked TD.

### TD notes

- **Delayed execution:** `enqueueJob(name, payload, { runAt })` would use the existing `next_visible_at` column in `cron_queue`. Defer until we see a real need.
- **Data-driven template-tables discovery:** `_TEMPLATE_TABLE_COLUMNS` in `template_tables.py` is hand-maintained against `0001_processed_webhooks.sql`. Two tables is fine for now; if the set grows, parse the template migration SQL at load time instead.

---

## Finding 3 — Remove Shopify REST entirely; GraphQL-only ✅ SHIPPED

### Problem

Generated cron called `shopify.rest.paginate("/checkouts.json", {...})`. The architect contract implied the Abandoned Checkouts endpoint. After investigation:
- The endpoint name was likely correct (AbandonedCheckout resource IS served from `/checkouts.json`), but Gemini and I both flagged it as a bug from memory — exactly the ambiguity a catalog eliminates.
- Shopify marked the REST Admin API **legacy as of Oct 1, 2024**. New public apps must be GraphQL-only as of **April 1, 2025**. Latest stable is **2026-04**.
- GraphQL introspection gives us real schema-level validation (unknown fields, arg types, deprecations). REST has no equivalent.

No customer-generated apps exist yet. Removing REST is a clean cut.

### Shipped

Shopify REST is no longer reachable from any LLM-generated code. The
generator surface is GraphQL-only, and the template helpers are the only
way to talk to Shopify.

**Handler surface** (`ShopifyHelper`): `graphql`, `graphqlPaginate`,
`bulkQuery`, `storefront`. No REST methods, no escape hatches.

**Capabilities:** `shopify_graphql` is the only Shopify handler
capability. Architect cannot declare `shopify_rest` — it does not exist.

**Prompts:** every REST example/pattern/validator reference across the
capability, topic, core, and agent prompts is rewritten against the new
surface. The new `shopify_graphql` capability doc teaches the three
helpers with concrete examples, GID discipline, mutation `userErrors`
discipline, and explicit "no manual sleeps" rule.

**Rate limiting:** handled inside the template helpers — soft-throttle
preemptive sleep on successful responses, hard-throttle bounded retry
(5 attempts, 30s cumulative cap). Handler code never sees cost fields.

**`bulkQuery` helper:** wraps Shopify's bulk-operation three-step flow
(start → poll → stream JSONL) behind a single async iterator. Handler
writes no polling or URL-handling code.

Finding 1 (call-convention rules for `shopifyClientFor`) is covered
inline in the new `shopify_graphql.py` — effectively rolled into this
ship. Finding 2 is the remaining open item.

### Not in scope (deferred)

Platform-back's own operational REST usage (webhook registration, OAuth
flow, storefront-token minting, theme provisioning) is **not touched** by
this finding. Those calls run platform-side, are not LLM-generated, and
some endpoints have no clean GraphQL equivalent. Tracked as a TD below.

---

### TD note — GraphQL schema catalog and offline validation

Post-MVP but **in this plan** (user promoted it). Ship after Findings 1-3 close.

**Artifacts** (committed to `platform-ai/catalogs/shopify_graphql/{version}/`):
- `schema.graphql` — full SDL, source of truth.
- `schema.introspection.json` — raw introspection result (for tooling that expects JSON).
- `summary.md` — compressed operation + type index (~10-15k tokens) for architect-prompt injection when schema-aware architect lands.

**Build script** (`platform-ai/scripts/refresh_shopify_graphql_catalog.py {version}`):
- POSTs the standard introspection query to `https://shopify.dev/admin-graphql-direct-proxy/{version}`.
- Writes all three artifacts.
- Manual invocation for now (per user). Cadence revisited when we bump `LATEST_API_VERSION` in the handler template.

**Offline validator** (`platform-ai/subagents/.../graphql_validator.py`):
- Uses `graphql-core` (Python). Loads `schema.graphql` via `build_schema`.
- For each GraphQL query string extracted from handler source, runs `parse()` + `validate(schema, ast)`.
- Catches: unknown field, unknown argument, wrong argument type, required argument missing, deprecated field usage, invalid variable types, fragment-spread mismatches.
- Deterministic, offline, no network. Plugs into the existing static-validation pipeline alongside Q1/Q7.

**Handler prompt integration (when the validator lands):**
- Inject `summary.md` into the handler prompt under a `── Shopify GraphQL — available operations ──` section.
- Handler picks field names from the summary, writes queries against real ops. Validator catches any drift.

**Architect prompt integration (follow-up, not in this TD):**
- Inject the same `summary.md` into the architect when an intent classifier flags "Shopify app." Architect emits a `shopifyGraphqlOperations` list picked from real operations. SDL-slicing for handler prompt added later if token cost becomes an issue.

### TD note — TypeScript codegen via `@shopify/api-codegen-preset`

Post-MVP. Separate TD from the catalog. Do not ship with Findings 1-3.

**What it adds:**
- `@shopify/api-codegen-preset` + `@graphql-codegen/cli` as dev deps in the handler template.
- `.graphqlrc.ts` at the template root pointing `schema` at the **local committed** `schema.graphql` (not the network — determinism).
- Codegen step in the handler build pipeline: parses `` `#graphql` ``-tagged strings in handler source, emits `src/types/admin.generated.d.ts` with `QueryNameQuery` / `QueryNameQueryVariables` types per query.
- Handler writes `await shopify.graphql<AbandonedCheckoutsQuery>(q)` for full result type-safety.

**Why defer:** adds ~2-5s per build + a new dep. The offline validator (above) already catches query-shape errors at generation time, which is the bigger class of bug. Codegen adds handler-side result-shape type-safety — a strictly smaller class. Ship the validator first; add codegen only if we observe handler code mistyping query results in the wild.

**When to pick this back up:**
- The catalog is already built.
- We see handler-side bugs where the handler reads `.custmer` when the field is `.customer`, or assumes a nullable field is non-null.
- Before that signal exists, codegen is solution-in-search-of-a-problem.

### TD note — Schema-aware architect

Post-MVP, follow-up to the catalog. Architect injection of `summary.md` + emission of structured `shopifyGraphqlOperations` field in the plan. Enables a validator check that the handler only calls architect-approved operations. Skip for MVP; ship once the catalog is committed and the offline validator has shown its value.

---

## Order of operations

1. **Finding 3 first** (template cut + REST capability removal + new `bulkQuery` helper + throttle-aware retry inside `graphql`/`graphqlPaginate`/`bulkQuery`).
   Reason: Finding 1's prompt rewrite lives inside the new GraphQL-only capability doc. Doing Finding 3 first means Finding 1's prompt doc is written once, against the final surface, with no REST examples to scrub later. Throttle-aware retry ships here too — it's template-internal and complements the new GraphQL surface.
2. **Finding 1** (prompt rewrite + `ShopifyClientContext` narrowing).
3. **Finding 2** (`cron-enqueue.ts` helper + cron/webhook prompt updates + Q1/Q7 template-tables union).
4. **`tsc --noEmit` post-generation gate.**
   Cheapest high-leverage backstop. Catches Finding 1 and an entire class of adjacent bugs.
5. **GraphQL schema catalog + offline validator.** Build script, committed artifacts, `graphql-core`-based validator wired into the static-validation pipeline. Handler prompt injection of `summary.md`.
6. **TypeScript codegen** (conditional — only if handler-side result-shape bugs surface).
7. **Schema-aware architect** (conditional — natural next step once the catalog is in and the handler-side validator is proving its value).

Steps 1-4 are the MVP scope. Steps 5-7 are tracked but not part of this plan's immediate execution unless you want them bundled.

---

## Out of scope

- Findings 4, 5, 6 — see `FINDINGS_DEFERRED_4_5_6.md`.
- Per-store GraphQL schema introspection (typed custom metafields, metaobjects). Generic schema via direct-proxy is sufficient for v1.
- Removing the `shopify_rest` escape hatch semantics — escape hatch itself is gone, not dormant.
- GraphQL MCP integrations (redundant once the offline validator is in place).
