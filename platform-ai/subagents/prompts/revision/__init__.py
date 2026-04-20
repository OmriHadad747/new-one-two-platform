"""
Revision-agent prompt subpackage.

Revisions re-run the code generators against merchant feedback + the prior
handler code. The compact API surface below is what the revision agent
sees at the top of its prompt, instead of the full HARNESS_BASE the
initial handler generator consumes — revisions already have the prior
code in context, so the compact reminder is enough.

  _api_surface.py — HARNESS_API_SURFACE (compact handler surface + JIT'd
                    usage_rule one-liners from the handler capability
                    registry).
  _core.py        — REVISION_SYSTEM (the revision agent's system prompt;
                    embeds HARNESS_API_SURFACE at module-load time).
"""

from ._api_surface import HARNESS_API_SURFACE
from ._core import REVISION_SYSTEM

__all__ = ["HARNESS_API_SURFACE", "REVISION_SYSTEM"]
