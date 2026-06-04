# Platform helpers reference

The template ships these helpers under `scaffold/src/lib/`. **Import and call
them — never re-implement lifecycle, settings, currency math, or offset
pagination by hand.** You write TypeScript directly against this API; there is
no codegen step that rewrites your code.

Each section gives the import, the API, the rules, and a real call site.

## Workflow lifecycle — `workflow`

For every multi-state row lifecycle (`pending → running → done/failed`,
`draft → submitted → approved`, etc.). Storage: the table needs a
`status TEXT` column; optional `started_at`/`finished_at TIMESTAMPTZ`,
`failure_reason TEXT` are written when present. State names are yours.

```ts
import { workflow } from "../lib/workflow.js";

// atomic claim: UPDATE … WHERE status=$from RETURNING *  (null on race, never throws)
const row = await workflow.claim(table, id, { from, to?, statusColumn?, extraWhere? });
await workflow.complete(table, id, { to? });
await workflow.fail(table, id, reason, { to? });
// one-shot claim → run → complete-or-fail (re-throws after persisting failure_reason):
await workflow.attempt(table, id, { from }, async (row) => { /* side effects */ });
// flips rows stuck 'running' too long back to a terminal state:
await workflow.sweepStale(table, { ttlMinutes?, runningState?, timedOutState? });
```

Rules:
- Use `workflow.attempt(...)` to wrap the work — do NOT hand-roll
  `claim → try/catch → update`. The helper persists `failure_reason` and
  re-throws so the cron-runner can retry.
- Custom state names: `claim(t, id, { from: "approved", to: "shipped" })`.
- `extraWhere` takes a `sql\`…\`` predicate AND-ed into the WHERE (time gates,
  relation gates).
- **Every** workflow-bearing table needs a `sweepStale` cron (e.g. `*/10 * * * *`),
  or crashed rows stay `running` forever.

## Config (app settings) — `config`

For every app-wide setting (rate, threshold, toggle, TTL, choice). Backed by the
platform-owned `app_config` table — **do NOT declare a config/settings table** and
do NOT read settings with raw `SELECT`.

```ts
import { config } from "../lib/config.js";

await config.get(key, defaultValue);   // default is REQUIRED — key may be unset on first run
await config.get(key);                 // value | undefined
await config.set(key, value);          // upsert (last-writer-wins)
await config.getMany(keys);            // { key: value } subset
await config.getAll();                 // { key: value } map
```

Rules:
- Always pass a default to `get` — never assume a key is set.
- Keys: lowercase snake_case, `^[a-z][a-z0-9_]{0,62}$`; group by prefix
  (`notification_*`, `discount_*`) so an admin page can list them.
- An admin "save settings" route collapses to: validate → `config.set` → 200.

## Money — `money`

For every monetary value. Stored as integer minor units in `BIGINT`. The helper
converts Shopify decimal-string amounts correctly for **every** currency,
including zero-decimal (JPY, KRW) and three-decimal (BHD, JOD) where
`Math.round(parseFloat(x) * 100)` is silently wrong.

```ts
import { money } from "../lib/money.js";

money.toMinorUnits(value, currency);    // integer minor units
money.fromMinorUnits(amount, currency); // decimal number (rare)
money.format(amount, currency);         // decimal string
money.sum(amounts);                     // integer — use instead of +
money.percentage(amount, pct);          // integer — tax/fee/discount
```

Rules (never inline the math):
- Decimal string → minor units: `money.toMinorUnits(value, currency)`, not
  `Math.round(parseFloat(x) * 100)`.
- Totals: `money.sum([...])`, not `+`. Percentages: `money.percentage(amount, pct)`,
  not `amount * pct / 100`.
- Currency code is required — take it from the same payload as the amount (e.g.
  `…shopMoney.currencyCode`) and persist it alongside the amount in a `TEXT` column.

```ts
const cents = money.toMinorUnits(
  payload.totalPriceSet.shopMoney.amount,
  payload.totalPriceSet.shopMoney.currencyCode,
);
```

## Pagination — `paginate`

For every offset-paginated list route (a GET that returns a list). Handles the
`COUNT(*)` and `LIMIT/OFFSET` for you — **do NOT write your own `LIMIT`/`OFFSET`
or a separate count query.**

```ts
import { paginate } from "../lib/paginate.js";

// pass a bare SELECT (no LIMIT/OFFSET/COUNT); helper adds paging + total:
const result = await paginate(
  sql,
  sql`SELECT * FROM <table> WHERE <filters>`,
  { page: req.body.page, page_size: req.body.page_size },
  // { maxPageSize: 1000 }  // optional; default cap is 100
);
res.json(result);
// result === { items, total, page, page_size }
```

Rules:
- Request carries `page` and `page_size` (numbers); response is exactly
  `{ items, total, page, page_size }`.
- One bare `SELECT` (no `LIMIT`, no `OFFSET`, no `COUNT(*)`) handed to `paginate`.
  The helper caps `page_size` at 100 unless you pass `{ maxPageSize }`.
