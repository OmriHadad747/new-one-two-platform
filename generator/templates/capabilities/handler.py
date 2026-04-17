"""
Handler capability registry.

Every app has a handler (Node.js module running on the platform). The
architect declares `handlerCapabilities`, and the handler JIT assembles the
handler prompt by concatenating:

  1. HARNESS_CORE — always-shipped: DB, trigger routing, logger, output
     format, absolute rules, cross-cutting Shopify loop rule.
  2. Capability.docs for every entry listed in handlerCapabilities.
  3. Any conditional sections gated on trigger presence (webhook / cron
     batching / widget routing / admin routing / state machine / REST+GraphQL
     joint decision guide).

Adding a new handler capability is a single edit to the relevant registry
below — the architect's AVAILABLE list, the validator's allowed set, and
the handler JIT all pick it up automatically.
"""

from __future__ import annotations

from collections import OrderedDict

from ._types import Capability


# ─── Handler platform services (ctx.*) ────────────────────────────────────────

HANDLER_SERVICES: "OrderedDict[str, Capability]" = OrderedDict(
    [
        (
            "shopify_rest",
            Capability(
                short="ctx.shopify.get / post / delete — Shopify Admin REST API at /admin/api/2026-01. Declare when the handler reads or mutates Shopify data via REST.",
                docs="""\
── Shopify REST ──────────────────────────────────────────────

ctx.shopify.get(path: string) → Promise<any>
  Shopify Admin REST GET. Path is relative to /admin/api/2026-01.
  Example: await ctx.shopify.get('/orders.json?status=any&limit=10')

ctx.shopify.post(path: string, body: object) → Promise<any>
  Shopify Admin REST POST/PUT. Use for REST mutations.
  Example: await ctx.shopify.post('/customers/456.json', { customer: { id: 456, tags: 'VIP' } })

ctx.shopify.delete(path: string) → Promise<any>
  Shopify Admin REST DELETE. Use to remove Shopify resources.
  Example: await ctx.shopify.delete(`/products/${productId}/images/${imageId}.json`)
  Returns {} on 204 No Content. Throws on non-2xx responses.
  Common uses: delete product images, metafields, webhook subscriptions, draft orders.

WHEN TO USE REST (vs ctx.shopify.graphql):
  • Simple CRUD on a single known entity (fetch order, update customer, create fulfillment)
  • Batch fetching one entity type with a batch endpoint (/products.json?ids=...,
    /inventory_levels.json?inventory_item_ids=...)
  • Full-catalog scans — use since_id cursor pagination (see below)
  • Deleting Shopify resources (product images, metafields, etc.)

REST full-catalog pagination — ALWAYS use since_id cursor (NOT Link headers):
  The ctx.shopify.get response does NOT expose HTTP headers — Link header parsing will always fail.
  Use since_id for reliable full-catalog traversal of products, orders, customers, etc.:
  ✅ let sinceId = 0;
     while (true) {
       const { products } = await ctx.shopify.get(
         `/products.json?fields=id,images&limit=250&since_id=${sinceId}`
       );
       if (!products || products.length === 0) break;
       // process batch
       sinceId = products[products.length - 1].id;
       if (products.length < 250) break;  // last page
     }
  ❌ response._headers['link'] — headers are NOT available from ctx.shopify.get
  ❌ /products.json without limit — returns at most 50 (Shopify default), silently truncated

REST PUT endpoints use ctx.shopify.post() — there is no separate PUT method.\
""",
            ),
        ),
        (
            "shopify_graphql",
            Capability(
                short="ctx.shopify.graphql — Shopify Admin GraphQL API. Declare when the handler issues GraphQL queries or mutations (bulk tags, metafields, discountCodeBulkAdd, or joins across entities).",
                docs="""\
── Shopify GraphQL ───────────────────────────────────────────

ctx.shopify.graphql(query: string, variables?: object) → Promise<any>
  Shopify Admin GraphQL API — POST to /admin/api/2026-01/graphql.json.
  The harness throws on GraphQL errors — no need to check result.errors.
  The harness unwraps { data: ... } — access fields directly on the result.
  IDs MUST use Shopify Global ID (GID) format: `gid://shopify/TypeName/${numericId}`
    The type name matches the GraphQL schema type: Order, Product, Customer, etc.
    Convert numeric IDs from webhooks and REST responses before use in variables.
  Example:
    const order = await ctx.shopify.graphql(
      `query GetOrder($id: ID!) {
        order(id: $id) {
          id
          fulfillments { trackingInfo { number company } }
          lineItems(first: 50) { nodes { title quantity } }
        }
      }`,
      { id: `gid://shopify/Order/${orderId}` }
    )
    const { fulfillments, lineItems } = order.order

WHEN TO USE GraphQL (vs ctx.shopify.get/post):
  • A mutation has no REST equivalent — bulk tags, metafields, bulk discount codes:
      tagsAdd / tagsRemove             — add/remove tags on any resource
      metafieldsSet                    — write metafields on orders, products, customers
      discountCodeBulkAdd              — create many discount codes in one call
  • REST would require 2+ sequential calls to assemble the data you need:
      e.g. getting order + fulfillments + lineItems in one query
  • A cross-entity relationship that REST does not expose as a direct field
  ✅ const result = await ctx.shopify.graphql(
       `mutation TagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) { node { id } userErrors { message } }
        }`,
       { id: `gid://shopify/Order/${orderId}`, tags: ['VIP', 'high-value'] }
     )

GraphQL cursor-based pagination — use this pattern when a query can return more
than a page of results (typical first: 50, max first: 250). Loop on
pageInfo.hasNextPage / endCursor until there are no more pages:

  ✅ const PAGE_SIZE = 250
     const collected = []
     let cursor = null
     do {
       const result = await ctx.shopify.graphql(
         `query OrdersByTag($cursor: String, $pageSize: Int!) {
            orders(first: $pageSize, after: $cursor, query: "tag:backorder") {
              pageInfo { hasNextPage endCursor }
              nodes { id name createdAt }
            }
          }`,
         { cursor, pageSize: PAGE_SIZE }
       )
       collected.push(...result.orders.nodes)
       cursor = result.orders.pageInfo.hasNextPage ? result.orders.pageInfo.endCursor : null
     } while (cursor)
  ❌ Running one query with first: 50 and assuming the response is complete —
     stores with many matches will silently miss records beyond the first page.\
""",
            ),
        ),
        (
            "email",
            Capability(
                short="ctx.services.email.send — merchant-configured email templates (subject / body / CTA owned by the platform; handler only passes `to` and `data` variables).",
                docs="""\
── ctx.services.email.send ───────────────────────────────────

ctx.services.email.send({ to, data? }) → Promise<void>
  Send an email via the platform's email service.

  The handler ONLY provides the recipient and runtime variables. The platform
  owns everything else — subject, body, brand, layout, from address, delivery,
  tracking, unsubscribe. The merchant configures the template (subject, body,
  CTA, brand) in the Ton dashboard's Email tab; any {{variable}} placeholders
  they put in those fields are resolved against `data` at send time.

    to:    recipient email address (string)
    data:  optional variables bound to {{variable}} placeholders in the
           merchant-configured template. Include whatever dynamic values the
           merchant will want to reference: customer name, order ID, product
           title, URLs, amounts, etc.

  DO NOT pass `subject`, `templateId`, or HTML — those fields no longer exist
  on the API. DO NOT store email HTML in your app's DB tables or compile
  templates with Handlebars inside the handler — the platform does all of that.

  The variable names you pass in `data` become the token palette shown to the
  merchant in the Email tab, so use descriptive names (customerName, cartTotal,
  recoveryUrl) rather than single letters. All `data` keys MUST be camelCase —
  never snake_case or PascalCase. The merchant references them as {{camelCase}}
  in the template.

  Example:
    await ctx.services.email.send({
      to: cart.customerEmail,
      data: {
        customerName: cart.customerName,
        cartTotal:    cart.total,
        currency:     cart.currency,
        recoveryUrl:  cart.recoveryUrl,
      },
    })

  The merchant-configured template might then read:
    Subject: "{{customerName}}, your cart is waiting"
    Body:    "Come back and finish your order — {{cartTotal}} {{currency}}."
    CTA:     "Return to checkout" → {{recoveryUrl}}

  Deploy is blocked on apps that call ctx.services.email.send until the merchant
  has saved the Email tab at least once. That's by design — uncustomized emails
  would look generic and hurt the merchant's brand.\
""",
            ),
        ),
        (
            "sms",
            Capability(
                short="ctx.services.sms.send — outbound SMS to E.164 phone numbers.",
                docs="""\
── ctx.services.sms.send ─────────────────────────────────────

ctx.services.sms.send({ to, body }) → Promise<void>
  Send an SMS. Stub in MVP (logs SMS_SENT) — real Twilio in Phase 3.
    to:   E.164 phone number, e.g. "+15551234567"
    body: message text (max 160 chars)
  Example: await ctx.services.sms.send({ to: customer.phone, body: `Your order is ready!` })\
""",
            ),
        ),
        (
            "files",
            Capability(
                short="ctx.services.files.upload — generate a file (CSV / PDF / XLSX / ZIP / image) and return a signed download URL.",
                docs="""\
── ctx.services.files.upload ─────────────────────────────────

ctx.services.files.upload(name, content, mimeType?) → Promise<string>
  Upload a file and get back a URL. Stub in MVP (logs FILE_UPLOADED) — real GCS in Phase 3.
  Returns a signed URL valid for 1 hour (stub returns a placeholder URL).
    name:     filename, e.g. "orders-2024-01.csv"
    content:  Buffer or string
    mimeType: e.g. "text/csv", "application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  Example:
    const url = await ctx.services.files.upload('orders.csv', csvString, 'text/csv')
    return { downloadUrl: url }\
""",
            ),
        ),
        (
            "http",
            Capability(
                short="ctx.http.call — outbound HTTPS to third-party REST APIs. Declare only when the handler integrates with a non-Shopify service.",
                docs="""\
── ctx.http.call ─────────────────────────────────────────────

ctx.http.call(url, options?) → Promise<any>
  Make an authenticated HTTP call to an external API. All calls are logged with tenant context.
    url:            full URL (https:// is ALLOWED here — ctx.http is the only place)
    options.method: HTTP method (default "GET")
    options.headers: additional headers
    options.body:   request body — serialized to JSON automatically
  Throws on non-2xx responses.
  Example:
    const result = await ctx.http.call('https://api.example.com/compress', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer TOKEN' },
      body: { imageUrl: originalUrl }
    })\
""",
            ),
        ),
        (
            "storefront",
            Capability(
                short="ctx.storefront.graphql — server-side Shopify Storefront API reads. Rare: widgets usually read storefront data themselves via host.storefront (see widgetCapabilities). Declare here only when the handler itself needs public storefront data.",
                docs="""\
── ctx.storefront.graphql (server-side Storefront API) ──────

ctx.storefront.graphql(query, variables?) → Promise<any>
  Shopify Storefront API (public GraphQL). Uses the Storefront Access Token stored at OAuth time.
  The harness unwraps { data: ... } — access fields directly on the result.
  Use this for publicly available storefront data the handler needs server-side.
  Note: Widget code uses host.storefront() for client-side reads — ctx.storefront is for the handler.
  Example:
    const data = await ctx.storefront.graphql(
      `query GetProduct($handle: String!) {
        productByHandle(handle: $handle) { id title variants(first: 10) { nodes { id availableForSale } } }
      }`,
      { handle: productHandle }
    )\
""",
            ),
        ),
    ]
)


