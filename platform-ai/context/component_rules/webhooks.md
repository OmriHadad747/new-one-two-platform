# component_rules/webhooks.md

Conventions for Shopify webhook handlers. Read before writing any
webhook code.

## File and shape

One file: `scaffold/src/routes/webhook-handlers.ts`.

Export shape:

```ts
export const webhookHandlers = {
  "orders/paid":      async (payload, req) => { ... },
  "products/update":  async (payload, req) => { ... },
  // one quoted-string key per topic in app.json's webhookTopics
};
```

- Topic strings come EXACTLY from `shopifyIntegration.webhookTopics` in
  `app.json`. No paraphrasing.
- Keys MUST be quoted-string literals in an object literal — not
  bracket-assignment after declaration. The runner's integrity check
  expects the literal form.
- Every topic listed in `app.json` MUST have a matching handler.
  Missing handler fails the integrity check.

## Dispatching by topic — typed key lookup

The template's webhook router dispatches by topic against your
`webhookHandlers` object. Indexing with a bare `string` produces a
`implicit any` tsc error because the object's keys are literal strings
(`"orders/paid" | "products/update" | ...`), not `string`. Type the
lookup key as a member of the map's keys:

```ts
const topic = envelope.topic;  // string from the incoming envelope
const handler = webhookHandlers[topic as keyof typeof webhookHandlers];
if (!handler) {
  res.status(404).json({ error: `no handler for topic ${topic}` });
  return;
}
await handler(envelope.payload, req);
```

The template ships its own dispatch loop, so most apps never write
this directly — but if you do (e.g. test harness, custom router),
this is the only safe pattern.

## Handler signature

```ts
async (payload: SomeTopicPayload, req: Request) => Promise<void>
```

The template's webhook router parses the envelope, verifies the HMAC,
deduplicates against `processed_webhooks`, and invokes your handler
with `(payload, req)`.

Type `payload` against the matching webhook payload type in
`contracts.ts`. Never `unknown` past the signature boundary.

## req.platform is NOT available

`verify-platform` middleware does NOT run on `/webhook`. `req.platform`
is undefined.

```ts
// ❌ throws TypeError at runtime on every delivery
console.log({ requestId: req.platform!.requestId }, "msg");

// ✅ webhook-safe logging
console.log({ topic: "orders/paid", orderId: payload.id }, "received");
```

For Shopify access in a webhook, call `shopifyClientFor()` with NO
argument — the zero-arg overload reads the shop domain from the
envelope. The template handles that automatically.

## Topic selection — list the family, never pick by name

Topic names are often misleading. The verb in a topic's description
matters more than the verb in its name. To avoid name-driven misses,
the system prompt (§7.3) only lists CLUSTER NAMES — the full topic
list with descriptions is fetched on demand.

**Mandatory process — no exceptions:**

1. Identify the resource clusters that could plausibly carry the
   event. For a single event, list MULTIPLE clusters when relevant.
   In Shopify, variants are NESTED inside products in the webhook
   model — variant lifecycle (add/remove/modify) fires
   `products/update`, not `variants/*`. The `variants/*` family is
   stock-state only. So for any variant-related event, list BOTH
   `products` and `variants`.

2. For every candidate cluster, call:
   ```
   list_webhook_family("<prefix>")
   ```
   This returns every topic in that cluster with its description.

3. Compare descriptions side-by-side. The verb, scope, and conditions
   in the description determine what fires — not the name.

4. Pick the topic whose description ACTUALLY matches the event you
   need.

5. Only THEN call `get_webhook_topic(name)` to fetch payload detail
   for the chosen topic.

Never call `get_webhook_topic` on a single name before running
`list_webhook_family` on its cluster. Never pick a topic by name
alone — the cluster index in the system prompt deliberately does NOT
contain enough information to pick from; it only tells you WHERE to
look.

## Payload fields — verify before reading

Before reading `payload.X`, confirm `X` is in the topic's payload via
`get_webhook_topic("topic/name")`. Fields you remember from training
are not authoritative — Shopify webhook payloads vary by topic and
API version.

If `payload.X` might be missing (nullable), check before use:

```ts
const variantGids = payload.variant_gids;
if (!variantGids || variantGids.length === 0) return;  // skip cleanly
```

If `get_webhook_topic` says the field is `nullable: false`, do NOT add
defensive nullability checks — those tend to silently disable behavior
when the field actually arrived.

When the handler needs a Shopify value the payload does NOT carry (the
parent product of an `inventory_item_id`, a live price, a variant's
gid), resolve it with a real follow-up call — read
`runtime_examples/shopify_resolutions.md` for the recipe (e.g. the
inventory_item → variant → product hop). Wrapping a REAL numeric payload
id as `gid://shopify/<Type>/${id}` is correct plumbing; inventing the id
itself is the bug.

## Idempotency

The template's webhook router already deduplicates on
`(topic, delivery_id)` via `processed_webhooks`. Your handler runs
AT MOST ONCE per Shopify delivery — no need to re-implement dedup in
the body.

For business-level idempotency (e.g. don't double-credit on retries
across deliveries with different ids), use `INSERT ... ON CONFLICT
(key) DO NOTHING` against your own table. NEVER `SELECT existing;
if none then INSERT` — that's a race condition.

## Logging

```ts
console.log({ topic: "orders/paid", orderId: payload.id, ...fields }, "msg");
console.warn({ topic, reason }, "skipped");
console.error({ topic, err: String(err) }, "handler failed");
```

Never `req.platform!.requestId` (undefined). Never log full payloads —
log identifying ids only.

## Heavy work belongs in cron

If the handler needs to do >2s of work, push it to a cron job via
`enqueueJob`:

```ts
import { enqueueJob } from "../lib/cron-enqueue.js";

async (payload, req) => {
  await sql`INSERT INTO orders (...) VALUES (...) RETURNING id`;
  await enqueueJob("process_order", { order_id: payload.id }, { dedupKey: payload.id });
  // return; Shopify gets a fast 200
}
```

Shopify retries handlers that take too long. Returning fast and
processing async is the standard pattern.

## Allowed imports

Same as backend (see [backend.md](backend.md)):

- Node 20 builtins
- npm: `express`, `postgres`, `jose`, `google-auth-library`, `@shopify/shopify-api`
- Relative: `../lib/*` (template helpers), `./*` (own modules)
- Types from `../types/contracts.js`
