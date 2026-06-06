# Helper: `money`

Use the `money` helper for every monetary value — never hand-roll currency math.
Stored as integer minor units in BIGINT. Correct for every Shopify currency,
including zero-decimal (JPY, KRW) and three-decimal (BHD, JOD) where
`Math.round(parseFloat(x) * 100)` is silently wrong.

```ts
import { money } from "../lib/money.js";

// Decimal-string from Shopify -> integer minor units (BIGINT in DB):
const totalCents = money.toMinorUnits(
  payload.totalPriceSet.shopMoney.amount,
  payload.totalPriceSet.shopMoney.currencyCode,
);
const grand = money.sum([itemA, itemB, itemC]); // aggregate (never raw +)
const tax = money.percentage(grand, 8.5);        // tax / fee / discount
const display = money.format(totalCents, "USD"); // "9.99"
```

Rules:
- Decimal string → minor units: `money.toMinorUnits(value, currency)` — never
  `Math.round(parseFloat(x) * 100)`.
- Totals: `money.sum([...])`, not `+`. Percentage (tax/fee/discount):
  `money.percentage(amount, pct)`, not `amount * pct / 100`.
- Currency code is always required — take it from the same payload that carried
  the amount (e.g. `…shopMoney.currencyCode`) and persist it alongside the
  amount in a TEXT column so reads can format correctly.
