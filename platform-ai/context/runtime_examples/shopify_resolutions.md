# Runtime example: `shopify_resolutions`

Recipes for the recurring need "given X, get the REAL Shopify Y". Every
id, gid, price, title, code, and availability flag a capability surfaces
must come from one of these resolutions (or from the plan's bound
`shopifySteps` / `payloadBindings`) — never from a constructed string, a
hardcoded default, or a guess.

**Your need isn't listed? Run the DISCOVERY PROCEDURE at the bottom.**
Never fabricate a value and never silently drop a requested feature
because the resolution wasn't obvious.

House style as in the other `shopify_*.md` examples: `shopifyClientFor`
from `../lib/shopify.js`, `shopify.graphql<T>()` for Admin,
`shopify.storefront<T>()` for Storefront, `userErrors` checked as DATA.

---

## Live price for a variant

**Need:** display a current price (per-item price, cart line price, a
computed bundle total).
**Rule:** prices are NEVER stored in your DB — fetch live at request time.
A stored price is stale the moment the merchant edits it. If a widget must
show a total, the backend fetches the real prices and sums them; "we don't
have prices, show something else" is a dropped requirement, not a fallback.
**Call:** Storefront `node(id:)` narrowed to `ProductVariant` (public,
no auth context needed), or Admin `productVariant(id:)`.

```ts
const shopify = await shopifyClientFor(req.platform!);
const data = await shopify.storefront<{
  node: { price: { amount: string; currencyCode: string } } | null;
}>(
  `query VariantPrice($id: ID!) {
     node(id: $id) { ... on ProductVariant { price { amount currencyCode } } }
   }`,
  { id: variantGid }, // a REAL variant gid from a prior call — see next recipe
);
if (!data.node) return; // variant deleted — surface, don't invent a price
const cents = Math.round(parseFloat(data.node.price.amount) * 100);
```

For several variants at once use `nodes(ids: [ID!]!)` — one round trip.

---

## Default variant of a product (the cart needs a VARIANT gid)

**Need:** add a product to the cart, but cart line items take a *variant*
gid, not a product id.
**Gotcha:** a product id wrapped as `gid://shopify/ProductVariant/<id>` is
the canonical fabrication — it type-checks, then `cartLinesAdd` silently
fails. Resolve the real variant first and store/forward THAT gid.
**Call:** Storefront `product(id:)` → first variant.

```ts
const data = await shopify.storefront<{
  product: { variants: { nodes: { id: string; availableForSale: boolean }[] } } | null;
}>(
  `query DefaultVariant($id: ID!) {
     product(id: $id) { variants(first: 1) { nodes { id availableForSale } } }
   }`,
  { id: productGid },
);
const variant = data.product?.variants.nodes[0];
if (!variant) throw new Error(`product ${productGid} has no variants`);
// variant.id is the REAL gid cartLinesAdd / cartCreate accepts.
```

All variants with option names: `variants(first: 100) { nodes { id title
selectedOptions { name value } } }` on the same query.

---

## Variant availability (active ≠ in stock)

**Need:** decide whether a variant can actually be purchased.
**Gotcha:** a product being `ACTIVE` does not mean its variants are
sellable. Check `availableForSale` on the variant (Storefront), which
accounts for inventory policy and stock.

```ts
... on ProductVariant { id availableForSale quantityAvailable }
```

---

## Product display card (title / image / handle)

**Need:** render a product the customer can recognize.
**Rule:** title, image, and handle are Shopify-owned — fetch them live (or
refresh via a `products/update` webhook); never serve a stale stored copy
with no refresh path.
**Call:** Storefront `product(id:)` or `product(handle:)`:

```ts
product(id: $id) { title handle featuredImage { url altText } }
```

`product(handle:)` is also the handle→id resolution when a route receives
a handle from the theme.

---

## Product search by text

**Need:** find products matching free text (an admin picker, a widget
search box).
**Gotcha:** the singular `product` query takes id/handle only — text
search is the PLURAL `products(query:)` connection on either surface.

```ts
const data = await shopify.graphql<{
  products: { nodes: { id: string; title: string }[] };
}>(
  `query Search($q: String!) {
     products(first: 10, query: $q) { nodes { id title } }
   }`,
  { q: searchText },
);
```

---

## Order line items → variant + product ids + quantities

**Need:** an order webhook/capability must know what was bought.
**Rule:** the `orders/*` webhook payload carries `line_items[]` with
`variant_id` / `product_id` / `quantity` — bind those via the plan's
`payloadBindings` first. Fetch via Admin `order(id:)` only for fields the
payload genuinely lacks:

```ts
order(id: $id) {
  lineItems(first: 50) {
    nodes { quantity variant { id } product { id } discountAllocations { allocatedAmountSet { shopMoney { amount } } } }
  }
}
```

