"""
Per-agent model configuration.

Every agent resolves its model via get_agent_model(agent_name).
Override any agent by setting the corresponding environment variable:

  AGENT_HANDLER_MODEL=claude-sonnet-4-6
  AGENT_ARCHITECT_MODEL=claude-sonnet-4-6
  AGENT_BUG_FINDER_MODEL=claude-sonnet-4-6
  ...

Defaults reflect the cost/quality tradeoff for each role:
  - Classification / text tasks       → Haiku  (cheap, fast)
  - Code generation / planning        → Sonnet (highest quality)
  - Prompt-rule compliance validation → Haiku  (rules are explicit; no reasoning)
  - Cross-artifact bug-hunting        → Sonnet + extended thinking (multi-step)
"""

from __future__ import annotations

import os

_DEFAULTS: dict[str, str] = {
    # Planning agents
    "architect": "claude-sonnet-4-6",
    "hld": "claude-sonnet-4-6",
    # Code generation agents
    "handler": "claude-sonnet-4-6",
    "migration": "claude-sonnet-4-6",
    "widget_js": "claude-sonnet-4-6",
    "admin_ui": "claude-sonnet-4-6",
    "revision": "claude-sonnet-4-6",
    # Classification / text agents — Haiku is sufficient (fast, cheap)
    "product": "claude-haiku-4-5-20251001",
    "explanation": "claude-haiku-4-5-20251001",
    # LLM validator layer (Phase 2 of LLM_VALIDATORS_PLAN.md):
    #   agent_rules            — prompt-rule compliance across plan + handler.
    #                             Haiku is sufficient: each rule the prompt
    #                             carries directly; no multi-step reasoning.
    #   bug_finder             — open-ended cross-artifact runtime-bug hunt.
    #                             Sonnet + extended thinking (8192) — needs
    #                             multi-step reasoning across artifacts.
    #   quality_brief_coverage — explicit user-requirement coverage check.
    #                             Haiku — straightforward sentence-by-sentence
    #                             match against artifacts.
    "agent_rules": "claude-haiku-4-5-20251001",
    "bug_finder": "claude-sonnet-4-6",
    "quality_brief_coverage": "claude-haiku-4-5-20251001",
}


def get_agent_model(agent_name: str) -> str:
    """
    Return the model ID to use for a given agent.

    Resolution order:
      1. AGENT_<NAME>_MODEL environment variable  (e.g. AGENT_VALIDATOR_MODEL)
      2. Hardcoded default in _DEFAULTS
      3. claude-sonnet-4-6 as final fallback
    """
    env_key = f"AGENT_{agent_name.upper()}_MODEL"
    override = os.environ.get(env_key, "").strip()
    if override:
        return override
    return _DEFAULTS.get(agent_name, "claude-sonnet-4-6")
