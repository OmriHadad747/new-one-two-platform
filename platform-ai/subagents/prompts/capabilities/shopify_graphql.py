"""
shopify_graphql capability — Shopify Admin GraphQL API via src/lib/shopify.ts.

Per-agent views:
  ARCHITECT — short line for the AVAILABLE capabilities list.
  HANDLER   — full implementation docs injected when declared.
  REVISION  — one-line discipline rule for the revision compact surface.
"""

ARCHITECT = (
    "shopify.graphql(query, variables?) / shopify.graphqlPaginate(query, variables, connectionPath) — "
    "Shopify Admin GraphQL API via the template's src/lib/shopify.ts helper. "
    "Declare for GraphQL mutations (bulk tags, metafields, discountCodeBulkAdd) "
    "or multi-entity joins REST can't express in one call."
)

HANDLER = """\
── Shopify GraphQL ───────────────────────────────────────────

Obtained from the same helper as REST — no separate import:

  import { shopifyClientFor } from "../lib/shopify.js";
  const shopify = shopifyClientFor(req.platform!);

shopify.graphql(query: string, variables?: object) → Promise<any>
  Shopify Admin GraphQL API — POST to /admin/api/<version>/graphql.json.
  The helper throws on GraphQL errors — no need to check result.errors.
  The helper unwraps { data: ... } — access fields directly on the result.
  IDs MUST use Shopify Global ID (GID) format:
    `gid://shopify/<Type>/${numericId}`
    The type name matches the GraphQL schema type: Order, Product,
    Customer, etc. Convert numeric IDs from webhooks and REST responses
    before use in variables.
  Example:
    const { order } = await shopify.graphql(
      `query GetOrder($id: ID!) {
        order(id: $id) {
          id
          fulfillments { trackingInfo { number company } }
          lineItems(first: 50) { nodes { title quantity } }
        }
      }`,
      { id: `gid://shopify/Order/${orderId}` },
    );

WHEN TO USE GraphQL (vs shopify.rest):
  • A mutation has no REST equivalent — bulk tags, metafields, bulk
    discount codes:
      tagsAdd / tagsRemove         — add/remove tags on any resource
      metafieldsSet                — write metafields on orders, products, customers
      discountCodeBulkAdd          — create many discount codes in one call
  • REST would require 2+ sequential calls to assemble the data:
      e.g. getting order + fulfillments + lineItems in one query
  • A cross-entity relationship that REST does not expose as a direct
    field.
  ✅ const result = await shopify.graphql(
       `mutation TagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) { node { id } userErrors { message } }
        }`,
       { id: `gid://shopify/Order/${orderId}`, tags: ['<tag_1>', '<tag_2>'] },
     );

shopify.graphqlPaginate(query, variables, connectionPath) → AsyncGenerator<any[]>
  Async generator over a Relay GraphQL connection. Yields
  `edges.map(e => e.node)` at the given connectionPath per page; walks
  pageInfo.hasNextPage / endCursor internally. Use this for any query
  that may return more than one page.

  REQUIREMENTS of the query:
    • Declare $cursor: String and pass `after: $cursor` on the target
      connection.
    • The connection must request `pageInfo { hasNextPage endCursor }`
      and `edges { node { ... } }`. (The helper pulls nodes out of
      edges.)
  connectionPath is a dot-path into the response that locates the
  connection (e.g. "orders", "customer.orders", "products.variants").

  Example:
    const query = `
      query OrdersByTag($cursor: String, $pageSize: Int!) {
        orders(first: $pageSize, after: $cursor, query: "tag:<tag>") {
          pageInfo { hasNextPage endCursor }
          edges { node { id name createdAt } }
        }
      }`;
    for await (const nodes of shopify.graphqlPaginate(
      query, { pageSize: 100 }, 'orders',
    )) {
      for (const order of nodes) { /* process */ }
    }

  DO NOT hand-roll `do { cursor } while(cursor)` loops over
  shopify.graphql for paged reads — use graphqlPaginate instead.
  DO still use shopify.graphql directly for single-page queries
  (everything-in-first:50 reads, mutations, counts).\
"""

REVISION = (
    "For paginated GraphQL reads use "
    "`for await (const nodes of shopify.graphqlPaginate(query, vars, connectionPath))` — "
    "never hand-roll `do { cursor } while(cursor)` over shopify.graphql."
)
