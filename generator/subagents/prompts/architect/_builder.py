"""
Architect system prompt builder — assembles modular sections into a complete system prompt.

Assembly rule:
  Always:  _core + _state_machine + _cron_batching + _data_contracts
  Widget:  + _widget   (storefront_backend, storefront_backend_admin)
  Admin:   + _admin    (backend_admin, storefront_backend_admin)
  Always:  + _output_shape.build_output_shape(archetype)
"""

from ._core import INTRO, SHOPIFY_PLAN, FEASIBILITY, COMPLEXITY, PLATFORM_GAPS, EDGE_CASES
from ._state_machine import STATE_MACHINE, STATE_MACHINE_SHAPE
from ._cron_batching import CRON_BATCHING, CRON_BATCHING_SHAPE
from ._data_contracts import CONTRACTS_HEADER, DB_CONTRACTS, WEBHOOK_CONTRACT, CRON_CONTRACT
from ._widget import WIDGET_TARGET_TEMPLATES, WIDGET_API_CATALOG
from ._admin import ADMIN_API_CATALOG
from ._output_shape import build_output_shape

_NON_NULL_SHAPES_HEADER = """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NON-NULL SHAPES — use exactly when these fields are set:\
"""


def build_system_prompt(archetype: str) -> str:
    """
    Assemble the architect system prompt for the given app archetype.

    archetype: "backend" | "backend_admin" | "storefront_backend" | "storefront_backend_admin"
    """
    has_widget = "storefront" in archetype
    has_admin = "admin" in archetype

    sections = [
        INTRO,
        SHOPIFY_PLAN,
        FEASIBILITY,
        COMPLEXITY,
        STATE_MACHINE,
        PLATFORM_GAPS,
        CRON_BATCHING,
        EDGE_CASES,
        CONTRACTS_HEADER,
        DB_CONTRACTS,
        WEBHOOK_CONTRACT,
        CRON_CONTRACT,
    ]

    if has_widget:
        sections += [WIDGET_TARGET_TEMPLATES, WIDGET_API_CATALOG]

    if has_admin:
        sections.append(ADMIN_API_CATALOG)

    sections += [
        _NON_NULL_SHAPES_HEADER,
        STATE_MACHINE_SHAPE,
        CRON_BATCHING_SHAPE,
        build_output_shape(archetype),
    ]

    return "\n\n".join(sections)
