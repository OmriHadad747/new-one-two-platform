# Runtime example: `paginate_offset`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { paginate } from "../lib/paginate.js";
import { sql } from "../lib/db.js";

// The bare SELECT from the LLD's sql_select step (no LIMIT, no OFFSET,
// no COUNT(*)) is wrapped at codegen time. The helper handles input
// clamping (page>=1, page_size in [1,100]), the COUNT subquery, and
// the response shape.
const rows = await paginate(
  sql,
  sql`<your bare SELECT from the sql_select step, ORDER BY required>`,
  { page: req.body.page, page_size: req.body.page_size },
);
res.json(rows); // { items, total, page, page_size }

// Per-route maxPageSize override (when sql_select.purpose hints "max N"):
//   await paginate(sql, sql`...`, { page, page_size }, { maxPageSize: 1000 });
```
