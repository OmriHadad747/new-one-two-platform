# component_rules/backend.md

Conventions for backend handler files under `scaffold/src/routes/`. Read
this before writing your first widget / admin / webhook / cron handler.

## File layout

Map `httpRoutes` / `webhookTopics` / cron declarations from `app.json` to
exactly these files:

| Source                          | File                              | Export shape                                                  |
|---------------------------------|-----------------------------------|---------------------------------------------------------------|
| `httpRoutes.widget[]`           | `scaffold/src/routes/widget.ts`   | `widgetRouter.<method>("<path>", handler)`                    |
| `httpRoutes.admin[]`            | `scaffold/src/routes/admin.ts`    | `adminRouter.<method>("<path>", handler)`                     |
| `shopifyIntegration.webhookTopics` | `scaffold/src/routes/webhook-handlers.ts` | `export const webhookHandlers = { "<topic>": async (...) => ... }` |
| Cron jobs                       | `scaffold/src/routes/cron.ts`     | `export const jobs = { <jobName>: async (...) => ... }`       |
| Shared logic ≥2 callers         | `scaffold/src/lib/<name>.ts`      | Named exports                                                 |

`widgetRouter` and `adminRouter` are template-shipped. The webhook
router parses the envelope and dispatches by topic against
`webhookHandlers`. Topics MUST appear as quoted-string keys in an object
literal (not bracket-assignment) — the runner's integrity check expects
the literal form.

## Handler signatures

```ts
// /widget and /admin routes — req.platform is set
async (req: Request, res: Response) => Promise<void>

// Webhook handler — payload arrives parsed by the template router
async (payload: WebhookPayloadType, req: Request) => Promise<void>

// Cron job — invoked by the template's cron-runner
async (payload: JobPayloadType) => Promise<void>
```

Type `payload` against the matching shape in `contracts.ts` — never
`unknown` past the signature boundary.

## req.platform — CRITICAL landmine

`req.platform` (set by `verify-platform` middleware) is available ONLY
on `/widget` and `/admin` route handlers.

  - ✅ Route handlers: `req.platform!.tenantId | appId | shopDomain | requestId`
  - ❌ Webhook handlers: middleware does not run; `req.platform` is undefined
  - ❌ Cron handlers: no Express request at all

Reading `req.platform!.<anything>` from a webhook or cron handler throws
`TypeError` on every delivery. For Shopify access in those contexts,
call `shopifyClientFor()` with NO argument — its zero-arg overload reads
the shop domain from the webhook envelope or job payload.

## Logging — structured JSON to stdout

```ts
// Route handler
console.log({ requestId: req.platform!.requestId, ...fields }, "msg");

// Webhook handler — never reference req.platform
console.log({ topic: "<topic>", ...fields }, "msg");

// Cron handler
console.log({ jobName: "<jobName>", dedup_key, ...fields }, "msg");
```

Never log full Shopify payloads or email bodies — log identifying ids
and a one-line summary.

## Database

```ts
import { sql } from "../lib/db.js";

const rows = await sql<BundleRow[]>`
  SELECT id, title, enabled
  FROM bundles
  WHERE id = ${bundleId}
`;

await sql.begin(async (tx) => {
  await tx`INSERT INTO bundles ...`;
  await tx`INSERT INTO bundle_items ...`;
});
```

  - NEVER add a `tenant_id` column to DDL or queries. `search_path` is
    pinned per tenant by the middleware.
  - NEVER schema-qualify table names (`public.bundles`, etc.).
  - For routes whose `httpRoutes` entry has `paginationKind: "offset"`,
    use the `paginate(...)` helper — do not write `LIMIT/OFFSET` or a
    parallel `COUNT(*)` query. See `runtime_examples/paginate_offset.md`.

## Allowed imports

Anything else fails type-check.

  - **Node 20 builtins**: assert, buffer, crypto, events, fs, http,
    https, net, os, path, process, querystring, stream, string_decoder,
    url, util, zlib
  - **npm packages** (template-shipped, exact list):
    `express`, `postgres`, `jose`, `google-auth-library`,
    `@shopify/shopify-api`
  - **Relative imports**: `../lib/*` (template-shipped helpers — see
    §7.2 Platform helpers reference) and `./*` (your own modules under
    `scaffold/src/routes/`)
  - **`contracts.ts`**: import shared types from
    `../types/contracts.js` (note the `.js` extension — TS-emit
    convention)

## Files you do NOT write

These are template-managed; writes are denied by the runner:

```
src/server.ts                  ← rendered from httpRoutes by the runner
src/middleware/verify-platform.ts
src/lib/*.ts                   ← template helpers (db, shopify, platform,
                                 workflow, money, config, paginate, …)
src/migrate.ts
package.json, tsconfig.json, Dockerfile
```

If you find yourself reaching for one of these, you're likely
re-implementing platform logic. Use the relevant library from
`../lib/*.js` instead.

## Picking Shopify GraphQL ops — list the cluster first

