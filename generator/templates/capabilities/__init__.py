"""
Scoped capability registries — single source of truth for every capability
the architect can declare on the generated app AND the only place each
capability's implementation docs live.

One file per component so the scope of each capability is unambiguous:
  capabilities/handler.py  — ctx.* platform services and npm packages the
                             handler uses at runtime. Always declared.
  capabilities/widget.py   — host.* APIs the browser-side widget uses beyond
                             the always-on host.call channel. Declared only
                             for storefront archetypes.
  capabilities/admin.py    — (reserved) capabilities the embedded admin UI
                             uses. Empty today.

Each registry entry is a Capability with a verbosity ladder (short_docs /
medium_docs / full_docs) plus an optional packages list — see Capability in
_types.py for the per-field contract.

Consumers:
  - Architect prompt (subagents/prompts/architect/_core.py) — reads
    Capability.short via render_registry().
  - Revision agent (subagents/prompts/handler/_api_surface.py) — reads
    Capability.usage_rule via render_usage_rules().
  - Handler JIT (subagents/handler_agent.py) — reads Capability.docs for
    each declared handler capability.
  - Widget JIT (subagents/widget_js_agent.py) — reads Capability.docs for
    each declared widget capability.
  - Static validator (subagents/static_validation.py) — uses the
    ALLOWED_* frozensets, ALLOWED_NPM_PACKAGES (derived from the
    `packages` fields), and iterates
    Capability.static_validation_anti_pattern_regex.
"""

from __future__ import annotations

from ._types import Capability, render_usage_rules, render_registry
from .admin import ADMIN_CAPABILITIES, ALLOWED_ADMIN_CAPABILITIES
from .handler import ALLOWED_HANDLER_CAPABILITIES, ALLOWED_NPM_PACKAGES
from .widget import ALLOWED_WIDGET_CAPABILITIES

__all__ = [
    "ADMIN_CAPABILITIES",
    "ALLOWED_ADMIN_CAPABILITIES",
    "ALLOWED_HANDLER_CAPABILITIES",
    "ALLOWED_NPM_PACKAGES",
    "ALLOWED_WIDGET_CAPABILITIES",
    "Capability",
    "render_usage_rules",
    "render_registry",
]
