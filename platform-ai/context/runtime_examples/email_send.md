# Helper: `email`

Use the `email` helper (`platform.email.send`) for every transactional email —
order confirmations, alerts, receipts. The provider, templating, suppression
list, and monthly quota are platform-owned; you pass a recipient and template
`data`. Do NOT call an email SDK directly or add SMTP config.

```ts
import { platform, QuotaExceeded } from "../lib/platform.js";

try {
  const result = await platform.email.send({
    to: customerEmail,
    data: { customerName, productTitle, variantName },
  });

  if (result.delivered) {
    console.log({ deliveryId: result.deliveryId }, "email sent");
  } else {
    // result.reason is one of: "suppressed" | "missing_config" | "provider_failed"
    console.warn({ reason: result.reason }, "email not delivered");
  }
} catch (err) {
  if (err instanceof QuotaExceeded) {
    // err.kind === "email"; err.limit, err.current, err.resetsAt
    console.warn({ limit: err.limit, resetsAt: err.resetsAt }, "email quota exceeded");
    return; // monthly cap hit — stop the loop
  }
  throw err;
}
```

Rules:
- `send` resolves with `{ delivered }` for normal outcomes (including
  `delivered: false` carrying a `reason`) and only THROWS `QuotaExceeded` —
  branch on `result.delivered`, don't treat a non-delivery as an exception.
- A `delivered: false` reason (`suppressed` / `missing_config` /
  `provider_failed`) is terminal for that recipient — log it, don't retry in a
  tight loop.
- `QuotaExceeded` (`kind: "email"`) means the monthly cap is hit — stop sending
  and let it resume at `err.resetsAt`; don't catch-and-continue.
- Sending to many recipients? Use `email.sendBatch` (see `email_send_batch.md`)
  instead of a `send` loop.
