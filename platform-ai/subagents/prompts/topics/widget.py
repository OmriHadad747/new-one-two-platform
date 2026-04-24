"""
Single source of truth for the storefront widget surface.

  ARCHITECT_TEMPLATES  — architect prompt: widgetTargetTemplates declaration rules.
  ARCHITECT_CATALOG    — architect prompt: widgetApiCatalog declaration rules.
  HANDLER              — handler prompt: widget router implementation guide.
  HANDLER_STOREFRONT   — handler prompt: widget reads Shopify directly, no /widget/* routes.
"""

# ── Architect views ────────────────────────────────────────────────────────────

ARCHITECT_TEMPLATES = """\
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

ARCHITECT_CATALOG = """\
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

# ── Architect capabilities view ────────────────────────────────────────────────

ARCHITECT_CAPABILITIES = """\
widgetCapabilities: Closed-vocabulary list declaring which host.* APIs the
  storefront WIDGET uses beyond the always-on host.call(path, body) channel
  to the handler. null for non-storefront archetypes.

  Allowed values: the "Widget client-side APIs" entries in the AVAILABLE
  capabilities list above.

  RULES:
  - MUST be null for backend and backend_admin archetypes — those archetypes
    have no widget, so there are no widget capabilities to declare. Use
    null, not [].
  - Declare "storefront" when the widget reads Shopify public data directly
    via host.storefront (e.g. live variant availability, cart contents).
    The handler does NOT see those reads — do not add handler code to proxy them.
  - Keep the array [] for a storefront app whose widget talks only to the
    handler via host.call — the common case.\
"""

# ── Handler views ──────────────────────────────────────────────────────────────

HANDLER = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WIDGET ROUTER — src/routes/widget.ts

Requests arrive from storefront widgets via the Shopify App Proxy.
platform-back has verified the App Proxy HMAC signature by the time your
router runs; `req.platform` is populated (tenantId, shopDomain, etc.).

Widget calls are typically UNAUTHENTICATED from the customer's
perspective — there's no logged-in shopper identity. Any per-shopper
state (cart, recently-viewed, etc.) must be derived from payload
params, not from a session this handler holds.

File skeleton:

  import { Router } from "express";
  import { sql } from "../lib/db.js";

  export const widgetRouter = Router();

  widgetRouter.post("/<path_1>", async (req, res) => {
    // ... route body
  });

  widgetRouter.post("/<path_2>", async (req, res) => {
    // ... route body
  });

CRITICAL: Every path listed in the architect's widgetApiCatalog MUST
have a matching widgetRouter route with the exact method and path. Do
not invent paths not in the catalog — the widget JS generator sees the
same catalog and only calls paths the architect declared.

  If the catalog declares `POST /<path>` with
  requestShape { <field_1>, <field_2> } and
  responseShape { <res_field_1>, <res_field_2> }, emit:

    widgetRouter.post("/<path>", async (req, res) => {
      const { <field_1>, <field_2> } = req.body;
      // ... validate, insert, etc.
      res.json({ <res_field_1>: ..., <res_field_2>: ... });
    });

  Use the EXACT field names from requestShape — no renaming. Return
  EXACTLY the responseShape — no extra fields, no rewraps.

Shopper-sourced fields: the widget can only send what
window.Shopify.context provides (variantId, productId, customerId) plus
user input. IDs NOT in that context must be resolved server-side from
what IS there:
  ✅ // widget only sends <shopify_id_col>; you resolve <other_id_col> server-side:
     const data = await <shopify_client>.graphql(
       `query Get<Type>($id: ID!) { <shopify_resource_singular>(id: $id) { <other_id_col> } }`,
       { id: `gid://shopify/<Type>/${<shopify_id_col>}` },
     ) as { <shopify_resource_singular>: { <other_id_col>: string } };
     const otherId = data.<shopify_resource_singular>.<other_id_col>;

Response safety: widget responses are returned directly to the
storefront browser. Keep them small and JSON-safe. Never return raw DB
rows that include sensitive columns, stack traces, or internal IDs the
widget doesn't need.
"""

HANDLER_STOREFRONT = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WIDGET READS SHOPIFY STOREFRONT DIRECTLY — no /widget/* routes

The widget JS reads public Shopify storefront data directly from the
shopper's browser (/products/<handle>.js, /cart.js, etc.) without
involving the handler. The handler does NOT receive /widget/* calls for
this app.

Do NOT emit a src/routes/widget.ts file. The template's widget.ts
(which serves a ping example) will remain and stay unreachable — that
is the intended outcome; the deployer doesn't remove untouched template
files.

If you emit src/routes/widget.ts anyway, static validation will reject
it — the architect declared `widgetApiCatalog: []`, which means the
widget is NOT a client of this handler.
"""
