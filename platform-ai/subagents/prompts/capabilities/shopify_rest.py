"""
shopify_rest capability — Shopify Admin REST API via src/lib/shopify.ts.

Per-agent views:
  ARCHITECT — short line for the AVAILABLE capabilities list.
  HANDLER   — full implementation docs injected when declared.
  REVISION  — one-line discipline rule for the revision compact surface.
"""

ARCHITECT = (
    "shopify.rest.get/post/delete(path, body?) / shopify.rest.paginate(path, query?) — "
    "Shopify Admin REST API via the template's src/lib/shopify.ts helper. "
    "Declare for REST reads or mutations."
)

HANDLER = """\
── Shopify REST ──────────────────────────────────────────────

The template ships src/lib/shopify.ts which wraps @shopify/shopify-api
and returns a per-request client. You import and call it like this:

  import { shopifyClientFor } from "../lib/shopify.js";
  const shopify = shopifyClientFor(req.platform!);

Then four methods are available:

shopify.rest.get(path: string) → Promise<any>
  Shopify Admin REST GET. Path is relative to /admin/api/<version>.
  Example:
    const { orders } = await shopify.rest.get('/orders.json?status=any&limit=10');
  USE FOR: singular fetches (`/orders/<id>.json`), counts
  (`/<resource>/count.json`), small batches whose result fits in one
  page. For multi-page list endpoints use shopify.rest.paginate.

shopify.rest.post(path: string, body: object) → Promise<any>
  Shopify Admin REST POST / PUT. Use for REST mutations. The helper
  routes PUT-style updates through POST — there is no separate PUT
  method.
  Example:
    await shopify.rest.post('/customers/<id>.json', {
      customer: { id: <id>, tags: 'VIP' },
    });

shopify.rest.delete(path: string) → Promise<any>
  Shopify Admin REST DELETE. Returns {} on 204 No Content. Throws on
  non-2xx. Common uses: delete product images, metafields, webhook
  subscriptions, draft orders.
  Example:
    await shopify.rest.delete(`/products/${productId}/images/${imageId}.json`);

shopify.rest.paginate(path: string, query?: object) → AsyncGenerator<any[]>
  Async generator over a REST list endpoint. Yields one page of
  resources per iteration; handles Link-header cursor pagination
  internally. Filter params are applied to the first request only
  (Shopify rejects filter params on cursor follow-ups). Default limit 250.
  Example:
    for await (const batch of shopify.rest.paginate(
      '/orders.json',
      { status: 'any', updated_at_min: since },
    )) {
      for (const order of batch) { /* process */ }
    }
  DO NOT hand-roll `since_id`, `page_info`, `Link`-header parsing, or
  `?page=` loops — the underlying SDK does not expose response headers
  to you, so hand-rolled pagination will be silently broken.

WHEN TO USE REST (vs shopify.graphql):
  • Simple CRUD on a single known entity (fetch order, update customer,
    create fulfillment).
  • Batch fetching one entity type with a batch endpoint
    (/products.json?ids=..., /inventory_levels.json?inventory_item_ids=...).
  • Full-catalog / windowed scans → shopify.rest.paginate.
  • Deleting Shopify resources (product images, metafields, etc.).

REST PUT endpoints use shopify.rest.post() — there is no separate PUT
method.\
"""

REVISION = (
    "For Shopify REST list endpoints use "
    "`for await (const batch of shopify.rest.paginate(path, query))` — "
    "never hand-roll since_id, page_info, Link-header parsing, or ?page= loops."
)
