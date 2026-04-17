"""
Scoped capability registries — single source of truth for every capability
the architect can declare on the generated app.

One file per component so the scope of each capability is unambiguous:
  capabilities/handler.py  — ctx.* platform services and npm packages the
                             handler uses at runtime. Always declared.
  capabilities/widget.py   — host.* APIs the browser-side widget uses beyond
                             the always-on host.call channel. Declared only
                             for storefront archetypes.
  capabilities/admin.py    — (reserved) capabilities the embedded admin UI
                             uses. Empty today.

Consumers (one import per consumer keeps vocabulary drift impossible):
  - Architect prompt (subagents/prompts/architect/_capabilities.py) — renders
    the allowed vocabulary and per-capability description directly from the
    module-specific registries.
  - Static validator (subagents/static_validation.py) — uses the ALLOWED_*
    frozensets to reject unknown values, scoped per field.
  - Handler / widget JITs (future) — map capability strings to the
    corresponding harness / widget prompt sections.

This package re-exports the ALLOWED_* frozensets for ergonomic imports
(`from templates.capabilities import ALLOWED_HANDLER_CAPABILITIES, …`).
Full registries stay in their module (`templates.capabilities.handler`, …).
"""

from .admin import ADMIN_CAPABILITIES, ALLOWED_ADMIN_CAPABILITIES
from .handler import ALLOWED_HANDLER_CAPABILITIES
from .widget import ALLOWED_WIDGET_CAPABILITIES

__all__ = [
    "ADMIN_CAPABILITIES",
    "ALLOWED_ADMIN_CAPABILITIES",
    "ALLOWED_HANDLER_CAPABILITIES",
    "ALLOWED_WIDGET_CAPABILITIES",
]
