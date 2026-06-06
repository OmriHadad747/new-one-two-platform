# Runtime example: `shopify_graphql`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { shopifyClientFor, ShopifyRateLimitError } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!); // cron path: shopifyClientFor()

const data = await shopify.graphql<{
  order: { id: string; name: string; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } } | null;
}>(
  `query GetOrder($id: ID!) {
     order(id: $id) {
       id
       name
       totalPriceSet { shopMoney { amount currencyCode } }
     }
   }`,
  { id: `gid://shopify/Order/${orderId}` },
);

if (!data.order) return; // deleted / not visible

// Money — Shopify returns decimal strings; persist as integer minor units.
const amountCents = Math.round(parseFloat(data.order.totalPriceSet.shopMoney.amount) * 100);
```
