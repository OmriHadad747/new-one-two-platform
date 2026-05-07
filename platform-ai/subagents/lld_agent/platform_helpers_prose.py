"""
LLD-input prose for the platform's runtime helpers.

These contracts are JIT-injected into the LLD agent's user message based
on signals the HLD declares (returnsList, touchesMoney, usesConfig,
usesWorkflow). Each contract teaches the LLD what to emit when a recipe
touches the corresponding helper — recipe shape, step expressions,
response body, AND any helper-specific rules the static prompt would
otherwise have to carry for every plan. When the helper isn't relevant,
neither the API nor the rules cost any tokens.

Codegen agents NEVER read these contracts. The codegen sees only what
the LLD chose to write into its recipe (plus the per-step `example`
snippets stamped by `platform_runtime_examples.example_for_step`).

Source-of-truth split:
  - this file:                 prose teaching the LLD
  - platform_runtime_examples: working-TS snippets teaching the codegen
"""

from __future__ import annotations

WORKFLOW_HELPER_CONTRACT = """\
Workflow lifecycle helper — use for every multi-state row lifecycle
(pending → running → completed/failed, draft → submitted →
approved/rejected, etc.).

Storage: the workflow-bearing table you declare in `database.tables`
must have a `status TEXT` column with the state set in `enum`. Standard
optional columns (`started_at TIMESTAMPTZ`, `finished_at TIMESTAMPTZ`,
`failure_reason TEXT`) are recommended; the helper writes them when
present. The state set is yours — the helper has zero opinion about
"pending" / "running" / etc.; those are conventions you can override.

API surface (import { workflow } from "../lib/workflow.js"):

  workflow.claim(table, id, { from, to?, statusColumn?, startedAtColumn?, extraWhere? })
      Atomic single-statement UPDATE … WHERE status=$from RETURNING *.
      Returns the row, or null if zero rows matched (already claimed,
      wrong state, gated out by extraWhere). NEVER throws on race.

  workflow.complete(table, id, { to?, finishedAtColumn? })
      Marks the row terminal-success.

  workflow.fail(table, id, reason, { to?, finishedAtColumn?, failureReasonColumn? })
      Marks the row terminal-failure with reason (truncated to 4000).

  workflow.attempt(table, id, claimOptions, async (row) => …, { complete?, fail? })
      One-shot: claim → run callback → complete-or-fail. Re-throws
      callback errors AFTER persisting failure_reason. Returns
      { row, value } or null (if claim came back empty).

  workflow.sweepStale(table, { ttlMinutes?, runningState?, timedOutState?, … })
      Flips rows that have been 'running' too long back to a terminal
      state. Single SQL statement, RETURNING the swept ids.

Recipe rules (these REPLACE the hand-rolled sql_claim + try_catch +
sql_update pattern for kind="workflow" stateMachines — that's why this
contract is injected for usesWorkflow=true capabilities):

  - Use `workflow.attempt(...)` inside a single `compute` step. The
    callback's body holds the actual side effects (Shopify call, email
    send, etc.). On callback throw, the helper persists failure_reason
    (truncated) and re-throws — the cron-runner sees the error and
    decides retry. NO sql_claim, try_catch, or sql_update for the
    lifecycle is needed in the recipe.
  - Custom state names are supported: `claim(t, id, { from: "approved",
    to: "shipped" })`. The standard quartet is convention, not
    constraint.
  - Multi-step lifecycles call `claim` repeatedly with different
    `from`/`to` pairs (claim pending→running, do work, claim
    running→awaiting_input, …).
  - `extraWhere` accepts a `sql\`...\`` predicate AND-ed into the WHERE
    clause. Use for time-gated transitions (`scheduled_at <= now()`)
    or relation gates.

Stale sweeper — REQUIRED for every workflow-bearing table. Without it,
rows that crash mid-execution stay in 'running' forever. The validator
rejects workflow plans that omit it. Recipe shape:

  triggeredBy: "cron:sweep_<table>"
  cronSchedule: "*/10 * * * *"   (every 10 minutes)
  steps:
    - kind: compute
      purpose: "sweep stale running rows"
      expression: "await workflow.sweepStale('<table>')"

Example workflow recipe (cron: process_run):

  inputs: [{ name: "runId", source: "cron.payload", fieldPath: "run_id",
            type: "string", nullable: false }]
  steps:
    - kind: compute
      purpose: "claim, run, finalise"
      expression: "await workflow.attempt('rule_runs', runId,
                     { from: 'pending' },
                     async (row) => { /* do work — see other steps' example */ })"
"""


