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

from anthropic import APIStatusError, APITimeoutError
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from config import get_settings

log = logging.getLogger(__name__)

# Retryable HTTP status codes: 529 = overloaded, 429 = rate-limited.
_RETRYABLE_STATUS = {429, 529}
_RETRY_DELAYS = [5, 15, 30]  # seconds between attempts (3 retries total)

# Base timeout + per-token budget.  16k-token revision calls routinely take
# 3-5 minutes; the old flat 120 s was too short.
_TIMEOUT_BASE_S = 60
_TIMEOUT_PER_TOKEN_S = 0.05  # ~50 ms/token → 800 s ceiling for 16k tokens


@dataclass
class LLMResponse:
    content: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    # Prompt-caching telemetry. cache_read_input_tokens are billed at ~10% of the
    # normal input rate, cache_creation_input_tokens at ~125%. Totals both land
    # on the server side; they are exposed here so callers can log hit ratios.
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0


# Minimum prompt size for caching to be worthwhile. Anthropic's cache has a
# 1024-token floor; shorter prompts aren't cacheable and trying to mark them
# wastes a content block. System prompts for the large agents (handler,
# architect, revision) easily clear this; the small ones (product classifier)
# do not.
# 4096 chars ≈ 1024 tokens at ~4 chars/token — a safe margin above the floor.
_CACHE_MIN_CHARS = 4096


