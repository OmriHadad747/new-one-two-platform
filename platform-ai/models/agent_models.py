"""
Per-agent model configuration.
"""

from __future__ import annotations

_DEFAULTS: dict[str, str] = {
    "product": "claude-haiku-4-5-20251001",
    # The FIRST HLD pass runs on Opus: the plan is the highest-leverage
    # artifact (one bad decision poisons many downstream files), and it is a
    # small-token stage, so the strongest model here is cheap insurance
    # against expensive coding-loop churn. The REVISE pass is a constrained
    # "apply these reviewer findings" task — Sonnet is sufficient and far
    # cheaper. The reviewer (hld_v) also stays on Sonnet (broad semantic
    # judgment, but a missed plan bug is caught at coding, and Opus there
    # would only restore cross-model cache sharing we already accept losing).
    #
    # MEASUREMENT OVERRIDE: temporarily set to Sonnet to A/B the first-pass
    # model on a fixed prompt. Revert to "claude-opus-4-8" when the comparison
    # is done. (The cost telemetry derives its price from this value, so it
    # reprices the hld stage as Sonnet automatically — no other edit needed.)
    "hld": "claude-opus-4-8",
    "hld_revise": "claude-sonnet-4-6",
    "hld_v": "claude-sonnet-4-6",
    # Downstream micro-validators — narrow, single-invariant checks, so a
    # small model is both safe and cheap. Bump the protocol slice to Sonnet
    # only if measurement shows Haiku misses cross-file tracing.
    "codegen_v": "claude-haiku-4-5-20251001",
}


def get_agent_model(agent_name: str) -> str:
    """
    Return the model ID to use for a given agent."""
    return _DEFAULTS.get(agent_name, "claude-sonnet-4-6")
