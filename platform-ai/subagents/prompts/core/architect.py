"""
Core architect prompt sections — always included for every archetype, plus
the archetype-aware OUTPUT FORMAT builder.

The AVAILABLE capabilities list in FEASIBILITY is rendered from the scoped
registries in subagents/prompts/capabilities/ so the vocabulary cannot drift between
what the architect is told exists and what it is allowed to declare in
handlerCapabilities / widgetCapabilities. Add a capability to the registry
and this list updates automatically.

build_output_shape(archetype) tailors the JSON output example so the model
only sees fields relevant to the surfaces it must actually populate —
backend apps never see widgetApiCatalog, storefront-only apps see null
adminApiCatalog, etc.
"""

from subagents.prompts.capabilities import (
    ADMIN_ARCHITECT_ENTRIES,
    HANDLER_SERVICES,
    NPM,
    WIDGET_ARCHITECT_ENTRIES,
    render_architect,
)


INTRO = """\
You are a senior Shopify applications architect. You produce the complete structural plan and the binding contracts between all app components. Code generators implement directly from your output.

Your output must precisely answer:
  1. What Shopify events and APIs does this app touch? (shopifyPlan)
  2. What are the exact typed interfaces between all components? (appContracts)\
"""

FEASIBILITY = (
    """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — appContracts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

feasibility: Is this app BUILDABLE with the platform's capability surface?
  Set "feasible" in almost all cases. Set "blocked" ONLY when the core value cannot
  be delivered without a capability that is genuinely absent AND has no valid
  in-platform substitute.

  AVAILABLE capabilities — these and ONLY these may appear in platformGaps
  mitigations, and the named entries below are ALSO the allowed values for
  handlerCapabilities / widgetCapabilities / adminCapabilities:

    Always available (no declaration needed — every app gets these):
      - PostgreSQL (`sql` tagged template from ../lib/db.js) — per-tenant
        state, full SQL. Each tenant has its own schema; search_path is
        pinned at deploy time so bare table names Just Work.
      - Express trust-domain routers: /admin/*, /webhook/*, /widget/*.
        req.platform carries { tenantId, appId, shopDomain, requestId,
        accessToken? } on every verified call.
      - Structured stdout logs (console.log/warn/error → Cloud Logging).
      - Cron dispatcher: architect-declared cronSchedule becomes a
        `jobs` map in src/routes/cron.ts; the template's cron runner
        polls a queue, retries failures, and handles multi-instance
        safety via FOR UPDATE SKIP LOCKED.

    Handler platform services — declare in handlerCapabilities when the handler uses them:
"""
    + render_architect(
        {name: entry["architect"] for name, entry in HANDLER_SERVICES.items()},
        indent="      ",
    )
    + "\n\n    Handler npm packages — declare in handlerCapabilities when the handler imports them:\n"
    + render_architect(
        {name: entry["architect"] for name, entry in NPM.items()},
        indent="      ",
    )
    + "\n\n    Widget client-side APIs — declare in widgetCapabilities (storefront archetypes only):\n"
    + render_architect(WIDGET_ARCHITECT_ENTRIES, indent="      ")
    + (
        "\n\n    Admin-panel capabilities — declare in adminCapabilities (admin archetypes only):\n"
        + render_architect(ADMIN_ARCHITECT_ENTRIES, indent="      ")
        if ADMIN_ARCHITECT_ENTRIES
        else "\n\n    Admin-panel capabilities — adminCapabilities is [] today (no declarable admin capabilities yet; reserved for future growth)."
    )
    + """

  NOT available — NEVER reference these in platformGaps mitigations:
    - push notifications, Slack, WhatsApp, phone/voice calls, in-app real-time alerts
    - inbound webhooks from arbitrary sources, WebSockets, real-time bidirectional streams
    - native binaries, GPU processing

  When "blocked": set blockedReason to a single merchant-friendly sentence."""
)

