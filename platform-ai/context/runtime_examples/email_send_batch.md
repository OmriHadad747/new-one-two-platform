# Runtime example: `email_send_batch`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { platform, QuotaExceeded } from "../lib/platform.js";

const batch = await platform.email.sendBatch(
  rows.map((r) => ({ to: r.email, data: { name: r.name, productTitle: r.title } })),
);

for (const item of batch.items) {
  if (item.status === 200 && item.result.delivered) {
    // mark sent for rows[item.index]
  }
  // item.status === 429 → quota_exceeded for THIS item
  // item.status === 500 → send_failed for THIS item
}
```
