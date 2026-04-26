# Plan — Handler Invariants & Narrow Specifics

> **For the coding agent**: this doc is the spec. Execute the changes in `subagents/prompts/topics/handler.py`, then deduplicate the moved content from sibling topic files, then add the three narrow specifics to their existing topic/capability files. Verify the validator wiring at the end. No new files in `prompts/` are required.

---

## Goal

The handler prompts today teach correct patterns **inside scoped sections** — `webhook.py:HANDLER` teaches claim-then-act for webhook handlers, `cron.py:HANDLER` teaches it again for cron jobs, `state_machine.py:HANDLER` teaches it again for state transitions. Same idea, three places, scoped to the trigger that imported it.

Result: when the architect declares a combination of triggers (e.g., a cron that sends emails, or a widget POST that mutates state), the model only sees the rule under the trigger section the JIT picked — and may miss it entirely if the JIT didn't fire.

The fix is structural, not new content: **promote the universally-applicable rules into one always-on section in `topics/handler.py:HANDLER`** so every handler prompt sees them regardless of trigger. Then strip the duplicates from the trigger-specific topic files. Each topic file keeps only what is genuinely specific to its trigger.

---

## Step 1 — Add `HANDLER_INVARIANTS` to `topics/handler.py`

Open `platform-ai/subagents/prompts/topics/handler.py`. The file already exports a `HANDLER` constant that is always-injected into the handler agent's prompt. Append a new section to that constant called `HANDLER INVARIANTS` containing the nine rules below. Keep the existing tone (✅/❌ examples, no fluff).

Each rule should appear as one paragraph + one ✅ shape + one ❌ shape.

### Invariant 1 — Idempotency

Any externally-visible side effect (email send, Shopify mutation, third-party API call, queue publish) lives behind an atomic claim. Claim with `UPDATE … RETURNING` first, then act on the returned rows; never act first and mark done after.

```
✅ const claimed = await sql<Row[]>`
     UPDATE notifications SET sent_at = NOW()
     WHERE id = ANY(${ids}) AND sent_at IS NULL
     RETURNING id, recipient_email, payload
   `;
   for (const row of claimed) {
     await platform.email.send({ to: row.recipient_email, data: row.payload });
   }

❌ const rows = await sql`SELECT id, recipient_email FROM notifications WHERE sent_at IS NULL`;
   for (const row of rows) {
     await platform.email.send({ to: row.recipient_email });
     await sql`UPDATE notifications SET sent_at = NOW() WHERE id = ${row.id}`;
     // crash between send and UPDATE → next run re-sends
   }
```

Applies to: webhook handlers, cron jobs, widget POST routes, admin POST routes — every path that may retry.

### Invariant 2 — Scoping

Every SQL operation in a request-driven path filters to the specific entity from the request payload. `search_path` enforces tenant isolation, but inside the schema you must still scope to the right entity.

```
✅ WHERE entity_id = ${payload.id}

❌ WHERE sent_at IS NULL    // unscoped — touches every row in the tenant's table
```

### Invariant 3 — Bulk-fetch (read)

When iterating over N entities and you need Shopify data per-entity, fetch all of it in a single bulk call before the loop begins. Per-item Shopify calls inside loops fail under the cost-based rate limiter.

```
✅ const productMap = new Map<string, Product>();
   for await (const nodes of shopify.graphqlPaginate(query, vars, "products")) {
     for (const n of nodes) productMap.set(String(n.id), n);
   }
   for (const subscriber of subscribers) {
     const product = productMap.get(String(subscriber.product_id));
     // ...
   }

❌ for (const subscriber of subscribers) {
     const product = await shopify.graphql(`{ product(id: "${subscriber.product_id}") { ... } }`);
     // 100 subscribers = 100 calls = throttled
   }
```

### Invariant 4 — Replay survival

Every INSERT must defend against duplicate delivery. Webhooks retry. Cron retries. Use `ON CONFLICT DO NOTHING` for the simple case, `ON CONFLICT … DO UPDATE` for upserts.

```
✅ await sql`
     INSERT INTO subscriptions (email, product_id) VALUES (${e}, ${p})
     ON CONFLICT (email, product_id) DO NOTHING
   `;

❌ await sql`INSERT INTO subscriptions (email, product_id) VALUES (${e}, ${p})`;
   // webhook retry → duplicate row → duplicate notifications later
```

### Invariant 5 — State observation before mutation

