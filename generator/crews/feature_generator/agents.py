"""
Agent definitions for the FeatureGenerator crew.

Agents now live in their own subagent files:
  subagents/product_agent.py     — Agent 1 (Product + Analyze)
  subagents/explanation_agent.py — Agent 6 (Explanation)
  subagents/architect_agent.py   — Agent 2 (Architect)
  subagents/codespec_agent.py    — Agent 3 (CodeSpec)

This module re-exports the public API for backward compatibility with
crew.py and the API server.
"""

from __future__ import annotations

from typing import List

from models.adapter import get_llm
from shopify_mcp import client as mcp_client

# Re-export agent entry points from their canonical locations
from subagents.product_agent import run_product_agent, run_product_agent_analyze  # noqa: F401
from subagents.explanation_agent import run_explanation_agent  # noqa: F401


# ─── API context loader ───────────────────────────────────────────────────────


def fetch_api_context(resources: List[str], intent_description: str = "") -> str:
    """
    Return live Shopify API context for the given resources via the Dev MCP server.

    Calls the Shopify Dev MCP server (via npx) to fetch REST endpoint docs,
    GraphQL schema types, and webhook payload shapes for each resource.
    Results are cached to mcp/cache/ for 24 hours.
    Returns an empty string if MCP is unavailable — agents proceed without context.
    Never raises.

    Parameters
    ----------
    resources:
        Resource names from Intent output (e.g. ["orders", "inventory"]).
    intent_description:
        Optional one-liner from Intent.desiredOutcome — improves doc relevance.
    """
    if not resources:
        return ""
    return mcp_client.prefetch_for_run(resources, intent_description)
