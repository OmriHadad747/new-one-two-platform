# Runtime example: `shopify_bulk_query`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { shopifyClientFor } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!);

// Bulk-op constraints (Shopify rules):
//   - SINGLE top-level connection field
//   - ≤5 connections total, ≤2 levels of nesting
//   - nested connections take NO first/last/before/after/sortKey/query args
//
// Yields one parsed JSONL object per line. Use for 100k+ rows, or list
// reads where per-page graphql cost would be prohibitive.

for await (const node of shopify.bulkQuery(
  `{
     orders {
       edges { node { id name createdAt } }
     }
   }`,
)) {
  const o = node as { id: string; name: string; createdAt: string };
  // process one order
}

// Per-call timeout override:
//   shopify.bulkQuery(query, { maxPollMs: 30 * 60_000 })  // 30 min
```
