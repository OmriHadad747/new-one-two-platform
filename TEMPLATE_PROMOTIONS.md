# Handler-template promotions — moving generator boilerplate into the template

Goal: shrink the generator's surface and prompt size by lifting two
classes of repeated code out of generated files and into the
hand-written handler template. Same idea as the existing cron split
(template owns the runner, generator owns the `jobs` map) — apply it
to webhooks and `/services/*` calls.

The generator already retargeted off `ctx.*` in Phase 2; this work
finishes the job by removing the remaining mechanics it has to
reproduce per app.

## Why

Today the generator authors two patterns by hand on every relevant
app, and the prompt has to teach both. They're easy to get wrong and
identical across tenants:

1. **Webhook idempotency + topic dispatch.** Every webhook handler
   re-emits the `INSERT INTO processed_webhooks ON CONFLICT DO NOTHING`
   gate, the early-return on conflict, and the `switch (topic)` block.
   The template ships a stub with the gate; the generator REPLACES
   the file, so the gate is a "remember to keep this" rather than a
   structural guarantee.

2. **`/services/*` call pattern.** The template only exposes
   `callPlatformService({ path, body }) → { status, body }`. Every
   service call site has to: pick the path string, type the response,
   branch on 200/429/4xx/5xx, distinguish "delivered=false skip" from
   "real failure", and decide whether to break out of a loop. ~15–20
   lines per call, repeated wherever the handler talks to platform.

Both patterns are mechanics, not business logic. They belong in the
template.

## Scope (this work)

Two changes to the handler template + one matching prompt update in
`platform-ai`. No platform-back-side changes.

## Change 1 — Webhook handlers as a data file

### Template changes

`platform-back/templates/handler/src/routes/webhook.ts` — keep the
file, lock it down. It now imports a sibling and dispatches:

```ts
import { Router } from "express";
import { sql } from "../lib/db.js";
import { webhookHandlers } from "./webhook-handlers.js";

export const webhookRouter = Router();

webhookRouter.post("/:topic", async (req, res) => {
  const { topic } = req.params;
  const env = req.body as { webhook_id?: string; payload?: unknown };

  if (typeof env.webhook_id !== "string" || env.webhook_id.length === 0) {
    res.status(400).json({ error: "missing_webhook_id" });
    return;
  }

  const inserted = await sql<Array<{ webhook_id: string }>>`
    INSERT INTO processed_webhooks (webhook_id)
    VALUES (${env.webhook_id})
    ON CONFLICT (webhook_id) DO NOTHING
    RETURNING webhook_id
  `;
  if (inserted.length === 0) {
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  const handler = webhookHandlers[topic];
  if (!handler) {
    // Unknown topic — already marked processed above so we don't hot-loop.
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  try {
    await handler(env.payload, req);
    res.status(200).json({ ok: true });
  } catch (err) {
    req.log.error({ err, topic, webhook_id: env.webhook_id }, "webhook handler threw");
    res.status(500).json({ error: "handler_failed" });
  }
});
```

Add `platform-back/templates/handler/src/routes/webhook-handlers.ts`
as a stub the generator will replace:

```ts
import type { Request } from "express";

export type WebhookHandler = (
  payload: unknown,
  req: Request,
) => Promise<void>;

// Generator REPLACES this file. The template stub keeps the build
// green for handlers that declare no webhook topics.
export const webhookHandlers: Record<string, WebhookHandler> = {};
```

### Generator changes

- Generator no longer authors `routes/webhook.ts`. It authors
  `routes/webhook-handlers.ts` instead — a file that exports a
  `webhookHandlers` map keyed by topic.
- Update `platform-ai/subagents/prompts/handler/_webhook.py` to teach
  the new shape:
  - Output `routes/webhook-handlers.ts`, not `routes/webhook.ts`.
  - Each entry is `(payload, req) => Promise<void>` — pure business
    logic, no envelope parsing, no idempotency gate, no response
    writes (template handles all of that).
  - Existing topic-handler examples shrink ~10 lines each.
- Update `platform-ai/contract/validators.py` and the matching
  Zod schemas in `platform-back/apps/api/src/pubsub/schemas.ts` if
  they enumerate generator-authored file paths.

### Validation

- New unit test in `platform-back/templates/handler/__tests__/`:
  webhook router + a fake `webhookHandlers` map, exercise duplicate
  delivery (200 with `duplicate: true`), unknown topic (200 with
  `ignored: true`), throwing handler (500), happy path.
- Generate one webhook archetype app and walk it through the deploy
  pipeline end-to-end (generation → deploy → simulated webhook →
  handler dispatch).

## Change 2 — Typed `platform.*` SDK

### Template changes

Add `platform-back/templates/handler/src/lib/platform.ts`. It wraps
`callPlatformService` and encodes each `/services/*` endpoint's
response taxonomy in TypeScript, not in prompt prose.

