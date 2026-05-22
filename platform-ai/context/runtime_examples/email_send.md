# Runtime example: `email_send`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

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
