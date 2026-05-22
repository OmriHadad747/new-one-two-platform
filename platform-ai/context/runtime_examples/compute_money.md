# Runtime example: `compute_money`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { money } from "../lib/money.js";

// Currency-aware conversion. Correct for every Shopify currency including
// zero-decimal (JPY, KRW) and three-decimal (BHD, JOD).
//
// Decimal-string from Shopify -> integer minor units (BIGINT in DB):
const totalCents = money.toMinorUnits(
  payload.totalPriceSet.shopMoney.amount,
  payload.totalPriceSet.shopMoney.currencyCode,
);

// Aggregate amounts you've already converted to integer minor units:
const grand = money.sum([itemA, itemB, itemC]);

// Take a percentage (tax / fee / discount):
const tax = money.percentage(grand, 8.5);

// Format for display (no symbol, currency-correct decimal count):
const display = money.format(totalCents, "USD"); // "9.99"
```
