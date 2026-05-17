"""
Pre-codegen alignment agent — runs once after the LLD is final and before
the parallel codegen fan-out. Its single job: read the LLD as a whole and
surface short, structured alignment notes that downstream codegen agents
(db, backend, storefront, admin_ui) each need to honour identically.

Public API
----------
  run_pre_codegen(lld, intent) -> (notes, in_tok, out_tok, cache_r, cache_c)
  format_alignment_for(notes, agent_name) -> str
"""

from subagents.m_pre_codegen_agent.agent import run_pre_codegen
from subagents.m_pre_codegen_agent.inject import format_alignment_for

__all__ = ["run_pre_codegen", "format_alignment_for"]
