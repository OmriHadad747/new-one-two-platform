## Shopify Ajax API endpoints (host.storefront paths)

Each entry shows the relative path you pass to `host.storefront(path)`, the method, what triggers it, and the fields the response actually carries. The widget's ONLY public Shopify channel is these endpoints — paths NOT listed here are not supported by `host.storefront`.

### cart

- **GET /cart.js** — Get the current cart as JSON.
  response: { token, note, attributes, original_total_price, total_price, total_discount, total_weight, item_count, items, requires_shipping, currency, items_subtotal_price, cart_level_discount_applications }
  items[]: { id, key, title, product_title, variant_title, quantity, price, line_price, original_line_price, total_discount, discounts, sku, vendor, product_id, variant_id, handle, url, image, properties, requires_shipping }

- **POST /cart/add.js** — Add one or multiple variants to the cart.
  body: items*
  response: { items }

- **POST /cart/update.js** — Update line-item quantities, the cart's note, attributes, or apply a discount.
  body: updates, note, attributes, discount
  response: { (complete cart object) }

- **POST /cart/change.js** — Change one existing line item's quantity, properties, or selling plan.
  body: id, line, quantity*, properties, selling_plan
  response: { (complete cart object) }

- **POST /cart/clear.js** — Set all line-item quantities to zero (empty the cart).
  response: { token, note, attributes, total_price, total_weight, item_count, items, requires_shipping }

- **POST /cart/prepare_shipping_rates.json** — Initiate async shipping-rate calculation for an address. Poll cart.async_shipping_rates afterwards.
  query: shipping_address[zip]*, shipping_address[country]*, shipping_address[province]*
  response: { (null body) }

- **GET /cart/async_shipping_rates.json** — Poll for the result of a previously-initiated shipping-rate calculation.
  query: shipping_address[zip]*, shipping_address[country]*, shipping_address[province]*
  response: { shipping_rates }
  shipping_rates[]: { name, presentment_name, code, price, source, delivery_date, delivery_range, delivery_days, phone_required }

- **GET /cart/shipping_rates.json** — Synchronous (throttled) estimate of shipping rates for an address. Prefer prepare/async pair for production.
  query: shipping_address[zip]*, shipping_address[country]*, shipping_address[province]*
  response: { shipping_rates }
  shipping_rates[]: { name, price, delivery_date, source }

### product

- **GET /products/{handle}.js** — Fetch a single product by handle as JSON. Up to 250 variants returned.
  path: handle
  response: { id, title, handle, description, published_at, created_at, vendor, type, tags, price, price_min, price_max, available, price_varies, compare_at_price, compare_at_price_min, compare_at_price_max, compare_at_price_varies, variants, images, featured_image, options, url, requires_selling_plan, selling_plan_groups }
  variants[]: { id, title, option1, option2, option3, options, price, compare_at_price, weight, available, sku, inventory_management, requires_shipping, taxable, barcode, requires_selling_plan, selling_plan_allocations }
  options[]: { name, position }

### recommendations

- **GET /recommendations/products.json** — Fetch products recommended for a given product (related or complementary).
  query: product_id*, limit, intent
  response: { intent, products }

### search

- **GET /search/suggest.json** — Predictive (type-ahead) search across products, collections, pages, articles.
  query: q*, resources[type], resources[limit], resources[limit_scope], resources[options][unavailable_products], resources[options][fields]
  response: { resources }
  resources: { results }
  resources.results: { queries, products, collections, pages, articles }
