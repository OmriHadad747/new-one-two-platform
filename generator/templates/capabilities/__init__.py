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

Each registry entry is a Capability with two fields:
  - short: a one/two-line description the ARCHITECT sees in the AVAILABLE
    capabilities list. Informs "declare or not" decisions.
  - docs:  the full implementation prose the HANDLER (or widget / admin) JIT
    injects into the component prompt when the capability is declared. Empty
    for capabilities that have no JIT'able documentation yet.

This split kills the old drift risk where short descriptions lived in the
registry but full API docs lived in templates/harness_contract.py. Both are
now derived from the same Capability entry.

Consumers:
  - Architect prompt (subagents/prompts/architect/_core.py, _capabilities.py)
    — renders Capability.short.
  - Static validator (subagents/static_validation.py) — uses ALLOWED_*
    frozensets.
  - Handler JIT (subagents/handler_agent.py) — renders Capability.docs for
    each capability listed in handlerCapabilities.
"""

from __future__ import annotations

from ._types import Capability
from .admin import ADMIN_CAPABILITIES, ALLOWED_ADMIN_CAPABILITIES
from .handler import ALLOWED_HANDLER_CAPABILITIES
from .widget import ALLOWED_WIDGET_CAPABILITIES

__all__ = [
    "ADMIN_CAPABILITIES",
    "ALLOWED_ADMIN_CAPABILITIES",
    "ALLOWED_HANDLER_CAPABILITIES",
    "ALLOWED_WIDGET_CAPABILITIES",
    "Capability",
]
