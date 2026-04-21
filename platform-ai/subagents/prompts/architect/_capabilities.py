"""
Capability declaration prompt sections.

The capability vocabulary itself is rendered in FEASIBILITY (see _core.py)
from the scoped registries in templates/capabilities/. The sections below
only carry the RULES for how to populate handlerCapabilities and
widgetCapabilities — they reference the AVAILABLE list above for the
allowed values so the vocabulary is never duplicated in the prompt.

Four exported sections:
  HANDLER_CAPABILITIES_RULES  — always shown (every archetype has a handler).
                          Goes in the shared (archetype-independent) prefix.
  EMAIL_SPEC            — always shown; coupled to handlerCapabilities.
                          Required when "email" is declared. Lives in the
                          shared prefix right after HANDLER_CAPABILITIES_RULES.
  WIDGET_CAPABILITIES_RULES   — only shown for storefront archetypes. Goes in the
                          archetype tail alongside the other widget-specific
                          prompt sections.
  ADMIN_CAPABILITIES_RULES    — only shown for admin archetypes. Goes in the
                          archetype tail alongside ADMIN_API_CATALOG.
                          The registry is empty today (see
                          templates/capabilities/admin.py) so the section's
                          rule is simply "declare [] until caps are added";
                          when the first admin capability appears there, the
                          rules below should grow to describe when to declare it.
"""


HANDLER_CAPABILITIES_RULES = """\
handlerCapabilities: Closed-vocabulary list of platform services and npm
  packages the HANDLER will use at runtime. The handler generator JIT-injects
  only the docs for declared capabilities — undeclared = the handler does
  not see that API's docs.

  Allowed values: the "Handler platform services" and "Handler npm packages"
  entries in the AVAILABLE list above. Unknown strings fail validation.

  RULES:
  - Declare ONLY what the handler will actually call or import. Over-
    declaration wastes prompt budget; under-declaration ships a handler
    missing docs for the API it needs.
  - Declare "shopify_rest" and/or "shopify_graphql" based on which Shopify
    API the handler calls. Most handlers declare at least one; a DB-only
    admin panel with no Shopify reads declares neither.
  - Declare "files" when the handler produces a downloadable artefact.
    Declaring a document-format npm package (npm:pdfkit / npm:exceljs /
    npm:csv) without "files" is inconsistent — the output still needs
    the /services/files/upload service to hand the buffer to.
  - Declare "http" only for non-Shopify external services — never for
    Shopify REST/GraphQL (those belong under shopify_rest / shopify_graphql).
  - npm:* entries gate whether the handler may import the package — all
    packages are pre-installed in the handler template's package.json,
    so the architect's declaration is the ONLY gate deciding which
    imports are legal in the generated TypeScript.
  - Keep [] only when the handler needs nothing beyond the always-on
    surface (`sql`, `platform.*`, req.platform, console logging)
    — rare."""


EMAIL_SPEC = """\
emailSpec: Architect output field describing the email the handler will send.
  See the "email" entry in the AVAILABLE capabilities list above for what
  the /services/email/send platform service actually does — this field
  only captures the architect's classification + intent for that send.

  Shape:
    null if "email" is not in handlerCapabilities.
    Otherwise: { "type": "transactional" | "marketing",
                 "purpose": "<one present-tense sentence: what fires the email and when>" }

  type:
    - "transactional" — triggered by a customer action (order confirmation,
      cart recovery, shipping update, password reset). Default for Shopify
      automation apps.
    - "marketing" — unsolicited outreach (newsletter, win-back, promo blast).
      Only when the feature IS explicitly a marketing send.

  purpose: drives the handler's starter subject/body copy — the more
  concrete, the better what the merchant sees on first open.

  COUPLING — when emailSpec is set, the handlerMustProduce on whichever
  contract feeds the send (webhookContract or cronContract) MUST enumerate
  every data field the merchant will reference in the email template:
  recipient display name for personalization, the full content the email
  describes (not only an ID or sample), and any concrete action URL the CTA
  will point to. Listing only what the DB needs leaves the handler with an
  impoverished variable set."""


WIDGET_CAPABILITIES_RULES = """\
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


ADMIN_CAPABILITIES_RULES = """\
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
