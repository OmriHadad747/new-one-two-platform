# Platform-Wide Money Helper — Implementation Plan

## Goal

Centralise money-handling rules (minor-unit conversion per ISO 4217
currency, rounding policy, formatting) in a typed platform helper so
recipes never inline `Math.round(parseFloat(x) * 100)` again. The
helper is correct for every currency Shopify supports — including the
currencies our hardcoded `* 100` is silently wrong for (JPY = 0
decimals, BHD = 3 decimals).

## Why now

Today every recipe touching money writes the formula inline:

```ts
const cents = Math.round(parseFloat(payload.total_price) * 100);
```

Wrong cases this misses today:

- **JPY / KRW / VND / CLP / ISK** (zero-decimal currencies): the
  formula multiplies a whole-yen amount by 100, persisting it as
  hundredths of yen. Sum aggregates are off by 100x.
- **BHD / JOD / KWD / OMR** (three-decimal currencies): the formula
  truncates the third decimal, persisting fewer fils than the customer
  paid. Money is lost on every transaction.
- **CLP** (Chilean peso, 0 decimals but Shopify returns it as a
  decimal string with `.00`): formula appears to work but the
  intent — "store integer pesos" — is hidden behind the multiplier.

These hit any merchant outside USD/EUR/GBP — a real and growing
percentage of Shopify's GMV.

## Specification

### API

```ts
import { money } from "../lib/money.js";

// Parse Shopify decimal string → integer minor units (correct per currency)
const cents = money.toMinorUnits("9.99", "USD");      // → 999
const yen   = money.toMinorUnits("100", "JPY");       // → 100
const fils  = money.toMinorUnits("1.234", "BHD");     // → 1234

// Format integer minor units → user-facing string (no symbol)
const text = money.format(999, "USD");                // → "9.99"
const text = money.format(100, "JPY");                // → "100"
const text = money.format(1234, "BHD");               // → "1.234"

// Format with localised symbol + grouping (Phase 2)
const localized = money.formatLocalized(999, "USD", "en-US");
// → "$9.99"

// Inverse (rare — usually you store cents and never reconstruct)
const decimal = money.fromMinorUnits(999, "USD");     // → 9.99 (number)

// Sum / arithmetic safe operations — explicit so callers never
// accidentally do float math on minor-unit ints.
const total = money.sum([100, 200, 300]);             // → 600
const tax   = money.percentage(1000, 8.5);            // → 85 (8.5% of 10.00)

// Currency metadata
const meta = money.currency("BHD");
// → { code: "BHD", decimalDigits: 3, name: "Bahraini Dinar" }
```

### Internal: currency precision table

ISO 4217 maps every active currency code to its minor-unit count.
Static, doesn't change between releases. Embedded as a const map in
`money.ts`:

```ts
const CURRENCY_DECIMALS: Record<string, number> = {
  // Zero-decimal currencies
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, /* … */
  // Three-decimal currencies
  BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3, /* … */
  // Two-decimal default (everything else not listed)
};
```

Anything not in the map defaults to 2 decimals — matches the global
convention and avoids breaking on a Shopify-added currency the helper
hasn't been updated for.

### Rounding policy

