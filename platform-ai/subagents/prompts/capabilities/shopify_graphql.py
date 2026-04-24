"""
shopify_graphql capability — Shopify Admin GraphQL API via src/lib/shopify.ts.

Per-agent views:
  ARCHITECT — short line for the AVAILABLE capabilities list.
  HANDLER   — full implementation docs injected when declared.
  REVISION  — one-line discipline rule for the revision compact surface.
"""

ARCHITECT = (
    "shopify.graphql / shopify.graphqlPaginate / shopify.bulkQuery — "
    "Shopify Admin GraphQL API via the template's src/lib/shopify.ts helper. "
    "The only Shopify Admin API surface (REST is not available). Declare for "
    "any handler that reads or writes Shopify resources — queries, mutations, "
    "paginated list reads, or large bulk exports."
)

HANDLER = """\
── Shopify GraphQL ───────────────────────────────────────────

Obtained via `shopifyClientFor`. Call form depends on whether the handler
is on an HTTP request or a cron path:

  import { shopifyClientFor } from "../lib/shopify.js";

  // HTTP path (routes under /admin, /webhook, /widget):
  const shopify = await shopifyClientFor(req.platform!);

  // Cron path (inside a jobs.<name> function — no req available):
  const shopify = await shopifyClientFor();

ALWAYS `await` the call. NEVER construct a context object by hand or use
`as any` — the signature accepts only `undefined` or `req.platform!`.

Rate limiting: the helpers handle Shopify's cost-based throttle
internally (backoff + retry on THROTTLED, preemptive sleep when budget
is low). Handler code makes no cost-field checks and adds no manual
sleeps around Shopify calls.

shopify.graphql(query: string, variables?: object) → Promise<any>
  Single-shot query or mutation — POST to /admin/api/<version>/graphql.json.
  The helper throws on GraphQL errors and strips `{ data: ... }` — access
  response fields directly on the return value.

  IDs MUST use Shopify Global ID (GID) format:
    `gid://shopify/<Type>/${numericId}`
  The type name matches the GraphQL schema type: Order, Product, Customer,
  AbandonedCheckout, etc. Convert numeric IDs from webhook payloads
  before use in variables. NEVER parse or construct GIDs by string-
  splitting — treat them as opaque strings.

  Example (query):
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

  Mutation discipline: always request `userErrors { field message code }`
  and check for non-empty userErrors before treating the call as successful
  — userErrors are NOT thrown; they indicate business-rule failures.

  Example (mutation):
    const result = await shopify.graphql(
      `mutation TagsAdd($id: ID!, $tags: [String!]!) {
         tagsAdd(id: $id, tags: $tags) {
           node { id }
           userErrors { field message code }
         }
       }`,
      { id: `gid://shopify/Order/${orderId}`, tags: ['<tag_1>', '<tag_2>'] },
    );
    const { tagsAdd } = result as { tagsAdd: { userErrors: Array<{ message: string }> } };
    if (tagsAdd.userErrors.length > 0) {
      throw new Error(`tagsAdd failed: ${tagsAdd.userErrors.map(e => e.message).join('; ')}`);
    }

shopify.graphqlPaginate(query, variables, connectionPath) → AsyncGenerator<any[]>
  Async generator over a Relay GraphQL connection. Walks `pageInfo.hasNextPage`
  / `endCursor` internally and yields `edges.map(e => e.node)` at the given
  connectionPath per page. Use this for any query that may return more than
  one page.

  REQUIREMENTS of the query:
    • Declare `$cursor: String` and pass `after: $cursor` on the target
      connection.
    • The connection must request `pageInfo { hasNextPage endCursor }`
      and `edges { node { ... } }`. The helper pulls nodes out of edges.
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

  DO NOT hand-roll `do { cursor } while (cursor)` loops over shopify.graphql
  for paged reads — use graphqlPaginate.
  DO use shopify.graphql directly for single-page queries (everything-in-
  first:50 reads, mutations, counts).

shopify.bulkQuery(query: string) → AsyncGenerator<any>
  Async generator over a Shopify bulk operation result. Starts the bulk
  operation, polls to completion, streams the JSONL result, and yields one
  parsed object per line. Use for:
    • Very large exports (100k+ rows) where paginating would be too slow
      or too costly.
    • List reads where query cost would consume the rate budget entirely.

  The query is a plain GraphQL query string — NOT a mutation. The helper
  wraps it in `bulkOperationRunQuery(query: ...)` internally. Only one
  bulk operation can run per shop at a time; subsequent callers wait.

  Example:
    for await (const item of shopify.bulkQuery(
      `{
         orders(query: "created_at:>2025-01-01") {
           edges { node { id name totalPriceSet { shopMoney { amount currencyCode } } } }
         }
       }`,
    )) {
      const order = item as { id: string; name: string; totalPriceSet: { shopMoney: { amount: string } } };
      /* process one order per iteration */
    }

  DO NOT call bulkQuery from inside a per-item loop — it's the replacement
  for the loop, not an operation inside it. Start one bulk query, iterate
  the results.\
"""

REVISION = (
    "For paginated GraphQL reads use "
    "`for await (const nodes of shopify.graphqlPaginate(query, vars, connectionPath))` — "
    "never hand-roll `do { cursor } while(cursor)` over shopify.graphql. "
    "For very large exports use shopify.bulkQuery(queryString). "
    "Never add manual sleeps/setTimeout around Shopify calls — the helper handles throttle."
)
