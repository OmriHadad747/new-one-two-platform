# HLD Agent Prompt Rules — Validation Map

Source: every rule expressed by `platform-ai/subagents/hld_agent/prompt.py:SYSTEM_PROMPT_TEMPLATE` and the schema in `platform-ai/subagents/hld_agent/schema.py:HLDPlan`.

**Legend** — `validate?` = should this rule be enforced after the HLD agent emits a plan?
- **static** — structural / set-membership / regex / cross-field shape. Cheap, safe, reliable, very low FP, high blast radius. Lives in Pydantic.
- **llm** — semantic, prose, or judgment that won't survive a cheap structural check but is worth catching agentically.
- **no** — judgment / style / informational; high false-positive risk relative to value.
- **no (paranoid)** — structural rule the prompt + schema already carry; model gets it right ~always.

**`done?`** column — `✅` means the rule is currently enforced inside `HLDPlan` (Pydantic field constraint or `model_validator`). Blank for rules where the static check hasn't been added yet, or where the owner is `llm` / `no`.

**One owner per rule** — every row has exactly one owner. No rule is enforced both statically and by LLM.

**Static-validation policy:** only enforce a rule when it is (a) cheap to express, (b) safe (rejects bad output without blocking valid output), (c) reliable (≥ 99% precision on real outputs), (d) very low false-positive risk, and (e) the failure has high blast radius downstream — corrupts the LLD plan, the migration, the handler, or the runtime.

**Where static rules live:** unlike the architect (which needs a separate `arch_plan.py` Python module), the HLD agent's static rules live entirely inside the `HLDPlan` Pydantic model — `Literal[...]`, `Field(pattern=...)`, `Field(min_length=...)`, `@field_validator`, and `@model_validator(mode="after")`. The schema **is** the validator. This eliminates the prompt/validator drift class of bugs ARCH suffers from. A separate validators module is only added later if cross-artifact checks (HLD ↔ product brief, HLD ↔ LLD plan) are needed.

---

