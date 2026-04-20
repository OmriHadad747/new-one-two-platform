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
                short="ctx.shopify.get(path) / post(path, body) / delete(path) / paginate(path, params?) — Shopify Admin REST API at /admin/api/2026-01. Declare for REST reads or mutations.",
                docs="""\
── Shopify REST ──────────────────────────────────────────────

ctx.shopify.get(path: string) → Promise<any>
  Shopify Admin REST GET. Path is relative to /admin/api/2026-01.
  Example: await ctx.shopify.get('/orders.json?status=any&limit=10')
  USE FOR: singular fetches (`/orders/123.json`), counts (`/orders/count.json`),
  small batches whose result you KNOW fits in one page. For multi-page list
  endpoints use ctx.shopify.paginate (see below) — never hand-roll pagination.

ctx.shopify.post(path: string, body: object) → Promise<any>
  Shopify Admin REST POST/PUT. Use for REST mutations.
  Example: await ctx.shopify.post('/customers/456.json', { customer: { id: 456, tags: 'VIP' } })

ctx.shopify.delete(path: string) → Promise<any>
  Shopify Admin REST DELETE. Use to remove Shopify resources.
  Example: await ctx.shopify.delete(`/products/${productId}/images/${imageId}.json`)
  Returns {} on 204 No Content. Throws on non-2xx responses.
  Common uses: delete product images, metafields, webhook subscriptions, draft orders.

ctx.shopify.paginate(path: string, params?: object) → AsyncGenerator<any[]>
  Async generator over a REST list endpoint. Yields one page of resources
  per iteration; handles Link-header cursor pagination internally. Filter
  params are applied to the first request only (Shopify rejects filter
  params on cursor follow-ups). Default limit 250.
  Example:
    for await (const batch of ctx.shopify.paginate('/orders.json', { status: 'any', updated_at_min: since })) {
      for (const order of batch) { /* process */ }
    }
  DO NOT hand-roll `since_id`, `page_info`, `Link`-header parsing, or `?page=`
  loops — ctx.shopify.get does NOT expose response headers, so hand-rolled
  pagination will be silently broken.

WHEN TO USE REST (vs ctx.shopify.graphql):
  • Simple CRUD on a single known entity (fetch order, update customer, create fulfillment)
  • Batch fetching one entity type with a batch endpoint (/products.json?ids=...,
    /inventory_levels.json?inventory_item_ids=...)
  • Full-catalog / windowed scans → ctx.shopify.paginate
  • Deleting Shopify resources (product images, metafields, etc.)

REST PUT endpoints use ctx.shopify.post() — there is no separate PUT method.\
""",
                usage_rule=(
                    "For Shopify REST list endpoints use `for await (const batch of ctx.shopify.paginate(path, params))` — "
                    "never hand-roll since_id, page_info, Link-header parsing, or ?page= loops."
                ),
                static_validation_anti_pattern_regex=(
                    r"""[?&`'"](since_id|page_info)\s*="""
                ),
            ),
        ),
        (
            "shopify_graphql",
            Capability(
                short="ctx.shopify.graphql(query, variables?) / paginateGql(query, variables, connectionPath) — Shopify Admin GraphQL API. Declare for GraphQL mutations (bulk tags, metafields, discountCodeBulkAdd) or multi-entity joins REST can't express in one call.",
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

ctx.shopify.paginateGql(query, variables, connectionPath) → AsyncGenerator<any[]>
  Async generator over a Relay GraphQL connection. Yields `edges.map(e => e.node)`
  at the given connectionPath per page; walks pageInfo.hasNextPage / endCursor
  internally. Use this for any query that may return more than one page.

  REQUIREMENTS of the query:
    • Declare $cursor: String and pass after: $cursor on the target connection.
    • The connection must request pageInfo { hasNextPage endCursor } and
      edges { node { ... } }.  (The helper pulls nodes out of edges.)
  connectionPath is a dot-path into the response that locates the connection
  (e.g. "orders", "customer.orders", "products.variants").

  Example:
    const query = `
      query OrdersByTag($cursor: String, $pageSize: Int!) {
        orders(first: $pageSize, after: $cursor, query: "tag:backorder") {
          pageInfo { hasNextPage endCursor }
          edges { node { id name createdAt } }
        }
      }`;
    for await (const nodes of ctx.shopify.paginateGql(query, { pageSize: 100 }, 'orders')) {
      for (const order of nodes) { /* process */ }
    }

  DO NOT hand-roll `do { cursor } while(cursor)` loops over ctx.shopify.graphql
  for paged reads — use paginateGql instead.
  DO still use ctx.shopify.graphql directly for single-page queries
  (everything-in-first:50 reads, mutations, counts).\
""",
                usage_rule=(
                    "For paginated GraphQL reads use `for await (const nodes of ctx.shopify.paginateGql(query, vars, connectionPath))` — "
                    "never hand-roll `do { cursor } while(cursor)` over ctx.shopify.graphql."
                ),
            ),
        ),
        (
            "email",
            Capability(
                short="ctx.services.email.send({ to, data? }) — merchant-configured email template (subject/body/CTA owned by the platform; handler passes recipient + variables only).",
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
  would look generic and hurt the merchant's brand.

── Email metadata sidecar (REQUIRED when you call email.send) ───

  AFTER the handler.js code, emit a fenced JSON block declaring the exact
  variables you chose for `data` plus starter template content for the
  Email tab. The platform seeds the merchant's `app_email_configs` row
  from this block so the merchant never sees a blank form on first open.

  Format — one block per handler, fenced with ```email-metadata.
  Replace every <placeholder> token below with values specific to THIS
  app's send call(s); do NOT echo the angle-bracket placeholders verbatim.

```email-metadata
{
  "variables": ["<variableOne>", "<variableTwo>", "<urlVariable>"],
  "starterContent": {
    "subject":  "<short subject line that references {{variableOne}} when natural>",
    "heading":  "<optional greeting referencing a name-like variable, or omit>",
    "body":     "<one or two sentences describing the context, referencing {{variableTwo}} etc.>",
    "ctaLabel": "<short button label, or omit together with ctaUrl>",
    "ctaUrl":   "{{<urlVariable>}}"
  }
}
```

  RULES:
  - variables: the EXACT camelCase keys you pass in any `data: { ... }`
    across ALL ctx.services.email.send() call sites in this handler. First-
    seen order, deduplicated. If you only make one send call, it's just the
    keys from that one object literal.
  - starterContent.subject / body: short, warm, reference variables you
    declared with {{variable}} placeholders. The merchant will edit this
    copy — your job is to produce a sensible non-blank starting point
    informed by emailSpec.purpose from the architect plan, NOT to write
    final marketing copy.
  - heading: optional. Include it for personalized greetings when a name-
    like variable is available. Omit the key entirely otherwise.
  - ctaLabel + ctaUrl: required together if ANY URL variable is in your
    variables list (recoveryUrl, productUrl, orderUrl, actionUrl, url,
    etc.). Omit both when the handler passes no URL variable.
  - Keep variables consistent: every token referenced in starterContent
    with {{x}} MUST be in the variables array, and vice versa (no unused
    declared variables).
  - Emit ONE block even across multiple send call sites — merge all
    variables into a single array.
  - Do NOT emit this block when the handler does not call email.send.\
""",
            ),
        ),
        (
            "sms",
            Capability(
                short="ctx.services.sms.send({ to, body }) — outbound SMS to E.164 phone numbers.",
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
                short="ctx.services.files.upload(name, content, mimeType?) → signed URL — generate a downloadable artefact (CSV / PDF / XLSX / ZIP / image); content is a Buffer or string.",
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
                short="ctx.http.json / .buffer / .text — outbound HTTPS to a non-Shopify third party, split by response type. Declare only for external integrations — never for Shopify endpoints.",
                docs="""\
── ctx.http.json / .buffer / .text ───────────────────────────

Three methods, one per response type. Pick by what you expect back — never
use .json for an image or a binary download; you'll get a parse error.

  ctx.http.json(url, options?)   → Promise<unknown>    — JSON APIs
  ctx.http.buffer(url, options?) → Promise<Buffer>     — images, files, any binary
  ctx.http.text(url, options?)   → Promise<string>     — HTML, plaintext

Shared options (all three methods):
  url:            full URL (https:// is ALLOWED here — ctx.http is the only place)
  options.method: HTTP method (default "GET")
  options.headers: additional headers
  options.body:   request body — objects are JSON-stringified automatically;
                  Buffer / Uint8Array pass through raw (for uploading binary)

All three throw on non-2xx responses. All calls are logged with tenant context.

Examples:
  // JSON API
  const result = await ctx.http.json('https://api.example.com/enrich', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer TOKEN' },
    body: { customerId: id }
  })

  // Download an image as bytes (e.g. to pass into sharp)
  const bytes = await ctx.http.buffer(product.image.src)
  const meta = await sharp(bytes).metadata()

  // Scrape an HTML page
  const html = await ctx.http.text('https://example.com/status')\
""",
            ),
        ),
        (
            "storefront",
            Capability(
                short="ctx.storefront.graphql(query, variables?) — server-side Shopify Storefront API (public data). Rare — widgets usually read via host.storefront; declare here only when the handler itself needs public storefront data.",
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
    const metadata = await sharp(inputBuffer).metadata();  // { width, height, format, size }
  Buffer only — .toFile() writes to a local path that does not exist on
  Cloud Run; use .toBuffer() and pass the result to ctx.services.files.upload.\
""",
                usage_rule=(
                    "Use sharp(...).toBuffer() and hand the result to "
                    "ctx.services.files.upload — never .toFile() (Cloud Run FS is ephemeral)."
                ),
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
    const pdfBuffer = Buffer.concat(chunks);
  Buffer only — do NOT .pipe(fs.createWriteStream(...)) the document. Cloud
  Run's filesystem is ephemeral; hand the Buffer to ctx.services.files.upload.\
""",
                usage_rule=(
                    "Buffer pdfkit output via the data/end event pattern and hand the Buffer to "
                    "ctx.services.files.upload — never .pipe(fs.createWriteStream(...)) (Cloud Run FS is ephemeral)."
                ),
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
    const xlsxBuffer = await wb.xlsx.writeBuffer();
  Buffer only — wb.xlsx.writeFile(path) writes to a local path that does not
  exist on Cloud Run; use wb.xlsx.writeBuffer() and pass the result to
  ctx.services.files.upload.\
""",
                usage_rule=(
                    "Use wb.xlsx.writeBuffer() and hand the Buffer to ctx.services.files.upload — "
                    "never wb.xlsx.writeFile(path) (Cloud Run FS is ephemeral)."
                ),
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
  • Bulk tag / metafield mutation, cross-entity join, no-REST-equivalent op → GraphQL mutation (ctx.shopify.graphql)
  • Full-catalog / windowed scan of a single resource → ctx.shopify.paginate (REST Link-cursor pagination)
  • Paged cross-entity read that needs a GraphQL join → ctx.shopify.paginateGql
Exact pagination patterns and examples are documented in the individual
shopify_rest and shopify_graphql sections above. Never hand-roll pagination
loops — use the paginate helpers.\
"""
