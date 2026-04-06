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

import logging
import time
from dataclasses import dataclass
from typing import Optional

from anthropic import APIStatusError
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from config import get_settings

log = logging.getLogger(__name__)

# Retryable HTTP status codes: 529 = overloaded, 429 = rate-limited.
_RETRYABLE_STATUS = {429, 529}
_RETRY_DELAYS = [5, 15, 30]  # seconds between attempts (3 retries total)


@dataclass
class LLMResponse:
    content: str
    input_tokens: int
    output_tokens: int
    latency_ms: int


def get_llm(max_tokens: int = 2048, model: Optional[str] = None) -> ChatAnthropic:
    """
    Returns a configured ChatAnthropic instance.

    All callers pass an explicit model resolved via get_agent_model(agent_name).
    The model parameter is required in practice; the default is a safe fallback only.
    """
    settings = get_settings()
    resolved_model = model or "claude-haiku-4-5-20251001"
    return ChatAnthropic(
        model=resolved_model,  # type: ignore[call-arg]
        max_tokens=max_tokens,
        api_key=settings.anthropic_api_key,
    )


def _invoke_with_retry(llm: ChatAnthropic, messages: list) -> object:
    """
    Calls llm.invoke(messages) with exponential backoff on 529/429 errors.
    Raises the original exception after all retries are exhausted.
    """
    for attempt, delay in enumerate([0] + _RETRY_DELAYS, start=1):
        if delay:
            log.warning("Anthropic overloaded/rate-limited — retrying in %ds (attempt %d)…", delay, attempt)
            time.sleep(delay)
        try:
            return llm.invoke(messages)
        except APIStatusError as exc:
            if exc.status_code not in _RETRYABLE_STATUS or attempt > len(_RETRY_DELAYS):
                raise


def invoke(llm: ChatAnthropic, system: str, user: str) -> LLMResponse:
    """
    Calls the LLM with a system + user message pair.
    Returns content + token usage + latency.
    """
    start = time.monotonic()
    response = _invoke_with_retry(llm, [SystemMessage(content=system), HumanMessage(content=user)])
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


def invoke_conversation(
    llm: ChatAnthropic, system: str, messages: list[dict]
) -> LLMResponse:
    """
    Multi-turn conversation call.
    messages: list of {"role": "user"|"assistant", "content": str}
    """
    start = time.monotonic()
    lc_messages: list = [SystemMessage(content=system)]
    for msg in messages:
        if msg["role"] == "user":
            lc_messages.append(HumanMessage(content=msg["content"]))
        else:
            lc_messages.append(AIMessage(content=msg["content"]))

    response = _invoke_with_retry(llm, lc_messages)
    latency_ms = int((time.monotonic() - start) * 1000)

    content = response.content
    if not isinstance(content, str):
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
