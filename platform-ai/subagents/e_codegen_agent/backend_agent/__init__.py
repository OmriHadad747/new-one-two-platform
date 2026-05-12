"""Backend (handler) generator — produces the Node.js handler bundle.

Generator name is kept as `handler` so the existing artifacts-dict key,
CLI labels, and cross-artifact validator paths continue to work.
"""

from subagents.e_codegen_agent.backend_agent.agent import BackendGenerator

__all__ = ["BackendGenerator"]
