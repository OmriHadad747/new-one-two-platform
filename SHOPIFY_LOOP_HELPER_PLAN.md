# Platform-Wide Shopify-Loop (Cron-Batching) Helper — Implementation Plan

## Goal

Collapse the cron-driven Shopify-iteration pattern (bulk-fetch → for_each
→ checkpoint) into a typed `shopifyLoop()` helper. The cron-recipe
boilerplate that R6 (single-bulk-fetch), R10 (no per-item Shopify call),
R14 (continueOnError on side-effect for_each), and R15 (long work in
cron) currently police mostly vanishes — the helper IS the policy.

## Why now

Every cron-driven Shopify-sync recipe today writes the same 7–9-step
shape:

```
shopify_query   bulkQuery / graphqlPaginate over X (R6)
for_each        node:
                  sql_select existing row
                  decision: needs sync?
                    sql_upsert / sql_update
                  log
                continueOnError: true (R14)
                failedItemsBinding
sql_update      checkpoint last_synced_at
log             "synced N of M"
```

The variation is the GraphQL string and the inner per-item write;
everything else is plumbing. R6, R10, R14, and (parts of) R15 exist
specifically to enforce this plumbing — the moment a helper structurally
guarantees it, those rules go away.

## Specification

### Helper API

```ts
import { shopifyLoop } from "../lib/shopify-loop.js";

// Typical incremental-sync pattern.
const summary = await shopifyLoop<OrderNode>({
  job: "sync_orders",                  // checkpoint key (config.app_config)
  shopify,                             // shopify client (passed by cron framework)
  fetch: ({ since }) => shopify.bulkQuery(`
    {
      orders(query: "updated_at:>${since.toISOString()}") {
        edges { node { id name updatedAt } }
      }
    }
  `),
  cursorFromNode: (node) => new Date(node.updatedAt),
  process: async (node) => {
    await sql`INSERT INTO local_orders (...)
              VALUES (...) ON CONFLICT (id) DO UPDATE ...`;
  },
  onError: "continue",                 // | "abort"
});

// summary = {
//   processed: 142,
//   failed: 3,
//   failedItems: [{ node, error }, …],   // capped at 100
//   newCursor: <Date>,
//   durationMs: 12_543,
// }
```

For non-incremental "process every X" loops (rare):
```ts
await shopifyLoop({
  job: "rescan_products",
  shopify,
  fetch: () => shopify.bulkQuery(`{ products { edges { node { id title } } } }`),
  process: async (p) => { … },
  cursorFromNode: null,                // explicit opt-out — no checkpoint
  onError: "continue",
});
```

### Behavior

- **Cursor persistence.** Reads via the existing `config.get(\`__cursor_${job}\`, defaultSince)`;
  writes via `config.set` after successful processing. Keys are prefixed
  `__cursor_` to signal "platform-managed" and so admin "list settings"
  pages can hide them.
- **Streaming.** Iterates nodes one at a time via `for await`; never
  buffers the full bulk result in memory.
- **Per-item try/catch.** When `onError: "continue"`, each iteration
  is wrapped in `try/catch`. Caught errors land in `failedItems` (cap
  100 entries to bound memory; further failures still counted but body
  not retained).
- **`onError: "abort"`** re-throws on the first failure. Items already
  processed remain committed (no cross-row transaction).
- **Cursor advances only past success.** Helper tracks the highest
  cursor value among SUCCESSFUL items; failed items don't push the
  cursor forward. Next tick re-fetches the unprocessed window.
- **No-cursor mode.** When `cursorFromNode` is `null`, no checkpoint is
  read or written. Useful for one-shot rescans triggered ad-hoc.
- **First-run semantics.** When the cursor key is missing,
  `fetch({since})` receives `since = caller-provided default`
  (defaults to the Unix epoch). The GraphQL query decides what "first
  run" means.
- **Bulk vs paginate.** `fetch` is opaque — the helper doesn't care
  whether it returns a `bulkQuery` async-iterable, a `graphqlPaginate`
  iterable, or a plain array. Caller picks per Shopify rules.

### TypeScript signature

