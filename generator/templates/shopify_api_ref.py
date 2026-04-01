"""
Static Shopify Admin REST API reference — injected into the CodeSpec agent system prompt.
API version: 2026-01

Use ONLY the endpoints and fields listed here. Do not invent endpoints, query params,
or response fields that are not listed — if something is not here, it does not exist.
"""

SHOPIFY_API_REF = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHOPIFY ADMIN REST API — reference (2026-01)
Use ONLY the endpoints, params, and fields listed here. Do not invent anything not listed.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

── ORDERS ───────────────────────────────────────────────────

GET /orders/:id.json
  → { order: {
        id, email, order_number, financial_status, fulfillment_status,
        created_at, updated_at, cancelled_at, tags,
        customer: { id, email, first_name, last_name, phone, orders_count, total_spent, tags },
        line_items: [{ id, variant_id, product_id, title, quantity, price, sku,
                       variant_title, fulfillment_status, requires_shipping }],
        fulfillments: [{ id, status, tracking_info: { number, url, company },
                         line_items: [...] }],
        billing_address, shipping_address
      } }

GET /orders.json
  Query params: status, financial_status, fulfillment_status, customer_id,
    limit (max 250), fields, created_at_min, created_at_max,
    updated_at_min, updated_at_max
  financial_status values: pending | authorized | partially_paid | paid |
    partially_refunded | refunded | voided
  fulfillment_status values: fulfilled | partial | not_eligible | null
  ⚠ Pagination uses cursor-based Link headers (rel="next") — since_id is deprecated.

POST /orders/:id/fulfillments.json
  Body: { "fulfillment": {
    "line_items_by_fulfillment_order": [{ "fulfillment_order_id": <id> }],
    "tracking_info": { "number": "...", "url": "...", "company": "..." }
  } }

── PRODUCTS ─────────────────────────────────────────────────

GET /products/:id.json
  → { product: {
        id, title, handle, body_html, vendor, product_type, status, tags,
        created_at, updated_at, published_at,
        image: { id, src, width, height, alt } | null,
        images: [{ id, src, position, variant_ids[], alt, width, height }],
        options: [{ id, name, position, values[] }],
        variants: [{ id, product_id, inventory_item_id, title, price,
                     compare_at_price, sku, barcode, position,
                     inventory_quantity, inventory_management, inventory_policy,
                     requires_shipping, weight, weight_unit,
                     option1, option2, option3, image_id }]
      } }

GET /products.json
  Query params: ids (comma-separated, max ~250), limit (max 250), fields,
    collection_id, status (active | draft | archived)
  ⚠ vendor and product_type are NOT supported as query params.

POST /products.json
  Required: title
  Optional: body_html, vendor, product_type, status, tags, variants[], images[], options[]

── VARIANTS ─────────────────────────────────────────────────

GET /variants/:id.json
  → { variant: { id, product_id, inventory_item_id, title, price,
                 compare_at_price, sku, barcode, position,
                 inventory_quantity, inventory_management, inventory_policy,
                 option1, option2, option3, weight, weight_unit,
                 requires_shipping, image_id } }

PUT /variants/:id.json
  Updatable: price, compare_at_price, sku, title, barcode, weight,
    weight_unit, inventory_policy, image_id, option1/2/3
  ⚠ inventory_quantity is READ-ONLY — use POST /inventory_levels/set.json instead.
  ⚠ GET /variants.json does NOT support inventory_item_ids as a query param.

── CUSTOMERS ────────────────────────────────────────────────

GET /customers/:id.json
  → { customer: { id, email, phone, first_name, last_name,
                  orders_count, total_spent, verified_email,
                  accepts_marketing, tags,
                  addresses: [{ id, address1, city, province,
                                country, zip, phone, company }],
                  created_at, updated_at } }

GET /customers/search.json?query=<expr>
  Query syntax examples: "email:bob@example.com", "phone:555-1234", "first_name:Bob"
  ⚠ Use this — NOT /customers.json?email=X (that param does not exist).
  ⚠ Tag filtering is NOT supported in the search query syntax.