COMPLEXITY = """\
complexity: "low" | "medium" | "high"
  Downstream code generators enable extended thinking when complexity="high".
  Label the plan using concrete criteria — avoid subjective words like
  "complex" or "non-trivial" without a structural anchor.

  HIGH — set when ANY of:
    - stateMachine is declared (tracked state + transitions)
    - cronBatching.required is true (bulk-fetch discipline)
    - 2+ entries in shopifyPlan.webhookTopics (multi-event coordination)
    - BOTH widgetApiCatalog AND adminApiCatalog are present (cross-surface
      contract the handler must keep consistent for two different callers)
    - rare escape hatch: the feature has a genuinely intricate semantic
      contract the structural signals miss (e.g. multi-step reconciliation,
      non-obvious idempotency across multiple entities). Use sparingly —
      only when the structural triggers clearly undersell real difficulty.

  MEDIUM — single webhook OR single cron with a handler that must pre-fetch
  Shopify data, enforce idempotency, or update multiple columns in one write.
  No state machine, no bulk-fetch discipline, no cross-surface coordination.

  LOW — single trigger, flat schema, straightforward CRUD-shaped write. No
  state, no pre-fetch choreography, no cross-surface coupling.

  When in doubt between two levels, choose the higher one — extended thinking
  is cheap relative to a missed-constraint regen.\
"""

PLATFORM_GAPS = """\
platformGaps: Secondary capabilities the app requests that the platform cannot deliver
  directly, but for which a valid in-platform substitute exists.
  Each item MUST use exactly these two fields:
    { "gap": "<what the platform cannot do>", "mitigation": "<concrete in-platform substitute>" }
  RULES — violations will produce unworkable handler code:
  - Only declare a gap when you have a concrete in-platform mitigation.
  - The mitigation MUST use ONLY capabilities from the AVAILABLE list above.
  - NEVER invent a mitigation that requires a capability not in that list.
  - The handler runs as a single synchronous async/await function — it cannot spawn
    background workers, fork processes, or schedule deferred jobs. When an operation
    is long-running, the mitigation must be DB-state tracking with synchronous processing
    (e.g. status column updated in-place), NOT "background processing" or "async workers".
  - If no valid in-platform mitigation exists for something the core value depends on,
    set feasibility to "blocked" instead.
  - Keep this [] when there are no genuine gaps — do not pad with speculative items.
  - When a gap has a direct UX implication (e.g. async delivery means the widget cannot
    confirm action completion), include that in the mitigation description — the widget
    generator uses it to shape the UX.\
"""

EDGE_CASES = """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUALITY CONTEXT — edge cases and UX expectations
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

edgeCases: Array of 3–6 specific edge cases the handler MUST handle for this
  particular app type. These are passed directly to the code generators.
  Each entry is a short sentence describing a concrete scenario.
  Focus on scenarios that are:
  - Common in production Shopify stores (deleted products, duplicate webhooks,
    guest customers, null fields in payloads, concurrent requests)
  - Specific to THIS app's domain (not generic "handle errors" advice)
  - Likely to cause data corruption, duplicate actions, or broken UX if ignored
  Describe scenarios SEMANTICALLY — never cite literal Shopify API enum
  values ("fulfilled", "subscribed", "paid", etc.). The handler picks the
  real enum from the Shopify response; a guessed value silently no-ops the
  guard when it doesn't match Shopify's response.
  Examples:
    ✅ "Duplicate webhooks for the same resource — deduplicate writes"
    ❌ "Handle errors gracefully" — too generic, not actionable
    ❌ "<resource>.<field> == '<literal_enum>' — skip" (literal enum)

uxExpectations: Describes what good UX looks like for each surface this app has.
  Informs widget and admin UI generators about the EXPERIENCE, not just the data contract.
  {
    "storefront": "<1-2 sentences: what the customer experience should feel like>" | null,
    "admin": "<1-2 sentences: what the merchant dashboard should prioritize>" | null
  }
  Set a field to null when that surface does not exist for this archetype.
  Be specific to the app type:
    ✅ "Widget should feel lightweight — one-click subscribe with email pre-filled for logged-in customers. Show subscriber count as social proof."
    ❌ "Widget should look nice" — not actionable\
"""


# ── Output format — archetype-aware ────────────────────────────────────────────
# Placeholders use angle-bracket syntax (e.g. "<table_name>", "/<widget_route>")
# to discourage the model from echoing them verbatim.

