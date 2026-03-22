"""
LangChain model abstraction layer.

All agents call get_llm() to obtain a ChatAnthropic instance and use invoke()
to make LLM calls. No agent imports the anthropic SDK directly.

This layer ensures:
  - Provider and model name come from environment config
  - All agents can be redirected to a different model by changing env vars
  - Token usage tracking is consistent across all agents
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage

from config import get_settings


@dataclass
class LLMResponse:
    content: str
    input_tokens: int
    output_tokens: int
    latency_ms: int


def get_llm(
    model: Optional[str] = None,
    max_tokens: int = 2048,
) -> ChatAnthropic:
    """
    Returns a configured ChatAnthropic instance.

    Model precedence:
      1. Explicit `model` argument
      2. LLM_MODEL_CODE env var (for code generation agents)
      3. LLM_MODEL env var
      4. claude-haiku-4-5-20251001 (default, cheapest)
    """
    settings = get_settings()
    resolved_model = model or settings.llm_model
    return ChatAnthropic(
        model=resolved_model,  # type: ignore[call-arg]
        max_tokens=max_tokens,
        api_key=settings.anthropic_api_key,
    )


def get_code_llm(max_tokens: int = 2048) -> ChatAnthropic:
    """Returns the code-generation model (sonnet by default, highest quality)."""
    model = get_settings().llm_model_code
    return get_llm(model=model, max_tokens=max_tokens)


def invoke(llm: ChatAnthropic, system: str, user: str) -> LLMResponse:
    """
    Calls the LLM with a system + user message pair.
    Returns content + token usage + latency.
    """
    start = time.monotonic()
    response = llm.invoke([SystemMessage(content=system), HumanMessage(content=user)])
    latency_ms = int((time.monotonic() - start) * 1000)

    content = response.content
    if not isinstance(content, str):
        # ChatAnthropic may return a list of content blocks
        content = "".join(
            block["text"] if isinstance(block, dict) else str(block)
            for block in content
        )

    usage = getattr(response, "usage_metadata", None) or {}
    return LLMResponse(
        content=content,
        input_tokens=usage.get("input_tokens", 0) if usage else 0,
        output_tokens=usage.get("output_tokens", 0) if usage else 0,
        latency_ms=latency_ms,
    )


def extract_json(text: str) -> str:
    """Strip markdown code fences and extract the first JSON object/array."""
    import re
    text = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.MULTILINE)
    text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
    # Find first { or [
    start = next((i for i, c in enumerate(text) if c in "{["), 0)
    # Find matching last } or ]
    end = max(text.rfind("}"), text.rfind("]")) + 1
    return text[start:end].strip()


def extract_code(text: str) -> str:
    """Strip markdown code fences from a code block."""
    import re
    text = re.sub(r"^```(?:javascript|js)?\s*", "", text.strip(), flags=re.MULTILINE)
    text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
    return text.strip()
