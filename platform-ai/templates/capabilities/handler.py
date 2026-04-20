"""
Handler capability registry.

Every app has a handler (an Express TypeScript service running on Cloud
Run). The architect declares `handlerCapabilities`, and the handler JIT
assembles the handler prompt by concatenating:

  1. HARNESS_BASE — always-shipped: file-bundle output format, req.platform,
     sql tagged template, callPlatformService, absolute rules, logging,
     Shopify loop rule.
  2. Capability.docs for every entry listed in handlerCapabilities.
  3. Any conditional sections gated on trigger presence (webhook / cron /
     state machine / widget routing / admin routing / cron batching /
     REST+GraphQL joint decision guide).

Adding a new handler capability is a single edit to the relevant registry
below — the architect's AVAILABLE list, the validator's allowed set, and
the handler JIT all pick it up automatically.

The Shopify API surface is exposed by a template-owned helper at
`src/lib/shopify.ts`, which wraps `@shopify/shopify-api`. The generator
never imports `@shopify/shopify-api` directly — it always goes through
the helper. See `shopify_rest` / `shopify_graphql` capability docs below.
"""

from __future__ import annotations

from collections import OrderedDict

from ._types import Capability


# ─── Handler platform services ────────────────────────────────────────────────

HANDLER_SERVICES: "OrderedDict[str, Capability]" = OrderedDict(
    [
        (
            "shopify_rest",
            Capability(
                short="shopify.rest.get/post/delete(path, body?) / shopify.rest.paginate(path, query?) — Shopify Admin REST API via the template's src/lib/shopify.ts helper. Declare for REST reads or mutations.",
                docs="""\
── Shopify REST ──────────────────────────────────────────────

The template ships src/lib/shopify.ts which wraps @shopify/shopify-api
and returns a per-request client. You import and call it like this:

  import { shopifyClientFor } from "../lib/shopify.js";
  const shopify = shopifyClientFor(req.platform!);

Then four methods are available:

shopify.rest.get(path: string) → Promise<any>
  Shopify Admin REST GET. Path is relative to /admin/api/<version>.
  Example:
    const { orders } = await shopify.rest.get('/orders.json?status=any&limit=10');
  USE FOR: singular fetches (`/orders/<id>.json`), counts
  (`/<resource>/count.json`), small batches whose result fits in one
  page. For multi-page list endpoints use shopify.rest.paginate.

shopify.rest.post(path: string, body: object) → Promise<any>
  Shopify Admin REST POST / PUT. Use for REST mutations. The helper
  routes PUT-style updates through POST — there is no separate PUT
  method.
  Example:
    await shopify.rest.post('/customers/<id>.json', {
      customer: { id: <id>, tags: 'VIP' },
    });

shopify.rest.delete(path: string) → Promise<any>
  Shopify Admin REST DELETE. Returns {} on 204 No Content. Throws on
  non-2xx. Common uses: delete product images, metafields, webhook
  subscriptions, draft orders.
  Example:
    await shopify.rest.delete(`/products/${productId}/images/${imageId}.json`);

shopify.rest.paginate(path: string, query?: object) → AsyncGenerator<any[]>
  Async generator over a REST list endpoint. Yields one page of
  resources per iteration; handles Link-header cursor pagination
  internally. Filter params are applied to the first request only
  (Shopify rejects filter params on cursor follow-ups). Default limit 250.
  Example:
    for await (const batch of shopify.rest.paginate(
      '/orders.json',
      { status: 'any', updated_at_min: since },
    )) {
      for (const order of batch) { /* process */ }
    }
  DO NOT hand-roll `since_id`, `page_info`, `Link`-header parsing, or
  `?page=` loops — the underlying SDK does not expose response headers
  to you, so hand-rolled pagination will be silently broken.

WHEN TO USE REST (vs shopify.graphql):
  • Simple CRUD on a single known entity (fetch order, update customer,
    create fulfillment).
  • Batch fetching one entity type with a batch endpoint
    (/products.json?ids=..., /inventory_levels.json?inventory_item_ids=...).
  • Full-catalog / windowed scans → shopify.rest.paginate.
  • Deleting Shopify resources (product images, metafields, etc.).

REST PUT endpoints use shopify.rest.post() — there is no separate PUT
method.\
""",
                usage_rule=(
                    "For Shopify REST list endpoints use `for await (const batch of shopify.rest.paginate(path, query))` — "
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
                short="shopify.graphql(query, variables?) / shopify.graphqlPaginate(query, variables, connectionPath) — Shopify Admin GraphQL API via the template's src/lib/shopify.ts helper. Declare for GraphQL mutations (bulk tags, metafields, discountCodeBulkAdd) or multi-entity joins REST can't express in one call.",
                docs="""\
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
""",
                usage_rule=(
                    "For paginated GraphQL reads use `for await (const nodes of shopify.graphqlPaginate(query, vars, connectionPath))` — "
                    "never hand-roll `do { cursor } while(cursor)` over shopify.graphql."
                ),
            ),
        ),
        (
            "email",
            Capability(
                short="callPlatformService({path: '/services/email/send', body: { to, data? }}) — merchant-configured email template (subject/body/CTA owned by the platform; handler passes recipient + variables only).",
                docs="""\
── /services/email/send ──────────────────────────────────────

Sent via callPlatformService — the handler never talks to the email
provider directly.

  import { callPlatformService } from "../lib/platform-call.js";

  const { status, body } = await callPlatformService<{
    ok: boolean; delivered: boolean; reason?: string;
  }>({
    path: "/services/email/send",
    body: { to: <recipient>, data: { /* template vars */ } },
  });
  if (status === 429) { /* quota exceeded */ return ...; }
  if (status >= 400) { /* platform error */ return ...; }
  /* success */

The handler ONLY provides the recipient and runtime variables. The
platform owns everything else — subject, body, brand, layout, from
address, delivery, tracking, unsubscribe. The merchant configures the
template (subject, body, CTA, brand) in the dashboard's Email tab; any
{{variable}} placeholders they put in those fields are resolved against
`data` at send time.

  to:    recipient email address (string)
  data:  optional variables bound to {{variable}} placeholders in the
         merchant-configured template. Include whatever dynamic values
         the merchant will want to reference: customer name, order id,
         product title, URLs, amounts, etc.

DO NOT pass `subject`, `templateId`, or HTML — those fields do not exist
on the API. DO NOT store email HTML in your app's DB tables or compile
templates inside the handler — the platform does all of that.

The variable names you pass in `data` become the token palette shown to
the merchant in the Email tab, so use descriptive names
(<variable_name_one>, <variable_name_two>) rather than single letters.
All `data` keys MUST be camelCase — never snake_case or PascalCase. The
merchant references them as {{camelCase}} in the template.

Example (shape only — fill in variables appropriate to your app):
  const { status, body } = await callPlatformService({
    path: "/services/email/send",
    body: {
      to: <recipient>,
      data: {
        <variable_1>: <value_1>,
        <variable_2>: <value_2>,
        <variable_url>: <url_value>,
      },
    },
  });

The merchant-configured template might then read:
  Subject: "{{<variable_1>}}, your <noun> is waiting"
  Body:    "... — {{<variable_2>}}."
  CTA:     "<short_label>" → {{<variable_url>}}

Deploy is blocked on apps that use the email service until the merchant
has saved the Email tab at least once. That's by design — uncustomized
emails would look generic and hurt the merchant's brand.

── Email metadata sidecar (REQUIRED when you call the email service) ────

AFTER all your ===FILE: ... === blocks, emit a fenced JSON block
declaring the exact variables you chose for `data` plus starter template
content for the Email tab. The platform seeds the merchant's
`app_email_configs` row from this block so the merchant never sees a
blank form on first open.

Format — one block per handler, fenced with ```email-metadata.
Replace every <placeholder> token below with values specific to THIS
app's send call(s); do NOT echo the angle-bracket placeholders verbatim.

```email-metadata
{
  "variables": ["<variable_1>", "<variable_2>", "<variable_url>"],
  "starterContent": {
    "subject":  "<short subject line that references {{variable_1}} when natural>",
    "heading":  "<optional greeting referencing a name-like variable, or omit>",
    "body":     "<one or two sentences describing the context, referencing {{variable_2}} etc.>",
    "ctaLabel": "<short button label, or omit together with ctaUrl>",
    "ctaUrl":   "{{<variable_url>}}"
  }
}
```

RULES:
  - variables: the EXACT camelCase keys you pass in any
    `data: { ... }` across ALL email send call sites in this handler.
    First-seen order, deduplicated. If you only make one send call,
    it's just the keys from that one object literal.
  - starterContent.subject / body: short, warm, reference variables you
    declared with {{variable}} placeholders. The merchant will edit
    this copy — your job is to produce a sensible non-blank starting
    point informed by emailSpec.purpose from the architect plan, NOT
    to write final marketing copy.
  - heading: optional. Include it for personalized greetings when a
    name-like variable is available. Omit the key entirely otherwise.
  - ctaLabel + ctaUrl: required together if ANY URL variable is in your
    variables list (recoveryUrl, productUrl, orderUrl, actionUrl, url,
    etc.). Omit both when the handler passes no URL variable.
  - Keep variables consistent: every token referenced in starterContent
    with {{x}} MUST be in the variables array, and vice versa (no
    unused declared variables).
  - Emit ONE block even across multiple send call sites — merge all
    variables into a single array.
  - Do NOT emit this block when the handler does not use the email
    service.\
""",
            ),
        ),
        (
            "sms",
            Capability(
                short="callPlatformService({path: '/services/sms/send', body: { to, body }}) — outbound SMS to E.164 phone numbers.",
                docs="""\
── /services/sms/send ────────────────────────────────────────

Sent via callPlatformService. Stub in MVP (logs SMS_SENT) — real
Twilio integration ships later.

  const { status } = await callPlatformService({
    path: "/services/sms/send",
    body: {
      to: <e164_phone>,            // E.164 format, e.g. "+15551234567"
      body: <sms_text>,            // max 160 chars
    },
  });
  if (status === 429) { /* quota */ return ...; }
  if (status >= 400) { /* platform error */ return ...; }\
""",
            ),
        ),
        (
            "files",
            Capability(
                short="callPlatformService({path: '/services/files/upload', body: { name, contents, mimeType? }}) → signed URL — generate a downloadable artefact (CSV / PDF / XLSX / ZIP / image).",
                docs="""\
── /services/files/upload ────────────────────────────────────

Sent via callPlatformService. Stub in MVP (logs FILE_UPLOADED) — real
GCS integration ships later.

  const { status, body } = await callPlatformService<{ url: string }>({
    path: "/services/files/upload",
    body: {
      name: <filename>,            // e.g. "<report_name>.csv"
      contents: <base64_string>,   // the file bytes, base64-encoded
      mimeType: <mime>,            // e.g. "text/csv", "application/pdf"
    },
  });
  if (status === 429) { /* quota */ return ...; }
  if (status >= 400) { /* platform error */ return ...; }
  const downloadUrl = body!.url;   // signed URL valid for 1 hour

  Pass Buffers as base64:
    const b64 = buffer.toString("base64");

  Common mimeTypes:
    "text/csv"
    "application/pdf"
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    "application/zip"
    "image/png", "image/jpeg", "image/webp"\
""",
            ),
        ),
        (
            "http",
            Capability(
                short="Node's built-in fetch() for outbound HTTPS to a non-Shopify, non-platform third party. Declare only for external integrations — never for Shopify endpoints (use shopify.*) or platform-back (use callPlatformService).",
                docs="""\
── fetch() (Node built-in) ───────────────────────────────────

Node 20 ships fetch globally — no package to import, no wrapper. Use it
directly for third-party HTTPS calls.

  https:// URLs are ALLOWED here. They are NOT allowed anywhere else —
  no https:// in comments, email templateIds, or any other string.

Examples:

  // JSON API:
  const resp = await fetch("https://api.<third_party>.com/<path>", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env["<API_KEY_ENV>"]}`,
    },
    body: JSON.stringify({ <request_body> }),
  });
  if (!resp.ok) throw new Error(`third_party_failed: ${resp.status}`);
  const data = await resp.json();

  // Download bytes (e.g. an image to pass into sharp):
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) throw new Error(`image_fetch_failed`);
  const bytes = Buffer.from(await imgResp.arrayBuffer());

  // Plaintext / HTML:
  const htmlResp = await fetch("https://<host>/<path>");
  if (!htmlResp.ok) throw new Error(`fetch_failed`);
  const html = await htmlResp.text();

RULES:
  - Always check `resp.ok` and throw / early-return on non-2xx.
  - Always include a timeout — use `AbortSignal.timeout(<ms>)`:
      fetch(url, { signal: AbortSignal.timeout(5_000) })
  - NEVER use fetch() to call platform-back — use callPlatformService.
  - NEVER use fetch() to call Shopify — use the shopify client.\
""",
            ),
        ),
        (
            "storefront",
            Capability(
                short="shopify.storefront(query, variables?) — server-side Shopify Storefront API (public data) via the template's src/lib/shopify.ts helper. Rare — widgets usually read storefront data client-side; declare here only when the handler itself needs public storefront data.",
                docs="""\
── shopify.storefront (server-side Storefront API) ──────────

Same helper as REST / Admin GraphQL:

  import { shopifyClientFor } from "../lib/shopify.js";
  const shopify = shopifyClientFor(req.platform!);

shopify.storefront(query: string, variables?: object) → Promise<any>
  Shopify Storefront API (public GraphQL). Uses the Storefront Access
  Token stored at OAuth time.
  The helper unwraps { data: ... } — access fields directly on the
  result.
  Use this for publicly available storefront data the handler needs
  server-side (e.g. product-by-handle lookups during a webhook or cron
  job). Widget code reads storefront data client-side — the handler's
  storefront access is for server-side-only paths.
  Example:
    const data = await shopify.storefront(
      `query GetProduct($handle: String!) {
        productByHandle(handle: $handle) {
          id
          title
          variants(first: 10) { nodes { id availableForSale } }
        }
      }`,
      { handle: <product_handle> },
    );\
""",
            ),
        ),
    ]
)


# ─── Handler npm packages (import at build time) ──────────────────────────────
#
# Each package's `docs` carries: pinned version, what it does, declare
# line, import line, and an example the handler can crib from.

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
    import QRCode from "qrcode";
    const svgString = await QRCode.toString(text, { type: 'svg', width: 300 });
    const pngBuffer = await QRCode.toBuffer(text, { width: 300 });\
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
    import JsBarcode from "jsbarcode";
    import { DOMImplementation, XMLSerializer } from "@xmldom/xmldom";
    const doc = new DOMImplementation().createDocument('http://www.w3.org/1999/xhtml', 'html', null);
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
    import sharp from "sharp";
    const resizedBuffer = await sharp(inputBuffer)
      .resize(800, 600, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();
    const metadata = await sharp(inputBuffer).metadata();  // { width, height, format, size }
  Buffer only — .toFile() writes to a local path that does not persist
  on Cloud Run; use .toBuffer() and pass the result to the files
  service (base64-encoded).\
""",
                usage_rule=(
                    "Use sharp(...).toBuffer() and hand the result (base64) to /services/files/upload — "
                    "never .toFile() (Cloud Run FS is ephemeral)."
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
    import PDFDocument from "pdfkit";
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    await new Promise<void>((resolve) => { doc.on("end", () => resolve()); doc.text("<text>").end(); });
    const pdfBuffer = Buffer.concat(chunks);
  Buffer only — do NOT .pipe(fs.createWriteStream(...)) the document.
  Cloud Run's filesystem is ephemeral; hand the Buffer (base64) to
  /services/files/upload.\
""",
                usage_rule=(
                    "Buffer pdfkit output via the data/end event pattern and hand the Buffer (base64) to /services/files/upload — "
                    "never .pipe(fs.createWriteStream(...)) (Cloud Run FS is ephemeral)."
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
    import ExcelJS from "exceljs";
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("<sheet_name>");
    ws.columns = [{ header: "<col_1>", key: "<key_1>" }, { header: "<col_2>", key: "<key_2>" }];
    rows.forEach((r) => ws.addRow(r));
    const xlsxBuffer = await wb.xlsx.writeBuffer();
  Buffer only — wb.xlsx.writeFile(path) writes to a local path that
  does not persist on Cloud Run; use wb.xlsx.writeBuffer() and pass
  the result (base64) to /services/files/upload.\
""",
                usage_rule=(
                    "Use wb.xlsx.writeBuffer() and hand the Buffer (base64) to /services/files/upload — "
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
    import { parse } from "csv-parse/sync";
    const records = parse(csvString, { columns: true, skip_empty_lines: true });
  Usage — stringify:
    import { stringify } from "csv-stringify/sync";
    const csvString = stringify(rows, { header: true, columns: ['<col_1>', '<col_2>', '<col_3>'] });\
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
    import { XMLParser, XMLBuilder } from "fast-xml-parser";
    const parser = new XMLParser();
    const jsObj = parser.parse(xmlString);
    const builder = new XMLBuilder();
    const xmlOut = builder.build(jsObj);\
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
  NOTE: do NOT use handlebars for merchant-configured email bodies —
  email template rendering is owned by the platform (see the email
  capability). Use handlebars only for other HTML/text the handler
  generates itself (PDFs, third-party payloads, etc.).
  Usage:
    import Handlebars from "handlebars";
    const html = Handlebars.compile("<h1>Hi {{<variable_name>}}</h1>")({ <variable_name>: <value> });\
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
    import { marked } from "marked";
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
    import dayjs from "dayjs";
    const label = dayjs(<date_value>).format('YYYY-MM-DD');
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
    import JSZip from "jszip";
    const zip = new JSZip();
    zip.file("<file_1>.csv", csvString);
    zip.file("<file_2>.pdf", pdfBuffer);
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });\
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
    import { v4 as uuidv4 } from "uuid";
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
    import slugify from "slugify";
    const slug = slugify(<text>, { lower: true, strict: true });\
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

# Union of bare npm package names every npm capability authorizes. Derived
# from the registry so adding an npm capability (with its `packages` tuple)
# auto-extends the validator's allowed set — no parallel list to maintain.
ALLOWED_NPM_PACKAGES: frozenset = frozenset(
    pkg for cap in HANDLER_NPM_PACKAGES.values() for pkg in cap.packages
)


# ─── Cross-capability joint section ───────────────────────────────────────────
#
# Injected by the handler JIT only when BOTH shopify_rest AND shopify_graphql
# are declared — saves the decision-guide repetition for handlers that use
# only one. Kept here (not in either cap) because it is a choose-one
# discussion that belongs to neither alone.

SHOPIFY_REST_VS_GRAPHQL_GUIDE = """\
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
