"""
Architect Agent — produces the complete structural plan and binding contracts.

The Architect is the single source of truth for:
  - Which Shopify events and APIs the app touches (shopifyPlan)
  - The exact typed interfaces between all components (appContracts contracts)

Code generators (handler, migration, widget, admin_ui) implement directly from
these contracts. The Handler is the authority on which REST/GraphQL calls to
make — the Architect declares WHAT data is needed, not HOW to fetch it.

Output: { shopifyPlan, appContracts }

Model: claude-sonnet-4-6
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from models.adapter import get_llm, invoke, extract_json
from models.agent_models import get_agent_model
from subagents.prompts.core.architect import (
    INTRO,
    FEASIBILITY,
    COMPLEXITY,
    PLATFORM_GAPS,
    EDGE_CASES,
    build_output_shape,
)
from subagents.prompts.capabilities.email import ARCHITECT_SPEC as EMAIL_SPEC
from subagents.prompts.topics.admin_ui import (
    ARCHITECT as ADMIN_API_CATALOG,
    ARCHITECT_CAPABILITIES as ADMIN_CAPABILITIES_RULES,
)
from subagents.prompts.topics.cron import (
    ARCHITECT as CRON_RULES,
    ARCHITECT_SPLIT as _CRON_SPLIT,
)
from subagents.prompts.topics.db_contracts import ARCHITECT as DB_CONTRACTS
from subagents.prompts.topics.handler import (
    ARCHITECT_CAPABILITIES as HANDLER_CAPABILITIES_RULES,
)
from subagents.prompts.topics.shopify_loop import (
    ARCHITECT as CRON_BATCHING,
    ARCHITECT_SHAPE as CRON_BATCHING_SHAPE,
)
from subagents.prompts.topics.state_machine import (
    ARCHITECT as STATE_MACHINE,
    ARCHITECT_SHAPE as STATE_MACHINE_SHAPE,
)
from subagents.prompts.topics.webhook import (
    ARCHITECT as WEBHOOK_RULES,
    ARCHITECT_SPLIT as _WEBHOOK_SPLIT,
)
from subagents.prompts.topics.widget import (
    ARCHITECT_CAPABILITIES as WIDGET_CAPABILITIES_RULES,
    ARCHITECT_CATALOG as WIDGET_API_CATALOG,
    ARCHITECT_TEMPLATES as WIDGET_TARGET_TEMPLATES,
)
from llm_validations.shopify_ops import load_summary


_SHOPIFY_PLAN_HEADER = """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1 — shopifyPlan
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\
"""

_CONTRACTS_HEADER = """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTRACTS — binding interfaces between components
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\
"""

_NON_NULL_SHAPES_HEADER = """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NON-NULL SHAPES — use exactly when these fields are set:\
"""


_SHOPIFY_CATALOG_INTRO = """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHOPIFY GRAPHQL — available operations
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Two committed schemas the handler is allowed to call:
  Admin GraphQL — shopify.graphql / graphqlPaginate / bulkQuery (writes too)
  Storefront GraphQL — shopify.storefront (server-side public-data reads only)

When the app's data needs map onto operations below, name them in
appContracts.shopifyGraphqlOperations so the handler is given a tight
whitelist instead of the full schema. ONLY operation names from the
indexes below are valid; anything else fails plan validation.\
"""


def _build_shopify_catalog_section() -> str:
    """
    Concatenate the admin + storefront full operation indexes for the
    architect prompt. Both are loaded from the committed catalogs; missing
    catalogs degrade gracefully via load_summary's placeholder.
    """
    admin = load_summary("admin")
    storefront = load_summary("storefront")
    return _SHOPIFY_CATALOG_INTRO + "\n\n" + admin + "\n\n" + storefront


def _build_system_prompt(archetype: str) -> tuple[str, str]:
    """
    Assemble the architect system prompt for the given archetype.

    Returns (shared, tail) where shared is byte-identical across all archetypes
    (cache-friendly) and tail carries the archetype-specific widget/admin sections
    plus the output format example.
    """
    has_widget = "storefront" in archetype
    has_admin = "admin" in archetype

    # Split each topic's architect block so the webhookTopics / cronSchedule
    # field rules sit under SECTION 1 (shopifyPlan) and the *Contract rules
    # sit under the CONTRACTS block. Each topic's ARCHITECT string is
    # "<fieldRule>\n\n<contractRule>" — one split() yields both halves.
    webhook_topics_rule, webhook_contract_rule = WEBHOOK_RULES.split(_WEBHOOK_SPLIT, 1)
    cron_schedule_rule, cron_contract_rule = CRON_RULES.split(_CRON_SPLIT, 1)

    shared_sections = [
        INTRO,
        _SHOPIFY_PLAN_HEADER,
        webhook_topics_rule,
        cron_schedule_rule,
        FEASIBILITY,
        COMPLEXITY,
        STATE_MACHINE,
        PLATFORM_GAPS,
        HANDLER_CAPABILITIES_RULES,
        _build_shopify_catalog_section(),
        EMAIL_SPEC,
        CRON_BATCHING,
        EDGE_CASES,
        _CONTRACTS_HEADER,
        DB_CONTRACTS,
        webhook_contract_rule,
        cron_contract_rule,
    ]

    tail_sections: list[str] = []
    if has_widget:
        tail_sections += [
            WIDGET_TARGET_TEMPLATES,
            WIDGET_API_CATALOG,
            WIDGET_CAPABILITIES_RULES,
        ]
    if has_admin:
        tail_sections += [ADMIN_API_CATALOG, ADMIN_CAPABILITIES_RULES]
    tail_sections += [
        _NON_NULL_SHAPES_HEADER,
        STATE_MACHINE_SHAPE,
        CRON_BATCHING_SHAPE,
        build_output_shape(archetype),
    ]

    shared = "\n\n".join(shared_sections) + "\n\n"
    tail = "\n\n".join(tail_sections)
    return shared, tail


_ARCHITECT_USER_TEMPLATE = """{error_block}Merchant request: {prompt}