For "if X changed, do Y" logic, read the prior state from the DB before deciding. Never compare new payload state to itself; always compare new payload state to the last value persisted.

```
✅ const [prev] = await sql<{availability: boolean}[]>`
     SELECT availability FROM variant_state WHERE variant_id = ${id}
   `;
   const newAvail = (payload.available ?? 0) > 0;
   if (prev?.availability === false && newAvail === true) {
     // 0→1 transition — notify subscribers
   }
   await sql`
     INSERT INTO variant_state (variant_id, availability) VALUES (${id}, ${newAvail})
     ON CONFLICT (variant_id) DO UPDATE SET availability = EXCLUDED.availability
   `;

❌ if ((payload.available ?? 0) > 0) {
     // notifies on every "available" payload, even when stock was already > 0
   }
```

### Invariant 6 — Mutation `userErrors` are failures

Shopify mutations return `userErrors[]` as data, not as thrown exceptions. After every mutation, check `userErrors` and treat non-empty as failure. A successful `await` is necessary but not sufficient.

```
✅ const result = await shopify.graphql(`
     mutation { tagsAdd(id: $id, tags: $t) { userErrors { field message } } }
   `, { id, t });
   const errs = (result as any)?.tagsAdd?.userErrors ?? [];
   if (errs.length > 0) {
     throw new Error(`tagsAdd failed: ${JSON.stringify(errs)}`);
   }

❌ await shopify.graphql(`mutation { tagsAdd(...) { userErrors { ... } } }`);
   // No throw means "succeeded" to the handler, but Shopify may have rejected it.
```

### Invariant 7 — Money is integer cents in BIGINT

Money stored or computed in handlers is integer cents in BIGINT columns — never float, never INTEGER (overflows at $21.47M). Shopify returns prices as decimal strings; parse to integer cents (`Math.round(parseFloat(price) * 100)`) before doing math.

```
✅ const cents = Math.round(parseFloat(payload.total_price) * 100);
   await sql`INSERT INTO order_totals (order_id, total_cents) VALUES (${id}, ${cents})`;

❌ const total = parseFloat(payload.total_price);
   await sql`INSERT INTO order_totals (order_id, total) VALUES (${id}, ${total})`;
   // float drift: 0.1 + 0.2 = 0.30000000000000004 — customer charged the wrong amount
```

### Invariant 8 — Null-defense on payloads

Webhook and widget request payloads are partially typed; fields can be missing or null (guest checkouts, deleted parents, partial fulfillments). Always guard with `?.` and `??`.

```
✅ const customerId = payload?.customer?.id ?? null;
   if (!customerId) return;   // guest checkout — skip

❌ const customerId = payload.customer.id;
   // throws on guest checkouts, deleted customers, or any missing-field event
```

### Invariant 9 — Scale awareness

Match the strategy to N. **Reads:** ≤1000 items via `shopify.graphqlPaginate`; >1000 items via `shopify.bulkQuery` (async bulk operation, JSONL stream). **Writes:** ≤50 items synchronously; >50 items chunked via `enqueueJob` so each cron tick handles a small batch. **No naive long loops** — Cloud Run has hard timeouts; Shopify webhooks have ~5s budgets.

```
✅ Reading 100k orders for a report:
   for await (const order of shopify.bulkQuery(`{ orders { edges { node { ... } } } }`)) {
     // process one order
   }

✅ Creating 500 discount codes from an admin button:
   for (let i = 0; i < 500; i += 25) {
     await enqueueJob("createDiscountChunk", { startIndex: i, count: 25 });
   }
   return res.json({ ok: true, scheduled: 500 });

❌ for (let i = 0; i < 500; i++) {
     await shopify.graphql(`mutation { discountCodeCreate(...) }`);
     // times out long before 500
   }
```

---

## Step 2 — Remove the duplicates from sibling topic files

The rules above currently live, in scattered form, in the files below. Remove the duplicated paragraphs and keep only the trigger-specific content in each file. The handler will see the universal rules from `handler.py:HANDLER`, the trigger-specific files only need to teach what is genuinely unique to their trigger.

### `topics/webhook.py`

Find the `HANDLER` constant. Locate the section titled **"WEBHOOK BODY PATTERNS — atomic side effects, scoping, prefetch"** (around line 410+). Remove the entire block: the replay-survival INSERT rule, the claim-then-act for side effects, the scoping rule, and the bulk-prefetch reference. All four are now covered by Invariants 1, 2, 3, 4.

