"""
Generator registry — the single authoritative list of code-generation sub-agents.

To add a new generator:
  1. Create a new file in generator/subagents/ that subclasses Generator.
  2. Add one entry to GENERATORS below.
  3. crew.py uses is_storefront / is_admin_ui flags to skip generators
     that don't apply to this archetype.

Ordering matters: generators are run in parallel, but the dict order is used
when logging and when building the artifacts dict. Keep logically related
generators adjacent (backend before db, storefront/admin_ui after backend
since they consume the handler's API catalog).
"""

from __future__ import annotations

from typing import Dict

from subagents.base import Generator
from subagents.e_codegen_agent.backend_agent import BackendGenerator
from subagents.e_codegen_agent.db_agent import DbGenerator
from subagents.e_codegen_agent.storefront_agent import StorefrontGenerator
from subagents.e_codegen_agent.admin_agent import AdminGenerator

GENERATORS: Dict[str, Generator] = {
    # DbGenerator.name: DbGenerator(),
    # StorefrontGenerator.name: StorefrontGenerator(),
    BackendGenerator.name: BackendGenerator(),
    # AdminGenerator.name: AdminGenerator(),
}
