"""
Storefront widget prompt sections — injected only for storefront archetypes.
"""

WIDGET_TARGET_TEMPLATES = """\
widgetTargetTemplates: Which Shopify theme template pages this widget is designed to appear on.
  null for backend apps.
  For storefront apps: array of one or more values from:
    "product", "collection", "index", "cart", "page", "blog", "article", "search"
  Choose based on where the widget's UX makes sense:
    - "product"    — widget interacts with a specific product or variant
    - "collection" — widget applies across a set of products on a collection page
    - "cart"       — widget appears at the cart / checkout consideration step
    - "index"      — widget targets the storefront home page
    - "page"       — widget targets a generic content page
    - "blog"       — widget targets the blog listing page
    - "article"    — widget targets an individual blog post page
    - "search"     — widget targets the search results page
  Most apps target a single template. Multi-template is valid when the widget serves the same
  UX purpose across several page types.\
"""

WIDGET_API_CATALOG = """\
widgetApiCatalog: null for backend apps.
  For storefront apps: every route the widget calls via host.call().
  RULES:
  - Each entry contains ONLY these four fields: path, method, requestShape, responseShape.
    Do NOT add description or any other field.
  - path must start with "/"
  - NO path parameters (:id, :slug, etc.) — paths are matched by exact string equality.
    Put identifiers in requestShape instead.
    ✅ { "path": "/record/delete", "requestShape": { "id": "string" } }
    ❌ { "path": "/record/:id",    "requestShape": { "action": "string" } }
  - method: "POST" = mutation or DB write, "GET" = read-only
  - requestShape: fields the widget sends — only data the widget can access (form inputs,
    URL params, customerId/variantId/productId from host.context). NEVER include server-side
    data the handler must fetch; the handler resolves those independently.
  - responseShape: the exact JSON the handler returns on success. Both the widget and
    handler generators implement directly from these field names — mismatches cause runtime failures.\
"""
