# Runtime example: `shopify_mutation`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { shopifyClientFor } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!);

const result = await shopify.graphql<{
  tagsAdd: { userErrors: { field: string[] | null; message: string }[] };
}>(
  `mutation AddTags($id: ID!, $tags: [String!]!) {
     tagsAdd(id: $id, tags: $tags) {
       userErrors { field message }
     }
   }`,
  { id: `gid://shopify/Order/${orderId}`, tags: ["vip"] },
);

// userErrors are returned as DATA, not as a thrown exception. A successful
// await is necessary but NOT sufficient — a non-empty userErrors[] means
// Shopify rejected the mutation.
if (result.tagsAdd.userErrors.length > 0) {
  throw new Error(
    `tagsAdd failed: ${result.tagsAdd.userErrors.map((e) => e.message).join("; ")}`,
  );
}
```