```ts
export interface ShopifyLoopArgs<TNode> {
  job: string;                                              // checkpoint key
  shopify: ShopifyClient;                                   // existing client type
  fetch: (ctx: { since: Date }) => AsyncIterable<TNode> | Iterable<TNode> | Promise<Iterable<TNode>>;
  cursorFromNode: ((node: TNode) => Date | string | number) | null;
  process: (node: TNode) => Promise<void>;
  onError?: "continue" | "abort";                           // default "continue"
  defaultSince?: Date;                                      // first-run fallback
  maxFailedItems?: number;                                  // default 100
}

export interface ShopifyLoopSummary<TNode> {
  processed: number;
  failed: number;
  failedItems: Array<{ node: TNode; error: string }>;       // truncated at maxFailedItems
  newCursor: Date | string | number | null;
  durationMs: number;
}
```

## Edge cases

| Case | Handling |
|---|---|
| Cron tick fires before previous tick finished | Cron-runner already serializes via FOR UPDATE SKIP LOCKED — second tick stays pending. No double-loop. |
| Bulk operation still running at tick time (Shopify-side) | `shopify.bulkQuery` already polls until done; if it exceeds maxPollMs, throws → cron records failure → next tick re-fetches with same cursor. Process must be idempotent (sql_upsert). |
| Checkpoint advances past unprocessed items | Helper advances cursor only past SUCCESSFUL items; failed items leave the cursor pinned to the highest success value seen. Next tick re-fetches the unprocessed window. |
| Cursor type other than Date (string ID, integer revision) | `cursorFromNode` returns whatever the caller wants; helper persists as JSON via config.set. |
| First run (no cursor in app_config) | `defaultSince` (caller-supplied; default = Unix epoch). |
| Bulk returns 100k items, processing exceeds Cloud Run timeout (~9 min) | Helper streams item-by-item; long syncs MUST split via more frequent cron ticks. Documented limit; helper does NOT auto-chunk. |
| Per-item write fails | Counted as `failedItem`; cursor doesn't pass it; loop continues (or aborts per `onError`). |
| Per-item Shopify mutation inside `process` rate-limits | `shopify.ts`'s existing retry handles transient 429s; persistent rate-limit throws → `failedItem`. |
| Single bad node poisons the cursor (always-fails) | Operator inspects `failedItems` (returned summary) — can blacklist via app_config (Phase 2 adds `__skip_${job}` key support). |
| Memory blow-up on huge bulk results | Stream node-by-node; `failedItems` capped at 100. |
| Checkpoint key collision across apps | Per-tenant via search_path on app_config; impossible. |
| `onError: "abort"` mid-loop, partial work persisted | Each per-item write commits independently; no cross-row transaction. Documented as expected. Caller wraps outer call in `sql.begin` if atomicity needed (rare). |
| `process` is sync but throws | Caught (try/await covers sync throws too). |
| Caller forgets `cursorFromNode` for an incremental sync | Defaults to `null` → no checkpoint persisted; entire dataset re-processed every tick. Helper logs a `console.warn` ONCE if `defaultSince` was supplied without `cursorFromNode` (likely caller bug). |
| Checkpoint write fails (DB blip) | Per-item writes already committed. Next tick re-processes the same nodes. Caller's `process` MUST be idempotent — sql_upsert with `ON CONFLICT`. Documented as a strict requirement. |
| Caller's `process` mutates the node and recurses (infinite loop) | Out of scope — caller's bug. Helper passes nodes by reference; behavior is JS-standard. |
| `cursorFromNode` returns `null` for a node | Skipped in cursor-tracking but still counted in `processed`. Caller bug; not silently ignored. |
| Helper called outside a cron context (from an HTTP route) | Works mechanically but violates R15 (long work in HTTP). LLD prompt forbids; no runtime guard. |

## Reliability layers

1. **HLD signal:** `incrementalSync: bool` on Capability — set when the
   capability syncs records from Shopify on a recurring schedule.
2. **HLD validator:** keyword cross-check ("sync", "import", "process all",
   "every X minutes") + integration is shopify-admin/storefront.
3. **JIT contract** `SHOPIFY_LOOP_HELPER_CONTRACT` injected into the LLD
   user message when `incrementalSync=true`.
4. **LLD prompt slim:** R6 single-bulk-fetch mandate softens to "use
   shopifyLoop()"; R10 (no per-item Shopify reads) and R14
   (continueOnError) become structural — the helper has no per-item
   Shopify-read step and wraps each iteration in try/catch.
5. **Per-step snippet** `compute_shopify_loop` stamped on compute
   steps whose expression references `shopifyLoop(`.

## Safety