The system prompt only contains a CLUSTER INDEX for the Admin and
Storefront GraphQL surfaces, not the full op list. Op names + their
signatures live on disk and are fetched on demand:

  1. From the cluster index in the prompt, identify which cluster(s)
     your feature touches (e.g. "discount", "order", "product").
  2. Call `list_shopify_ops("<cluster>", "admin" | "storefront")` for
     every relevant cluster. This returns every query + mutation in
     that cluster with its full signature, side-by-side.
  3. Compare signatures. A cluster like `discount` has 30+ mutations —
     names are similar (`discountCodeBasicCreate` vs
     `discountAutomaticBasicCreate` vs `discountCodeBxgyCreate`) and
     the input types differ. Pick the one whose semantics match the
     feature.
  4. Call `get_shopify_op(name, surface)` for full SDL + working
     examples.

Never call `get_shopify_op` on an op name you guessed. Never pick
between similar-sounding ops without listing the cluster first.

## Bug-class prevention (production-burned)

These have all caused real outages. Internalize them.

**1. NUL-byte sanitization before DB writes.**
External strings (Shopify titles, user input) sometimes contain ` `.
postgres.js silently aborts the transaction. Strip before insert:
```ts
const safe = raw.replace(/ /g, "");
```

**2. BIGINT id normalization on JS boundaries.**
Shopify returns numeric IDs (`123456789`); Postgres returns strings for
BIGINT columns (`"123456789"`). Using them as Map/object keys without
normalising loses state silently. INSIDE SQL templates DO NOT wrap with
`String()` — postgres.js handles it. OUTSIDE SQL (Map keys, set
membership, joins against DB rows), normalise both sides with `String()`.

**3. Idempotency belongs in the database, not in code.**
Beyond the template's `(topic, delivery_id)` dedup, use:
```ts
await sql`INSERT INTO bundle_purchase_records ... VALUES (...)
  ON CONFLICT (order_external_id, bundle_id) DO NOTHING`;
```
NEVER `SELECT existing; if none then INSERT` — it's a race condition.

**4. NEVER `setTimeout` for retry/backoff around Shopify or platform calls.**
The `shopify.*` and `platform.*` helpers already retry 429/5xx internally
with exponential backoff. Adding your own compounds and cascades timeout
failures. If a call needs to be made later, use `enqueueJob`.

**5. If a route's purpose includes CREATING a Shopify resource
(discount, refund, draft order, fulfillment, etc.), call the
corresponding mutation in the handler and return the resource id.**
Don't return values that imply a resource exists when no mutation
happened (e.g. returning `applied_discount_rate: 1000` to the widget
without calling `discountCodeBasicCreate` first leaves the discount
unreal). Cart/Ajax operations that legitimately run client-side
(adding line items to the customer's session cart) are not in scope
here — this rule is about CREATING the entity, not about where it
gets APPLIED.

**6. NEVER cast `req.query` directly to a typed shape.**
`req.query` is `ParsedQs` (values may be string, string[], or nested).
Validate field-by-field:
```ts
const bundleId = typeof req.query.bundle_id === "string"
  ? (req.query.bundle_id as BundleId)
  : null;
if (!bundleId) { res.status(400).json({...}); return; }
```
`req.query as SomeRequest` hides shape mismatches and breaks at runtime.

**7. SQL results may be empty — guard before accessing.**
The `sql` tagged template returns `T[]`. Destructuring gives you
`T | undefined`:
```ts
// ❌ tsc rejects: `row` is `Row | undefined`
const [row] = await sql<Row[]>`SELECT * FROM bundles WHERE id = ${id}`;
return res.json({ name: row.name });

// ✅ guard, narrow, then use
const [row] = await sql<Row[]>`SELECT * FROM bundles WHERE id = ${id}`;
if (!row) { res.status(404).json({ error: "not found" }); return; }
return res.json({ name: row.name });
```
The same applies to `.find(...)`, `.shift()`, single-row picks from any
`T[]`. NEVER use `!` (non-null assertion) to silence the tsc error —
that just pushes the failure to runtime, where it crashes the handler.
NEVER use `as Row` casts for the same reason.

For aggregate queries like `SELECT COUNT(*)`, you still get an array
with one element — destructure with a default:
```ts
const [countRow] = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM ...`;
const total = parseInt(countRow?.count ?? "0", 10);
```

## Quick reference — platform libs (see §7.2 for full API)

| Lib         | When to import                                       |
|-------------|------------------------------------------------------|
| `sql`       | DB access — every route that touches Postgres        |
| `config`    | App settings — replaces hand-rolled settings tables  |
| `money`     | Currency math — every monetary value the app touches |
| `workflow`  | Multi-state lifecycles (pending → running → done)    |
| `paginate`  | Offset-paginated routes                              |
| `platform`  | email / files / storage SDK                          |
| `shopify`   | Admin + Storefront GraphQL clients                   |
| `enqueueJob`| HTTP route → background work                         |
