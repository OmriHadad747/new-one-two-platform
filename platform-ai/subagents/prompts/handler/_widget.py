"""
Widget-routing handler patterns.

Two sibling sections, injected by handler_agent.py's JIT in mutually
exclusive situations:

- HARNESS_SECTION_WIDGET — when the handler serves backend routes for the
  storefront widget (widgetApiCatalog non-empty). Covers the /widget/:path
  route shape, express path-to-catalog mapping, and response-shape
  contract adherence.

- HARNESS_SECTION_WIDGET_STOREFRONT — when the widget reads Shopify's
  public storefront API directly (widgetApiCatalog == []) and does NOT
  call the handler. Tells the handler explicitly not to add code proxying
  those reads.
"""

HARNESS_SECTION_WIDGET = """
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
     const { <shopify_resource_singular> } = await <shopify_client>.rest.get(
       `/<shopify_resource>/${<shopify_id_col>}.json`,
     );
     const otherId = <shopify_resource_singular>.<other_id_col>;

Response safety: widget responses are returned directly to the
storefront browser. Keep them small and JSON-safe. Never return raw DB
rows that include sensitive columns, stack traces, or internal IDs the
widget doesn't need.
"""

HARNESS_SECTION_WIDGET_STOREFRONT = """
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