PUT /customers/:id.json
  Updatable: email, first_name, last_name, phone, accepts_marketing, addresses[]
  ⚠ tags cannot be updated via REST PUT.

POST /customers.json
  Recommended fields: email, first_name, last_name, phone

── INVENTORY ────────────────────────────────────────────────

GET /inventory_levels.json?inventory_item_ids=<comma-ids>
  → { inventory_levels: [{ inventory_item_id, location_id, available, updated_at }] }
  ⚠ One row per (inventory_item_id × location) pair — NOT a store-wide total.
  ⚠ Sum available across all rows for the same inventory_item_id to get store-wide stock.
  Max 50 ids per request.

GET /inventory_items/:id.json
  → { inventory_item: { id, sku, tracked, requires_shipping, cost } }
  ⚠ NO variant_id field on this object.

POST /inventory_levels/set.json
  Body: { "inventory_item_id": <id>, "location_id": <id>, "available": <int> }
  Sets absolute stock at one location.

POST /inventory_levels/adjust.json
  Body: { "inventory_item_id": <id>, "location_id": <id>, "available_adjustment": <int> }
  Adjusts stock by a delta (positive or negative) at one location.

GET /locations.json
  → { locations: [{ id, name, address1, city, province, country, zip,
                    phone, active, created_at, updated_at }] }

── DISCOUNTS ────────────────────────────────────────────────

POST /price_rules.json
  Body: { "price_rule": {
    "title": "SALE10",
    "target_type": "line_item",       // "line_item" | "shipping_line"
    "target_selection": "all",        // "all" | "entitled"
    "value_type": "percentage",       // "percentage" | "fixed_amount"
    "value": "-10.0",                 // always negative
    "allocation_method": "each",      // "each" | "across"
    "customer_selection": "all",      // "all" | "prerequisite"
    "starts_at": "2026-01-01T00:00:00Z"
  } }
  → { price_rule: { id, title, value_type, value, ... } }

POST /price_rules/:id/discount_codes.json
  Body: { "discount_code": { "code": "SALE10OFF" } }
  → { discount_code: { id, code, created_at } }

── METAFIELDS ───────────────────────────────────────────────

POST /metafields.json
  Body: { "metafield": {
    "namespace": "custom",
    "key": "my_field",
    "value": "some value",
    "type": "single_line_text_field",
    "owner_resource": "product",   // product | variant | order | customer |
    "owner_id": <id>               //   collection | article | page | location
  } }

GET /:resource/:id/metafields.json   (e.g. /products/:id/metafields.json)
  → { metafields: [{ id, namespace, key, value, type, owner_id, owner_resource }] }

PUT /metafields/:id.json
  Body: { "metafield": { "value": "new value" } }

── WEBHOOK TOPICS ───────────────────────────────────────────

Available topics in 2026-01:
  orders/create, orders/updated, orders/cancelled, orders/paid,
  orders/fulfilled, orders/partially_fulfilled,
  products/create, products/update, products/delete,
  customers/create, customers/update, customers/delete,
  inventory_levels/update, inventory_items/update,
  fulfillments/create, fulfillments/update,
  refunds/create, checkouts/create, checkouts/update,
  carts/create, carts/update,
  collections/create, collections/update, collections/delete,
  app/uninstalled,
  customers/data_request, customers/redact, shop/redact  (mandatory compliance)

Key payload fields per topic:
  inventory_levels/update → { inventory_item_id, location_id, available, updated_at }
    ⚠ available is ONE location's quantity — sum across locations for store-wide total.
  orders/create           → { id, email, order_number, financial_status,
                               line_items[], customer{}, created_at }
  customers/create        → { id, email, first_name, last_name, phone, tags, created_at }
  products/update         → { id, title, handle, variants[], status, updated_at }
  fulfillments/create     → { id, order_id, status, tracking_info{}, line_items[] }

── ID TYPES ─────────────────────────────────────────────────

Shopify entity IDs (variant_id, product_id, order_id, customer_id,
  inventory_item_id, location_id, fulfillment_id) are numeric integers.
  Store as BIGINT in Postgres. Never UUID.
  Only tenant_id and internal record primary keys use UUID.
"""