---

## Discount: code-based vs automatic (pick ONE model)

**Need:** apply a discount for the customer.
**Gotcha:** an AUTOMATIC discount (`discountAutomaticBasicCreate`) has no
code, so it can never be applied via `cartDiscountCodesUpdate` — Shopify
applies it by itself when conditions match. A shareable/applicable code
requires the CODE-based mutation, and you must store the code string +
gid Shopify returns — never mint a code string locally.

```ts
const result = await shopify.graphql<{
  discountCodeBasicCreate: {
    codeDiscountNode: { id: string; codeDiscount: { codes: { nodes: { code: string }[] } } } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}>(
  `mutation CreateCode($d: DiscountCodeBasicInput!) {
     discountCodeBasicCreate(basicCodeDiscount: $d) {
       codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { codes(first: 1) { nodes { code } } } } }
       userErrors { field message }
     }
   }`,
  { d: discountInput },
);
if (result.discountCodeBasicCreate.userErrors.length > 0) {
  throw new Error(result.discountCodeBasicCreate.userErrors.map((e) => e.message).join("; "));
}
const node = result.discountCodeBasicCreate.codeDiscountNode!;
const realCode = node.codeDiscount.codes.nodes[0].code; // store THIS, plus node.id
```

Reading a discount back from an order: `discount_codes[]` on the order
payload covers code-based; automatic ones appear in
`discount_applications[]` (no code field — don't invent one).

---

## Cart: resolve/create, add real lines, apply a code

**Need:** a storefront widget mutates the customer's cart.
**Rules:**
- Each item is its own `CartLineInput` with a REAL variant gid (see the
  default-variant recipe) — never a merged or placeholder line.
- `cartDiscountCodesUpdate(cartId, discountCodes:)` takes the code STRING
  returned by `discountCodeBasicCreate` — not a gid, not a local constant.
- Theme-embedded widgets can equally use the Ajax Cart API
  (`/cart/add.js` with numeric variant ids) — see `__SHOPIFY_AJAX__` in
  the system prompt; pick one mechanism per flow, don't mix.

```ts
const created = await shopify.storefront<{
  cartCreate: { cart: { id: string; checkoutUrl: string } | null; userErrors: { message: string }[] };
}>(
  `mutation CreateCart($input: CartInput) {
     cartCreate(input: $input) { cart { id checkoutUrl } userErrors { message } }
   }`,
  {
    input: {
      lines: items.map((i) => ({ merchandiseId: i.variantGid, quantity: i.quantity })),
      discountCodes: [realCode], // from discountCodeBasicCreate — never invented
    },
  },
);
```

---

## inventory_item_id → variant → product

**Need:** `inventory_levels/update` webhooks identify stock by
`inventory_item_id`, but your domain works in variants/products.
**Call:** Admin `inventoryItem(id:)` hops to the variant and its product:

```ts
inventoryItem(id: $id) { variant { id product { id title } } }
```

(`id` is `gid://shopify/InventoryItem/<numeric>` built from the payload's
numeric `inventory_item_id` — wrapping a REAL payload value is plumbing,
not fabrication.)

Inventory quantity at a location: `inventoryLevel` under the item's
`inventoryLevels` connection, or bind the payload's own `available` field.

---

## Customer by email → id (may be null)

**Need:** map an email (form input, external event) to a Shopify customer.
**Gotcha:** there may be NO such customer — design the null path (guest
flow), don't synthesize a customer gid.

```ts
customers(first: 1, query: $q) { nodes { id email } }   // q = `email:${email}`
```

Customer signals (tags, order count, total spent) come from the same node:
`{ id tags numberOfOrders amountSpent { amount } }`.

---

## DISCOVERY PROCEDURE (need not covered above)

The catalog tools can resolve ANY "given X get Y" need — the recipes above
are just the worn paths. When your need isn't covered:

1. `search_shopify_ops("<intent keywords>", "<admin|storefront>")` — finds
   ops by name/signature/return-type fields, no cluster guessing
   (e.g. `search_shopify_ops("variant price", "storefront")`).
2. `list_shopify_ops("<cluster>", "<surface>")` on the best hit's cluster —
   see the siblings so you pick the right variant of the op.
3. `get_shopify_op("<name>", "<surface>")` — exact args, return SDL, and a
   worked example. Implement from THAT, in the house style above.

If even discovery finds nothing, the need is probably bound the other way
(a webhook payload field — `list_webhook_family` / `get_webhook_topic`) or
is platform-owned. Surface the gap explicitly (a `do_not` escalation note)
— do NOT hardcode a value, build a fake gid, or quietly drop the feature.
