# LLM Validators — Refactor Plan

> Status: Phases 0 + 1 complete (per-surface registries built; static layer narrowed to the four-bar policy in `ARCH_RULES.md` / `HANDLER_RULES.md`). **Phase 2 next** — build the four parallel LLM validators (`agent_rules_arch`, `agent_rules_handler`, `quality_brief_coverage`, `bug_finder`). Pick up from Phase 2 below.

---

## Background

Today, one LLM validator (`subagents/validator_agent.py`) runs Q1-Q8 + Part B (open review) after every gen. Q's are flat, mixed-genre, and overlap with the static validators in `llm_validations/`. The system is opaque — you can't easily answer "what catches X", "what's the recall here", "is this static or LLM enforced".

Static validators were just refactored (this branch): `validation/` was split per-surface and renamed to `llm_validations/`. Helpers extracted to `utils/static_validations/`. 69/69 tests pass at branch tip.

This plan refactors the LLM side to match: **clear scope, parallel execution, no overlap with static.**

---

## Static-validation policy

**The four-bar policy.** A rule earns a static check ONLY when ALL FOUR bars are cleared:

- **(a) Frequency** — the failure mode has been seen with non-trivial frequency in real generations. Frontier models with explicit prompt teaching essentially never violate enum/schema-shape rules (the schema-as-prompt IS the enforcement); cheap structural checks for things that almost never fail are tax on every gen for unmeasurable benefit.
- **(b) Near-zero false-positive rate** — the check is cheap & structural and produces no FP on legitimate code patterns. Not "low" FP — *near-zero*. A regex that fires on the same token in a comment, a docstring, an error-message string literal, or a JSDoc reference is FP-prone and disqualified until scrubbed.
- **(c) Catastrophic blast radius** — the failure causes deploy failure, silent data corruption, charged-the-wrong-amount, double-execution, tenant cross-talk, or **catastrophic-by-cascade** (wrong upstream classification poisons every downstream agent's prompt — wrong `appCategory` from the product agent → wrong archetype contracts from the architect → wrong codegen everywhere). Annoying UX bugs and cosmetic drift do NOT clear this bar.
- **(d) Not duplicated downstream** — `tsc` (handler TypeScript), `handler_graphql` (Shopify schema), the deployer's `sql-validator.ts` (migration DDL), the App Block runtime (widget modules), and the Shopify Admin iframe runtime (admin modules) are deterministic downstream gates. When one of these catches a rule, the local static check is `no (paranoid)` — duplicating it adds maintenance burden and produces less actionable error messages than the downstream gate.

**Bias toward removing static checks, not adding them.** When in doubt: trust the prompt + bug_finder. Per-surface rule registries (`ARCH_RULES.md`, `HANDLER_RULES.md`, `MIGRATION_RULES.md`, `WIDGET_JS_RULES.md`, `ADMIN_UI_RULES.md`, `PRODUCT_RULES.md`) classify each prompt rule as `static` / `llm` / `no` / `no (paranoid)`. The trend across audit rounds has been net-negative on static count — every round reclassifies multiple checks downward as the four-bar policy is applied more strictly.

**One owner per rule.** No rule is enforced by both static AND llm. Where a rule is also caught by a downstream gate, the local static is `no (paranoid)` and the downstream gate is the owner. The LLM layer (agent_rules + bug_finder) owns everything left.

### FP-class taxonomy and resistance patterns

Static checks fail bar (b) most often through one of these FP classes. Each has a known resistance pattern.

**Comment & string-literal FP.** A regex like `\bdocument\.body\b` will match `// don't use document.body` in a comment or `'document.body access leaks'` in an error message. This bug class has a documented post-merge incident (the handler `tenant_id` regex matching its own forbidden-pattern string-literal). The fix:

- `utils/static_validations/js_parse.py:strip_comments_and_strings(js)` — full scrub for token denylists. Strips JS line comments, block comments, and string literals (single, double, template; template-literal `${...}` interpolation contents are preserved as raw code).
- `utils/static_validations/js_parse.py:strip_comments_only(js)` — partial scrub for checks where the literal contents inside quotes ARE the data being validated (e.g. `data-status="pending"` or `status === 'pending'` patterns where the literal IS the value to inspect). Strips comments, preserves string literals.
- `utils/static_validations/sql_parse.py:strip_comments_and_strings(sql)` — SQL equivalent. Handles `-- line`, `/* block */`, `'single-quoted'` with `''` escape, `E'…'` escape strings, `$tag$ … $tag$` dollar-quoted strings. Double-quoted identifiers are NOT scrubbed.

**Order-dependent FP.** Patterns like "innerHTML += after appendChild" depend on order-of-execution, not order-of-text. Two patterns can appear in source order in any ordering across branches that don't actually run sequentially. Static heuristic either misses real bugs or FPs on legitimate scope-separated uses. **These belong to bug_finder**, not static.

**Cross-artifact-context FP.** A pattern can be benign in one context and catastrophic in another (`data-status="loading"` for a UI spinner is fine; `data-status="loading"` as a filter-button value when `loading` is not in any dbContracts column enum is dead UI). Static can't distinguish; agent_rules can. **These belong to agent_rules**, not static.

### Frontier-model tax

Closed-set enum checks for fields whose schema is given to the model in the system prompt almost never fire. Schema-as-prompt IS the enforcement. Specific examples already classified `no (paranoid)`:

- `complexity ∈ {low, medium, high}` (architect)
- `feasibility ∈ {feasible, blocked}` (architect)
- `method ∈ {GET, POST}` (admin/widget catalog)
- `unknownSentinel == "null"` field-presence (architect — only the value check survives static)
- Required-key presence on JSON outputs across all surfaces

**Default classification:** when the system prompt includes a JSON schema example showing the shape, presence and enum-value checks for that shape are paranoid by default. They earn static only when the failure mode is documented from real gens.

### Catastrophic-by-cascade

A real subclass of catastrophic. Wrong upstream classification produces an output that LOOKS valid in isolation but poisons every downstream agent's prompt. The product agent is the canonical example: bad `appCategory` → architect runs with the wrong archetype gate → handler/widget/admin codegen agents silently skip on archetype mismatch → deploy ships malformed app. Each individual downstream agent's static layer flags the symptoms ten steps later (or not at all), never the root cause.

**Cascade rule:** when the catastrophic-by-cascade pattern is in play, even rules with low individual frequency clear bar (a) — the union frequency across cascading agents is non-trivial, and the cost of unclear blame is high.

### Decision tree

When evaluating whether a rule should be static:

1. Is it structurally checkable (regex / set / cross-field equality / dict-key)? **No** → llm or no.
2. After applying the appropriate scrubber, does the check have near-zero FP? **No** → llm or no.
3. Is the failure catastrophic (deploy fail / silent corruption / cascade) — not just UX-degradation? **No** → llm or no.
4. Does a downstream gate (tsc / handler_graphql / sql-validator / iframe runtime / upstream architect check) catch it? **Yes** → `no (paranoid)`.
5. Does the schema-as-prompt make the rule essentially impossible to violate? **Yes** → `no (paranoid)`.

**All four "no" branches in steps 1–3 + both "yes" branches in steps 4–5 → not static.** Only rules that survive every gate become static. Apply the policy on every audit round; reclassify when the answers shift (e.g. a new downstream gate ships, or a new FP class is documented).

**Per-surface registries are the canonical source.** Every rule the prompts teach is listed in the matching `*_RULES.md` with a `validate?` column showing the classification and a `done?` column tracking implementation. Rules files are pure registries (table + counts + audit findings); the policy itself lives in this section.

---

## Target architecture

**Static layer** (`llm_validations/*.py`) — every rule that survives the four-bar policy lives here. Implementation lives in:
- `arch_plan.py` — architect plan validation
- `handler_artifact.py`, `handler_typecheck.py`, `handler_graphql.py` — handler bundle
- `migration_artifact.py` — migration SQL (mirrors deployer's `sql-validator.ts`)
- `widget_artifact.py`, `admin_ui_artifact.py` — widget / admin UI modules
- `cross_widget_handler.py`, `cross_admin_handler.py` — cross-artifact field-shape match
- `shopify_ops.py` — Shopify GraphQL operation catalog match
- `product_intent.py` — product agent intent classification
- `utils/static_validations/{js_parse,sql_parse,shared_checks}.py` — scrubbers + shared denylists

**LLM layer** — three new parallel validators in `subagents/validators/`:

| validator | model | scope | runs when |
|---|---|---|---|
| `agent_rules` | Haiku, no thinking | Unified prompt-rule compliance validator across the architect plan AND the handler bundle. Owns all `owner: LLM` rule-rows from `ARCH_RULES.md` and `HANDLER_RULES.md` today (23 + 42 = 65). When a new generator surface (migration / widget / admin / product / revision) ships its rule registry, ADD a section to this prompt — do not add a new validator. | Always. |
| `quality_brief_coverage` | Haiku | Are explicit `qualityBrief` requirements addressed in the artifacts? | Only when `qualityBrief` non-empty. |
| `bug_finder` | Sonnet + extended thinking | Catch-all for deploy-blocking AND runtime bugs not claimed by the rule-validator: races, silent data loss, resource leaks, orphaned state, semantic-equivalent reads, numeric overflow, etc. | Always. |

All three run **in parallel**. Findings merge into one issues list. Existing revision-routing logic (which reads each finding's `artifact` field) keeps working unchanged.

### Why this shape

- **One owner per rule** — registry decides static vs LLM. No duplication, no gaps.
- **Focused prompts** — each validator has ONE lens. Smaller prompt, smaller model, better answer.
- **Parallel** — 3 calls, ~same wall-clock as today's 1 call.
- **Cost** — 2 of 3 are Haiku; only `bug_finder` pays Sonnet+thinking.
- **Open review unchanged in spirit** — `bug_finder` IS the new Part B, but smaller scope (rule-validator already covers what we know to look for).

---

## Phases

### Phase 0 — Rule-ownership registry  ✅ COMPLETE (per-surface)

**Note:** the original plan called for one global `RULES_OWNERSHIP.md`. We landed on per-surface registries instead — more focused, fewer cross-surface conflicts. Each registry doubles as the rule list a future LLM validator pulls from.

- `ARCH_RULES.md` (root) — architect prompt rules. 73 rows, 28 static + 23 llm (after this round's audit; row #20 reclassed as non-catastrophic).
- `HANDLER_RULES.md` (root) — handler prompt rules. 95 rows, 26 static + 42 llm.
- `MIGRATION_RULES.md` / `WIDGET_RULES.md` / `ADMIN_RULES.md` / etc. — added later when those generators mature.



**Goal:** one document listing every rule, with one owner each.

**Output:** `llm_validations/RULES_OWNERSHIP.md` — Markdown table:

```
| id | rule (one line) | source | owner | reason |
```

`owner ∈ { STATIC, LLM, DEAD }`.
- `STATIC` → owned by Python check in `llm_validations/*.py`. May be already implemented or a TODO.
- `LLM` → too semantic for static; will be enforced by `agent_rules` validator.
- `DEAD` → redundant after the registry settles; remove from prompts/static/LLM.

**Build process:**
1. Walk every `subagents/prompts/topics/*.py:ARCHITECT*` and `:HANDLER*` block. List every rule taught.
2. Walk every `errors.append(...)` site in `llm_validations/*.py`. List every static check.
3. Walk every `Q1`-`Q8` in `subagents/prompts/core/validator.py`. List every LLM check.
4. Merge into one table. Many rows will combine — same rule taught in prompt + statically checked + LLM-Q'd. One row per rule.
5. Decide owner per row. Justify in `reason` column.

**Acceptance:** Every rule has an ID. Every existing static check + every existing LLM Q maps to a row. Sum of `STATIC + LLM` rows ≈ today's enforcement points minus DEAD rows.

**Output:** 168 rules across 8 prefixes (PV/HA/MA/WA/AU/CA/QB/BF). 110 STATIC, 57 LLM, 1 DEAD. Every row has a decided owner.

---

### Phase 1 — Static migration

**Goal:** for every row marked `STATIC` that's currently LLM-only or duplicated, strengthen the static side.

**Today** Q1/Q2/Q3/Q4/Q7 are mostly already static. The LLM is a backstop for aliasing/spread edge cases. Per-row decision:
- Improve static to handle the edge case (preferred when feasible).
- Move the edge case to `agent_rules` validator (when static would be too brittle).
- Drop the LLM check (when static now covers the case fully).

**Acceptance:** Every `owner: STATIC` row is implemented in `llm_validations/`. Per-rule precision/recall is HIGH (HIGH false-positive rate disqualifies → re-mark `LLM`).

**Output:** updated `llm_validations/*.py` modules; no LLM-side changes yet.

---

### Phase 2 — Build three LLM validators

**Goal:** three new modules in `subagents/validators/`. Always three, fixed. Adding new generator surfaces (migration, widget, admin, product, revision) = adding a section to `agent_rules`'s prompt, NOT a new validator.

**File layout:**
```
subagents/
  validators/
    __init__.py
    agent_rules.py             — Haiku, no thinking. Prompt-rule compliance across plan + handler.
    quality_brief_coverage.py  — Haiku. Only when ctx.intent.qualityBrief is non-empty.
    bug_finder.py              — Sonnet + extended thinking 8192. Cross-artifact runtime bugs.
    base.py                    — shared Finding dataclass + ThreadPoolExecutor harness.
```

**Each validator exports:** `run_<name>_validator(artifacts, ctx) -> List[Finding]`.

**Finding shape:**
```python
{
  "validator": "agent_rules" | "bug_finder" | "quality_brief_coverage",
  "artifact": "plan" | "handler" | "migration" | "widget_js" | "admin_ui",
  "location": "<file:symbol or plan field path or route>",
  "issue": "<what is wrong, one sentence>",
  "failure_mode": "<how it fails at runtime, one sentence>",
  "confidence": "high" | "medium",
}
```

**Why one `agent_rules` instead of per-surface:** with hand-written prompts that don't enumerate rules verbatim, the entire arch + handler rulebook fits in ~150 prompt-lines. Splitting per-surface adds infra cost (more validator slots, more fixtures, more maintenance) without prompt-size benefit. The unified prompt naturally separates architect-plan concerns from handler-bundle concerns. New surfaces = new prompt section.

**Validator prompts (hand-written; not assembled from the registry markdown).** The `ARCH_RULES.md` / `HANDLER_RULES.md` tables are the source of truth for *what to validate*; the prompts below are the source of truth for *how the validator reads the rules*. We don't enumerate row IDs — the prompts capture the substance directly.

#### `agent_rules` — system prompt

> You are an LLM-side validator for a Shopify-app codegen pipeline. The architect agent emits a plan JSON; the handler agent emits a TypeScript file bundle. Both agents are taught explicit rules in their prompts. Your job is to find places where the output violates those rules in ways structural validators cannot detect — i.e., where the failure depends on understanding intent, prose, or cross-field consistency.
>
> You will be given the architect plan, the handler bundle, and the user's app intent. Return only HIGH-confidence findings — every flagged item must be a real violation that would degrade or break the running app, not a stylistic preference.
>
> **ARCHITECT PLAN — what to look for:**
>
> *Capability honesty.* `platformGaps` mitigations must reference only AVAILABLE platform capabilities (no push notifications, Slack, WebSockets, GPU, inbound webhooks from arbitrary sources). Mitigations must not propose background workers or deferred-job patterns — the handler runs as a single synchronous async function. If the core value cannot be delivered without a missing capability, `feasibility` should be `"blocked"` rather than padded with an unworkable gap. `widgetCapabilities` should declare `"storefront"` only when the widget genuinely reads Shopify public storefront data directly. `shopifyGraphqlOperations` should list only ROOT operations the handler issues directly; sub-resources reached as sub-selections of another listed op should NOT appear separately.
>
> *Edge cases.* `edgeCases` entries must describe scenarios semantically. Never cite literal Shopify enum values like `"fulfilled"` / `"paid"` / `"subscribed"` — Shopify's actual values may differ in case or naming, and a guessed literal silently no-ops the guard.
>
> *Catalog discipline.* `widgetApiCatalog` and `adminApiCatalog` `requestShape` must contain only data the caller can actually produce — widgets see form inputs, URL params, and identifiers from `window.Shopify.context` (variantId / productId / customerId); they cannot send tenantId or arbitrary server state. Routes that persist per-shopper state must include both `customerId` AND `guestToken` in `requestShape` so the handler can identify both logged-in and guest flows. List routes returning collections must include pagination in both shapes (`page`, `page_size`, `items`, `total`). When `cronSchedule` is non-null, `adminApiCatalog` must include a manual-trigger POST route — merchants need to fire ad-hoc runs without waiting for the schedule.
>
> *Webhook and cron contracts.* `webhookTopics` must contain only topics the handler actually consumes (no "just in case"). Every field listed in `webhookContract.payloadFields` must be referenced in `handlerMustProduce`. `cronContract.handlerMustProduce` must not describe per-item Shopify reads inside the loop body — bulk pre-fetch is required when iterating. `cronBatching` must be declared whenever the cron loop reads Shopify per-item; per-item write-only patterns require a corresponding `platformGaps` entry.
>
> *Database contracts.* Structured-data columns (payload snapshots, settings blobs, line-item arrays — anything that would otherwise be `JSON.stringify`-ed) must use `JSONB`, never `TEXT`, even when not named with a `_json` suffix. Tables with one record per entity-combination (per customer per product, per order per item) must declare `uniqueConstraint` on the natural deduplication key. Each table must have exactly ONE creation timestamp — don't add `created_at` when a domain timestamp like `ran_at` / `sent_at` / `processed_at` is already set at row insertion. Log/audit tables that reference a parent record must declare `REFERENCES <parent>(id) ON DELETE CASCADE`; orphans become unqueryable when the parent is deleted. Discrete-value columns (`status`/`kind`/`channel`/`type`) must declare a non-empty `enum` list. Don't declare configuration/settings tables unless `adminApiCatalog` includes routes to read AND write them — settings the merchant can't change are dead.
>
> *State machines.* `stateMachine` should be declared ONLY for discrete string/enum transitions. Numeric threshold logic (`available > 0`, `quantity >= 10`) belongs in `handlerMustProduce` prose, not as a state machine. Application workflow states (`pending`/`sent`/`expired`) are plain DB columns, not state machines. `skipWhenUnknown` must agree with `handlerMustProduce`: `true` means the first observation is skipped; `false` means it triggers action.
>
> **HANDLER BUNDLE — what to look for:**
>
> *Routes and responses.* Every admin and widget route handler must eventually call `res.json` / `res.status().json` / `res.status().send`. A code path that throws or returns without responding leaves the request hanging until the client times out. Webhook handlers, by contrast, must NOT touch `res` — the template router owns response writes; throw to signal failure.
>
> *Email service.* `data` argument keys passed to `platform.email.send` must be camelCase strings (matching the email-metadata sidecar variable names). Never pass `subject` / `templateId` / HTML / from-name / CTA fields directly — those are merchant-edited via the platform's Email tab. Don't store email HTML in app DB tables; don't compile templates inside the handler. The send loop must catch `QuotaExceeded` with `kind="email"`, log, and STOP — never retry past the monthly quota. `delivered:false` is a soft outcome (`suppressed`/`missing_config`/`provider_failed`) — log and continue; never throw.
>
> *Files service.* Pass `Buffer` or `Uint8Array` directly as `contents`; never pre-base64-encode. Store the returned `fileId`; re-sign read URLs via `platform.files.signReadUrl` when handing them out (upload-time URLs expire in ~15 minutes). MIME type must be in the allowed set.
>
> *SQL discipline.* Never qualify tables with a schema name — `search_path` is pinned. Never wrap IDs in `String()` when interpolating into `sql\`...\`` (postgres-js handles JS numbers natively). When using IDs as JS `Map`/object keys, normalize both sides with `String()` because Shopify returns numbers and postgres returns BIGINT-as-strings. Strip NUL bytes from any string sourced outside the handler before a postgres write — postgres rejects ` ` and aborts the transaction.
>
> *Idempotency invariants.* Every externally-visible side effect (email send, Shopify mutation, third-party API call, queue publish) must live behind an atomic `UPDATE … RETURNING` claim that runs first, with the act on the returned rows after. Never SELECT-then-act-then-UPDATE. INSERTs in request-driven paths must use `ON CONFLICT DO NOTHING` (or `DO UPDATE` for upserts) paired with a `uniqueConstraint` on the dedup key. Every SQL operation in a request-driven path must filter to the specific entity from the request payload — never run an unscoped UPDATE / DELETE / SELECT on the schema.
>
> *State observation.* For "if X changed, do Y" logic, read the prior state from the DB before deciding; null means "never observed" and must not be treated as a transition. When applying the atomic claim to a state machine, include the prior state in the WHERE clause and bail on zero-row results so cron and webhook paths don't double-fire. Log `prevState` and `newState` on every transition.
>
> *Shopify mutations.* After every Shopify mutation, check `userErrors[]` — non-empty means failure even though the `await` succeeded; throw to surface. Mutations must request `userErrors { field message code }` in the GraphQL selection. Never construct GIDs by parsing or concatenating raw IDs; treat them as opaque and build via `gid://shopify/<Type>/${id}`.
>
> *Money.* Money is integer cents stored in BIGINT columns. Shopify returns prices as decimal strings; parse to integer cents via `Math.round(parseFloat(x) * 100)` before any math. Never use float (drift), never use INTEGER (overflow at ~$21.47M).
>
> *Null-defense.* Webhook and widget payloads are partially typed; guard every field with `?.` and `??`. Treat absent identity (guest checkout, deleted parent, partial fulfillment) as a valid branch — not an error — unless the feature genuinely cannot proceed.
>
> *Scale and bulk-fetch.* Reads ≤1000 items via `shopify.graphqlPaginate`; >1000 items via `shopify.bulkQuery`. Writes ≤50 synchronously; >50 chunked via `enqueueJob` so each cron tick handles a small batch. No naive long sync loops. Bulk-fetch all required Shopify data BEFORE per-item loops; the loop body must contain zero `shopify.*` calls. The Shopify lookup ID used inside the loop must be SELECTed alongside the entity ID on the DB row. Per-item Shopify writes only when no batch mutation exists AND `platformGaps` acknowledges the gap. `bulkQuery` must never be called from inside a per-item loop.
>
> *Outbound HTTP.* `fetch()` is allowed only for non-Shopify, non-platform third-party APIs. Always pass `AbortSignal.timeout(<ms>)`. Always check `resp.ok` and throw on non-2xx. Use `shopify.*` for Shopify; use `platform.*` for platform-back; never hand-roll fetch() to either.
>
> *Shopify client and helpers.* `shopifyClientFor` takes `req.platform!` on HTTP paths, no argument on cron paths; never use `as any` to bypass the typed context. `graphqlPaginate` queries must declare `$cursor: String`, pass `after: $cursor`, and request both `pageInfo {hasNextPage endCursor}` and `edges {node {...}}`.
>
> *Webhook field consumption.* Every field listed in `webhookContract.payloadFields` must be read from the `payload` somewhere in the handler body — declared-but-unused fields signal stale planning.
>
> *Cron job dispatch.* `enqueueJob`'s first argument must match a key in the `jobs` map exported from `cron.ts`. Pass `dedupKey` when the same trigger may fire twice (admin double-click, webhook retry storm) and at-most-one in-flight is required.
>
> *Widget routes.* Route handlers read EXACT field names from the catalog's `requestShape` and return EXACTLY the catalog's `responseShape` — no renaming, no extra fields. `customerId` and `guestToken` are advisory; when both are present, merge guest data onto the customer record inside a transaction and drop the guest row. IDs the widget cannot produce must be looked up server-side via Shopify GraphQL inside the handler. Responses must be small and JSON-safe — never return raw DB rows with sensitive columns, stack traces, or internal IDs the storefront doesn't need.
>
> *Admin routes.* Same exact-shape rule as widget. List routes implement pagination semantics matching the catalog (`page`, `page_size`, `items`, `total`). When `cronSchedule` is non-null, the manual-trigger POST route in `adminRouter` must dispatch via `enqueueJob` — never via a direct `sql` INSERT into `cron_queue` (the template owns that table).
>
> **OUTPUT FORMAT:** Return JSON `{ "findings": [...] }`. Each finding: `{ artifact, location, issue, failure_mode, confidence }`. Cap output at 12 findings. Skip everything tsc, the GraphQL parser, or the static validators would already catch — they run separately. Skip stylistic preferences. Skip duplicates of the same issue across files.

#### `bug_finder` — system prompt

> You are a runtime-bug hunter for a generated Shopify app. You see all the artifacts together: the architect plan, the migration SQL, the handler TypeScript bundle, and the email-metadata sidecar. Your job is to find runtime bugs that the static validators and the per-prompt-rule LLM validator do NOT cover — bugs that emerge from cross-artifact inconsistency, edge cases, or subtle semantic mismatches.
>
> You're paired with extended thinking. Use it. Read all the artifacts, build a mental model of what the running app does, and look for failure modes a deploy-fresh test wouldn't trigger but a real customer would.
>
> *Cross-artifact mismatches.* A `stateMachine` transition declares `from`/`to` values that the handler never writes, or whose column type can't hold them, or whose enum doesn't include them — the transition is dead at runtime. `handlerCapabilities` lists `"shopify_graphql"` but the handler never calls `shopify.*` (or vice versa). A widget/admin catalog entry with no matching handler route, or a near-match that looks like a typo. `adminApiCatalog` says `GET` but the handler implementation mutates state. The email-metadata sidecar declares `variables` the handler never passes in `data:`, or the handler passes `data:` keys the sidecar doesn't list.
>
> *Race and idempotency hazards.* Two paths can observe the same state transition (cron + webhook on same entity) and only one has the atomic-claim discipline (`UPDATE … WHERE state=prev RETURNING`), or both do but one omits the prev-state predicate. Side effects (email send, Shopify mutation, queue publish) emitted before the row is marked done — any crash leaks duplicates. INSERT statements in request-driven paths without `ON CONFLICT`, on tables that webhook retries or widget retries hit twice. Cron jobs that mutate without an idempotency gate.
>
> *Silent data loss / corruption.* Money column declared as `INTEGER` / `FLOAT` / `NUMERIC` / `DOUBLE PRECISION` (must be BIGINT cents), or money math using floats (`parseFloat` without `Math.round * 100`). A money column without a sibling `currency` column — SUM aggregates silently mix denominations. NOT-NULL columns INSERTed without a value or with a value that may be `undefined`. SQL strings concatenated rather than bound through `sql\`...\``. BIGINT IDs compared as strings on one side and numbers on the other (`Map.get(row.id)` where Shopify returned strings and postgres returned numbers, or vice versa). NUL bytes from third-party text written straight into postgres (transaction will abort).
>
> *Resource leaks and scale.* A long loop that hits Shopify per-item without bulk pre-fetch (will throttle at scale). A `bulkQuery` call inside a loop. A `graphqlPaginate` without `pageInfo {hasNextPage endCursor}` (pagination breaks silently after the first page). A loop calling `platform.email.send` without catching `QuotaExceeded` (wastes the rest of the monthly quota). File uploads where signed read URLs are stored in the DB instead of `fileId`s (URLs expire in ~15 min). Synchronous loops that exceed Cloud Run's 5s webhook budget.
>
> *Numeric overflow / drift.* `INTEGER` money columns above the $21.47M ceiling. BIGINT-parsed-as-Number when the value exceeds 2^53. Float math on values that should be integer cents.
>
> *Null-defense gaps.* A webhook handler reading `payload.customer.id` without `?.` (guest checkouts crash). A widget route requiring `customerId` without a guest fallback. An "if X changed" check firing on `null → value` (null means never observed).
>
> *GraphQL traps.* A mutation called without checking `userErrors[]` in the response. Per-item Shopify mutation inside a loop where a batch alternative exists (`metafieldsSet`, batch `tagsAdd`, etc.).
>
> **OUTPUT FORMAT:** Return JSON `{ "findings": [...] }`. Each finding: `{ artifact, location, issue, failure_mode, confidence }`. Cap findings at 8. Return only HIGH or genuinely-suspicious-MEDIUM. Skip anything tsc / `handler_graphql` would flag (they run separately). Skip duplicates of issues the per-prompt-rule validator would catch — atomic claim, money cents, null-defense are its lane unless you spot a specific cross-artifact instance the rule-validator can't see.

#### `quality_brief_coverage` — system prompt

> The user provided a `qualityBrief` — explicit feature requirements like "send a follow-up email at T+24h", "show subscriber count as social proof", "throttle to 5 sends per shopper per day". Your job is to verify that EACH explicit requirement is addressed somewhere in the architect plan or handler implementation.
>
> You are given the `qualityBrief` text, the architect plan, and the handler bundle.
>
> For each EXPLICIT requirement (concrete behavior, threshold, deadline, UX detail) in the brief, decide whether the artifacts implement it. If a requirement is NOT addressed, return one finding identifying which sentence of the brief is unmet and where it would have to be implemented.
>
> Skip implicit / stylistic requirements ("nice UI", "clean code"). Only flag concrete unmet items.
>
> **OUTPUT FORMAT:** Return JSON `{ "findings": [...] }`. Each finding: `{ artifact, location, issue, failure_mode, confidence }`. Return only high-confidence findings. Cap at 8.

**LLM classification audit (this round):** re-evaluated every `llm` row in `ARCH_RULES.md` and `HANDLER_RULES.md` under the stricter four-bar policy (real, semantic, catastrophic, not duplicated by static / tsc / handler_graphql). 65 of 66 rows still fit (24 → 23 arch + 42 handler). One drop: arch row #20 (`method` semantic GET-vs-POST match) → `no` — non-catastrophic; GET-that-mutates is unconventional but routes and runs. The `agent_rules` prompt above intentionally does not mention method-method-semantic-match.

**Acceptance:** each validator callable in isolation; unit tests per validator with fixture artifacts; the unified `agent_rules` prompt covers all 23 arch + 42 handler `llm` rule-rows.

---

### Phase 3 — Pipeline integration

**Goal:** wire the new validators into the codegen pipeline. No flag, no dual-run — replace the existing `run_validator_agent` call in place. Follow the same pattern the codegen agents already use (parallel `ThreadPoolExecutor` calls, results merged into one list).

**Changes:**
- `crews/feature_generator/crew.py` — replace the single `run_validator_agent` call with a new function that fans out the validators via `concurrent.futures.ThreadPoolExecutor` and merges findings. Same shape as how the codegen agents are dispatched today.
- Delete `subagents/validator_agent.py`, `subagents/prompts/core/validator.py`, and the old Q1–Q8 prose.
- Revision routing logic untouched — every Finding still carries its `artifact` field.

**Validator set (fixed at three; new surfaces extend the prompts, not the validator count):**
- `agent_rules` — Haiku. Owns all `owner: LLM` rule-rows across surfaces. Reads plan + handler bundle today; future surfaces (migration / widget / admin / product / revision) extend this prompt.
- `quality_brief_coverage` — Haiku. Only fires when `ctx.intent.qualityBrief` is non-empty.
- `bug_finder` — Sonnet + extended thinking budget 8192. Open-ended cross-artifact runtime-bug hunt. Cap findings at 8.

When the migration / widget / admin / product / revision agents stabilize, build their `<SURFACE>_RULES.md` registry the same way as `ARCH_RULES.md` / `HANDLER_RULES.md` (Phase 0 + 1 per surface), then APPEND the new `llm` rules as a new section in `agent_rules`'s prompt. The pipeline never changes; only the prompt grows.

**Acceptance:** old `validator_agent.py` deleted; pipeline runs the new validator set in parallel; existing tests pass.

---

### Phase 4 — Eval harness  *(optional, later)*

**Goal:** measurable recall/precision per validator.

Each validator gets a fixture set under `tests/validators/<validator>/`: pairs of `(artifact, expected_findings)`. CI runs them; recall/precision tracked over time. Without this, every "is this validator getting better" question is unanswerable.

**Acceptance:** ≥ 5 fixtures per validator; recall + precision computed; CI gate (don't merge if recall drops).

---

## File map (target end-state)

```
platform-ai/
  llm_validations/
    arch_plan.py                  — STATIC plan rules
    handler_artifact.py           — STATIC handler rules
    migration_artifact.py         — STATIC migration rules
    widget_artifact.py            — STATIC widget rules
    admin_ui_artifact.py          — STATIC admin UI rules
    cross_widget_handler.py       — STATIC cross-artifact (probably stays static-only)
    cross_admin_handler.py        — STATIC cross-artifact
    handler_graphql.py            — STATIC GraphQL query check (unchanged)
    handler_typecheck.py          — STATIC TS typecheck (unchanged)
    shopify_ops.py                — Shopify catalog loader (unchanged)
  subagents/
    validators/
      __init__.py
      agent_rules.py              — LLM: prompt-rule enforcement
      quality_brief_coverage.py   — LLM: brief coverage
      bug_finder.py               — LLM: deploy + runtime bugs
      base.py                     — shared Finding type
    validator_agent.py            — DELETED at end of Phase 4
  utils/
    static_validations/           — already extracted; unchanged
```

---

## Open questions to resolve as we go

1. **Cross-artifact contracts (`cross_*.py`)** — keep static-only? Phase 0 audit will tell us if any aliasing edge cases warrant LLM coverage. Default: stay static.
2. **`agent_rules` prompt size** — if the registry has 30+ LLM-owned rules, prompt may be too big for Haiku to reason about cleanly. Fallback: split `agent_rules` into 2-3 sub-validators (per-archetype). Decide after Phase 0 sees the count.
3. **Revision routing** — `agent_rules` finding for the architect plan should trigger architect-revision, not handler-revision. Current routing reads `artifact: "plan"` for plan findings; verify that's the existing convention or add it.

---

## Resuming this work in another session

Pick up from the active phase listed at the top of this doc.
- Phase 0 output → `llm_validations/RULES_OWNERSHIP.md`
- Phases 1-5 are sequential; each unblocks the next.
- Tests must pass at the end of every phase. Run: `cd platform-ai && .venv/bin/python -m pytest -q --ignore=tests/test_graphql_validation.py`. (test_graphql_validation needs `graphql-core` package not installed in this env.)

When you finish a phase, update the status line at the top of this doc and commit.
