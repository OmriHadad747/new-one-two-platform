"""
LLM validators (Phase 2 of LLM_VALIDATORS_PLAN.md).

Three modules, run in parallel after the static layer accepts the artifacts:

  agent_rules            — Haiku. Prompt-rule compliance across plan + handler.
                           Owns every `owner: LLM` rule-row in ARCH_RULES.md
                           and HANDLER_RULES.md. Adding a new generator
                           surface = adding a section to the prompt.
  quality_brief_coverage — Haiku. Only when ctx.intent.qualityBrief is non-empty.
                           Verifies each explicit user requirement is addressed.
  bug_finder             — Sonnet + extended thinking. Cross-artifact runtime
                           bugs the rule-validator does not claim.

All three share the Finding shape and the ThreadPoolExecutor harness in base.py.
The crew dispatches them via run_llm_validators(...).
"""

from subagents.validators.base import (
    Finding,
    run_llm_validators,
)

__all__ = ["Finding", "run_llm_validators"]
