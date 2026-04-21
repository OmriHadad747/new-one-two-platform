"""
Cross-capability decision rule — injected by the handler JIT only when BOTH
shopify_rest AND shopify_graphql are declared. Not a capability surface (no
opt-in declaration of its own), so it lives here alongside the other topics
rather than in subagents/prompts/capabilities/.
"""

HANDLER = """\
── Shopify REST vs GraphQL — which to pick ──────────────────

This handler uses BOTH REST and GraphQL. Pick per call:
  • Simple CRUD on a single known entity → REST (shopify.rest.get / post / delete)
  • Bulk tag / metafield mutation, cross-entity join, no-REST-equivalent op → GraphQL mutation (shopify.graphql)
  • Full-catalog / windowed scan of a single resource → shopify.rest.paginate (REST Link-cursor pagination)
  • Paged cross-entity read that needs a GraphQL join → shopify.graphqlPaginate
Exact pagination patterns and examples are documented in the individual
shopify_rest and shopify_graphql sections above. Never hand-roll
pagination loops — use the paginate helpers.\
"""
