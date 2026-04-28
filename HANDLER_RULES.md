# Handler Prompt Rules — Validation Map

Source: every handler-facing prompt block — `platform-ai/subagents/prompts/topics/handler.py` (HANDLER, HANDLER INVARIANTS), the non-`ARCHITECT*` blocks under `topics/{cron,webhook,widget,admin_ui,db_contracts,shopify_loop,state_machine,template_tables}.py`, and the capability-gated docs under `subagents/prompts/capabilities/{email,files,shopify_graphql,shopify_storefront,npm}.py` JIT-injected per `handlerCapabilities`.

**Legend** — `validate?` = should this rule be enforced after the handler emits its file bundle?
- **static** — structural / regex / AST / schema-shape / cross-artifact check. HIGH precision (no false positives). The static layer is the union of `llm_validations/handler_artifact.py` (regex/AST), `llm_validations/handler_typecheck.py` (tsc gate), `llm_validations/handler_graphql.py` (Shopify schema), `llm_validations/cross_{widget,admin}_handler.py` and `llm_validations/shopify_ops.py` (cross-artifact catalog matching).
- **llm** — semantic, prose, or judgment that won't survive a cheap structural check but is worth catching agentically (per `LLM_VALIDATORS_PLAN.md`).
- **no** — judgment/style/informational; high false-positive risk relative to value.
- **no (paranoid)** — structural rule the prompt + file-bundle template already carry; model gets it right ~always. If it ever drifts, `bug_finder` (Sonnet + thinking) catches downstream runtime impact, and `handler_typecheck` / `handler_graphql` catch deploy-blocking versions.

**`done?`** column — `✅` means the static-tier check is currently implemented (cross-referenced to a numbered check in [`platform-ai/llm_validations/handler_artifact.py`](platform-ai/llm_validations/handler_artifact.py)'s docstring, or to the deterministic gates `handler_typecheck` / `handler_graphql` / `cross_*_handler` / `shopify_ops`). Blank for `llm` / `no` / `no (paranoid)` rows.

**One owner per rule** — every row has exactly one owner. No rule is enforced by both static AND llm, AND no rule has a regex/AST static check on top of what `handler_typecheck` (tsc) or `handler_graphql` (Shopify schema) already catches. Those two ARE the static enforcement for what they cover.

**Static-validation principle:** only enforce a regex/AST static rule when (a) the failure mode has been seen with non-trivial frequency, (b) the check is cheap & structural with low false-positive risk, (c) the blast radius is catastrophic (deploy fails, silent corruption, charged-the-wrong-amount, double-execution, tenant cross-talk), AND (d) tsc + handler_graphql don't already catch it. Everything else flows through the LLM validators (`agent_rules` + `bug_finder`).

**What earns a static validator (concept summary for future sessions):** the static layer in this repo is intentionally narrow. A rule earns a regex/AST check ONLY when all four bars are cleared: it's structurally checkable, the model fails it often enough to matter, the failure is catastrophic (not "drift" or "wasted tokens" or "annoying UX"), AND the deterministic runtime gates (`tsc`, `handler_graphql`, `handler_typecheck`, the migration generator's DDL emitter) don't already surface it. Everything else — including most of the handler invariants, the platform-SDK usage rules, and any "is this idiomatic?" check — belongs to the LLM validators (`agent_rules` for prompt-rule compliance, `bug_finder` Sonnet+thinking for cross-artifact runtime bugs). When in doubt: trust the prompt + bug_finder safety net. A static check duplicating tsc is dead code with a less actionable error message; a static check on a rare-failure rule is a tax on every gen for a benefit you can't measure. The prompt is teaching, the static layer is the "everyone gets these wrong" net, and the LLM validators are the catch-all for semantic and cross-artifact issues. Bias toward removing static checks, not adding them.

---

