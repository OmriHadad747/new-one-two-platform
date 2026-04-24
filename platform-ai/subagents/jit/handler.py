"""
Shared JIT assembly for the handler prompt surface.

Produces the per-run block of capability docs + topic HANDLER sections that
apply to a given plan. Used by:
  - handler_agent.py — first-run codegen
  - revision_agent.py — so revisions see the exact same handler surface the
    handler saw at first-run time

Trigger gates:
  - Capability docs: each capability declared in handlerCapabilities
  - Webhook handler docs: when shopifyPlan.webhookTopics is non-empty
  - Cron handler docs: when shopifyPlan.cronSchedule is non-null
  - State machine handler docs: when appContracts.stateMachine is non-null
  - Cron batching handler docs: when appContracts.cronBatching.required is true
  - Widget handler docs: when widgetApiCatalog is non-empty
  - Widget-storefront handler docs: when widgetApiCatalog is [] (storefront app
    whose widget reads Shopify directly, no backend widget routes)
  - Admin handler docs: when adminApiCatalog is non-empty
"""

from __future__ import annotations

from typing import Any, Dict, List

from subagents.prompts.capabilities import HANDLER_CAPABILITY_DOCS
from subagents.prompts.topics.admin_ui import HANDLER as HARNESS_SECTION_ADMIN
from subagents.prompts.topics.cron import HANDLER as HARNESS_SECTION_CRON
from subagents.prompts.topics.shopify_loop import HANDLER as HARNESS_SECTION_CRON_BATCHING
from subagents.prompts.topics.state_machine import HANDLER as HARNESS_SECTION_STATE_MACHINE
from subagents.prompts.topics.webhook import HANDLER as HARNESS_SECTION_WEBHOOK
from subagents.prompts.topics.widget import (
    HANDLER as HARNESS_SECTION_WIDGET,
    HANDLER_STOREFRONT as HARNESS_SECTION_WIDGET_STOREFRONT,
)


def build_handler_jit_sections(
    plan: Dict[str, Any],
    widget_catalog: List[Dict[str, str]],
) -> str:
    """
    Assemble capability docs + trigger-gated handler topic sections for a
    given plan. Returns a string ready to concatenate into a user prompt.

    `widget_catalog` is the widgetApiCatalog list already extracted from the
    plan by the caller (for handler_agent.py, this comes from
    ctx.platform_api_catalog).
    """
    shopify = plan.get("shopifyPlan") or {}
    impl = plan.get("appContracts") or {}
    sm = impl.get("stateMachine") or {}
    batching = impl.get("cronBatching") or {}

    sections: List[str] = []

    # Capability docs — registry-driven, preserves registration order for
    # cache stability across runs with the same declared set.
    declared = set(impl.get("handlerCapabilities") or [])
    for cap_name, docs in HANDLER_CAPABILITY_DOCS.items():
        if cap_name in declared and docs:
            sections.append(docs)

    # Trigger-gated topic sections.
    if shopify.get("webhookTopics"):
        sections.append(HARNESS_SECTION_WEBHOOK)

    if shopify.get("cronSchedule"):
        sections.append(HARNESS_SECTION_CRON)

    if sm and isinstance(sm, dict):
        sections.append(HARNESS_SECTION_STATE_MACHINE)

    # Inject the "no Shopify in per-item loops" pattern whenever the handler
    # uses shopify_graphql — the rule is universal to any Shopify-using path
    # (cron, webhook enrichment, state machines), not just cronBatching.
    if batching.get("required") or "shopify_graphql" in declared:
        sections.append(HARNESS_SECTION_CRON_BATCHING)
        # When the architect specified a batching plan for THIS app, pass the
        # prose through so the handler knows exactly what to pre-fetch rather
        # than re-deriving it from handlerMustProduce.
        description = (batching.get("description") or "").strip()
        if description:
            sections.append(
                "CRON BATCHING — architect's plan for this app:\n"
                f"{description}"
            )

    if widget_catalog:
        sections.append(HARNESS_SECTION_WIDGET)

    # widgetApiCatalog == [] means a storefront app whose widget reads
    # Shopify directly — the handler gets no /widget/* calls.
    if impl.get("widgetApiCatalog") is not None and not widget_catalog:
        sections.append(HARNESS_SECTION_WIDGET_STOREFRONT)

    if impl.get("adminApiCatalog"):
        sections.append(HARNESS_SECTION_ADMIN)

    return "\n\n".join(sections) + ("\n\n" if sections else "")
