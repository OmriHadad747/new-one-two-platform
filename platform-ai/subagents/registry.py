"""
Generator registry — the single authoritative list of code-generation sub-agents.

To add a new generator:
  1. Create a new file in generator/subagents/ that subclasses Generator.
  2. Add one entry to GENERATORS below.
  3. crew.py uses is_storefront / is_admin_ui flags to skip generators
     that don't apply to this archetype.

Ordering matters: generators are run in parallel, but the dict order is used
when logging and when building the artifacts dict. Keep logically related
generators adjacent (handler before migration since migration schema reflects
handler needs).

Phase 2 scope
-------------
Only `handler` and `migration` run. The legacy `widget_js` and `admin_ui`
generators are intentionally absent from the registry — they target the
pre-Phase-2 widget/admin mount pattern (host.call / bridge.call against a
single-file CommonJS handler) which the platform-back runtime no longer
honors.

Phase 4 will reintroduce widget + admin generators targeting the new
widget archetype (App Proxy HMAC verify + server-side widget routes; App
Bridge session verification + admin routes). Until then, widget and admin
generation is disabled at TWO layers so nothing slips through:

  1. This registry omits WidgetJsGenerator / AdminUiGenerator.
  2. crew.py forces `is_storefront = False` and `is_admin_ui = False` for
     every run in Phase 2, so the progress-event emitters + cross-artifact
     validators also skip those surfaces.

The legacy generator classes remain in subagents/widget_js_agent.py and
subagents/admin_ui_agent.py as reference code for the Phase 4 port; they
are not imported anywhere outside those files today.
"""

from __future__ import annotations

from typing import Dict

from subagents.base import Generator
from subagents.handler_agent import HandlerGenerator
from subagents.migration_agent import MigrationGenerator

GENERATORS: Dict[str, Generator] = {
    HandlerGenerator.name: HandlerGenerator(),
    MigrationGenerator.name: MigrationGenerator(),
}