Feature intent:
{intent_json}

App archetype: {archetype}
{quality_brief_section}{component_descriptions_section}
Produce the structural plan and binding contracts."""


def run_architect_agent(
    prompt: str,
    intent: Dict[str, Any],
    app_archetype: str,
    validation_errors: Optional[List[str]] = None,
) -> Tuple[Dict[str, Any], int, int]:
    """
    Architect Agent: produces shopifyPlan + appContracts with typed contracts.

    Parameters
    ----------
    prompt:
        Original merchant prompt.
    intent:
        Parsed intent from run_product_agent().
    app_archetype:
        "storefront_backend" | "storefront_backend_admin" | "backend" | "backend_admin"
    validation_errors:
        Errors from validate_architect_plan() on a prior attempt, or None.

    Returns
    -------
    dict with keys: shopifyPlan, appContracts
    """
    error_block = ""
    if validation_errors:
        lines = "\n".join(f"  - {e}" for e in validation_errors)
        error_block = (
            f"PREVIOUS ATTEMPT FAILED VALIDATION:\n{lines}\n"
            f"Fix ALL listed errors in this attempt.\n\n"
        )

    quality_brief = intent.get("qualityBrief", "")
    quality_brief_section = (
        f"\nQuality brief (use this to inform edgeCases and uxExpectations):\n{quality_brief}\n"
        if quality_brief
        else ""
    )

    # Merchant-added component descriptions — these are provided when the merchant
    # manually added a widget or admin panel that the AI didn't originally suggest.
    # The descriptions explain what the merchant expects from that component.
    comp_parts = []
    widget_desc = intent.get("widgetDescription", "")
    admin_desc = intent.get("adminDescription", "")
    if widget_desc:
        comp_parts.append(f"  Widget (merchant-added): {widget_desc}")
    if admin_desc:
        comp_parts.append(f"  Admin panel (merchant-added): {admin_desc}")
    component_descriptions_section = (
        "\nMerchant-provided component descriptions (components added beyond the AI suggestion — "
        "incorporate these requirements into the contracts):\n"
        + "\n".join(comp_parts)
        + "\n"
        if comp_parts
        else ""
    )

    user = _ARCHITECT_USER_TEMPLATE.format(
        error_block=error_block,
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
        archetype=app_archetype,
        quality_brief_section=quality_brief_section,
        component_descriptions_section=component_descriptions_section,
    )

    system_shared, system_tail = _build_system_prompt(app_archetype)
    system_segments = [system_shared, system_tail]
    llm = get_llm(model=get_agent_model("architect"), max_tokens=4000)
    current_user = user
    total_in = 0
    total_out = 0
    for attempt in range(2):
        result = invoke(llm, system_segments, current_user)
        total_in += result.input_tokens
        total_out += result.output_tokens
        raw = extract_json(result.content)
        try:
            return json.loads(raw), total_in, total_out
        except json.JSONDecodeError as e:
            if attempt == 1:
                raise
            current_user = (
                f"PREVIOUS ATTEMPT RETURNED INVALID JSON:\n  {e}\n"
                f"Output ONLY a valid JSON object. No markdown fences, no trailing commas, "
                f"no comments inside JSON.\n\n"
            ) + user
