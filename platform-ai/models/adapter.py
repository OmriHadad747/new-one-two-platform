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

import contextvars
import logging
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional, Union

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


# ── Input tracing ─────────────────────────────────────────────────────────────
#
# Opt-in capture of every LLM call's exact system+user prompt to disk. Off by
# default — only callers that enter an `input_log(...)` block produce dumps,
# so the platform/UI server path is a no-op. The chat_local CLI uses this to
# write per-agent inputs alongside outputs in test_results/<run>/inputs/.
#
# Why ContextVar (not threading.local): ThreadPoolExecutor doesn't carry
# either across the pool boundary, but ContextVar pairs with copy_context()
# which lets the parent's state surface inside worker threads when the
# submission is wrapped (see crew.run_codegen_parallel).


@dataclass
class _InputLogState:
    agent: str
    run_dir: Path


_input_log_ctx: contextvars.ContextVar[Optional[_InputLogState]] = (
    contextvars.ContextVar("input_log_ctx", default=None)
)


@contextmanager
def input_log(agent: str, run_dir: Path) -> Iterator[None]:
    """
    Enable on-disk capture of every invoke() / invoke_conversation() call made
    inside this block. Each call writes:

        <run_dir>/inputs/<agent>/attempt_N/{system.txt, user.txt[, retry_suffix.txt]}

    attempt_N is derived by counting existing attempt_* dirs, so multiple calls
    from the same agent (e.g. revision attempts 1 and 2) produce attempt_1 and
    attempt_2 automatically.

    Outside any input_log block the dump is skipped — invoke() behaves exactly
    as it did before the feature was added. This is the platform/UI no-op.
    """
    token = _input_log_ctx.set(_InputLogState(agent=agent, run_dir=run_dir))
    try:
        yield
    finally:
        _input_log_ctx.reset(token)


def current_input_log_run_dir() -> Optional[Path]:
    """Run-dir of the active input_log block, or None when no block is active.

    Used by crew.run_codegen_parallel so each worker thread can re-enter the
    context with a generator-specific agent name while preserving run_dir.
    """
    state = _input_log_ctx.get()
    return state.run_dir if state else None


def _dump_inputs(
    system: Union[str, list[str]],
    user: str,
    retry_suffix: str,
    *,
    multi_turn_messages: Optional[list[dict]] = None,
) -> None:
    """
    Write the prompt about to be sent to the LLM, if input_log is active.

    Failures are logged and swallowed — input tracing must never break a
    generation. Called before _invoke_with_retry so the input is captured even
    when the API call later fails.
    """
    state = _input_log_ctx.get()
    if state is None:
        return
    try:
        agent_dir = state.run_dir / "inputs" / state.agent
        agent_dir.mkdir(parents=True, exist_ok=True)
        existing = sum(
            1
            for p in agent_dir.iterdir()
            if p.is_dir() and p.name.startswith("attempt_")
        )
        attempt_dir = agent_dir / f"attempt_{existing + 1}"
        attempt_dir.mkdir()

        if isinstance(system, list):
            sys_text = "\n\n".join(s for s in system if s)
        else:
            sys_text = system or ""
        (attempt_dir / "system.txt").write_text(sys_text)

        if multi_turn_messages is not None:
            transcript = "\n\n".join(
                f"[{m.get('role', '?')}]\n{m.get('content', '')}"
                for m in multi_turn_messages
            )
            (attempt_dir / "user.txt").write_text(transcript)
        else:
            (attempt_dir / "user.txt").write_text(user)

        if retry_suffix:
            (attempt_dir / "retry_suffix.txt").write_text(retry_suffix)
    except Exception as exc:  # pragma: no cover — observability must not raise
        log.warning("input-trace dump failed (agent=%s): %s", state.agent, exc)


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
    effective_max_tokens = (
        max_tokens + thinking_budget if thinking_budget else max_tokens
    )
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
            log.warning(
                "Anthropic request timed out — retrying in %ds (attempt %d)…",
                _RETRY_DELAYS[attempt - 1],
                attempt,
            )
        except APIStatusError as exc:
            if exc.status_code not in _RETRYABLE_STATUS or attempt > len(_RETRY_DELAYS):
                raise
            log.warning(
                "Anthropic overloaded/rate-limited (%s) — retrying in %ds (attempt %d)…",
                exc.status_code,
                _RETRY_DELAYS[attempt - 1],
                attempt,
            )


