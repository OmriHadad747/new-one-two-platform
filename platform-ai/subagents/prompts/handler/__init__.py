"""
Handler prompt subpackage — parallels prompts/architect/ and prompts/widget/.

  _core.py              — HARNESS_BASE (always-on system prompt)
  _webhook.py           — HARNESS_SECTION_WEBHOOK
  _cron.py              — HARNESS_SECTION_CRON (jobs-map contract)
  _state_machine.py     — HARNESS_SECTION_STATE_MACHINE
  _cron_batching.py     — HARNESS_SECTION_CRON_BATCHING (bulk Shopify prefetch)
  _widget.py            — HARNESS_SECTION_WIDGET, HARNESS_SECTION_WIDGET_STOREFRONT
  _admin.py             — HARNESS_SECTION_ADMIN

Per-capability API docs (shopify REST/GraphQL, platform services, npm
packages) live in templates/capabilities/handler.py and are injected by
handler_agent.py's JIT based on what the architect declared in
handlerCapabilities. The sections in this package are trigger-gated
(webhook / cron / cron batching / state machine / widget routing /
admin routing), injected when the plan requires them.

The compact surface the revision agent reads (HARNESS_API_SURFACE) lives
in prompts/revision/_api_surface.py — it used to live here but was moved
to its consumer's subpackage since the handler generator never reads it.
"""

from ._admin import HARNESS_SECTION_ADMIN
from ._core import HARNESS_BASE
from ._cron import HARNESS_SECTION_CRON
from ._cron_batching import HARNESS_SECTION_CRON_BATCHING
from ._state_machine import HARNESS_SECTION_STATE_MACHINE
from ._webhook import HARNESS_SECTION_WEBHOOK
from ._widget import HARNESS_SECTION_WIDGET, HARNESS_SECTION_WIDGET_STOREFRONT

__all__ = [
    "HARNESS_BASE",
    "HARNESS_SECTION_ADMIN",
    "HARNESS_SECTION_CRON",
    "HARNESS_SECTION_CRON_BATCHING",
    "HARNESS_SECTION_STATE_MACHINE",
    "HARNESS_SECTION_WEBHOOK",
    "HARNESS_SECTION_WIDGET",
    "HARNESS_SECTION_WIDGET_STOREFRONT",
]
