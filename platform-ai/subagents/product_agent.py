"""
Product Agent — Agent 1 of the FeatureGenerator pipeline.

Two entry points:
  run_product_agent()         — one-shot: translate a merchant prompt into a feature spec.
  run_product_agent_analyze() — multi-turn: interactive clarification loop used by the
                                /analyze API endpoint before generation is triggered.

System prompts live in subagents/prompts/product/ (PRODUCT_BASE for one-shot,
PRODUCT_ANALYZE_BASE for the interactive flow).

Model: claude-haiku (fast; purely classification + JSON extraction, no code generation).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple

from models.adapter import get_llm, invoke, invoke_conversation, extract_json
from models.agent_models import get_agent_model
from subagents.prompts.core.product import PRODUCT_BASE, PRODUCT_ANALYZE_BASE


def run_product_agent(prompt: str) -> Tuple[Dict[str, Any], int, int]:
    """
    Agent 1: Parse merchant prompt into a product feature specification.
    Returns (intent_dict, input_tokens, output_tokens).
    """
    llm = get_llm(model=get_agent_model("product"), max_tokens=512)
    result = invoke(llm, PRODUCT_BASE, f"Merchant request: {prompt}")
    raw = extract_json(result.content)
    return json.loads(raw), result.input_tokens, result.output_tokens


def run_product_agent_analyze(history: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Multi-turn product agent for the interactive analyze endpoint.
    history: list of {"role": "user"|"assistant", "content": str}
    Returns either {"status": "needs_clarification", "question": "..."} or
    {"status": "ready", "summary": "...", "intent": {...}}.
    """
    llm = get_llm(model=get_agent_model("product"), max_tokens=512)
    result = invoke_conversation(llm, PRODUCT_ANALYZE_BASE, history)
    raw = extract_json(result.content)
    if not raw:
        # LLM returned prose without a JSON block — ask for clarification
        return {
            "status": "needs_clarification",
            "question": "Could you tell me more about what you'd like to build?",
        }
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {
            "status": "needs_clarification",
            "question": "Could you tell me more about what you'd like to build?",
        }
    # Ensure required "status" field is present
    if "status" not in parsed:
        parsed["status"] = "needs_clarification"
    return parsed
