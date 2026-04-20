"""
Architect system prompt builder — assembles modular sections into a complete system prompt.

Assembly rule:
  Shared (identical across every archetype, cacheable):
    _core + _state_machine + _cron_batching + _data_contracts
    + HANDLER_CAPABILITIES_RULES (every app has a handler)
  Archetype tail (varies per archetype):
    Widget:  _widget + WIDGET_CAPABILITIES_RULES  (storefront_backend, storefront_backend_admin)
    Admin:   _admin  + ADMIN_CAPABILITIES_RULES   (backend_admin, storefront_backend_admin)
    NON-NULL SHAPES header + state-machine/cron shape snippets
    _output_shape.build_output_shape(archetype)

The builder returns (shared, tail). Callers may concatenate them for a single
string prompt, or pass them as a list to models.adapter.invoke() so the shared
prefix caches across archetype changes while the tail caches per-archetype
(when large enough to qualify for Anthropic's prompt cache).
"""

from ._capabilities import (
    ADMIN_CAPABILITIES_RULES,
    EMAIL_SPEC,
    HANDLER_CAPABILITIES_RULES,
    WIDGET_CAPABILITIES_RULES,
)
from ._core import (
    INTRO,
    SHOPIFY_PLAN,
    FEASIBILITY,
    COMPLEXITY,
    PLATFORM_GAPS,
    EDGE_CASES,
)
from ._state_machine import STATE_MACHINE, STATE_MACHINE_SHAPE
from ._cron_batching import CRON_BATCHING, CRON_BATCHING_SHAPE
from ._data_contracts import (
    CONTRACTS_HEADER,
    DB_CONTRACTS,
    WEBHOOK_CONTRACT,
    CRON_CONTRACT,
)
from ._widget import WIDGET_TARGET_TEMPLATES, WIDGET_API_CATALOG
from ._admin import ADMIN_API_CATALOG
from ._output_shape import build_output_shape

_NON_NULL_SHAPES_HEADER = """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NON-NULL SHAPES — use exactly when these fields are set:\
"""


def build_system_prompt(archetype: str) -> tuple[str, str]:
    """
    Assemble the architect system prompt for the given app archetype.

    archetype: "backend" | "backend_admin" | "storefront_backend" | "storefront_backend_admin"

    Returns
    -------
    (shared, tail)
      shared: archetype-independent prefix, byte-identical across all archetypes.
              Ends with a "\\n\\n" separator so ``shared + tail`` reproduces the
              full prompt without further glue.
      tail:   archetype-specific sections — widget/admin rules (when applicable)
              followed by the NON-NULL SHAPES block and the OUTPUT FORMAT example.
    """
    has_widget = "storefront" in archetype
    has_admin = "admin" in archetype

    shared_sections = [
        INTRO,
        SHOPIFY_PLAN,
        FEASIBILITY,
        COMPLEXITY,
        STATE_MACHINE,
        PLATFORM_GAPS,
        HANDLER_CAPABILITIES_RULES,
        EMAIL_SPEC,
        CRON_BATCHING,
        EDGE_CASES,
        CONTRACTS_HEADER,
        DB_CONTRACTS,
        WEBHOOK_CONTRACT,
        CRON_CONTRACT,
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