CONFIG_HELPER_CONTRACT = """\
Config helper — use for every app-wide setting (rate, threshold, toggle,
TTL, choice).

Storage is the platform-owned `app_config` table (template-managed, one
row per setting key, JSONB value). Per-tenant via search_path. Do NOT
declare a config table in `database.tables` — the helper writes directly
to `app_config` with no per-app DDL.

API surface (import { config } from "../lib/config.js"):

  config.get(key, default)    -> stored value, or default if missing/null
  config.get(key)             -> value or undefined
  config.set(key, value)      -> upsert (last-writer-wins)
  config.getMany(keys)        -> { key: value } subset (missing keys absent)
  config.getAll()             -> { key: value } map of every key
  config.unset(key)           -> remove a key (rare)

Recipe rules:

  - Reads happen in `compute` steps:
      expression: "await config.get('points_per_dollar', 1)"
    The default literal MUST always be supplied — never assume a key
    is set on first run.
  - Writes happen in admin "save settings" routes via a `compute` step
    per knob, or one batched compute step iterating req.body. The
    typical pattern collapses the legacy 5-step admin save (read, merge,
    upsert, validate, respond) to: validate → config.set → 200.
  - Key conventions: lowercase snake_case, ≤63 chars, regex
    `^[a-z][a-z0-9_]{0,62}$`. Group related keys by prefix —
    `loyalty_*`, `notification_*`, `discount_*` — so an admin page can
    list them coherently.
  - Concurrent writes: last-writer-wins. The merchant overrides their
    own setting — that's the right semantics. If a recipe needs
    optimistic locking on a counter-style value, use a real DB column
    instead of config.

Example admin "save settings" recipe (3 steps total):

  1. compute   purpose: "validate input"
               expression: "(typeof req.body.points_per_dollar === 'number'
                            && req.body.points_per_dollar >= 0)
                            ? true
                            : (() => { throw new Error('invalid rate') })()"
  2. compute   purpose: "persist setting"
               expression: "await config.set('points_per_dollar',
                                              req.body.points_per_dollar)"
  3. response  status: 200
               body: { ok: "true" }
"""


MONEY_HELPER_CONTRACT = """\
Money helper — use for every monetary value the recipe touches.

Storage stays integer minor units in BIGINT columns. The
helper converts between Shopify's decimal-string payloads and stored
integers correctly for every currency Shopify supports — including
zero-decimal (JPY, KRW) and three-decimal (BHD, JOD) where the legacy
formula `Math.round(parseFloat(x) * 100)` is silently wrong.

API surface (import { money } from "../lib/money.js"):

  money.toMinorUnits(value, currency)   -> integer minor units
  money.fromMinorUnits(amount, currency) -> decimal number (rare)
  money.format(amount, currency)        -> plain decimal string
  money.sum(amounts)                    -> integer (use instead of +)
  money.percentage(amount, pct)         -> integer (tax, discount, fee)
  money.currency(code)                  -> { code, decimalDigits }

Recipe rules:

  - Compute steps that derive money from a Shopify decimal string MUST
    use `money.toMinorUnits(value, currency)`. Do NOT inline
    `Math.round(parseFloat(x) * 100)` — it is wrong for zero-decimal
    (JPY, KRW) and three-decimal (BHD, JOD) currencies.
  - Compute steps that aggregate money MUST use `money.sum([a, b, c])`.
    Never `+` raw integers in compute expressions when the meaning is
    "total of these money amounts".
  - Compute steps that take a percentage of money (tax, fee, discount)
    MUST use `money.percentage(amount, pct)`. Never inline
    `amount * pct / 100`.
  - Currency code is always required — pass it from the same Shopify
    payload that carried the amount (e.g. presentmentMoney.currencyCode
    or shopMoney.currencyCode). Persist the currency code alongside
    the amount in a TEXT column so future reads can format correctly.

Example compute step expression:

  expression: "money.toMinorUnits(payload.totalPriceSet.shopMoney.amount,
                                  payload.totalPriceSet.shopMoney.currencyCode)"
"""


PAGINATE_HELPER_CONTRACT = """\
Pagination helper — use for every offset-paginated list route.

When you set httpRoutes.*.paginationKind="offset" on a route, its recipe
MUST follow this exact pattern:

  - Request shape includes `page: "number"` and `page_size: "number"`.
  - Response shape is exactly:
      { items: "{...}[]", total: "number", page: "number", page_size: "number" }
  - The recipe contains exactly ONE `sql_select` step whose template is
    a plain SELECT with NO LIMIT, NO OFFSET, NO COUNT(*). Set its
    `bindResultTo` (e.g. "rows").
  - The recipe's `response` step body is:
      { items: "$rows.items", total: "$rows.total",
        page: "$rows.page", page_size: "$rows.page_size" }
  - DO NOT emit a separate count query or an offset-math compute step —
    the paginate() helper handles both at codegen time.

The handler codegen translates the bare sql_select into:

  import { paginate } from "../lib/paginate.js";
  const rows = await paginate(sql, sql`<your SELECT here>`,
                              { page: req.body.page, page_size: req.body.page_size });
  res.json(rows);

Caps page_size at 100 by default. For a higher cap on a specific route,
add a comment in the sql_select.purpose like "max 1000" and the codegen
will pass `{ maxPageSize: 1000 }` as the fourth arg.
"""