def get_llm(
    max_tokens: int = 2048,
    model: Optional[str] = None,
    thinking_budget: Optional[int] = None,
) -> ChatAnthropic:
    """
    Returns a configured ChatAnthropic instance.

    All callers pass an explicit model resolved via get_agent_model(agent_name).
    The model parameter is required in practice; the default is a safe fallback only.

    thinking_budget: when set, enables extended thinking with the given token budget.
    Anthropic counts thinking tokens against max_tokens, so we increase max_tokens
    by thinking_budget to preserve the original visible-output budget.
    Extended thinking requires temperature=1 (the default) and a capable model.
    """
    settings = get_settings()
    resolved_model = model or "claude-haiku-4-5-20251001"
    # Thinking tokens count against max_tokens — increase ceiling to preserve
    # the intended visible-output budget alongside the thinking budget.
    effective_max_tokens = max_tokens + thinking_budget if thinking_budget else max_tokens
    timeout = _TIMEOUT_BASE_S + int(effective_max_tokens * _TIMEOUT_PER_TOKEN_S)
    kwargs: dict = dict(
        model=resolved_model,  # type: ignore[call-arg]
        max_tokens=effective_max_tokens,
        api_key=settings.anthropic_api_key,
        timeout=timeout,
    )
    if thinking_budget:
        kwargs["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}
    return ChatAnthropic(**kwargs)


def _invoke_with_retry(llm: ChatAnthropic, messages: list) -> object:
    """
    Calls llm.invoke(messages) with backoff on recoverable errors.

    Retries on:
      - APITimeoutError  (read timeout — transient network or slow generation)
      - APIStatusError   with status 429 / 529 (rate-limited or overloaded)

    Raises the original exception after all retries are exhausted.
    """
    for attempt, delay in enumerate([0] + _RETRY_DELAYS, start=1):
        if delay:
            time.sleep(delay)
        try:
            return llm.invoke(messages)
        except APITimeoutError:
            if attempt > len(_RETRY_DELAYS):
                raise
            log.warning("Anthropic request timed out — retrying in %ds (attempt %d)…", _RETRY_DELAYS[attempt - 1], attempt)
        except APIStatusError as exc:
            if exc.status_code not in _RETRYABLE_STATUS or attempt > len(_RETRY_DELAYS):
                raise
            log.warning("Anthropic overloaded/rate-limited (%s) — retrying in %ds (attempt %d)…", exc.status_code, _RETRY_DELAYS[attempt - 1], attempt)


def _system_message(system: str) -> SystemMessage:
    """
    Build a SystemMessage with prompt caching marked when the system prompt is
    large enough to benefit.

    We mark exactly one cache breakpoint at the end of the system content block —
    every identical system prompt sent within the 5-minute TTL will be served
    from the cache at ~10% of the normal input-token price.

    Short system prompts (below _CACHE_MIN_CHARS) are sent as plain strings;
    Anthropic's cache has a ~1024-token floor and marking a short prompt just
    wastes a content-block slot.
    """
    if len(system) < _CACHE_MIN_CHARS:
        return SystemMessage(content=system)
    return SystemMessage(
        content=[
            {
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }
        ]
    )


def _extract_cache_metrics(usage: dict) -> tuple[int, int]:
    """
    Pull cache telemetry out of LangChain's usage_metadata.

    langchain-anthropic exposes cache fields in two places depending on version:
    top-level (input_token_details) or nested under `input_tokens`. We tolerate
    both shapes and default to 0 when absent.
    """
    if not usage:
        return 0, 0
    details = usage.get("input_token_details") or {}
    cache_read = (
        details.get("cache_read")
        or usage.get("cache_read_input_tokens")
        or 0
    )
    cache_create = (
        details.get("cache_creation")
        or usage.get("cache_creation_input_tokens")
        or 0
    )
    return int(cache_read), int(cache_create)


def _build_user_message(stable: str, retry_suffix: str = "") -> HumanMessage:
    """
    Build a HumanMessage with optional prompt caching on the stable prefix.

    When retry_suffix is absent and the content is short: plain string (no overhead).
    When the stable prefix is large enough: mark it with cache_control so that
    retry attempts (which send the same stable content + a new retry_suffix) hit
    the cache for the expensive portion — db schema, api_context, JIT sections.
    The retry_suffix is always uncached because it changes between attempts.
    """
    if not retry_suffix and len(stable) < _CACHE_MIN_CHARS:
        return HumanMessage(content=stable)

    stable_block: dict = {"type": "text", "text": stable}
    if len(stable) >= _CACHE_MIN_CHARS:
        stable_block["cache_control"] = {"type": "ephemeral"}

    if not retry_suffix:
        return HumanMessage(content=[stable_block])

    return HumanMessage(content=[stable_block, {"type": "text", "text": retry_suffix}])


def _extract_text_content(raw_content: object) -> str:
    """
    Extract the visible text from an LLM response content value.

    Handles three shapes that ChatAnthropic may return:
      - str                    — plain text (no thinking, no blocks)
      - list[dict]             — content blocks (text + optional thinking blocks)
      - list[mixed]            — older LangChain fallback

    Thinking blocks (type == "thinking") are intentionally excluded — only the
    final text output is returned to callers.
    """
    if isinstance(raw_content, str):
        return raw_content
    parts: list[str] = []
    for block in raw_content:
        if isinstance(block, dict):
            if block.get("type") == "text":
                parts.append(block["text"])
            # thinking blocks (type == "thinking") are skipped
        else:
            parts.append(str(block))
    return "".join(parts)


def invoke(llm: ChatAnthropic, system: str, user: str, retry_suffix: str = "") -> LLMResponse:
    """
    Calls the LLM with a system + user message pair.
    Returns content + token usage + latency.

    The system prompt is automatically cached (Anthropic ephemeral cache) when
    it exceeds _CACHE_MIN_CHARS — all stable large prompts (handler, architect,
    revision, migration) qualify; the small product/classifier prompts do not.

    retry_suffix: validation error block from a prior attempt. When provided, it
    is sent as a separate uncached content block appended after the cached stable
    user prefix. This means the second and third retry calls hit the cache for
    the stable portion (db schema, api_context, JIT sections) and only pay full
    price for the new retry_suffix.
    """
    start = time.monotonic()
    response = _invoke_with_retry(
        llm, [_system_message(system), _build_user_message(user, retry_suffix)]
    )
    latency_ms = int((time.monotonic() - start) * 1000)

    usage = getattr(response, "usage_metadata", None) or {}
    cache_read, cache_create = _extract_cache_metrics(usage)
    return LLMResponse(
        content=_extract_text_content(response.content),
        input_tokens=usage.get("input_tokens", 0) if usage else 0,
        output_tokens=usage.get("output_tokens", 0) if usage else 0,
        latency_ms=latency_ms,
        cache_read_tokens=cache_read,
        cache_creation_tokens=cache_create,
    )


def invoke_conversation(
    llm: ChatAnthropic, system: str, messages: list[dict]
) -> LLMResponse:
    """
    Multi-turn conversation call.
    messages: list of {"role": "user"|"assistant", "content": str}
    """
    start = time.monotonic()
    lc_messages: list = [_system_message(system)]
    for msg in messages:
        if msg["role"] == "user":
            lc_messages.append(HumanMessage(content=msg["content"]))
        else:
            lc_messages.append(AIMessage(content=msg["content"]))

    response = _invoke_with_retry(llm, lc_messages)
    latency_ms = int((time.monotonic() - start) * 1000)

    usage = getattr(response, "usage_metadata", None) or {}
    cache_read, cache_create = _extract_cache_metrics(usage)
    return LLMResponse(
        content=_extract_text_content(response.content),
        input_tokens=usage.get("input_tokens", 0) if usage else 0,
        output_tokens=usage.get("output_tokens", 0) if usage else 0,
        latency_ms=latency_ms,
        cache_read_tokens=cache_read,
        cache_creation_tokens=cache_create,
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
