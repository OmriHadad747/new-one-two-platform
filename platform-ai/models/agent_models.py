"""
Per-agent model configuration.

Every agent resolves its model via get_agent_model(agent_name).
Override any agent by setting the corresponding environment variable:

  AGENT_VALIDATOR_MODEL=claude-sonnet-4-6
  AGENT_HANDLER_MODEL=claude-sonnet-4-6
  AGENT_ARCHITECT_MODEL=claude-sonnet-4-6
  ...

Defaults reflect the cost/quality tradeoff for each role:
  - Classification / text tasks  → Haiku  (cheap, fast)
  - Code generation / planning   → Sonnet (highest quality)
  - Semantic validation          → Sonnet (Part B open review needs real reasoning
                                   across artifacts; paired with extended thinking)
"""

from __future__ import annotations

import os

_DEFAULTS: dict[str, str] = {
    # Planning agents
    "architect": "claude-sonnet-4-6",
    # Code generation agents
    "handler": "claude-sonnet-4-6",
    "migration": "claude-sonnet-4-6",
    "widget_js": "claude-sonnet-4-6",
    "admin_ui": "claude-sonnet-4-6",
    "revision": "claude-sonnet-4-6",
    # Classification / text agents — Haiku is sufficient (fast, cheap)
    "product": "claude-haiku-4-5-20251001",
    "explanation": "claude-haiku-4-5-20251001",
    # Hybrid validator — Part A identifier matching + Part B deploy-blocking
    # bug review. Part B needs multi-step reasoning across handler/migration/
    # widget/admin, so it runs on Sonnet with extended thinking enabled in
    # validator_agent.py. Haiku was sufficient for Part A alone.
    "validator": "claude-sonnet-4-6",
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
