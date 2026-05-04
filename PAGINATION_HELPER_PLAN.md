# Platform-Wide Pagination Helper — Implementation Plan

## Goal

Eliminate per-recipe pagination boilerplate by shipping a typed
`paginate()` helper from the handler template. Every list-returning
admin / widget route uses one call instead of hand-rolling
`LIMIT/OFFSET`, `COUNT(*)`, page math, and the response shape.

## Why now

Today every list route is ~4 LLD steps:
1. `sql_select` rows with `LIMIT $page_size OFFSET $offset`
2. `sql_select` total count via `SELECT COUNT(*)`
3. `compute` page / page_size math
4. `response` with `{ items, total, page, page_size }`

Plus the recipe must do `compute` to derive `offset = (page - 1) *
page_size`, validate inputs, etc. Same boilerplate per app per route.
The shape never varies; only the underlying query does. Perfect
candidate for a platform helper.

## Specification

### Wire shape (response)

```ts
interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
```

Cursor variant (Phase 2 — see below):

```ts
interface CursorPaginatedResponse<T> {
  items: T[];
  next_cursor: string | null;     // null = end of stream
  page_size: number;
}
```

### Helper API

```ts
// Offset pagination (the common case)
import { paginate } from "../lib/paginate.js";

const result = await paginate(
  sql,
  sql`SELECT id, name, created_at FROM rules WHERE deleted_at IS NULL ORDER BY updated_at DESC`,
  { page: req.body.page, page_size: req.body.page_size }
);
res.json(result);
// result = { items: [...], total: 42, page: 1, page_size: 20 }
```

### Behavior

- **Input validation:** clamp `page` to `>=1`, clamp `page_size` to
  `[1, 100]` (configurable cap; rejecting hostile callers asking for
  10000 rows is a feature). Defaults: `page=1, page_size=20`.
- **Total count:** wraps the supplied query in
  `SELECT COUNT(*) FROM (<query>) AS _count` once per call. Two
  round-trips: count + page.
- **Empty page:** returns `{ items: [], total: <n>, page, page_size }`
  not 404 — caller decides how to render an empty state.
- **Out-of-range page:** `page * page_size > total` returns empty
  items; same semantics as last page being short.
- **Order-by required:** Postgres LIMIT without ORDER BY is
  non-deterministic. The helper assumes the supplied query has its
  own ORDER BY — if the caller forgets, results are unpredictable but
  the helper does not error (it's the caller's responsibility, same
  as `sql.begin`).
- **No JOIN special-casing:** the helper treats the supplied SQL as a
  black-box subquery for COUNT purposes. Complex queries with GROUP
  BY may need to use a different shape — escape hatch:
  `paginate.fromSubquery(...)` accepts a precomputed `(rows, total)`
  pair.

### TypeScript signature

```ts
export interface PaginateInput {
  page?: number | string;          // tolerated as string; helper coerces
  page_size?: number | string;
}

export async function paginate<T>(
  sql: SqlInstance,
  baseQuery: PendingQuery<T[]>,
  input: PaginateInput
): Promise<PaginatedResponse<T>>;
```

`PendingQuery` is the postgres.js return type from a tagged-template
call that hasn't been awaited yet.

### Cursor variant (Phase 2)

For unbounded keyset pagination over append-mostly tables (e.g. event
logs, run history) where OFFSET cost grows with page depth.

```ts
const result = await paginate.cursor(
  sql,
  ({ cursor, limit }) => sql`
    SELECT id, run_id, started_at FROM rule_runs
     WHERE started_at < ${cursor ?? "infinity"}
     ORDER BY started_at DESC LIMIT ${limit}
  `,
  { cursor: req.query.cursor, page_size: req.query.page_size },
  (lastRow) => lastRow.started_at.toISOString()  // cursor extractor
);
// result = { items, next_cursor, page_size }
```

The cursor extractor is application-level — it's the only piece the
helper can't infer.

## Implementation phases

### Phase 1 — Offset helper (the 80% case)

**Files to author:**
- `platform-back/templates/handler/src/lib/paginate.ts` —
  the offset implementation + input validation.

**Files to modify:** none. Pure addition.

### Phase 2 — Cursor helper (deferred)

Same file, adds `paginate.cursor(...)`. Land only when a real app
needs it.

### Phase 3 — LLD integration

**Files to modify:**
- `platform-ai/subagents/lld_agent/schema.py` — add a new
  `HttpRoute.paginationKind` value `"offset"` is already there;
  no schema change needed. The helper substitution is a codegen
  concern, not LLD.
- `platform-ai/subagents/lld_agent/prompt.py` — replace the existing
  guidance about hand-rolling list response shape with:

  > "When `paginationKind: 'offset'`, the recipe MUST collapse all
  >  list-fetch logic into a SINGLE `sql_select` step that returns
  >  the helper's input query (no `LIMIT`, no `OFFSET`, no
  >  `COUNT(*)`). The codegen wraps the query with `paginate()` from
  >  `../lib/paginate.js` automatically. Do NOT emit separate count
  >  queries or page math compute steps."

- Add an LLD validator: when a recipe has a route with
  `paginationKind: "offset"`, reject if the recipe contains more
  than one `sql_select` whose template references the same primary
  table or contains the substring `COUNT(*)`. Keeps the model from
  duplicating the helper's job.

**Files to modify (codegen):**
- The handler codegen prompt (when we get there) needs a one-line
  dispatch: when `paginationKind="offset"`, wrap the recipe's
  sql_select PendingQuery in `await paginate(sql, query, ...)` and
  emit `res.json(result)` directly instead of emitting a separate
  response step. Until the codegen is rewritten, the LLD continues
  to emit the response step explicitly using the helper's shape.

### Phase 4 — Documentation

**Files to author / modify:**
- `docs/PAGINATION_HELPER.md` — public contract for app authors and
  the LLD prompt to reference.
- Update `docs/HANDLER_RUNTIME_REFERENCE.md` (or wherever handler
  imports are listed) to include `import { paginate }`.

## Sequencing

```
Phase 1 (helper + tests) ─────────────┐
                                      ▼
                            Phase 3 (LLD prompt update)
                                      │
                                      ▼
                            Phase 4 (docs)
                                      │
                                      ▼
                          Phase 2 (cursor helper, when needed)
```

No coordinated rollout required.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Caller's query has GROUP BY / window functions and the COUNT wrap is wrong | Document the limitation; provide `paginate.fromSubquery({ rows, total })` escape hatch |
| Slow COUNT on huge tables | Cursor pagination (Phase 2) avoids COUNT entirely. For tables expected to grow >100k rows, the LLD prompt should prefer cursor over offset |
| Page-size cap (100) too low for export-style admin pages | Two options: bump the cap globally, or add a per-route `maxPageSize` parameter. Default 100 is conservative; revisit when a real use case arrives |
| LLD continues writing manual COUNT queries despite the rule | Validator rejects (Phase 3); fail fast |

## Success metrics

- Average list-route LLD recipe drops from ~7 steps to ~3 steps.
- Zero recipes contain `SELECT COUNT(*)` after Phase 3 lands.
- No production incidents from clients sending `page_size=10000`
  (clamping holds).

## Estimated scope

| Phase | Effort |
|---|---|
| 1. Offset helper | 0.5 day |
| 2. Cursor helper | 0.5 day (when needed) |
| 3. LLD prompt + validator | 0.5 day |
| 4. Docs | 0.5 day |
| **Total (Phases 1+3+4)** | **1.5 working days** |
