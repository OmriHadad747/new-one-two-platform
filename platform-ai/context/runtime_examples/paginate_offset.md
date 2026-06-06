# Helper: `paginate`

Use the `paginate` helper for every offset-paginated list route (a GET that
returns a list). It handles input clamping, the `COUNT`, and the response shape
— do NOT write your own `LIMIT`/`OFFSET` or a separate count query.

```ts
import { paginate } from "../lib/paginate.js";
import { sql } from "../lib/db.js";

// Hand paginate a BARE SELECT (no LIMIT, no OFFSET, no COUNT(*); ORDER BY
// required). The helper clamps page>=1 and page_size to [1,100], runs the
// COUNT subquery, and returns the response shape.
const rows = await paginate(
  sql,
  sql`SELECT * FROM <table> WHERE <filters> ORDER BY <col>`,
  { page: req.body.page, page_size: req.body.page_size },
);
res.json(rows); // { items, total, page, page_size }

// Per-route cap override (default cap is 100):
//   await paginate(sql, sql`...`, { page, page_size }, { maxPageSize: 1000 });
```

Rules:
- Request carries `page` and `page_size` (numbers); response is exactly
  `{ items, total, page, page_size }`.
- One bare `SELECT` (no `LIMIT`/`OFFSET`/`COUNT(*)`) handed to `paginate`.