`toMinorUnits` uses `Math.round` (nearest, ties away from zero).
Locked to one policy so different recipes don't drift. The Shopify
Money type itself uses HALF_EVEN (banker's rounding) in some
internal contexts; we choose `round` because:
- It matches what every recipe today already does.
- The drift versus banker's rounding is sub-cent over a single value
  and effectively zero in aggregate.
- One policy = no per-recipe ambiguity.

If a future caller genuinely needs banker's rounding, expose
`money.toMinorUnits(value, currency, { rounding: "halfEven" })` as a
typed second arg. Until then: one policy.

### Edge cases handled

| Input | Behavior |
|---|---|
| `null` / `undefined` value | Throws `MoneyError("missing value")` |
| `"NaN"` / non-numeric string | Throws `MoneyError("invalid number")` |
| Negative value | Allowed (refunds, adjustments). Sign preserved. |
| Currency code unknown | Defaults to 2 decimals + structured `console.warn` (so we see when Shopify ships a new one) |
| Currency code lowercase | Normalised to uppercase |
| Scientific notation (`"1e3"`) | Rejected — Shopify never sends this, and accepting it surfaces caller bugs |
| Trailing zeros (`"9.90"`) | Handled correctly by parseFloat |
| Whitespace / commas (`"1,000.00"`) | Rejected — Shopify always sends en-US format |

### What the helper does NOT do

- **Currency conversion / FX** — out of scope. Apps that need
  multi-currency conversion call a third-party FX provider.
- **Tax calculation** — out of scope. Tax engines are a different
  product.
- **Localised formatting in Phase 1** — `Intl.NumberFormat` lives in
  `formatLocalized` which is Phase 2.

## Implementation phases

### Phase 1 — Core helper + currency table

**Files to author:**
- `platform-back/templates/handler/src/lib/money.ts` —
  `toMinorUnits`, `fromMinorUnits`, `format`, `currency`, `sum`,
  `percentage`, `MoneyError`, internal currency table.

**Files to modify:** none. Pure addition.

### Phase 2 — Localised formatting

Add `money.formatLocalized(amount, currency, locale)` using
`Intl.NumberFormat`. Defer until a real app needs it — for handler
recipes returning JSON to a JS client, formatting is usually the
client's job.

### Phase 3 — LLD integration

**Files to modify:**
- `platform-ai/subagents/lld_agent/prompt.py` — replace the existing
  R6 (money rules) with:

  > "R6 (revised). Money values are integers in minor units, stored
  > in BIGINT columns. To parse a Shopify decimal-string value into
  > minor units, use `money.toMinorUnits(value, currency)` from
  > `../lib/money.js` — NEVER inline `Math.round(parseFloat(x) *
  > 100)`. The helper is correct for zero-decimal currencies (JPY,
  > KRW), three-decimal currencies (BHD, JOD), and the standard
  > two-decimal currencies. Use `money.sum()` for aggregations and
  > `money.percentage()` for percentage math; never apply `+` or
  > `*` to minor-unit ints in `compute` steps."

- `platform-ai/subagents/lld_agent/platform_runtime_examples.py` —
  add a `money` snippet bucket. Wire `compute` steps that match the
  pattern `Math.round(parseFloat(...))` to inject the snippet as a
  warning. (Optional polish; the prompt change alone may be enough.)

- LLD validator (optional): regex `compute.expression` for
  `Math\.round\s*\(\s*parseFloat\s*\(.*\)\s*\*\s*100\s*\)` and
  reject with a message pointing to `money.toMinorUnits`. Fail fast
  before the bad pattern propagates.

### Phase 4 — Documentation + currency table refresh process

**Files to author:**
- `docs/MONEY_HELPER.md` — public contract.
- `docs/CURRENCY_TABLE_REFRESH.md` — short SOP for refreshing
  `CURRENCY_DECIMALS` against ISO 4217 changes (rare — a few times
  per decade).

## Sequencing

```
Phase 1 (helper + tests) ──────────────┐
                                       ▼
                             Phase 3 (LLD prompt + validator)
                                       │
                                       ▼
                             Phase 4 (docs)
                                       │
                                       ▼
                             Phase 2 (localised format, when needed)
```

Pure addition. No coordinated rollout.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Currency added by Shopify after our last refresh defaults to 2 decimals incorrectly | Helper logs a structured `console.warn` when defaulting. We monitor logs for unknown-currency events and refresh the table. Worst case: 2 decimals is wrong for a new 0/3-decimal currency, but it's wrong consistently — recoverable via backfill |
| Caller passes BigInt or non-string value to `toMinorUnits` | Strict type signature + runtime check; throws `MoneyError`. No silent conversion |
| `Math.round` ties (e.g. `Math.round(0.5)` → 1, `Math.round(-0.5)` → 0 in JS) | Documented; this is JS's native behavior, not the helper's. Recipes that care about banker's rounding for tax compliance opt into the explicit option |
| Validator regex catches false positives (e.g. `Math.round(parseFloat(x) * 100)` where `100` is a coincidence, not a money operation) | Validator is advisory only on first attempt; only escalates to reject if the surrounding context (variable name, table column type) confirms money — or skip the validator entirely and rely on prompt + helper docs |

## Success metrics

- Zero `Math.round(parseFloat(...) * 100)` patterns in generated
  recipes after Phase 3.
- `console.warn` "unknown currency" log rate stays at 0 in steady
  state (table is fresh).
- A merchant on a JPY store can enable a money-touching feature and
  the persisted amounts match Shopify's reported totals exactly.

## Estimated scope

| Phase | Effort |
|---|---|
| 1. Helper + currency table | 0.5 day |
| 2. Localised format (deferred) | 0.5 day (when needed) |
| 3. LLD prompt + optional validator | 0.5 day |
| 4. Docs | 0.5 day |
| **Total (Phases 1+3+4)** | **1.5 working days** |