# ─── Handler npm packages (require at runtime) ────────────────────────────────
#
# Each package's `docs` carries: pinned version, what it does, declare line,
# require line, and an example the handler can crib from.

HANDLER_NPM_PACKAGES: "OrderedDict[str, Capability]" = OrderedDict(
    [
        (
            "npm:qrcode",
            Capability(
                short="QR code generation as PNG buffer or SVG string (qrcode).",
                packages=("qrcode",),
                docs="""\
── npm:qrcode ────────────────────────────────────────────────
  Declare: npmPackages: ['qrcode@1.5.3']
  Usage:
    const QRCode = require('qrcode');
    const svgString = await QRCode.toString(text, { type: 'svg', width: 300 });
    const pngBuffer  = await QRCode.toBuffer(text, { width: 300 });\
""",
            ),
        ),
        (
            "npm:jsbarcode",
            Capability(
                short="Barcode SVG generation (jsbarcode, pulls in @xmldom/xmldom).",
                packages=("jsbarcode", "@xmldom/xmldom"),
                docs="""\
── npm:jsbarcode ─────────────────────────────────────────────
  Declare: npmPackages: ['jsbarcode@3.11.6', '@xmldom/xmldom@0.8.10']
  Supports CODE128, EAN13, UPC, CODE39, and more.
  Usage:
    const JsBarcode = require('jsbarcode');
    const { DOMImplementation, XMLSerializer } = require('@xmldom/xmldom');
    const doc     = new DOMImplementation().createDocument('http://www.w3.org/1999/xhtml', 'html', null);
    const svgNode = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svgNode, value, { format: 'CODE128', width: 2, height: 100, xmlDocument: doc });
    const svg = new XMLSerializer().serializeToString(svgNode);\
""",
            ),
        ),
        (
            "npm:sharp",
            Capability(
                short="Image resize / convert / compose (sharp).",
                packages=("sharp",),
                docs="""\
── npm:sharp ─────────────────────────────────────────────────
  Declare: npmPackages: ['sharp@0.33.5']
  Formats: JPEG / PNG / WebP / AVIF in and out.
  Usage:
    const sharp = require('sharp');
    const resizedBuffer = await sharp(inputBuffer)
      .resize(800, 600, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();
    const metadata = await sharp(inputBuffer).metadata();  // { width, height, format, size }\
""",
            ),
        ),
        (
            "npm:pdfkit",
            Capability(
                short="PDF generation (pdfkit).",
                packages=("pdfkit",),
                docs="""\
── npm:pdfkit ────────────────────────────────────────────────
  Declare: npmPackages: ['pdfkit@0.15.0']
  Pure JS, no native deps.
  Usage:
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    await new Promise(resolve => { doc.on('end', resolve); doc.text('Hello').end(); });
    const pdfBuffer = Buffer.concat(chunks);\
""",
            ),
        ),
        (
            "npm:exceljs",
            Capability(
                short="Excel / XLSX workbook creation (exceljs).",
                packages=("exceljs",),
                docs="""\
── npm:exceljs ───────────────────────────────────────────────
  Declare: npmPackages: ['exceljs@4.4.0']
  Usage:
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Orders');
    ws.columns = [{ header: 'ID', key: 'id' }, { header: 'Email', key: 'email' }];
    rows.forEach(r => ws.addRow(r));
    const xlsxBuffer = await wb.xlsx.writeBuffer();\
""",
            ),
        ),
        (
            "npm:csv",
            Capability(
                short="CSV parse and stringify (csv-parse, csv-stringify).",
                packages=("csv-parse", "csv-stringify"),
                docs="""\
── npm:csv ───────────────────────────────────────────────────
  Declare for parse:     npmPackages: ['csv-parse@5.5.6']
  Declare for stringify: npmPackages: ['csv-stringify@6.5.2']
  Declare both when the handler reads AND writes CSV.
  Usage — parse:
    const { parse } = require('csv-parse/sync');
    const records = parse(csvString, { columns: true, skip_empty_lines: true });
  Usage — stringify:
    const { stringify } = require('csv-stringify/sync');
    const csvString = stringify(orders, { header: true, columns: ['id', 'email', 'total'] });\
""",
            ),
        ),
        (
            "npm:xml",
            Capability(
                short="XML parse and build (fast-xml-parser).",
                packages=("fast-xml-parser",),
                docs="""\
── npm:xml (fast-xml-parser) ─────────────────────────────────
  Declare: npmPackages: ['fast-xml-parser@4.3.6']
  Usage:
    const { XMLParser, XMLBuilder } = require('fast-xml-parser');
    const parser  = new XMLParser();
    const jsObj   = parser.parse(xmlString);
    const builder = new XMLBuilder();
    const xmlOut  = builder.build(jsObj);\
""",
            ),
        ),
        (
            "npm:handlebars",
            Capability(
                short="Mustache-style HTML/text templating (handlebars).",
                packages=("handlebars",),
                docs="""\
── npm:handlebars ────────────────────────────────────────────
  Declare: npmPackages: ['handlebars@4.7.8']
  NOTE: do NOT use handlebars for merchant-configured email bodies — email
  template rendering is owned by the platform (see ctx.services.email.send).
  Use handlebars only for other HTML/text the handler generates itself (PDFs,
  third-party payloads, etc.).
  Usage:
    const Handlebars = require('handlebars');
    const html = Handlebars.compile('<h1>Hi {{name}}</h1>')({ name: customer.first_name });\
""",
            ),
        ),
        (
            "npm:marked",
            Capability(
                short="Markdown → HTML (marked).",
                packages=("marked",),
                docs="""\
── npm:marked ────────────────────────────────────────────────
  Declare: npmPackages: ['marked@15.0.0']
  Usage:
    const { marked } = require('marked');
    const html = marked.parse(markdownString);\
""",
            ),
        ),
        (
            "npm:dayjs",
            Capability(
                short="Date parsing, formatting, arithmetic (dayjs).",
                packages=("dayjs",),
                docs="""\
── npm:dayjs ─────────────────────────────────────────────────
  Declare: npmPackages: ['dayjs@1.11.13']
  Usage:
    const dayjs = require('dayjs');
    const label = dayjs(order.created_at).format('YYYY-MM-DD');
    const sevenDaysAgo = dayjs().subtract(7, 'day').toISOString();\
""",
            ),
        ),
        (
            "npm:jszip",
            Capability(
                short="In-memory ZIP archive creation (jszip).",
                packages=("jszip",),
                docs="""\
── npm:jszip ─────────────────────────────────────────────────
  Declare: npmPackages: ['jszip@3.10.1']
  Usage:
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('orders.csv', csvString);
    zip.file('report.pdf', pdfBuffer);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });\
""",
            ),
        ),
        (
            "npm:uuid",
            Capability(
                short="RFC 4122 UUID generation (uuid).",
                packages=("uuid",),
                docs="""\
── npm:uuid ──────────────────────────────────────────────────
  Declare: npmPackages: ['uuid@9.0.1']
  Prefer v4 (random). Use only when the DB cannot set the UUID itself
  (gen_random_uuid() is usually a better choice for primary keys).
  Usage:
    const { v4: uuidv4 } = require('uuid');
    const correlationId = uuidv4();\
""",
            ),
        ),
        (
            "npm:slugify",
            Capability(
                short="URL-safe slug generation (slugify).",
                packages=("slugify",),
                docs="""\
── npm:slugify ───────────────────────────────────────────────
  Declare: npmPackages: ['slugify@1.6.6']
  Usage:
    const slugify = require('slugify');
    const slug = slugify(productTitle, { lower: true, strict: true });\
""",
            ),
        ),
    ]
)