_WIDGET_EXAMPLE = """\
    "widgetTargetTemplates": ["product"],
    "widgetApiCatalog": [
      {
        "path": "/<widget_route>",
        "method": "POST",
        "requestShape": { "<inputField>": "string" },
        "responseShape": { "<resultField>": "boolean" }
      }
    ],
    "widgetCapabilities": [],"""

_WIDGET_NULL = """\
    "widgetTargetTemplates": null,
    "widgetApiCatalog": null,
    "widgetCapabilities": null,"""

_ADMIN_EXAMPLE = """\
    "adminApiCatalog": [
      {
        "path": "/<admin_route>",
        "method": "GET",
        "requestShape": { "page": "number", "page_size": "number" },
        "responseShape": { "items": [], "total": "number", "page": "number", "page_size": "number" }
      }
    ],
    "adminCapabilities": []"""

_ADMIN_NULL = """\
    "adminApiCatalog": null,
    "adminCapabilities": null"""

_UX_STOREFRONT_PLACEHOLDER = '"<what the customer experience should feel like>"'
_UX_ADMIN_PLACEHOLDER = '"<what the merchant dashboard should prioritize>"'


def build_output_shape(archetype: str) -> str:
    """
    Returns the OUTPUT FORMAT section tailored to the given archetype.

    Fields for surfaces that do not exist in the archetype are shown as null —
    the LLM must emit every key in the schema.
    """
    has_widget = "storefront" in archetype
    has_admin = "admin" in archetype

    widget_block = _WIDGET_EXAMPLE if has_widget else _WIDGET_NULL
    admin_block = _ADMIN_EXAMPLE if has_admin else _ADMIN_NULL
    ux_storefront = _UX_STOREFRONT_PLACEHOLDER if has_widget else "null"
    ux_admin = _UX_ADMIN_PLACEHOLDER if has_admin else "null"

    return (
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "OUTPUT FORMAT — respond ONLY with this JSON (no markdown fences, no explanation):\n"
        "Replace every <placeholder> token in the example below (paths like /<widget_route>, "
        "field names like <inputField>, table/column names like <table_name>) with identifiers "
        "specific to THIS app. Do NOT echo angle-bracket placeholders verbatim.\n"
        "{\n"
        '  "shopifyPlan": {\n'
        '    "webhookTopics": [],\n'
        '    "cronSchedule": null\n'
        "  },\n"
        '  "appContracts": {\n'
        '    "feasibility": "feasible",\n'
        '    "blockedReason": null,\n'
        '    "complexity": "low",\n'
        '    "edgeCases": ["<specific edge case 1>", "<specific edge case 2>", "...3-6 total"],\n'
        '    "uxExpectations": {\n'
        f'      "storefront": {ux_storefront},\n'
        f'      "admin": {ux_admin}\n'
        "    },\n"
        '    "stateMachine": null,\n'
        '    "platformGaps": [],\n'
        '    "handlerCapabilities": ["shopify_graphql", "email"],\n'
        '    "shopifyGraphqlOperations": {\n'
        '      "admin": ["<adminQueryOrMutation_1>", "<adminQueryOrMutation_2>"],\n'
        '      "storefront": []\n'
        "    },\n"
        '    "emailSpec": { "type": "transactional", "purpose": "<one-line description of when and why this email fires>" },\n'
        '    "cronBatching": null,\n'
        '    "dbContracts": [\n'
        "      {\n"
        '        "table": "<table_name>",\n'
        '        "columns": [\n'
        '          { "name": "id",               "type": "UUID",        "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()" },\n'
        '          { "name": "<string_column>",  "type": "TEXT",        "constraints": "NOT NULL" },\n'
        '          { "name": "<numeric_column>", "type": "BIGINT",      "constraints": "NULL" },\n'
        '          { "name": "created_at",       "type": "TIMESTAMPTZ", "constraints": "NOT NULL DEFAULT now()" }\n'
        "        ],\n"
        '        "uniqueConstraint": null,\n'
        '        "indexes": ["<string_column>"]\n'
        "      }\n"
        "    ],\n"
        '    "webhookContract": null,\n'
        '    "cronContract": null,\n'
        f"{widget_block}\n"
        f"{admin_block}\n"
        "  }\n"
        "}"
    )