| # | rule | validate? | how | done? |
|---|---|---|---|---|
| **Harness contract / file bundle** | | | | |
| 1 | Handler does NOT emit replacements for template-owned files (`topics/template_tables.py:TEMPLATE_OWNED_FILES`) | yes | static | ✅ |
| 2 | Files emitted only under `src/routes/*.ts` and `src/lib/*.ts`; no absolute paths, no `..` traversal | yes | static | ✅ |
| 3 | Bundle uses `===FILE: <path>===` / `===END===` markers; bundle parses cleanly | yes | static | ✅ |
| 5 | `<path>` ≤512 chars; full file contents per emit; no markdown fences / prose outside markers | no (paranoid) | — | |
| 6 | `cron.ts` emitted iff architect declared `cronSchedule` non-null | no (paranoid) | — | |
| 7 | `widget.ts` NOT emitted when `widgetApiCatalog` is `[]` (storefront-direct) | no (paranoid) | — | |
| 8 | `webhook-handlers.ts` emitted iff `webhookTopics` non-empty | no (paranoid) | — | |
| 9 | Required exports (`webhookHandlers` / `adminRouter` / `widgetRouter` / `jobs`) present | no | — (made impossible by the template structure — the template `import`s these names directly, so a missing export is a tsc compile error. Not a separately-maintained check) | |
| **TypeScript & imports** | | | | |
| 10 | ESM `import` syntax only; no `require()`, no `module.exports` | no (paranoid) | — (covered by `handler_typecheck` — `require` is undefined in ESM mode → tsc error) | |
| 11 | Imports only from: node builtins, packages declared in `handlerCapabilities` (npm:*), template-shipped packages, relative `../lib/*` and `./*` | yes | static | ✅ |
| 12 | No `eval()`, `Function()`, `setInterval()`, `setImmediate()`, `process.exit()`, `process.kill()` | yes | static | ✅ |
| 13 | `setTimeout` permitted only as bounded pause with literal numeric delay ≤500ms | yes | static | ✅ |
| 14 | `process.env` read only at module init — never per-request | no | — (no observable runtime difference on Cloud Run; env doesn't change per-request) | |
| 15 | HTTPS URLs allowed ONLY inside `fetch()` calls; never in comments / templateIds / other string literals | yes | llm | |
| 16 | TypeScript compiles under `tsc --noEmit` | yes | static | ✅ (`handler_typecheck`) |
| **Forbidden references** | | | | |
| 18 | No direct import of `lib/platform-call.ts` | yes | static | ✅ |
| 19 | No direct DML on template-owned tables (`cron_queue`, `processed_webhooks`) | yes | static | ✅ |
| 20 | No local-disk writes (`sharp(...).toFile`, `.pipe(fs.createWriteStream(...))`, `.xlsx.writeFile(...)`) | yes | static | ✅ |
| **Error handling & responses** | | | | |
| 21 | Try/catch inside routes; uncaught errors fall to template's error handler | no (paranoid) | — | |
| 22 | Hand-rolled `fetch()` to `/services/*` (must use `platform.*`) | yes | static | ✅ (covered by row 15 + row 18) |
| 23 | `callPlatformService` direct call | no (paranoid) | — | |
| 24 | Every admin/widget route sends a response (`res.json` / `res.status().json` / `res.status().send`) | yes | llm | |
| 25 | Webhook handlers don't write to `res` (template router owns all `res.*`); throw to signal failure | yes | static | ✅ |
| 26 | Catch `ShopifyRateLimitError` specifically when surfacing degraded outcome | no | — | |
| **Email service (`platform.email`)** | | | | |
| 27 | Email send loop catches `QuotaExceeded` (kind=`"email"`) and stops the loop — never retry | yes | llm | |
| 28 | `delivered:false` is a SOFT outcome — log and continue; do NOT throw | yes | llm | |
| 29 | All `data` keys passed to `platform.email.send` are camelCase | yes | llm | |
| 30 | Do NOT pass `subject` / `templateId` / HTML to `platform.email.send` | yes | llm | |
| 31 | Do NOT store email HTML in the app's DB tables or compile templates inside the handler | yes | llm | |
| 32 | `QuotaExceeded` shape | no (paranoid) | — | |
| **Email metadata sidecar (when handler uses email service)** | | | | |
| 33 | Sidecar emitted iff handler calls `platform.email.send/sendBatch`; exactly ONE fenced ```email-metadata``` block | yes | static | ✅ |
| 34 | `variables` ↔ `data:` keys cross-check (sidecar lists exactly the camelCase keys passed in `data`) | yes | llm | |
| 35 | `ctaLabel` + `ctaUrl` together iff any URL-flavored variable in `variables` (`*Url` / `url`) | no | — (broken CTA renders as missing button or dangling label; merchant edits the sidecar in the Email tab anyway and would notice) | |
| 36 | `variables` ↔ `starterContent` `{{x}}` references consistent (every placeholder declared, every variable referenced) | yes | static | ✅ |
| 37 | `starterContent.subject` / `body` reference declared variables with `{{var}}` placeholders | no | — | |
| 38 | `heading` optional (omit key entirely otherwise) | no (paranoid) | — | |
| 39 | No `<placeholder>` tokens echoed verbatim in sidecar strings | no (paranoid) | — | |
| **Files service (`platform.files`, when declared)** | | | | |
| 40 | Method picked explicitly: `upload` (≤25 MiB) vs `uploadLarge` (≤500 MiB); SDK throws `PayloadTooLarge` on wrong choice | no (paranoid) | — | |
| 41 | MIME type ∈ allowed set | no | — (SDK rejects unsupported MIME at runtime — fast, actionable, single-call failure) | |
| 42 | Pass `Buffer` or `Uint8Array` directly as `contents`; never pre-base64-encode | no | — (SDK rejects pre-encoded blob immediately at runtime) | |
| 43 | Store `fileId`; re-sign read URLs via `platform.files.signReadUrl` (upload URL expires ~15 min) | yes | llm | |
| 44 | No `storage.googleapis.com` URL literal (SDK is the only path) | no (paranoid) | — | |
| **DB / SQL** | | | | |
| 45 | All SQL goes through `sql` tagged template from `../lib/db.js` (implicit via import allowlist + tsc) | yes | static | ✅ (covered by row 11 + row 16) |
| 46 | Tables not qualified with schema name (`tenant_<x>.<table>`) | yes | llm | |
| 47 | No `tenant_id` column referenced in any `sql\`...\`` block | yes | static | ✅ |
| 48 | IDs passed to `sql` are not wrapped in `String()` | yes | llm | |
| 49 | When IDs are JS `Map`/object keys, both sides normalized with `String()` (or both built as GIDs) | yes | llm | |
| 50 | NUL-byte stripping on any string sourced outside the handler before postgres write | yes | llm | |
| 51 | Atomicity across statements uses `sql.begin(tx => {...})` | no | — | |
| 53 | Handler INSERT/UPDATE literal values against `dbContracts` `enum` columns must be members of that enum | yes | static | ✅ |
| **Idempotency / atomicity (Invariants 1–3)** | | | | |
| 54 | **Inv 1** — Atomic claim: `UPDATE … RETURNING` then act; never SELECT-then-act-then-UPDATE | yes | llm | |
| 55 | **Inv 2** — Scoping: every SQL op in a request-driven path filters to the entity from the request payload | yes | llm | |
| 56 | **Inv 3** — Replay-safe INSERTs: `ON CONFLICT DO NOTHING` (or `DO UPDATE` for upserts) paired with `uniqueConstraint` | yes | static (structural target match) + llm (semantic — should this INSERT use ON CONFLICT at all?) | ✅ structural half — `_check_on_conflict_targets` |
| **State observation & mutation (Invariants 4–5)** | | | | |
| 57 | **Inv 4** — Read prior state from DB before deciding; null = "never observed" (do not fire on null→value) | yes | llm | |
| 58 | **Inv 5** — After every Shopify mutation, check `userErrors[]`; non-empty = throw/fail | yes | llm | |
| 59 | State-machine atomic claim includes prior state in `WHERE`; zero-row result = bail | yes | llm | |
| 60 | State transitions log both `prevState` and `newState` | yes | llm | |
| **Money (Invariant 6)** | | | | |
| 62 | **Inv 6** — Money is integer cents in BIGINT; Shopify decimals parsed via `Math.round(parseFloat(x)*100)` before math | yes | llm | |
| **Null-defense (Invariant 7)** | | | | |
| 63 | **Inv 7** — Webhook/widget payloads partially typed; guard with `?.` and `??`; absent identity = valid branch | yes | llm | |
| **Scale (Invariant 8)** | | | | |
| 64 | **Inv 8** — Reads ≤1000 via `graphqlPaginate`, >1000 via `bulkQuery`; writes ≤50 sync, >50 chunked via `enqueueJob`; no naive long sync loops | yes | llm | |
| **Shopify bulk-fetch (Invariant 9)** | | | | |
| 65 | **Inv 9** — Bulk-fetch all Shopify reads BEFORE per-item loops; zero Shopify calls inside loop body | yes | llm | |
| 66 | The Shopify lookup ID used inside the loop is SELECTed alongside the primary entity ID on the DB row | yes | llm | |
| 67 | Per-item Shopify writes only when no batch mutation exists AND `platformGaps` declared the gap | yes | llm | |
| **Outbound HTTP** | | | | |
| 68 | `fetch()` allowed only to non-Shopify, non-platform third parties; always `AbortSignal.timeout(<ms>)`; always check `resp.ok` and throw on non-2xx | yes | llm | |
| **Shopify client / GraphQL helpers** | | | | |
| 69 | `shopifyClientFor` call form (HTTP path passes `req.platform!`; cron path passes nothing); no `as any` on the context | yes | llm | |
| 70 | No hand-rolled `fetch()` to Shopify (use `shopify.*` helpers) | yes | static | ✅ |
| 71 | GIDs use `gid://shopify/<Type>/${id}`; never parsed/concatenated; opaque | yes | llm | |
| 72 | `graphqlPaginate` queries declare `$cursor: String`, pass `after: $cursor`, request `pageInfo {hasNextPage endCursor}` and `edges {node {...}}` | yes | llm | |
| 73 | `bulkQuery` argument is a plain GraphQL **query**, NOT a mutation | yes | static | ✅ |
| 74 | Don't call `bulkQuery` from inside a per-item loop | yes | llm | |
| 75 | Mutations request `userErrors { field message code }` | yes | llm | |
| 76 | One Shopify bulk operation per shop at a time (helper queues subsequent callers) | no (paranoid) | — | |
| **Shopify GraphQL operations** | | | | |
| 77 | Every `gql` query/mutation parses against the live Shopify schema (admin / storefront) | yes | static | ✅ (`handler_graphql`) |
| 78 | Every `gql` op corresponds to an entry in `shopifyGraphqlOperations.{admin, storefront}` | yes | static | ✅ (`shopify_ops.py`) |
| **Webhooks** | | | | |
| 79 | `webhookHandlers` keys exactly match `webhookTopics` (no extras, no missing); valid topics only; no `_cron/*` keys | yes | static | ✅ |
| 80 | Webhook handler signature `(payload: unknown, req: Request) => Promise<void>` | no | — (made impossible by the template's `WebhookHandler` type — wrong signature is a tsc compile error) | |
| 81 | Every field in `webhookContract.payloadFields` is read from `payload` somewhere in the handler | yes | llm | |
| **Cron** | | | | |
| 82 | `jobs` map has at least one entry | yes | static | ✅ |
| 83 | `JobFn` signature `(payload: unknown) => Promise<void>` | no | — (made impossible by the template's `JobFn` type — wrong signature is a tsc compile error) | |
| 84 | Cron jobs are idempotent (apply Invariants 1 & 3 — see rows 54 / 56) | yes | llm | |
| 85 | `enqueueJob("name", ...)` `jobName` matches a key in the `jobs` map exported from `cron.ts` | yes | llm | |
| 86 | `dedupKey` passed when same trigger may fire twice | yes | llm | |
| **Widget routes** | | | | |
| 87 | Every `widgetApiCatalog` entry has a matching `widgetRouter` route with exact method+path | yes | static | ✅ |
| 88 | Widget route handlers read EXACT `requestShape` field names; return EXACT `responseShape` (no renaming, no extras) | yes | llm | |
| 89 | `customerId` + `guestToken` both code paths handled; guest-to-logged-in migration merges in a transaction | yes | llm | |
| 90 | Server-side resolution: IDs the widget cannot produce are looked up via Shopify GraphQL inside the handler | yes | llm | |
| 91 | Widget responses small + JSON-safe; never raw DB rows with sensitive columns / stack traces / internal IDs | yes | llm | |
| **Admin routes** | | | | |
| 92 | Every `adminApiCatalog` entry has a matching `adminRouter` route with exact method+path | yes | static | ✅ |
| 93 | Admin route handlers read EXACT `requestShape` field names; return EXACT `responseShape` (no renaming, no extras) | yes | llm | |
| 94 | List routes implement pagination semantics matching catalog shapes (`page`, `page_size`, `items`, `total`) | yes | llm | |
| 95 | When `cronSchedule` non-null, the manual-trigger POST route exists in `adminRouter` and dispatches via `enqueueJob` | yes | llm | |
| **Logging** | | | | |
| 96 | Structured stdout logs (single-object arg); log route entry, early exits, state transitions, claimed-row counts | no | — | |
| 97 | Cron log lines include `jobName` | no | — | |
| 98 | Admin route entry log includes `requestId` + `path` | no | — | |
| 99 | Do not log email bodies or full Shopify payloads | no (paranoid) | — | |

---

## Counts

- **95 rules** total across handler prompts (was 99 — rows 4, 17, 52, 61 removed this turn as not prompt-derived; numbers retained as stable identifiers, gaps left at those positions)
- **68 validate** → **25 static** rule-rows (✅) — of which **22 regex/AST in `handler_artifact.py`**, **1 by `handler_typecheck` (tsc compile gate, row 16)**, **1 by `handler_graphql`** (row 77), **1 by `shopify_ops.py`** (row 78); plus **43 llm** rule-rows deferred to `agent_rules` + `bug_finder` (row 15 reclassified static → llm — catastrophic cases already covered by rows 30 + 70, and the standalone https-outside-fetch regex had high FP surface on JSDoc / comments / error-message URLs)
- **27 skip** → **13 no** (style / judgment / non-catastrophic / structurally-impossible-given-template — rows 9, 80, 83 fall here because tsc + template imports own the enforcement, no separate check exists) + **14 paranoid** (model handles via prompt; bug_finder catches downstream impact)
- The static layer is narrow by intent — see the philosophy paragraph above. Rules outside the four bars (structural / frequent / catastrophic / not-tsc-covered) flow through `agent_rules` and `bug_finder`.

---

## Audit findings — ON CONFLICT target ↔ uniqueConstraint static check (2026-04-28)

Documented case (image-optimizer generation, run
`2026-04-28T20-38-51_automatically-optimize-and-store-product-images`)
where the handler emitted `ON CONFLICT (run_id, image_id) DO NOTHING`
on `optimization_run_items` INSERTs but the migration declared no
matching `uniqueConstraint` on that pair. Postgres throws
`there is no unique or exclusion constraint matching the ON CONFLICT
specification` on the FIRST INSERT — every cron run dies before
processing any image. Both `agent_rules` and `bug_finder` flagged it
correctly (high-confidence, named the same root cause from two
angles), but the revision agent returned `[]` and the broken code
shipped.

The structural half of Inv 3 — "the ON CONFLICT target column-set
must correspond to a real unique constraint or PRIMARY KEY in
dbContracts" — clears all four bars of the static-validation policy:

- **(a) Frequency**: real, observed in actual generations. The
  generated handler reasonably picked a `(run_id, image_id)` dedup
  key but the migration forgot the matching constraint.
- **(b) Near-zero FP**: the check parses `INSERT INTO <table> ... ON
  CONFLICT (cols)` and compares the column-set (order-insensitive)
  against (i) the table's PRIMARY KEY column(s), (ii) any declared
  `uniqueConstraint.columns`, (iii) any column-level UNIQUE flag.
  Skips named-constraint form (`ON CONFLICT ON CONSTRAINT name`) and
  expression targets and tables not in dbContracts. Smoke-tested
  across 7 scenarios — only the real bug fires.
- **(c) Catastrophic**: deploy-time / first-INSERT crash. Whole
  cron / route dies before any side effect.
- **(d) Not duplicated downstream**: tsc doesn't read SQL semantics.
  `handler_typecheck` only types the TypeScript. `handler_graphql`
  validates GraphQL queries, not SQL. The deployer's
  `sql-validator.ts` checks the migration DDL but not the handler's
  runtime SQL. No deterministic gate covers this — the static check
  IS the only fast-feedback path.

**Implementation:** `llm_validations/handler_artifact.py:_check_on_conflict_targets`
— wired into `validate_handler_artifact` step 11b (next to the
existing dbContracts-aware enum-write cross-check). Threaded the
existing `db_contracts` parameter; no new args. Error message names
the table, the conflict columns, the declared valid targets, and
both fix paths (add a uniqueConstraint to dbContracts OR change the
conflict target).

**Row 56 reclassified to `static (structural) + llm (semantic)`** —
the structural half (target exists) is now the static check; the
semantic half (did the agent CHOOSE ON CONFLICT correctly given the
use case — atomic-claim vs upsert vs idempotency invariant) stays
llm because that's intent-level reasoning the structural check can't
make.

**Note on the migration side:** the matching prompt fix (architect's
`uniqueConstraint` field is the contract; migration agent must emit
`UNIQUE (cols)` constraint or `CREATE UNIQUE INDEX`) was added in
the same round to `subagents/prompts/core/migration.py`'s REQUIRED
PATTERN section, naming the runtime failure mode. See
MIGRATION_RULES.md audit findings for that side.

---

## Audit findings — method-aware SDK + cross-handler validators (2026-04-28)

A second issue from the same cart-recovery run: the architect declared
`GET /reminders` and `GET /abandoned-carts` in `adminApiCatalog`, the admin
codegen agent obediently called `bridge.call('/reminders', { page, ... })`,
the handler agent obediently wrote `adminRouter.get('/reminders', ...)`
reading from `req.query` (HTTP-correct for a GET) — and the cross-handler
validator FP'd "never reads req.body — collected data is silently
discarded." The validator was right about the symptom but wrong about
the cause: the bridge SDK was always-POST regardless of catalog method,
so at runtime the POST hit the GET route and 404'd.

Resolution: the SDK now derives method per path from a
`window.__PLATFORM_CATALOG__` manifest prepended to the served bundle
by `platform-back/apps/api/src/lib/bundle-storage.ts:saveBundles`. The
manifest is a slim `{path, method}[]` projection of the architect's
catalogs, threaded through `Bundle.widgetCatalog` /
`Bundle.adminCatalog` (Pydantic + Zod) into the served JS prelude.

Side effects on rules in this file:

- **Rows 88, 93** (widget / admin route handlers read EXACT requestShape
  field names) — the rules are unchanged in classification but the
  IMPLEMENTATION expectation is now: for **GET** catalog rows, the
  handler reads field names from `req.query` (the SDK encodes args as
  query string); for **POST** catalog rows, from `req.body` (JSON body).
  `cross_widget_handler.py` and `cross_admin_handler.py` are now
  method-aware — they parse the architect catalog's `method` field per
  path and check the appropriate slot. Defaults to POST when the path
  is absent from the catalog (matches the SDK's fallback behaviour for
  routes that bypass the catalog).
- The cross-handler validators' new signature accepts the architect
  catalog as a third argument; `crew.validate_artifacts` threads it
  through from `ctx.plan.appContracts.{widgetApiCatalog,adminApiCatalog}`.
- Codegen prompts UNCHANGED. The architect already declares method per
  catalog row; the codegen agents already see it; the handler-template
  prompt already teaches `<router>.<method>(path, ...)` shape. The only
  thing that changed is the SDK enforcing the catalog at runtime.

---

## Audit findings — sidecar reliability (2026-04-28)

A documented case (cart-recovery generation, run `2026-04-28T16-17-38_recover-lost-sales-by-automatically-reminding`) hit row 33 three retries in a row and never recovered: the static check correctly fired each time, the cumulative_errors mechanism correctly fed the error string forward, and the model consistently chose to drop the sidecar entirely instead of fixing it. The check was right; the prompt design wasn't actionable enough under retry pressure.

Two-part fix this round, both leaving the static check itself unchanged:

- **Requirement promoted into HARNESS_BASE.** The sidecar IS a bundle-output rule (it ships AFTER the final `===END===` marker), so the requirement to emit it now lives in `subagents/prompts/topics/handler.py:HANDLER` next to the `===FILE:===` rules — encountered during the same cognitive pass that produces the bundle. The format spec stays in `subagents/prompts/capabilities/email.py:116-163` (canonical reference, gated by capability-injection — unchanged).

- **Static error message enriched with an inline format example.** `_check_email_sidecar` in `handler_artifact.py` now returns an error string that includes a minimal correct sidecar block + the three governing rules (variables ↔ data: keys equality, no orphan placeholders/declarations, one-block-merge-across-call-sites). The retry loop feeds the message straight into the next attempt's user prompt, so the format example travels with the feedback. No new injection mechanism — the cumulative_errors path was already correct, the message just needed to be self-sufficient.

Row 33 classification stays `static` ✅. The `done?` reference now points at the enriched implementation: `handler_artifact.py:_check_email_sidecar` (error includes inline format example) + the prompt placement in `topics/handler.py:HANDLER` (requirement) + `capabilities/email.py:116-163` (format spec).
