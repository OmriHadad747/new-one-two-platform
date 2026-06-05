# Helper: `email.sendBatch`

Batch variant of `email.send` — one call sends many messages and returns a
per-item result array, so a partial failure doesn't abort the rest. Use it
whenever you'd otherwise loop `email.send`.

```ts
import { platform } from "../lib/platform.js";

const batch = await platform.email.sendBatch(
  rows.map((r) => ({ to: r.email, data: { name: r.name, productTitle: r.title } })),
);

for (const item of batch.items) {
  if (item.status === 200 && item.result.delivered) {
    // mark sent for rows[item.index]
  }
  // item.status === 429 → quota_exceeded for THIS item (item.limit, item.current)
  // item.status === 500 → send_failed for THIS item
}
```

Rules:
- Outcomes are PER ITEM via `item.status` (200 / 429 / 500) — the call itself
  does NOT throw `QuotaExceeded`; inspect each item.
- `item.index` maps back to the input row — use it to mark exactly the rows that
  delivered, not the whole batch.