- Single bulk-fetch per tick → Shopify rate-limit naturally respected.
- Streaming → bounded memory regardless of result size.
- Per-item writes commit independently → partial failure doesn't
  rollback already-processed work.
- Checkpoint write atomic via `config.set` upsert.
- Failure summary surfaced to caller — silent failures impossible if
  caller checks the returned `summary`.

## Implementation phases

### Phase 1 — Helper + tests

**Files to author:**
- `platform-back/templates/handler/src/lib/shopify-loop.ts` — helper.
- `platform-back/templates/handler/__tests__/shopify-loop.test.ts`:
  happy path (incremental cursor advances), error path (failedItems
  collected, cursor doesn't pass failed nodes), abort path (re-throws),
  no-cursor path (no checkpoint write), `failedItems` cap honored,
  first-run uses `defaultSince`, checkpoint write via mocked config
  helper.

Both `shopify` (the client) and `sql` are mocked; `config.get`/`config.set`
intercepted via the existing mock pattern.

### Phase 2 — LLD integration

- HLD: add `incrementalSync: bool` + keyword check.
- HLD prompt: document the field.
- LLD prompt: drop R6's mandate, soften R10/R14 in cron context, add
  1-line pointer to JIT.
- LLD agent: `_hld_uses_shopify_loop(plan)` → JIT inject
  `SHOPIFY_LOOP_HELPER_CONTRACT`.
- platform_helpers_prose.py: `SHOPIFY_LOOP_HELPER_CONTRACT`.
- platform_runtime_examples.py: `compute_shopify_loop` snippet
  (replaces the bulk-fetch + for_each pattern).

### Phase 3 — Skip-list (deferred)

A `__skip_${job}` config key the loop reads on each tick to skip
known-bad nodes. Lands when a real app accumulates always-failing
items.

## Sequencing

```
Phase 1 (helper + tests) ─────┐
                              ▼
                    Phase 2 (HLD signal + LLD slim)
                              │
                              ▼
                    Phase 3 (skip-list, when needed)
```

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cloud Run 9-min cap for huge syncs | Documented; cron schedule must be cadenced so each tick has bounded work. Helper does NOT auto-chunk; operator runs cron more frequently for backfills. |
| Always-failing items poison the cursor | `failedItems` summary surfaces them; Phase 3 adds skip-list support. Until then, operator manually inspects + blacklists. |
| `__cursor_*` keys clutter admin "settings" pages | Reserved underscore prefix; document that `config.getAll()` callers SHOULD filter `key.startsWith("__")` for admin display. |
| HLD `incrementalSync` false positives (apps that say "sync" but mean a one-shot import) | Conservative pattern; LLD slack catches misses. |
| Helper hides errors caller wanted to fail loudly | `onError: "abort"` opts in to fail-fast. Default "continue" matches typical batch-processing semantics. |
| Per-item Shopify mutation inside `process` doesn't get retry | shopify.ts already retries 429/throttled; persistent failure throws to `failedItems`. Caller can wrap with custom retry if needed. |
| Checkpoint not advanced when ALL items fail | Intentional — next tick retries the same window. If the failure is systemic, every tick burns the bulk-fetch quota. Operator should investigate via failedItems summary. |
| Helper's checkpoint write fails AFTER per-item writes succeed | Caller's `process` MUST be idempotent (sql_upsert). Documented as a strict precondition; no automatic recovery. |
| Two cron jobs accidentally share the same `job` key | Last-writer-wins on the cursor → both jobs corrupt each other's progress. Document: `job` MUST be unique per cron recipe. |
| Caller's `cursorFromNode` returns inconsistent types across calls | Helper persists via `config.set` (JSON); recovers as JSON. Type drift = caller bug. |

## Success metrics

- Cron-driven sync recipes drop from ~9 LLD steps to ~3 (one compute
  calling shopifyLoop, one log of summary, one return).
- R6 / R10 / R14 vanish from the LLD output for cron syncs (the helper
  structurally enforces them).
- Zero `for_each` steps in cron recipes that wrap a per-item Shopify
  read after Phase 2.

## Estimated scope

| Phase | Effort |
|---|---|
| 1. Helper + tests | 1 day |
| 2. HLD signal + LLD prompt + JIT + snippet | 0.5 day |
| 3. Skip-list (deferred) | 0.5 day (when needed) |
| **Total (Phases 1+2)** | **1.5 working days** |
