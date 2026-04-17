"""
Handler capability registry.

Every app has a handler (Node.js module running on the platform), so
`handlerCapabilities` is always declared by the architect. The handler JIT
will map each entry here to a HARNESS_SECTION_* block and include only the
sections the handler actually needs at runtime.

Two sub-registries:
  HANDLER_SERVICES      — ctx.* APIs exposed by the harness.
  HANDLER_NPM_PACKAGES  — npm packages the handler must require() at runtime
                          (the deployer installs strictly from this list).
"""

from __future__ import annotations

from collections import OrderedDict


# Platform services exposed through ctx. Declare only when the handler body
# calls the corresponding API — undeclared means the handler won't see the
# documentation for that service.
HANDLER_SERVICES: "OrderedDict[str, str]" = OrderedDict(
    [
        (
            "shopify_rest",
            "ctx.shopify.get / post / delete — Shopify Admin REST API at /admin/api/2026-01. Declare when the handler reads or mutates Shopify data via REST.",
        ),
        (
            "shopify_graphql",
            "ctx.shopify.graphql — Shopify Admin GraphQL API. Declare when the handler issues GraphQL queries or mutations (bulk tags, metafields, discountCodeBulkAdd, or joins across entities).",
        ),
        (
            "email",
            (
                "ctx.services.email.send({ to, data }) — transactional / triggered emails. "
                "Templates (subject, body, CTA, brand, {{variable}} substitution) are "
                "owned by the PLATFORM, stored in app_email_configs, and edited by the "
                "merchant in the Ton dashboard's Email tab — NOT in the app's admin UI. "
                "The handler's only contract is passing `to` and runtime values in `data`; "
                "the platform renders the merchant's template against them. `data` keys "
                "MUST be camelCase (customerName, cartValue, recoveryUrl) — the merchant "
                "references them as {{camelCase}} in the template."
            ),
        ),
        (
            "sms",
            "ctx.services.sms.send — outbound SMS to E.164 phone numbers.",
        ),
        (
            "files",
            "ctx.services.files.upload — generate a file (CSV / PDF / XLSX / ZIP / image) and return a signed download URL.",
        ),
        (
            "http",
            "ctx.http.call — outbound HTTPS to third-party REST APIs. Declare only when the handler integrates with a non-Shopify service.",
        ),
        (
            "storefront",
            "ctx.storefront.graphql — server-side Shopify Storefront API reads. Rare: widgets usually read storefront data themselves via host.storefront (see widgetCapabilities). Declare here only when the handler itself needs public storefront data.",
        ),
    ]
)


# npm packages the handler must require() at runtime. Declare only when the
# handler body will actually load the package — unused packages waste install
# time and the deployer installs strictly from this list.
HANDLER_NPM_PACKAGES: "OrderedDict[str, str]" = OrderedDict(
    [
        ("npm:pdfkit", "PDF generation (pdfkit)."),
        ("npm:exceljs", "Excel / XLSX workbook creation (exceljs)."),
        ("npm:csv", "CSV parse and stringify (csv-parse, csv-stringify)."),
        ("npm:qrcode", "QR code generation as PNG buffer or SVG string (qrcode)."),
        (
            "npm:jsbarcode",
            "Barcode SVG generation (jsbarcode, pulls in @xmldom/xmldom).",
        ),
        ("npm:sharp", "Image resize / convert / compose (sharp)."),
        ("npm:handlebars", "Mustache-style HTML/text templating (handlebars)."),
        ("npm:marked", "Markdown → HTML (marked)."),
        ("npm:dayjs", "Date parsing, formatting, arithmetic (dayjs)."),
        ("npm:jszip", "In-memory ZIP archive creation (jszip)."),
        ("npm:uuid", "RFC 4122 UUID generation (uuid)."),
        ("npm:slugify", "URL-safe slug generation (slugify)."),
        ("npm:xml", "XML parse and build (fast-xml-parser)."),
    ]
)


HANDLER_CAPABILITY_REGISTRY: "OrderedDict[str, str]" = OrderedDict(
    list(HANDLER_SERVICES.items()) + list(HANDLER_NPM_PACKAGES.items())
)

ALLOWED_HANDLER_CAPABILITIES: frozenset = frozenset(HANDLER_CAPABILITY_REGISTRY.keys())
