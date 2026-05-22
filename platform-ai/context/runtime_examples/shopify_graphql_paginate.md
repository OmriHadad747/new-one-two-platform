# Runtime example: `shopify_graphql_paginate`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { shopifyClientFor } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!);

// Query MUST declare $cursor: String and pass it to `after:`.
// The helper supplies the cursor on each iteration; you yield page-of-nodes.
const dataMap = new Map<string, { id: string; name: string; createdAt: string }>();

for await (const nodes of shopify.graphqlPaginate(
  `query Recent($cursor: String) {
     orders(first: 250, after: $cursor, query: "created_at:>2026-01-01") {
       pageInfo { hasNextPage endCursor }
       edges { node { id name createdAt } }
     }
   }`,
  {},
  "orders",          // connectionPath — where pageInfo/edges live
)) {
  for (const n of nodes as Array<{ id: string; name: string; createdAt: string }>) {
    dataMap.set(String(n.id), n);   // String() on both sides when joining vs DB rows
  }
}
```
