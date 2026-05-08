"""
Per-agent model configuration.
"""

from __future__ import annotations

import os

_DEFAULTS: dict[str, str] = {
    "product": "claude-haiku-4-5-20251001",
    "hld": "claude-sonnet-4-6",
    "hld_v": "claude-sonnet-4-6",
    "ops_picker": "claude-sonnet-4-6",
    "lld": "claude-sonnet-4-6",
    "db": "claude-sonnet-4-6",
    "storefront": "claude-sonnet-4-6",
    "admin_ui": "claude-sonnet-4-6",
    "handler": "claude-sonnet-4-6",
    "bug_finder": "claude-sonnet-4-6",
    "quality_brief_coverage": "claude-haiku-4-5-20251001",
    "agent_rules": "claude-haiku-4-5-20251001",
    "revision": "claude-sonnet-4-6",
    "explanation": "claude-haiku-4-5-20251001",
}


def get_agent_model(agent_name: str) -> str:
    """
    Return the model ID to use for a given agent."""
    return _DEFAULTS.get(agent_name, "claude-sonnet-4-6")
