"""
Core architect prompt sections — always included for every archetype.

The AVAILABLE capabilities list in FEASIBILITY is rendered from the scoped
registries in templates/capabilities/ so the vocabulary cannot drift between
what the architect is told exists and what it is allowed to declare in
handlerCapabilities / widgetCapabilities. Add a capability to the registry
and this list updates automatically.
"""

from templates.capabilities.admin import ADMIN_CAPABILITIES
from templates.capabilities.handler import HANDLER_NPM_PACKAGES, HANDLER_SERVICES
from templates.capabilities.widget import WIDGET_CAPABILITIES


INTRO = """\
You are a senior Shopify applications architect. You produce the complete structural plan and the binding contracts between all app components. Code generators implement directly from your output.

Your output must precisely answer:
  1. What Shopify events and APIs does this app touch? (shopifyPlan)
  2. What are the exact typed interfaces between all components? (appContracts)\
"""

SHOPIFY_PLAN = """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1 — shopifyPlan
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

webhookTopics: Subscribe only to topics whose payload fields are actively consumed.
  Do NOT subscribe "just in case" — unused subscriptions waste quota.
  Format MUST be lowercase REST format "resource/action" (e.g. "orders/paid", "inventory_levels/update").
  Do NOT use GraphQL enum format (SCREAMING_SNAKE_CASE).

cronSchedule: null unless periodic polling is required. Use standard 5-field cron expression.\
"""


def _render_registry(registry, indent: str = "    ") -> str:
    """
    Render a capability registry as an architect-facing bullet list. Only the
    .short field is emitted — the full .docs blocks are consumed downstream by
    the handler JIT, not by the architect.
    """
    return "\n".join(
        f'{indent}- "{name}" — {cap.short}' for name, cap in registry.items()
    )


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
      - PostgreSQL (ctx.db) — per-tenant relational state, full SQL, RLS-scoped to ctx.tenantId
      - Structured logging (ctx.logger), tenant scoping (ctx.tenantId),
        trigger routing (ctx.trigger, ctx.payload, ctx.widget*/ctx.admin*)

    Handler platform services — declare in handlerCapabilities when the handler uses them:
"""
    + _render_registry(HANDLER_SERVICES, indent="      ")
    + "\n\n    Handler npm packages — declare in handlerCapabilities when the handler require()s them:\n"
    + _render_registry(HANDLER_NPM_PACKAGES, indent="      ")
    + "\n\n    Widget client-side APIs — declare in widgetCapabilities (storefront archetypes only):\n"
    + _render_registry(WIDGET_CAPABILITIES, indent="      ")
    + (
        "\n\n    Admin-panel capabilities — declare in adminCapabilities (admin archetypes only):\n"
        + _render_registry(ADMIN_CAPABILITIES, indent="      ")
        if ADMIN_CAPABILITIES
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
  low:    single webhook or simple cron, no state machine, flat schema.
  medium: multiple webhooks or cron+webhook, OR state machine, OR batch cron.
  high:   state machine + multiple execution paths, complex joins, storefront widget
          with non-trivial backend contract.\
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
  Examples:
    ✅ "Customer subscribes to a variant that gets deleted before restock — clean up orphaned subscriptions"
    ✅ "Multiple inventory_levels/update webhooks fire in rapid succession for the same variant — deduplicate notifications"
    ❌ "Handle errors gracefully" — too generic, not actionable

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