```ts
import { callPlatformService } from "./platform-call.js";

export class QuotaExceeded extends Error {
  constructor(
    public readonly limit: number,
    public readonly current: number,
    public readonly resetsAt: string | null,
  ) {
    super(`Monthly quota exceeded (${limit})`);
    this.name = "QuotaExceeded";
  }
}

export type EmailSendResult =
  | { ok: true; delivered: true; deliveryId: string }
  | { ok: true; delivered: false; reason: "suppressed" | "missing_config" }
  | { ok: true; delivered: false; reason: "provider_failed"; deliveryId: string };

export interface EmailSendInput {
  to: string;
  data: Record<string, unknown>;
}

async function emailSend(input: EmailSendInput): Promise<EmailSendResult> {
  const { status, body } = await callPlatformService<EmailSendResult | {
    error: "quota_exceeded"; limit: number; current: number; resetsAt: string | null;
  }>({ path: "/services/email/send", body: input });

  if (status === 200) return body as EmailSendResult;
  if (status === 429) {
    const e = body as { limit: number; current: number; resetsAt: string | null };
    throw new QuotaExceeded(e.limit, e.current, e.resetsAt);
  }
  if (status >= 500) {
    // Soft-fail platform problems by surfacing as delivered=false; handler
    // continues. Caller can ignore or log.
    return { ok: true, delivered: false, reason: "provider_failed", deliveryId: "" };
  }
  // 400/401/403 — programming error. Throw so it surfaces loudly.
  throw new Error(
    `platform.email.send: unexpected status ${status} (${JSON.stringify(body)})`,
  );
}

export type EmailBatchItemResult =
  | { index: number; status: 200; result: EmailSendResult }
  | { index: number; status: 429; error: "quota_exceeded"; limit: number; current: number }
  | { index: number; status: 500; error: "send_failed" };

async function emailSendBatch(items: EmailSendInput[]): Promise<{
  items: EmailBatchItemResult[];
}> {
  const { status, body } = await callPlatformService<{ items: EmailBatchItemResult[] }>({
    path: "/services/email/send-batch",
    body: { items },
  });
  if (status === 207) return body;
  throw new Error(
    `platform.email.sendBatch: unexpected status ${status} (${JSON.stringify(body)})`,
  );
}

export const platform = {
  email: { send: emailSend, sendBatch: emailSendBatch },
  QuotaExceeded,
};
```

When `/services/files`, `/services/sms`, `/services/events` ship,
add corresponding methods (`platform.files.upload`, etc.). Same
shape: throw on the one stop signal (quota / fatal), return a result
union for everything else.

### Generator changes

- `platform-ai/subagents/prompts/handler/_core.py` — rewrite the
  service-call section:
  - Drop the `callPlatformService` example block.
  - Drop the 200/429/4xx/5xx response-taxonomy explanation.
  - Replace with: "use `platform.email.send(...)`, catch
    `platform.QuotaExceeded` to stop a loop early, otherwise the
    return tells you whether the email was delivered or was silently
    skipped."
  - One example per available service method.
- Estimated prompt reduction in this section: ~70 lines down to ~25.

### Validation

- Unit tests in `platform-back/templates/handler/__tests__/platform.test.ts`:
  - mock `callPlatformService`, assert `emailSend` returns the right
    union for 200 / 200-with-skip-reason / 5xx, and throws
    `QuotaExceeded` on 429.
  - assert `emailSendBatch` parses 207 correctly.
- Generate one email-using app, diff the call sites — should drop
  ~10 lines each.

## Suggested order

1. Land Change 1 (webhooks). Smaller blast radius, easier to validate.
2. Generate one webhook-archetype app and walk it through the deploy
   pipeline.
3. Land Change 2 (platform SDK). Touches more prompt content.
4. Generate one email-using app, walk it through end-to-end, confirm
   the call sites shrank as expected.
5. Update any example apps in `platform-ai` test fixtures that
   reference the old shapes.

## Out of scope (track separately)

These are tempting smaller wins but should NOT be bundled into this
work — keep the changes focused and reviewable:

- `parseBody(req, Schema)` helper for Zod boilerplate
- `ok()` / `badRequest()` / `forbidden()` response helpers
- `req.customerId` / `req.loggedIn` getters for widget routes
- Shopify 429 backoff wrapper

Each is a 1–2-file addition that can land independently once the
two big promotions are validated.

## Estimated impact

- Prompt tokens for handler generation: ~15–25% reduction overall
  (most gains in the service-call section).
- Generated handler.ts file size on a typical email-using webhook app:
  ~30% smaller.
- Per-call correctness of `/services/*`: type system enforces the
  taxonomy instead of prompt prose; expected reduction in revision-
  agent rounds.
