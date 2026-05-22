"""
Per-agent model configuration.
"""

from __future__ import annotations

_DEFAULTS: dict[str, str] = {
    "product": "claude-haiku-4-5-20251001",
    "hld": "claude-sonnet-4-6",
    "hld_v": "claude-sonnet-4-6",
}


def get_agent_model(agent_name: str) -> str:
    """
    Return the model ID to use for a given agent."""
    return _DEFAULTS.get(agent_name, "claude-sonnet-4-6")