Keep:
- The `webhookHandlers` map shape and skeleton (the `===FILE: ... ===` example).
- The "topic keys must match plan exactly" rule.
- The "handlers throw to signal failure; never write to `res`" rule.
- The `_TEMPLATE_TABLES_HANDLER` import + injection (template-owned tables guidance).

### `topics/cron.py`

Find the `HANDLER` constant. Remove the per-item-loop rule (around line 42-46), the `ON CONFLICT DO NOTHING` example (around line 92-95), and the claim-then-act reference. All covered by Invariants 1, 3, 4.

Keep:
- The `jobs` map shape and skeleton.
- The cron schedule semantics (how `cronSchedule` becomes a job dispatch).
- The `enqueueJob` discoverability prose if present (this is a useful pointer; only remove if it duplicates the handler-side prose verbatim).

### `topics/state_machine.py`

Find the `HANDLER` constant. Remove the standalone `UPDATE … RETURNING` shape example (around line 64-82). The general claim-then-act idiom now lives in Invariant 1.

Keep:
- The `unknownSentinel` / "null as never-observed" prose (this is state-machine-specific and not covered elsewhere).
- The teaching about `appContracts.stateMachine` declaration shape.
- One short specialization sentence: "When applying Invariant 1 to a state machine, the claim's WHERE clause includes the prior state: `UPDATE … WHERE entity_id = $1 AND state = $prev RETURNING …`. The zero-row return means another path beat you to it — bail."

### `topics/shopify_loop.py`

Find the `HANDLER` constant. Remove the bulk-prefetch handler prose. Now covered by Invariant 3.

Keep:
- The `ARCHITECT` / `ARCHITECT_SHAPE` views (they are architect-side — they describe the `cronBatching` plan field shape; not duplicated in handler.py).

### `topics/handler.py` itself

Search for any `RETURNING`, `ON CONFLICT`, `claim`, or `bulk` prose in the existing `HANDLER` constant **outside** the new `HANDLER INVARIANTS` section you just added. If something is there from before, fold it into the corresponding invariant or delete it as a duplicate. The invariants are the single home now.

---

## Step 3 — Three narrow specifics

These are not principles — they are app-specific structural rules. Each goes in an existing topic/capability file, not a new file.

### 3a — Storefront customer identity → `topics/widget.py:HANDLER`

Append a new subsection to the `HANDLER` constant in `platform-ai/subagents/prompts/topics/widget.py`. Title: **"WIDGET CUSTOMER IDENTITY"**. Content:

> Widget routes are typically unauthenticated — Shopify storefront pages can call them from any browser, including guests. The handler must identify the customer (when one exists) without trusting the widget's claim alone.
>
> The widget reads `window.Shopify.context.customer?.id` on the storefront and includes it in the request body or as a query parameter. The handler treats it as advisory:
>
> - **Logged-in flow**: when `customerId` is present in the request, persist data keyed by `customer_id`. Do not trust the value for cross-tenant access — the platform's verify-platform middleware confirms the request belongs to this tenant; customer-level authorization within the tenant is the handler's responsibility.
>
> - **Guest flow**: when `customerId` is absent, persist data keyed by an anonymous identifier — typically `email` (when collected by the widget) or a client-generated `guest_token` stored in `localStorage` and replayed on every request. Do not refuse the request just because it's a guest unless the feature genuinely requires authentication.
>
> - **Migration**: if a guest later logs in, the next request will carry both the `guest_token` (from `localStorage`) and the `customerId` (from `window.Shopify.context`). The handler should merge — copy the guest's data onto the customer's record and drop the guest row.
>
> ✅ const customerId = (req.body?.customerId ?? null) as string | null;
> ✅ const guestToken = (req.body?.guestToken ?? null) as string | null;
> ✅ if (!customerId && !guestToken) return res.status(400).json({ error: "missing identity" });
> ❌ const customerId = req.body.customerId;   // throws on guest, refuses guests entirely
> ❌ trusting `customerId` for cross-tenant scope (the verify-platform middleware already pins tenant)

### 3b — Settings table requires admin routes → `topics/db_contracts.py:ARCHITECT`

Append a new rule to the `ARCHITECT` constant in `platform-ai/subagents/prompts/topics/db_contracts.py`. The rule:

> **Singleton settings tables MUST be paired with admin routes.** A `dbContract` entry with `singleton: true` (config-style table holding tunable thresholds, schedule cadence, feature toggles) is meaningless without merchant-facing UI to manage it. When you declare such a table, you MUST also declare admin routes to read and update it in `adminApiCatalog`:
>
> - At least one `GET /<resource>/settings`-style route that returns the current row.
> - At least one `PUT` or `POST /<resource>/settings`-style route that updates it (with `requestShape` covering every settable field).
>
> If the merchant never needs to tune the value, do not declare a singleton — hardcode the constant in the handler and skip the table entirely. Do not declare a singleton settings table without the matching admin routes; plan validation fails.

### 3c — Email-metadata sidecar variables → `capabilities/email.py:ARCHITECT_SPEC`

Open `platform-ai/subagents/prompts/capabilities/email.py`. The `ARCHITECT_SPEC` constant feeds the architect prompt as `EMAIL_SPEC`. Verify it already teaches the variable-declaration coupling. If missing, add this rule:

> When the architect declares `email` in `handlerCapabilities` and the handler will send a templated email, the handler must emit an `email-metadata` sidecar (variables list + starterContent block) alongside the bundle. The architect's job here is to ensure `appContracts.handlerMustProduce` lists every variable the email template will consume — concrete keys like `customerName`, `cartUrl`, `cartValueCents`, not vague phrases like "order details."
>
> Each named variable must appear in `handlerMustProduce` so the handler agent knows what to compute. Variables not declared upfront end up rendered as empty strings in the merchant's email tab and the merchant has to file a revision request.

If `ARCHITECT_SPEC` already covers this, no change.

---

## Step 4 — Sanity-check the result

After applying steps 1-3:

1. **Run the existing pytest suite** (`cd platform-ai && python3 -m pytest -v`). All existing tests must still pass — none of them assert prompt prose, so this verifies no Python imports broke.
2. **Print the assembled handler prompt for one of the test apps** and grep for `ON CONFLICT`. It must appear once (in Invariant 4), not three times. Same for `RETURNING`, `claim`, `bulk-fetch`. Single occurrence each.
3. **Diff `topics/webhook.py`, `topics/cron.py`, `topics/state_machine.py`, `topics/shopify_loop.py`** to confirm they shrunk: each lost a paragraph, none gained one.
4. **Read one of the trigger-specific topic files end-to-end** to confirm it still reads as a coherent rule set on its own (i.e., it doesn't reference rules it no longer contains).

---

## Step 5 — Validator wiring check (read-only verification)

Confirm the validator agent always receives the merchant's `qualityBrief` when one exists.

Read `platform-ai/subagents/validator_agent.py` (specifically `_build_prompt` and the surrounding plumbing) and verify:

1. **Producer side**: the codegen orchestrator passes `intent.qualityBrief` (or equivalent) into `CodegenContext` and the validator agent reads it.
2. **Consumer side**: the validator's user prompt includes the `QUALITY_BRIEF_HEADER` block followed by the brief content, **and** appends `PART_B_QUALITY_BRIEF_COVERAGE` to its Part B rubric — both already exist in `prompts/core/validator.py`.
3. **Skip when empty**: when `qualityBrief` is empty/missing, neither block is added (no empty headers).

Expected outcome: all wired, no diff needed. If any of the three is missing, that's the only place a small (≤20-line) plumbing fix is warranted in this changeset; otherwise leave it.

---

## What this changeset does NOT do

- No new files in `prompts/`. Every change is to an existing file.
- No new directory structures (no `patterns/` directory).
- No JIT-trigger plumbing changes — invariants are always-on by virtue of living in `handler.py:HANDLER`.
- No validator code changes (Step 5 is verification only).
- No schema changes, no migrations.

If the agent finds itself creating new files or directories beyond the verified targets, stop and ask.

---

## Order of commits

One commit is fine — the changes are coherent. Suggested message:

> `refactor(prompts): promote handler invariants to handler.py; deduplicate trigger-specific files`
>
> Move 5 universally-applicable rules (idempotency, scoping, bulk-fetch, replay survival, state observation) plus 4 new ones (userErrors as failures, money as integer cents, null-defense, scale awareness) into `topics/handler.py:HANDLER` so every handler prompt sees them regardless of which triggers the architect declared. Remove the duplicates from webhook.py, cron.py, state_machine.py, shopify_loop.py. Add three narrow specifics to their existing topic/capability files: storefront customer identity (widget.py), settings-table coupling (db_contracts.py), email-metadata variable declaration (email.py).
