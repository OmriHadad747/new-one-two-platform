"""
Generator registry — the single authoritative list of code-generation sub-agents.

To add a new generator:
  1. Create a new file in generator/subagents/ that subclasses Generator.
  2. Add one entry to GENERATORS below.
  3. crew.py uses is_storefront / is_admin_ui flags to skip generators
     that don't apply to this archetype.

Ordering matters: generators are run in parallel, but the dict order is used
when logging and when building the artifacts dict. Keep logically related
generators adjacent (handler before migration, widget/admin after handler
since they consume the handler's API catalog).
"""

from __future__ import annotations

from typing import Dict

from subagents.base import Generator
from subagents.handler_agent import HandlerGenerator
from subagents.migration_agent import MigrationGenerator
from subagents.widget_js_agent import WidgetJsGenerator
from subagents.admin_ui_agent import AdminUiGenerator

GENERATORS: Dict[str, Generator] = {
    HandlerGenerator.name: HandlerGenerator(),
    MigrationGenerator.name: MigrationGenerator(),
    WidgetJsGenerator.name: WidgetJsGenerator(),
    AdminUiGenerator.name: AdminUiGenerator(),
}