def _system_message(system: Union[str, list[str]]) -> SystemMessage:
    """
    Build a SystemMessage with prompt caching marked when the system prompt is
    large enough to benefit.

    String input (the common case):
      One cache breakpoint at the end of the system block when the prompt is
      above _CACHE_MIN_CHARS; plain text otherwise. Every identical system
      prompt sent within the 5-minute TTL is served from the cache at ~10% of
      the normal input-token price.

    List input (used when the caller wants a segmented system prompt):
      Useful when a stable shared prefix precedes caller-specific content — for
      example the architect agent, whose rule body is identical across all
      archetypes but whose tail (widget/admin sections + output example) varies
      per archetype. Each segment at or above _CACHE_MIN_CHARS becomes its own
      content block with a cache_control marker, so Anthropic's prefix matcher
      can reuse the shared block even when the tail differs. Segments that fall
      below the floor ride uncached as plain blocks. If no segment individually
      qualifies, the segments are merged and treated as a single system prompt
      (no separator inserted — callers embed their own whitespace at segment
      boundaries).
    """
    segments = [system] if isinstance(system, str) else [s for s in system if s]

    if not segments:
        return SystemMessage(content="")

    if len(segments) == 1:
        text = segments[0]
        if len(text) < _CACHE_MIN_CHARS:
            return SystemMessage(content=text)
        return SystemMessage(
            content=[
                {"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}
            ]
        )

    cacheable = [len(s) >= _CACHE_MIN_CHARS for s in segments]

    # Nothing qualifies on its own — behave exactly like the single-string
    # path by merging and caching (or not) on the total.
    if not any(cacheable):
        merged = "".join(segments)
        if len(merged) < _CACHE_MIN_CHARS:
            return SystemMessage(content=merged)
        return SystemMessage(
            content=[
                {"type": "text", "text": merged, "cache_control": {"type": "ephemeral"}}
            ]
        )

    blocks: list[dict] = []
    for seg, mark in zip(segments, cacheable):
        block: dict = {"type": "text", "text": seg}
        if mark:
            block["cache_control"] = {"type": "ephemeral"}
        blocks.append(block)
    return SystemMessage(content=blocks)


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
    cache_read = details.get("cache_read") or usage.get("cache_read_input_tokens") or 0
    cache_create = (
        details.get("cache_creation") or usage.get("cache_creation_input_tokens") or 0
    )
    return int(cache_read), int(cache_create)


def _build_user_message(stable: str, retry_suffix: str = "") -> HumanMessage:
    """
    Build a HumanMessage with optional prompt caching on the stable prefix.

    When retry_suffix is absent and the content is short: plain string (no overhead).
    When the stable prefix is large enough: mark it with cache_control so that
    retry attempts (which send the same stable content + a new retry_suffix) hit
    the cache for the expensive portion — db schema, JIT sections, capabilities.
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


def invoke(
    llm: ChatAnthropic,
    system: Union[str, list[str]],
    user: str,
    retry_suffix: str = "",
) -> LLMResponse:
    """
    Calls the LLM with a system + user message pair.
    Returns content + token usage + latency.

    The system prompt is automatically cached (Anthropic ephemeral cache) when
    it exceeds _CACHE_MIN_CHARS — all stable large prompts (handler, architect,
    revision, migration) qualify; the small product/classifier prompts do not.

    ``system`` may also be a list of strings for callers that want a segmented
    system prompt — each qualifying segment gets its own cache breakpoint so a
    stable shared prefix can cache across calls whose tail differs (e.g. the
    architect agent varies its tail per app archetype). See _system_message().

    retry_suffix: validation error block from a prior attempt. When provided, it
    is sent as a separate uncached content block appended after the cached stable
    user prefix. This means the second and third retry calls hit the cache for
    the stable portion (db schema, JIT sections, capabilities) and only pay full
    price for the new retry_suffix.
    """
    # Dump before the network call so the prompt is captured even on failure.
    # No-op unless an input_log() block is active.
    _dump_inputs(system, user, retry_suffix)
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
    llm: ChatAnthropic, system: Union[str, list[str]], messages: list[dict]
) -> LLMResponse:
    """
    Multi-turn conversation call.
    messages: list of {"role": "user"|"assistant", "content": str}
    """
    _dump_inputs(system, "", "", multi_turn_messages=messages)
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
