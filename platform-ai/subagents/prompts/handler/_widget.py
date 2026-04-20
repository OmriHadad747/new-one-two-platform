"""
Widget-routing handler patterns.

Two sibling sections, injected by handler_agent.py's JIT in mutually-exclusive
situations:

- HARNESS_SECTION_WIDGET — when the handler serves backend routes for the
  storefront widget (widgetApiCatalog non-empty). Covers ctx.widgetPath
  routing, ctx.widgetBody destructuring, tenant scoping, and response-shape
  contract adherence.

- HARNESS_SECTION_WIDGET_STOREFRONT — when the widget reads Shopify's public
  storefront API directly via host.storefront (widgetApiCatalog == []) and
  does NOT call the handler. Tells the handler explicitly not to add code
  proxying those reads.
"""

HARNESS_SECTION_WIDGET = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WIDGET ROUTING — this handler receives storefront requests from the widget:

When ctx.trigger === 'widget', the storefront called host.call(path, body).
  ctx.widgetPath — the path the widget called (e.g. '/signup', '/status')
  ctx.widgetBody — the body the widget sent (object)

Rule: Route on ctx.widgetPath inside the widget branch. Always return a value.
  ✅ if (ctx.trigger === 'widget') {
       if (ctx.widgetPath === '/signup') {
         const { customerEmail, variantId, productId } = ctx.widgetBody
         await ctx.db`INSERT INTO ... ON CONFLICT DO NOTHING`
         return { ok: true }
       }
       if (ctx.widgetPath === '/status') {
         const [row] = await ctx.db`SELECT ... WHERE tenant_id = ${ctx.tenantId} AND ...`
         return { status: row ? row.status : 'not_signed_up' }
       }
       return { error: 'unknown path' }
     }
  ❌ if (!ctx.payload || Object.keys(ctx.payload).length === 0) { ... }
     // NEVER use payload emptiness to detect cron or widget — use ctx.trigger

Rule: Use the exact field names from widgetApiCatalog requestShape — the Architect defines
  the contract and both the widget and handler are generated from it. Do not rename fields.

Rule: The widget can only send what host.context provides (variantId, productId, customerId)
  plus user input. IDs not in host.context must be resolved server-side:
  ✅ const { variant } = await ctx.shopify.get(`/variants/${variantId}.json`)
     const inventoryItemId = variant.inventory_item_id

Rule: Widget paths must match the platformApiCatalog exactly.
  The catalog lists every path the widget may call. Do not handle paths not in the catalog.
  Do not invent paths — only handle paths listed in the catalog provided.

Rule: Widget responses are returned directly to the storefront — keep them small and JSON-safe.
  CRITICAL: Return EXACTLY the responseShape from the widget API catalog — never rename fields.
  The widget generator sees the same catalog and checks the exact field names listed there.
  Never return raw DB rows or internal state.
"""

HARNESS_SECTION_WIDGET_STOREFRONT = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WIDGET STOREFRONT READS — widget fetches Shopify public data directly:

The widget uses host.storefront(relativePath) to read public Shopify storefront data
without involving the backend handler. The handler is NOT called for these reads.

  host.storefront(relativePath) → Promise<any>
  Fetches public Shopify storefront endpoints (same-origin, no auth required).
  Common paths:
    '/products/${handle}.js'           → full product JSON including variants[].available
    '/collections/${handle}.js'        → collection with products
    '/cart.js'                         → current cart state

When ctx.trigger === 'widget', the handler only handles host.call() paths from the
widgetApiCatalog. It does NOT handle host.storefront() requests — those go directly
to Shopify. Do not add handler code to proxy storefront data.
"""
