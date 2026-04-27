# Architect Prompt Rules — Validation Map

Source: every architect-facing prompt block under `platform-ai/subagents/prompts/topics/*.py:ARCHITECT*` and `platform-ai/subagents/prompts/core/architect.py`.

**Legend** — `validate?` = should this rule be enforced after the architect emits a plan?
- **static** — structural / set-membership / regex / schema-shape / cross-field presence. HIGH precision (no false positives).
- **llm** — semantic, prose, or judgment that won't survive a cheap structural check but is worth catching agentically (per `LLM_VALIDATORS_PLAN.md`).
- **no** — judgment/style/informational; high false-positive risk relative to value.
- **no (paranoid)** — structural rule the prompt + JSON template already carry; model gets it right ~always. Not worth a hand-written validator. If it ever drifts, the bug_finder LLM validator (Sonnet + thinking) catches downstream runtime impact, and the cron/typecheck/graphql layers catch deploy-blocking versions.

**`done?`** column — `✅` means this rule is currently enforced in `platform-ai/llm_validations/arch_plan.py` (cross-referenced to a numbered check in that file's docstring). Blank for rules where the static check hasn't been written yet, or where the owner is `llm` / `no`.

**One owner per rule** — per `LLM_VALIDATORS_PLAN.md`, every row has exactly one owner. No rule is enforced by both static AND llm. When a static heuristic cleanly catches the canonical failure mode (even if recall isn't 100%), the row is `static` and llm stays out.

**Static-validation principle:** only enforce rules where (a) the failure mode has been seen with non-trivial frequency, (b) the check is cheap & structural, and (c) the blast radius is catastrophic (deploy fails, silent corruption, charged-the-wrong-amount). Everything else flows through `handler_typecheck` / `handler_graphql` (deterministic runtime ground truth) and the LLM validators (`agent_rules` + `bug_finder`).

---

| # | rule | validate? | how | done? |
|---|---|---|---|---|
| **Feasibility / capabilities (core)** | | | | |
| 1 | `feasibility ∈ {"feasible","blocked"}`; `blockedReason` non-null only when blocked | no (paranoid) | — | |
| 2 | `handlerCapabilities` / `widgetCapabilities` / `adminCapabilities` values come from the closed AVAILABLE registry | yes | static | ✅ |
| 3 | `platformGaps` mitigations reference only AVAILABLE capabilities (no push, slack, websockets, gpu, etc.) | yes | llm | |
| 4 | `platformGaps` mitigation does not propose background workers / forked processes / deferred jobs | yes | llm | |
| 5 | Per-gap shape: exactly `{gap, mitigation}`, no extras | no (paranoid) | — | |
| 6 | If no valid mitigation exists, `feasibility` must be `"blocked"` (not a padded gap) | yes | llm | |
| **Complexity** | | | | |
| 7 | `complexity ∈ {low, medium, high}` | no (paranoid) | — | |
| 8 | `complexity == "high"` whenever any structural trigger fires (`stateMachine`, `cronBatching.required`, ≥2 webhookTopics, both widget+admin catalogs) | no (paranoid) | — | |
| **Edge cases / UX** | | | | |
| 9 | `edgeCases` length is 3–6 | no (paranoid) | — | |
| 10 | `edgeCases` entries are domain-specific, not generic ("handle errors gracefully") | no | — | |
| 11 | `edgeCases` entries do not cite literal Shopify enum values (e.g. `"fulfilled"`, `"paid"`) | yes | llm | |
| 12 | `uxExpectations.{storefront, admin}` is null iff that surface doesn't exist for the archetype | no (paranoid) | — | |
| **Output format** | | | | |
| 13 | Output is pure JSON, no markdown fences, every schema key present | no (paranoid) | — | |
| 14 | No `<placeholder>` tokens echoed verbatim in any string field | no (paranoid) | — | |
| **Widget — templates / catalog** | | | | |
| 15 | `widgetTargetTemplates` null for backend archetypes; for storefront: subset of `{product, collection, index, cart, page, blog, article, search}` | yes | static | ✅ |
| 16 | `widgetApiCatalog` null for backend archetypes | yes | static | ✅ |
| 17 | Each catalog entry has no extra fields beyond `{path, method, requestShape, responseShape}` | no (paranoid) | — | |
| 18 | `path` contains no `:param` segments | yes | static | ✅ |
| 19 | `method ∈ {"GET", "POST"}` | no (paranoid) | — | |
| 20 | `method` semantically matches op (POST for mutation/write, GET for read-only) | no | — (non-catastrophic; GET-that-mutates is unconventional but still routes and runs. bug_finder catches real misuse cross-artifact) | |
| 21 | `requestShape` contains only data the widget can produce (no server-side fields) | yes | llm | |
| 22 | Per-shopper-state widget routes include both `customerId` and `guestToken` in `requestShape` | yes | llm | |
| **Widget — capabilities** | | | | |
| 23 | `widgetCapabilities` is `null` for backend / backend_admin, array for storefront archetypes | yes | static | ✅ |
| 24 | `widgetCapabilities` values are from the Widget client-side APIs registry | yes | static | ✅ |
| 25 | Declare `"storefront"` when the widget reads Shopify storefront data directly | yes | llm | |
| **Admin — catalog** | | | | |
| 26 | `adminApiCatalog` non-null & non-empty for `*_admin` archetypes; null for non-admin archetypes | yes | static | ✅ |
| 27 | Each entry has no extra fields beyond `{path, method, requestShape, responseShape}` | no (paranoid) | — | |
| 28 | `path` contains no `:param` segments | yes | static | ✅ |
| 29 | `method ∈ {"GET", "POST"}` | no (paranoid) | — | |
| 30 | List routes include pagination in both shapes (`page`, `page_size`, `items`, `total`) | yes | llm | |
| 31 | When `cronSchedule` non-null, catalog includes a manual-trigger POST route | yes | llm | |
| **Admin — capabilities** | | | | |
| 32 | `adminCapabilities` is `null` for non-admin archetypes, `[]` for admin archetypes (registry empty today) | yes | static | ✅ |
| **Shopify-loop / cronBatching** | | | | |
| 33 | `cronBatching` non-null ⇒ contains `"required": true` and a `description` string | yes | static | ✅ |
| 34 | `cronBatching` declared whenever the cron loop reads Shopify per-item | yes | llm | |
| 35 | If per-item writes are unavoidable, a corresponding `platformGaps` entry exists | yes | llm | |
| **Handler capabilities / Shopify ops** | | | | |
| 36 | `handlerCapabilities` is closed-vocab (services + npm registry) | yes | static | ✅ |
| 37 | Declare exactly what's used — no over/under-declaration vs. what the plan implies | no | — | |
| 38 | `shopifyGraphqlOperations.{admin, storefront}` are both string-arrays; non-empty `admin` requires `"shopify_graphql"` ∈ `handlerCapabilities`; non-empty `storefront` requires `"shopify_storefront"` ∈ `handlerCapabilities` | yes | static | ✅ |
| 39 | When `shopify_graphql` declared, every `admin` op name is in the closed Admin GraphQL operation index | yes | static | ✅ |
| 40 | Sub-resources reached via sub-selection are NOT listed as separate ops | yes | llm | |
| 41 | `emailSpec` non-null `{type, purpose}` iff `"email"` ∈ `handlerCapabilities`; `type ∈ {"transactional","marketing"}`; `purpose` is a non-empty string | yes | static | ✅ |
| **Webhooks** | | | | |
| 42 | Each `webhookTopics` entry is in `WEBHOOK_TOPICS` (REST `resource/action` lowercase) | yes | static | ✅ |
| 43 | No SCREAMING_SNAKE_CASE / GraphQL-enum format | yes | static | ✅ |
| 44 | `webhookContract` non-null iff `webhookTopics` is non-empty | yes | static | ✅ |
| 45 | Subscribed topics are actually consumed (no "just in case") | yes | llm | |
| 46 | Every field in `webhookContract.payloadFields` is referenced in `handlerMustProduce` | yes | llm | |
| 47 | `handlerMustProduce` states WHAT, not HOW (no implementation prescriptions) | no | — | |
| **Cron** | | | | |
| 48 | `cronSchedule` is a valid 5-field cron expression (or null) | yes | static | ✅ |
| 49 | `cronContract` non-null iff `cronSchedule` non-null | yes | static | ✅ |
| 50 | `cronContract.handlerMustProduce` does not describe per-item Shopify reads inside the loop | yes | llm | |
| **dbContracts — column rules** | | | | |
| 51 | No `tenant_id` column on any table | yes | static | ✅ |
| 52 | Shopify entity ID columns (`variant_id`, `product_id`, `order_id`, `customer_id`, `inventory_item_id`, `location_id`) are `BIGINT` or `TEXT`, never `UUID` | yes | static | ✅ |
| 53 | Primary-key `id` is `UUID` | no (paranoid) | — | |
| 54 | `customer_id` on storefront-facing tables is `BIGINT NULL` (nullable) | no (paranoid) | — | |
| 55 | Money columns (`*_cents`, totals/price/amount/etc.) are `BIGINT`, never TEXT/NUMERIC/FLOAT/DOUBLE/INTEGER | yes | static | ✅ |
| 56 | Every money column has a sibling `currency` column | yes | static | ✅ |
| 57 | Structured-data columns (named `*_json` or holding payload/settings/items blobs) are `JSONB`, not `TEXT` | yes | llm | |
| 58 | When `stateMachine.unknownSentinel == "null"`, the tracked-state column is NULLABLE | yes | static | ✅ |
| 59 | `uniqueConstraint` shape is `null` or `{"columns":[...]}` — no `"name"` field | no (paranoid) | — | |
| 60 | `uniqueConstraint` declared on tables with one-row-per-entity-combo semantics | yes | llm | |
| 61 | Exactly one creation timestamp per table (no `created_at` alongside an at-insert domain timestamp) | yes | llm | |
| 62 | Log/audit tables with a parent-record FK column declare `REFERENCES <parent>(id) ON DELETE CASCADE` | yes | llm | |
| 63 | Discrete-value columns (`status`, `kind`, `channel`, `type`) declare a non-empty `enum` list | yes | llm | |
| 64 | `enum` column's `DEFAULT '<x>'` literal is a member of the `enum` list | yes | static | ✅ |
| 65 | Singleton tables: no `id` UUID column, no `uniqueConstraint`, `"singleton": true` flag set | yes | static | ✅ |
| 66 | Don't declare config/settings tables without matching read+write `adminApiCatalog` routes | yes | llm | |
| 67 | Don't declare email-template columns (`email_subject`, `email_body`, `email_body_template`, `email_cta_label`, `email_cta_url`, `email_from_name`) — platform-owned | yes | static | ✅ |
| **State machine** | | | | |
| 68 | `stateMachine` non-null ⇒ has `entity`, `trackedField`, `transitions[]`, `unknownSentinel`, `skipWhenUnknown` | no (paranoid) | — | |
| 69 | `unknownSentinel === "null"` (string) — never `0`, `false`, `""` | yes | static | ✅ |
| 70 | Each transition is `{from, to, action}` | no (paranoid) | — | |
| 71 | `stateMachine` used only for discrete string/enum transitions (not numeric thresholds, not workflow queue columns) | yes | llm | |
| 72 | `from`/`to` are not descriptive range labels (e.g. `"zero_or_negative"`) — must be exact stored enum values | no (paranoid) | — | |
| 73 | `skipWhenUnknown` consistent with `handlerMustProduce` (no contradiction) | yes | llm | |

---

## Counts

- **73 rules** total across architect prompts
- **51 validate** → **28 static** rule-rows + **23 llm** (deferred to `agent_rules` + `bug_finder` per `LLM_VALIDATORS_PLAN.md`)
- **22 skip** → **4 style/judgment** (high FP risk; row #20 reclassed this turn after llm audit — non-catastrophic) + **18 paranoid** (model handles via prompt; bug_finder catches downstream impact)

The 28 static rule-rows are covered by **17 numbered checks** in [`platform-ai/llm_validations/arch_plan.py`](platform-ai/llm_validations/arch_plan.py) (mapping is M:N — e.g. check #9 covers 7 rule-rows of dbContracts column discipline; check #1 covers webhook-topic set-membership which implies #42 + #43; check #7 covers `:param` rejection across both #18 and #28). The "all enforced" status holds at the rule-row level — every static-yes row in the table maps to a check or sub-check that runs today.
