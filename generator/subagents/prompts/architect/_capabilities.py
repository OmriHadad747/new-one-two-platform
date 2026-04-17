"""
Capability declaration prompt sections.

The capability vocabulary itself is rendered in FEASIBILITY (see _core.py)
from the scoped registries in templates/capabilities/. The sections below
only carry the RULES for how to populate handlerCapabilities and
widgetCapabilities — they reference the AVAILABLE list above for the
allowed values so the vocabulary is never duplicated in the prompt.

Four exported sections:
  HANDLER_CAPABILITIES  — always shown (every archetype has a handler).
                          Goes in the shared (archetype-independent) prefix.
  EMAIL_SPEC            — always shown; coupled to handlerCapabilities.
                          Required when "email" is declared. Lives in the
                          shared prefix right after HANDLER_CAPABILITIES.
  WIDGET_CAPABILITIES   — only shown for storefront archetypes. Goes in the
                          archetype tail alongside the other widget-specific
                          prompt sections.
  ADMIN_CAPABILITIES    — only shown for admin archetypes. Goes in the
                          archetype tail alongside ADMIN_API_CATALOG.
                          The registry is empty today (see
                          templates/capabilities/admin.py) so the section's
                          rule is simply "declare [] until caps are added";
                          when the first admin capability appears there, the
                          rules below should grow to describe when to declare it.
"""


HANDLER_CAPABILITIES = """\
handlerCapabilities: Closed-vocabulary list declaring which platform services
  and npm packages the HANDLER will actually use at runtime. The handler
  generator consumes this to include only the harness prompt sections and npm
  package instructions it needs — undeclared capabilities mean the handler
  will not see the relevant API documentation.

  Allowed values: the "Handler platform services" and "Handler npm packages"
  entries in the AVAILABLE capabilities list above. Do NOT invent values;
  unknown strings fail validation.

  RULES:
  - Declare ONLY what the handler will actually call or require(). Do not pad
    with speculative items: an over-declaration wastes install time and
    prompt budget; an under-declaration produces a handler missing the API
    it needs.
  - Declare "shopify_rest" and/or "shopify_graphql" based on which Shopify
    APIs the handler actually calls. Most handlers declare at least one;
    a DB-only admin panel with no Shopify reads declares neither.
  - Declare "email" when the handler calls ctx.services.email.send. Email is
    an AVAILABLE capability — do NOT list it in platformGaps. Same for "sms"
    and "files": these are available services; platformGaps is for capabilities
    the platform cannot deliver at all.
  - Declare "files" when the handler produces any downloadable artefact
    (CSV export, PDF receipt, XLSX report). Declaring a document-format npm
    package (npm:pdfkit / npm:exceljs / npm:csv) without "files" is
    inconsistent — the output still needs ctx.services.files.upload.
  - Declare "http" only for calls to a non-Shopify third-party service. Do
    NOT declare it for Shopify REST/GraphQL — those belong under
    shopify_rest / shopify_graphql.
  - Each npm:* entry implies that the handler's top-level npmPackages array
    will include the corresponding package. Declare only what require()-d
    code actually uses.
  - Keep the array [] only when the handler truly needs nothing beyond the
    always-on surface (ctx.db, ctx.logger, ctx.tenantId, ctx.trigger) —
    rare in practice."""


EMAIL_SPEC = """\
emailSpec: Structured spec for the email the handler will send. MUST be
  non-null whenever "email" is declared in handlerCapabilities, and MUST be
  null otherwise. Consumed downstream by the Email tab (to pre-select email
  type) and by the Handler prompt (to guide starter-content generation).

  Shape when set:
    {
      "type": "transactional" | "marketing",
      "purpose": "<one-line description of when this email is sent and why>"
    }

  RULES:
  - type = "transactional" when the email is triggered by a customer action
    (order confirmation, abandoned-cart recovery, shipping update, receipt,
    password reset, subscription confirmation, etc.). Transactional is the
    default for app-driven Shopify automations.
  - type = "marketing" only for unsolicited merchant-to-customer outreach
    (newsletter, win-back campaign, promotional blast, announcement). These
    require customer consent and unsubscribe handling — declare marketing
    ONLY when the feature is explicitly a marketing send.
  - purpose: one sentence, present tense. Describe WHAT the email is and
    WHEN it fires. Example: "Sent when a customer abandons a cart with
    items totalling $50+, one hour after cart last-updated timestamp."
    This drives the handler's starter subject/body copy — the more concrete,
    the better the starter content the merchant sees on first open.
  - Keep this null if the handler does not send email. Do NOT invent an
    emailSpec to document hypothetical future email sends."""


WIDGET_CAPABILITIES = """\
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
    handler via host.call — the common case."""


ADMIN_CAPABILITIES = """\
adminCapabilities: Closed-vocabulary list declaring which App Bridge / admin
  APIs the ADMIN UI uses beyond the always-on bridge.call(path, body) channel
  to the handler. null for non-admin archetypes.

  Allowed values: the "Admin-panel capabilities" entries in the AVAILABLE
  capabilities list above. No declarable admin capabilities exist today,
  so the array is [] for every admin archetype until the registry grows.

  RULES:
  - MUST be null for backend and storefront_backend archetypes — those
    archetypes have no admin UI, so there are no admin capabilities to
    declare. Use null, not [].
  - Keep the array [] for admin archetypes today — no declarable admin
    capabilities exist yet. When the AVAILABLE list adds admin entries
    (e.g. "toast", "resource_picker"), declare them here if the admin UI
    uses them."""
