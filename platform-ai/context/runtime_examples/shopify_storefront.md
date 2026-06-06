# Runtime example: `shopify_storefront`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { shopifyClientFor } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!);

// Public storefront data (uses a separate, public-scoped token minted
// by platform-back at OAuth time).
const data = await shopify.storefront<{
  product: { title: string; handle: string } | null;
}>(
  `query Lookup($handle: String!) {
     product(handle: $handle) { title handle }
   }`,
  { handle: "blue-widget" },
);
```