# ─── Combined registry + validator-facing allowed set ─────────────────────────

HANDLER_CAPABILITY_REGISTRY: "OrderedDict[str, Capability]" = OrderedDict(
    list(HANDLER_SERVICES.items()) + list(HANDLER_NPM_PACKAGES.items())
)

ALLOWED_HANDLER_CAPABILITIES: frozenset = frozenset(HANDLER_CAPABILITY_REGISTRY.keys())

# Union of bare npm package names every npm capability authorizes. Derived from
# the registry so adding an npm capability (with its `packages` tuple) auto-
# extends the validator's allowed set — no parallel list to maintain.
ALLOWED_NPM_PACKAGES: frozenset = frozenset(
    pkg for cap in HANDLER_NPM_PACKAGES.values() for pkg in cap.packages
)


# ─── Cross-capability joint section ───────────────────────────────────────────
#
# Injected by the handler JIT only when BOTH shopify_rest AND shopify_graphql
# are declared — saves the ~1.5KB decision-guide repetition for handlers that
# use only one. Kept here (not in either cap) because it is a choose-one
# discussion that belongs to neither alone.

SHOPIFY_REST_VS_GRAPHQL_GUIDE = """\
── Shopify REST vs GraphQL — which to pick ──────────────────

This handler uses BOTH REST and GraphQL. Pick per call:
  • Simple CRUD on a single known entity → REST (ctx.shopify.get / post / delete)
  • Bulk tag / metafield mutation, cross-entity join, no-REST-equivalent op → GraphQL
  • Full-catalog scan of a single resource → REST with since_id cursor pagination
  • Paged query that may exceed 250 rows on a single entity → GraphQL cursor pagination
Exact pagination patterns and examples are documented in the individual
shopify_rest and shopify_graphql sections above.\
"""