| # | rule | validate? | how | done? |
|---|---|---|---|---|
| **Top-level shape** | | | | |
| 1 | `schema_version == "1"` | yes | static (`Literal["1"]`) | |
| 2 | Output is a single JSON object that parses against `HLDPlan` (no markdown fences, no prose) | yes | static (`model_validate_json` — parse failure becomes the retry suffix) | |
| 3 | No `<placeholder>` tokens echoed verbatim in any string field | no (paranoid) | — | |
| 4 | No extra/unknown keys at any level | yes | static (`extra="forbid"`) | |
| **Archetype** | | | | |
| 5 | `archetype ∈ {"backend","backend+admin","backend+storefront","backend+admin+storefront"}` | yes | static (`Literal[...]`) | |
| 6 | `archetype` correlates with `externalContracts` — `backend` has none; surfaces declared in contracts must be a subset of those implied by archetype | yes | static (`@model_validator`) | |
| **Feasibility** | | | | |
| 7 | `feasibility ∈ {"feasible","blocked"}` | yes | static (`Literal[...]`) | |
| 8 | `blockedReason` is non-null iff `feasibility == "blocked"` | yes | static (`@model_validator`) | |
| **Complexity** | | | | |
| 9 | `complexity ∈ {"low","medium","high"}` | yes | static (`Literal[...]`) | |
| 10 | `complexity == "high"` when any structural trigger fires (stateMachine declared, OR a schedule with `bulkFetchRule=true`, OR ≥2 external-event triggers, OR archetype is `backend+admin+storefront`) | yes | static (`@model_validator`) | |
| **Triggers** | | | | |
| 11 | `triggers` is a non-empty list | yes | static (`Field(min_length=1)`) | |
| 12 | Each trigger's `kind ∈ {"external-event","schedule","inbound-request"}` | yes | static (discriminated union) | |
| 13 | `external-event` trigger has non-empty `event`, `signalFields[]`, `idempotency` | yes | static (variant model) | |
| 14 | `schedule` trigger has non-empty `cadence`, `jobPurpose`, `perTickWork`, and a boolean `bulkFetchRule` | yes | static (variant model) | |
| 15 | `cadence` is a domain phrase, not a cron expression (no 5-field `* * * * *` strings) | yes | static (regex reject) | |
| 16 | `signalFields` entries are domain names — no dotted paths (`customer.email`) and no API enum literals | yes | llm | |
| 17 | `event` description is a single business-language sentence | no | — | |
| 18 | When the archetype includes a UI surface, an `inbound-request` trigger SHOULD exist (widget/admin can't be useful without one) | yes | llm | |
| **Capabilities** | | | | |
| 19 | `capabilities` is a non-empty list | yes | static (`Field(min_length=1)`) | |
| 20 | Each capability `id` is unique within the plan | yes | static (`@model_validator`) | ✅ |
| 21 | Each capability `id` matches kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`) | yes | static (`Field(pattern=...)`) | |
| 22 | Each capability `kind ∈ {"read","write","compute","notify"}` | yes | static (`Literal[...]`) | |
| 23 | Each capability `integration ∈ {"shopify-admin","shopify-storefront","email", null}` | yes | static (`Literal[...] | None`) | |
| 24 | Each capability has a non-empty `description` | yes | static (`Field(min_length=1)`) | |
| 25 | `dataNeeds` non-empty for `read`/`write` capabilities; may be empty for `compute`/`notify` | yes | static (`@model_validator`) | |
| 26 | `dataNeeds` entries are domain names, not API field paths | yes | llm | |
| 27 | A capability with `integration == null` is purely internal (no external API called) | no | — | |
| 28 | Capabilities are distinct concerns — "read order data and email customer" must be two capabilities, not one | yes | llm | |
| 29 | Every external-event trigger has at least one capability that consumes its signal | yes | llm | |
| **Data flow** | | | | |
| 30 | `dataFlow` is a non-empty string | yes | static (`Field(min_length=1)`) | |
| 31 | `dataFlow` is 3–6 sentences | yes | llm | |
| 32 | `dataFlow` references at least one capability `id` and at least one persistence table by name | yes | llm | |
| 33 | `dataFlow` does not name specific Shopify ops, GraphQL paths, file paths, or SQL types | yes | llm | |
| **Persistence** | | | | |
| 34 | `persistence` is a list (may be empty for stateless backends) | yes | static (typing) | |
| 35 | Each table `name` matches `^[a-z][a-z0-9_]*$` (snake_case, lowercase) | yes | static (`Field(pattern=...)`) | |
| 36 | Each column `name` matches `^[a-z][a-z0-9_]*$` | yes | static (`Field(pattern=...)`) | |
| 37 | Each column `role ∈ {"identifier","reference","timestamp","money","status","flag","text","count"}` | yes | static (`Literal[...]`) | |
| 38 | Each column has a `nullable: bool` | yes | static (typing) | |
| 39 | Table `keyedBy` is a non-empty string | yes | static (`Field(min_length=1)`) | |
| 40 | If `statusField` is set, it names an existing column on the same table | yes | static (`@model_validator`) | ✅ |
| 41 | If `statusField` is set, that column's `role == "status"` | yes | static (`@model_validator`) | |
| 42 | If `statusField` is set, `stateMachine` must be non-null | yes | static (`@model_validator`) | ✅ |
| 43 | If `stateMachine` is non-null, **at least one** persistence table has a `statusField` set (no upper-bound — apps may bind the same state machine to multiple lifecycle-tracked tables) | yes | static (`@model_validator`) | ✅ |
| 44 | Column `name` is not a SQL reserved word (`order`, `user`, `group`, `from`, `to`, etc.) | yes | static (deny-list regex) | |
| 45 | Column roles match the column's domain meaning (e.g. `*_at` columns are `timestamp`, `*_amount` is `money`) | yes | llm | |
| 46 | Email-template columns (`email_subject`, `email_body`, `email_cta_label`, `email_cta_url`, `email_from_name`) are NOT declared — platform-owned | yes | static (deny-list) | ✅ |
| 47 | No tenant-identifier column (`tenant_id`, `shop_domain`, `shop_id`, or any equivalent) — the platform runs each app in its own isolated database schema; any such column is always redundant dead weight | no | — | |
| **State machine** | | | | |
| 48 | `stateMachine` is `null` or an object with `states[]`, `initialState`, `terminalStates[]`, `transitions[]`, `invariants[]` | yes | static (typing) | |
| 49 | `states` is non-empty and entries are unique | yes | static (`@model_validator`) | |
| 50 | `initialState ∈ states` | yes | static (`@model_validator`) | ✅ |
| 51 | Every state in `terminalStates` is in `states` | yes | static (`@model_validator`) | |
| 52 | `transitions` is non-empty | yes | static (`Field(min_length=1)`) | |
| 53 | Every `transition.from` and `transition.to` is in `states` | yes | static (`@model_validator`) | ✅ |
| 54 | No transition has `from ∈ terminalStates` (terminal means terminal) | yes | static (`@model_validator`) | |
| 55 | Every non-terminal state has at least one outgoing transition (no orphan states) | yes | static (`@model_validator`) | |
| 56 | `transition.trigger` is a domain phrase, not an enum literal from a specific API | yes | llm | |
| 57 | Invariants are non-trivial (no "the row exists" / "the value is set") | yes | llm | |
| **External contracts** | | | | |
| 58 | `externalContracts` is empty when `archetype == "backend"` (no UI surfaces) | yes | static (`@model_validator`) | ✅ |
| 59 | Each entry's `surface ∈ {"widget","admin"}` | yes | static (`Literal[...]`) | |
| 60 | Surfaces in `externalContracts` are a subset of those implied by `archetype` | yes | static (`@model_validator`) | ✅ |
| 61 | Each `path` starts with `/` | yes | static (`Field(pattern="^/")`) | ✅ |
| 62 | Each `path` contains no `:param` segments | yes | static (regex reject `:`) | ✅ |
| 63 | Each `method ∈ {"GET","POST","PUT","DELETE"}` | yes | static (`Literal[...]`) | |
| 64 | `(surface, path, method)` triples are unique | yes | static (`@model_validator`) | |
| 65 | `requestShape` and `responseShape` values are drawn from the closed semantic-kind set (`identifier`, `reference`, `timestamp`, `money`, `status`, `flag`, `text`, `count`, `list`, `object`) — no TS types | yes | static (closed-set `@field_validator` on both dicts) | ✅ |
| 66 | List/index routes include pagination keys in both shapes (`page`, `page_size`, `items`, `total`) | yes | llm | |
| 67 | When a `schedule` trigger exists and the archetype includes admin, the catalog has a manual-trigger POST route | yes | llm | |
| 68 | `requestShape` contains only data the caller (widget/admin) can produce — no server-side fields | yes | llm | |
| **Edge cases** | | | | |
| 69 | `edgeCases` length is 3–6 | yes | static (`Field(min_length=3, max_length=6)`) | |
| 70 | `edgeCases` entries are non-empty strings | yes | static (`Field(min_length=1)`) | |
| 71 | `edgeCases` entries are domain-specific, not generic ("handle errors gracefully") | yes | llm | |
| 72 | `edgeCases` entries do not cite literal API enum values (`"fulfilled"`, `"paid"`, `"PROCESSING"`) | yes | llm | |
| **LLD-leak prevention (cross-cutting)** | | | | |
| 73 | No string field anywhere contains a Shopify GraphQL operation name (e.g. `abandonedCheckouts`, `productCreate`) | yes | llm | |
| 74 | No string field contains a webhook topic literal (`orders/create`, `checkouts/create`) | yes | llm | |
| 75 | No string field contains a file path (`src/routes/...`, `src/lib/...`) | yes | llm | |
| 76 | No string field contains SQL types (`UUID`, `BIGINT`, `TIMESTAMPTZ`) or constraints (`PRIMARY KEY`, `NOT NULL`) | yes | static (deny-list regex over all string fields) | |
| 77 | No string field contains TypeScript type syntax (`: string`, `: number`, `Promise<`, `Array<`) | yes | static (deny-list regex) | |
| 78 | No string field contains npm package names or version pins (`dayjs@1.11.13`, `sharp`) | yes | llm | |
| 79 | No string field contains capability registry names (`shopify_graphql`, `shopify_storefront`, `email` as a capability literal — `"email"` as `integration` value is fine because that's the schema enum) | yes | llm | |
| **Persistence — column purpose** | | | | |
| 80 | Each column may declare an optional `purpose` field — a one-phrase description of what the column stores in domain terms | yes | static (`Optional[str]`) | ✅ |
| 81 | When a column's `role == "reference"`, its `purpose` should be provided and written in domain language (not API field names or platform-specific terms) | yes | llm | |
| **Capabilities — granularity** | | | | |
| 82 | State transitions on the same record are one capability regardless of terminal-state count — name for the outcome (`record-cart-outcome`), not per state (`mark-cart-sent` / `mark-cart-skipped` / `mark-cart-failed`) | yes | llm | |

---

## Counts

- **82 rules** total across the HLD prompt + schema.
- **Static: 51** — every one of these lives inside `HLDPlan` (field constraints, `@field_validator`, or `@model_validator`). No separate validator module today.
- **LLM: 23** — semantic, prose-judgment checks deferred to a future `hld_validators.py` (parallel to `agent_rules` / `bug_finder`).
- **No / paranoid: 8** — covered by parse-or-fail behavior of Pydantic itself, or judgment calls with FP risk that outweighs value.

## Why this lives in Pydantic, not a separate module

- **Single source of truth.** The schema *is* the contract; bumping a `Literal[...]` updates both the validator and the JSON schema injected into the prompt automatically.
- **No prompt/validator drift.** The class of bugs ARCH suffers (prompt says one thing, `arch_plan.py` enforces another) cannot exist when both reads come from the same class.
- **Errors are precise.** `ValidationError` carries the JSON path of the offending field — drops directly into the retry suffix as actionable feedback.
- **Cheap.** No new module, no new test suite for the validator separately from the schema.

## Where a separate `hld_validators.py` would still earn its keep

- Cross-artifact checks: HLD ↔ product brief alignment, HLD ↔ LLD plan consistency. Pydantic can't see those; a thin module that takes both objects can.
- LLM-validator runners (rows above marked `llm`) — same shape as `agent_rules.py` / `bug_finder.py` for the architect.

Add only when those cross-artifact stages exist. Don't pre-build.
