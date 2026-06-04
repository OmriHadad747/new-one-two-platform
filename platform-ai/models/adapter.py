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
    # Anthropic stop reason: "end_turn", "max_tokens", "stop_sequence", "tool_use".
    # Callers that produce structured output should treat "max_tokens" as truncation.
    stop_reason: Optional[str] = None


@dataclass
class StructuredLLMResponse:
    """
    Response shape for `invoke_structured()` — the API decoded a tool call
    whose arguments match the caller-supplied JSON Schema. The model can
    no longer drift on output shape (object-vs-array confusion, missing
    required fields, wrong enum value) because the schema is enforced at
    decode time, not after the fact.

    `structured_output` is the parsed tool-arguments dict; pass it directly
    to `Pydantic.model_validate(...)`. Semantic validators (e.g. cross-
    field invariants like "paginationKind required when responseShape has
    object-list values") still run on the Pydantic model — tool use
    enforces shape, not semantics.
    """

    structured_output: dict
    input_tokens: int
    output_tokens: int
    latency_ms: int
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    stop_reason: Optional[str] = None


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
    uncached_suffix: str = "",
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
        if uncached_suffix:
            # Separate file so post-mortem can tell which bytes were the
            # mutating-but-not-retry chunk (today: codegen prior_code).
            (attempt_dir / "uncached_suffix.txt").write_text(uncached_suffix)
    except Exception as exc:  # pragma: no cover — observability must not raise
        log.warning("input-trace dump failed (agent=%s): %s", state.agent, exc)


def dump_input(
    system: Union[str, list[str]],
    user: str,
    retry_suffix: str = "",
    *,
    multi_turn_messages: Optional[list[dict]] = None,
) -> None:
    """
    Public entry point to trace a prompt for agents that bypass `invoke()` —
    the raw-client agentic loops in c_hld_agent / w_coding_agent. Creates the
    next `attempt_N` dir and writes system.txt / user.txt exactly as `invoke()`
    does, so loop-driven agents leave the same on-disk trail as single-shot
    ones. No-op outside an `input_log` block. Pair with `dump_output` (free-form)
    or `dump_structured_output` (tool output) to persist the response too.
    """
    _dump_inputs(system, user, retry_suffix, multi_turn_messages=multi_turn_messages)


def dump_output(content: str) -> None:
    """
    Persist a model response into the most recent attempt_N dir created by
    `_dump_inputs` for the active `input_log` block. No-op outside an
    `input_log` block.

    Lets the agent runner save raw model output side-by-side with its
    prompts (system.txt / user.txt / retry_suffix.txt) for post-mortem.
    Failures are swallowed — observability must never break a run.
    """
    state = _input_log_ctx.get()
    if state is None:
        return
    try:
        agent_dir = state.run_dir / "inputs" / state.agent
        if not agent_dir.is_dir():
            return
        attempts = sorted(
            (
                p
                for p in agent_dir.iterdir()
                if p.is_dir() and p.name.startswith("attempt_")
            ),
            key=lambda p: (
                int(p.name.split("_", 1)[1]) if p.name.split("_", 1)[1].isdigit() else 0
            ),
        )
        if not attempts:
            return
        (attempts[-1] / "output.txt").write_text(content)
    except Exception as exc:  # pragma: no cover — observability must not raise
        log.warning("output-trace dump failed (agent=%s): %s", state.agent, exc)


# Minimum prompt size for caching to be worthwhile. Anthropic's cache has a
# 1024-token floor; shorter prompts aren't cacheable and trying to mark them
# wastes a content block. System prompts for the large agents (handler,
# architect, revision) easily clear this; the small ones (product classifier)
# do not.
# 4096 chars ≈ 1024 tokens at ~4 chars/token — a safe margin above the floor.
_CACHE_MIN_CHARS = 4096


def _cache_control(ttl: Optional[str] = None) -> dict:
    """
    Build the Anthropic `cache_control` dict for a content block.

    Default (ttl=None) → 5-minute ephemeral cache. Write costs 1.25× base
    input, read costs 0.1× base input. Right for tight back-to-back call
    bursts (LLD generation + retry, codegen + retry).

    ttl="1h" → 1-hour ephemeral cache. Write costs 2× base input (so 0.75×
    more than 5-min), read costs 0.1× base input. Right for agents whose
    next call may come after a merchant pause longer than 5 minutes
    (product analyze loop).

    No other values are accepted — keep callers honest. Anthropic supports
    only these two TTLs today; new options can be added here when they ship.
    """
    if ttl is None:
        return {"type": "ephemeral"}
    if ttl == "1h":
        return {"type": "ephemeral", "ttl": "1h"}
    raise ValueError(
        f"unsupported cache_ttl {ttl!r}; valid values are None (5-min default) or '1h'"
    )


def get_llm(
    max_tokens: int = 2048,
    model: Optional[str] = None,
    thinking_budget: Optional[int] = None,
    cache_ttl: Optional[str] = None,
) -> ChatAnthropic:
    """
    Returns a configured ChatAnthropic instance.

    All callers pass an explicit model resolved via get_agent_model(agent_name).
    The model parameter is required in practice; the default is a safe fallback only.

    thinking_budget: when set, enables extended thinking with the given token budget.
    Anthropic counts thinking tokens against max_tokens, so we increase max_tokens
    by thinking_budget to preserve the original visible-output budget.
    Extended thinking requires temperature=1 (the default) and a capable model.

    cache_ttl: when "1h", attaches the `anthropic-beta: extended-cache-ttl-
    2025-04-11` header so the API honors the 1-hour `cache_control.ttl`
    marker we emit in `_cache_control()`. Without this header Anthropic
    silently ignores the ttl field and may not register the cache write
    at all — observed as `cache_create=0` on turn 1 + `cache_read=0` on
    every following turn. None = default 5-minute ephemeral; no header
    needed.

    Caching is keyed (in part) on the request shape, so an LLM instance
    constructed with the beta header is safe to reuse for non-1h calls
    too — the header is a no-op when the cache_control marker is the
    default ephemeral form.
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
    if cache_ttl == "1h":
        kwargs["default_headers"] = {
            "anthropic-beta": "extended-cache-ttl-2025-04-11"
        }
    elif cache_ttl is not None:
        raise ValueError(
            f"unsupported cache_ttl {cache_ttl!r}; valid values are None or '1h'"
        )
    return ChatAnthropic(**kwargs)


def _invoke_with_retry(llm: ChatAnthropic, messages: list) -> object:
    """
    Calls llm.invoke(messages) with backoff on recoverable errors.

    Retries on:
      - APITimeoutError  (read timeout — transient network or slow generation)
      - APIStatusError   with status 429 / 529 (rate-limited or overloaded)

    Raises the original exception after all retries are exhausted. Non-
    retryable HTTP errors (400 / 401 / 403) log the response body before
    re-raising — without the body, the only signal is "HTTP 400" with no
    indication of which schema field / cache_control marker / tool block
    Anthropic rejected.
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
                # Non-retryable — surface the actual Anthropic error body
                # so the operator can see WHICH part of the request was
                # rejected (e.g. tool input_schema constraints, missing
                # required field, oversized payload). Default LangChain
                # propagation swallows this into "HTTP 400" alone.
                body = None
                try:
                    body = exc.response.text if exc.response is not None else None
                except Exception:  # noqa: BLE001
                    body = None
                log.error(
                    "Anthropic %s rejected request (request_id=%s) body=%s",
                    exc.status_code,
                    getattr(exc, "request_id", "?"),
                    (body or "<no body>")[:2000],
                )
                raise
            log.warning(
                "Anthropic overloaded/rate-limited (%s) — retrying in %ds (attempt %d)…",
                exc.status_code,
                _RETRY_DELAYS[attempt - 1],
                attempt,
            )


def _system_message(
    system: Union[str, list[str]], cache_ttl: Optional[str] = None
) -> SystemMessage:
    """
    Build a SystemMessage with prompt caching marked when the system prompt is
    large enough to benefit.

    String input (the common case):
      One cache breakpoint at the end of the system block when the prompt is
      above _CACHE_MIN_CHARS; plain text otherwise. Every identical system
      prompt sent within the TTL is served from the cache at ~10% of the
      normal input-token price.

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

    cache_ttl: see `_cache_control` for accepted values. None = 5-min default.
    """
    cc = _cache_control(cache_ttl)
    segments = [system] if isinstance(system, str) else [s for s in system if s]

    if not segments:
        return SystemMessage(content="")

    if len(segments) == 1:
        text = segments[0]
        if len(text) < _CACHE_MIN_CHARS:
            return SystemMessage(content=text)
        return SystemMessage(
            content=[{"type": "text", "text": text, "cache_control": cc}]
        )

    cacheable = [len(s) >= _CACHE_MIN_CHARS for s in segments]

    # Nothing qualifies on its own — behave exactly like the single-string
    # path by merging and caching (or not) on the total.
    if not any(cacheable):
        merged = "".join(segments)
        if len(merged) < _CACHE_MIN_CHARS:
            return SystemMessage(content=merged)
        return SystemMessage(
            content=[{"type": "text", "text": merged, "cache_control": cc}]
        )

    blocks: list[dict] = []
    for seg, mark in zip(segments, cacheable):
        block: dict = {"type": "text", "text": seg}
        if mark:
            block["cache_control"] = cc
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


def _build_user_message(
    stable: str,
    retry_suffix: str = "",
    cache_ttl: Optional[str] = None,
    uncached_suffix: str = "",
    cache_user: bool = True,
) -> HumanMessage:
    """
    Build a HumanMessage with optional prompt caching on the stable prefix.

    Three text blocks, in order:

      1. `stable`           — truly stable content (intent, LLD JSON, alignment
                              notes, emit instruction). Marked with
                              cache_control when ≥ _CACHE_MIN_CHARS so retry
                              attempts read the heavy bytes from cache.
      2. `uncached_suffix`  — content that varies per attempt within the same
                              agent (today: the codegen agents' PRIOR CODE
                              block, which is attempt N's bundle injected
                              into attempt N+1). Putting this here keeps the
                              `stable` block byte-identical across retries,
                              so the cache prefix never invalidates.
      3. `retry_suffix`     — per-attempt validation findings + policy
                              text. Also uncached.

    Why this exists: when mutating content lives inside the cached `stable`
    block, the cache marker is at the END of the mutating block — meaning
    every change downstream of the marker invalidates the cache for the
    whole user prefix. Splitting the mutating piece out lets the cache
    breakpoint land BEFORE it, so the stable bytes keep hitting cache on
    every retry. Empirically this brings codegen retry cache-hit ratio
    from ~10% to ~50-70% on backend / storefront / admin_ui.

    cache_user: when False, the `stable` block is NEVER marked cacheable —
    it rides as plain input. Use this when the user payload is UNIQUE per
    call and so can never produce a cache READ (e.g. the micro-validators,
    whose user message is plan-excerpt + the specific files under review,
    different every call). Caching such a payload only pays the cache-WRITE
    premium (1.25×/2× input) for bytes that are never re-read — strictly
    worse than sending them as plain input. The system prompt keeps its own
    caching independently via `_system_message`.

    cache_ttl: see `_cache_control` for accepted values.
    """
    has_suffix = bool(retry_suffix or uncached_suffix)
    if not has_suffix and (not cache_user or len(stable) < _CACHE_MIN_CHARS):
        return HumanMessage(content=stable)

    blocks: list[dict] = []
    stable_block: dict = {"type": "text", "text": stable}
    if cache_user and len(stable) >= _CACHE_MIN_CHARS:
        stable_block["cache_control"] = _cache_control(cache_ttl)
    blocks.append(stable_block)

    if uncached_suffix:
        blocks.append({"type": "text", "text": uncached_suffix})
    if retry_suffix:
        blocks.append({"type": "text", "text": retry_suffix})

    return HumanMessage(content=blocks)


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
    cache_ttl: Optional[str] = None,
    uncached_suffix: str = "",
    cache_user: bool = True,
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

    cache_ttl: None (default, 5-min ephemeral cache, cheapest write) or "1h"
    (1-hour ephemeral cache, 2× write cost but useful when calls may have
    multi-minute gaps — e.g. the product analyze loop where the merchant
    pauses between clarification turns).
    """
    # Dump before the network call so the prompt is captured even on failure.
    # No-op unless an input_log() block is active.
    _dump_inputs(system, user, retry_suffix, uncached_suffix=uncached_suffix)
    start = time.monotonic()
    response = _invoke_with_retry(
        llm,
        [
            _system_message(system, cache_ttl=cache_ttl),
            _build_user_message(
                user,
                retry_suffix,
                cache_ttl=cache_ttl,
                uncached_suffix=uncached_suffix,
                cache_user=cache_user,
            ),
        ],
    )
    latency_ms = int((time.monotonic() - start) * 1000)

    usage = getattr(response, "usage_metadata", None) or {}
    cache_read, cache_create = _extract_cache_metrics(usage)
    stop_reason = (getattr(response, "response_metadata", None) or {}).get(
        "stop_reason"
    )
    return LLMResponse(
        content=_extract_text_content(response.content),
        input_tokens=usage.get("input_tokens", 0) if usage else 0,
        output_tokens=usage.get("output_tokens", 0) if usage else 0,
        latency_ms=latency_ms,
        cache_read_tokens=cache_read,
        cache_creation_tokens=cache_create,
        stop_reason=stop_reason,
    )


def invoke_structured(
    llm: ChatAnthropic,
    system: Union[str, list[str]],
    user: str,
    *,
    tool_name: str,
    tool_description: str,
    tool_input_schema: dict,
    retry_suffix: str = "",
    cache_ttl: Optional[str] = None,
    uncached_suffix: str = "",
    cache_user: bool = True,
) -> StructuredLLMResponse:
    """
    Structured-output variant of `invoke()`. The model MUST reply with a
    single tool call to `tool_name` whose `arguments` match
    `tool_input_schema`. Returns the parsed tool-arguments dict in
    `.structured_output`.

    Why this exists
    ---------------
    Free-form JSON is sampled token-by-token without any schema constraint;
    on long outputs (LLD, codegen_v findings) the model can drift on the
    output SHAPE — emitting `[{...}, {...}]` where the schema declares
    `{"k1": {...}, "k2": {...}}`, missing required fields, or picking a
    string outside an enum. We then catch the drift post-hoc via Pydantic
    and burn a retry attempt patching it.

    Tool use is decoded against the schema directly. The API will not
    sample a `[` after a `"type": "object"` opening, will not skip a
    required field, will not invent an enum value. Shape drift becomes
    impossible. Semantic validators (cross-field invariants) still run on
    the Pydantic model — only structural shape is enforced here.

    Schema source
    -------------
    Pass `MyPydanticModel.model_json_schema()` for `tool_input_schema`.
    Pydantic emits a JSON Schema with `$defs` references which Anthropic's
    tool input_schema accepts natively. No preprocessing needed.

    Caching
    -------
    System prompt and stable user prefix are cached exactly as in
    `invoke()`. Retry suffix stays uncached. Tools themselves are part of
    the request shape; sending the same `tool_input_schema` across calls
    keeps the cache prefix valid.

    Tracing
    -------
    `input_log` captures the prompt before the call (same as `invoke()`).
    Callers should follow with `dump_structured_output(response.structured_output)`
    to write the tool arguments as JSON next to the prompt files.
    """
    _dump_inputs(system, user, retry_suffix, uncached_suffix=uncached_suffix)

    tools = [
        {
            "name": tool_name,
            "description": tool_description,
            "input_schema": tool_input_schema,
        }
    ]
    # `tool_choice={"type": "auto"}` is the ONLY choice compatible with
    # extended thinking — Anthropic rejects `any` and the named-tool
    # form (`{"type": "tool", "name": ...}`) with HTTP 400
    # "Thinking may not be enabled when tool_choice forces tool use"
    # whenever a `thinking_budget` is set. Every JSON-emitting agent
    # we converted uses thinking, so this is the only viable form.
    #
    # `auto` does not technically force a tool call — the model could
    # in principle reply with free-form text. In practice, with one
    # tool defined and a prompt that explicitly instructs the model to
    # call it, Sonnet calls the tool ~always. We still defend below
    # by falling back to `extract_json` on the text content when no
    # tool_use block surfaces, so the agent gets a parsed dict either
    # way.
    bound = llm.bind_tools(tools, tool_choice={"type": "auto"})

    start = time.monotonic()
    response = _invoke_with_retry(
        bound,
        [
            _system_message(system, cache_ttl=cache_ttl),
            _build_user_message(
                user,
                retry_suffix,
                cache_ttl=cache_ttl,
                uncached_suffix=uncached_suffix,
                cache_user=cache_user,
            ),
        ],
    )
    latency_ms = int((time.monotonic() - start) * 1000)

    structured = _extract_tool_args(response, tool_name)

    usage = getattr(response, "usage_metadata", None) or {}
    cache_read, cache_create = _extract_cache_metrics(usage)
    stop_reason = (getattr(response, "response_metadata", None) or {}).get(
        "stop_reason"
    )
    return StructuredLLMResponse(
        structured_output=structured,
        input_tokens=usage.get("input_tokens", 0) if usage else 0,
        output_tokens=usage.get("output_tokens", 0) if usage else 0,
        latency_ms=latency_ms,
        cache_read_tokens=cache_read,
        cache_creation_tokens=cache_create,
        stop_reason=stop_reason,
    )


def _extract_tool_args(response: object, tool_name: str) -> dict:
    """
    Pull the tool-call arguments out of a LangChain AIMessage. langchain-
    anthropic exposes them in two complementary places (per version):

      • `response.tool_calls`  — a list of {"name", "args", "id"} dicts,
                                  normalised across providers.
      • `response.content`     — the raw block list; tool calls appear as
                                  `{"type": "tool_use", "name", "input", "id"}`.

    Preferred path: the normalised `.tool_calls` attribute. Fallback path:
    walk the raw content for a `tool_use` block.

    Last-resort fallback: when neither path yields a tool call (the model
    replied with free-form text instead of using the tool — possible with
    `tool_choice="auto"`, which is the only form compatible with extended
    thinking), try to parse the visible text as JSON via `extract_json`.
    That puts the caller back on the same footing as a pre-tool-use
    `invoke()` call: the dict still flows through Pydantic, and any
    shape drift surfaces as a normal `ValidationError` for the retry
    loop to address. Only when text-based JSON extraction also fails do
    we raise — that's a real "model refused to comply at all" case.
    """
    tool_calls = getattr(response, "tool_calls", None)
    if tool_calls:
        for call in tool_calls:
            name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
            if name == tool_name:
                args = call.get("args") if isinstance(call, dict) else getattr(call, "args", None)
                if isinstance(args, dict):
                    return args

    content = getattr(response, "content", None)
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                if block.get("name") == tool_name:
                    args = block.get("input")
                    if isinstance(args, dict):
                        return args

    # Text fallback — `tool_choice=auto` lets the model emit free text
    # instead of calling the tool. Try to recover JSON from there.
    import json as _json

    text = _extract_text_content(content if content is not None else "")
    if text:
        try:
            parsed = _json.loads(extract_json(text))
            if isinstance(parsed, dict):
                log.warning(
                    "invoke_structured: model emitted text instead of a "
                    "tool call for %r — recovered JSON via extract_json "
                    "fallback. The agent runs but loses tool-decode shape "
                    "enforcement on this attempt.",
                    tool_name,
                )
                return parsed
        except (ValueError, _json.JSONDecodeError):
            pass

    stop_reason = (getattr(response, "response_metadata", None) or {}).get(
        "stop_reason"
    )
    raise RuntimeError(
        f"invoke_structured: no tool_use block named {tool_name!r} in "
        f"response and text fallback did not yield parseable JSON "
        f"(stop_reason={stop_reason!r})."
    )


def dump_structured_output(output: dict) -> None:
    """
    Persist a structured tool-call output into the current attempt_N dir
    as `output.json` so the post-mortem layout mirrors free-form runs
    (which write `output.txt`). No-op outside an `input_log` block.

    Failures are swallowed — observability must never break a run.
    """
    import json as _json

    state = _input_log_ctx.get()
    if state is None:
        return
    try:
        agent_dir = state.run_dir / "inputs" / state.agent
        if not agent_dir.is_dir():
            return
        attempts = sorted(
            (
                p
                for p in agent_dir.iterdir()
                if p.is_dir() and p.name.startswith("attempt_")
            ),
            key=lambda p: (
                int(p.name.split("_", 1)[1]) if p.name.split("_", 1)[1].isdigit() else 0
            ),
        )
        if not attempts:
            return
        (attempts[-1] / "output.json").write_text(
            _json.dumps(output, indent=2, default=str)
        )
    except Exception as exc:  # pragma: no cover — observability must not raise
        log.warning(
            "structured-output dump failed (agent=%s): %s", state.agent, exc
        )


def invoke_conversation(
    llm: ChatAnthropic,
    system: Union[str, list[str]],
    messages: list[dict],
    cache_ttl: Optional[str] = None,
) -> LLMResponse:
    """
    Multi-turn conversation call.
    messages: list of {"role": "user"|"assistant", "content": str}

    cache_ttl: see `invoke()`.
    """
    _dump_inputs(system, "", "", multi_turn_messages=messages)
    start = time.monotonic()
    lc_messages: list = [_system_message(system, cache_ttl=cache_ttl)]
    for msg in messages:
        if msg["role"] == "user":
            lc_messages.append(HumanMessage(content=msg["content"]))
        else:
            lc_messages.append(AIMessage(content=msg["content"]))

    response = _invoke_with_retry(llm, lc_messages)
    latency_ms = int((time.monotonic() - start) * 1000)

    usage = getattr(response, "usage_metadata", None) or {}
    cache_read, cache_create = _extract_cache_metrics(usage)
    stop_reason = (getattr(response, "response_metadata", None) or {}).get(
        "stop_reason"
    )
    return LLMResponse(
        content=_extract_text_content(response.content),
        input_tokens=usage.get("input_tokens", 0) if usage else 0,
        output_tokens=usage.get("output_tokens", 0) if usage else 0,
        latency_ms=latency_ms,
        cache_read_tokens=cache_read,
        cache_creation_tokens=cache_create,
        stop_reason=stop_reason,
    )


def extract_json(text: str) -> str:
    """
    Strip markdown code fences and extract the top-level JSON object/array.

    Two cases we handle, in priority order:

      Case A — the response is pure JSON (the first non-whitespace char
      after fence-stripping is `{` or `[`). Use the cheap slice from the
      first opening brace to the last matching closing brace. If the JSON
      is malformed, json.loads will fail downstream and the caller's retry
      path surfaces the parse error to the model verbatim — exactly what
      we want, because the model intended pure JSON and just got it
      slightly wrong (one missing comma, an extra `{`, etc.). Trying to
      "rescue" a malformed top-level by extracting an inner sub-block
      silently feeds the wrong shape to Pydantic.

      Case B — the response begins with prose ("Looking at the finding…")
      and the JSON appears later. Walk the text looking for balanced JSON
      blocks, ignoring braces inside string literals. Return the LARGEST
      parseable block — prose preambles may contain small literal
      fragments like `{...}` (invalid JSON, skipped) or `[]` (valid empty
      array but tiny); the real JSON is by far the biggest parseable
      block in the text. Picking by size eliminates those false positives
      reliably.
    """
    import json as _json
    import re

    text = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.MULTILINE)
    text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE).strip()

    # Case A — pure JSON output. Let json.loads surface parse errors so
    # the retry loop can show the model exactly what's malformed.
    if text.startswith("{") or text.startswith("["):
        end = max(text.rfind("}"), text.rfind("]")) + 1
        return text[:end].strip() if end > 0 else text

    # Case B — prose-then-JSON. Walk balanced blocks and return the
    # first one that parses cleanly.
    def _balanced_slice(s: str, start: int) -> Optional[str]:
        open_ch = s[start]
        if open_ch not in "{[":
            return None
        close_ch = "}" if open_ch == "{" else "]"
        depth = 0
        in_str = False
        escape = False
        for i in range(start, len(s)):
            c = s[i]
            if in_str:
                if escape:
                    escape = False
                elif c == "\\":
                    escape = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
                continue
            if c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1
                if depth == 0:
                    return s[start : i + 1]
        return None

    best: str = ""
    i = 0
    while i < len(text):
        if text[i] not in "{[":
            i += 1
            continue
        candidate = _balanced_slice(text, i)
        if candidate is None:
            i += 1
            continue
        try:
            _json.loads(candidate)
            if len(candidate) > len(best):
                best = candidate
            i += len(candidate)
        except ValueError:
            i += 1

    if best:
        return best.strip()

    # Last-resort fallback so a malformed response still surfaces a useful
    # slice on the caller's error path.
    start = next((i for i, c in enumerate(text) if c in "{["), 0)
    end = max(text.rfind("}"), text.rfind("]")) + 1
    return text[start:end].strip()


def extract_code(text: str) -> str:
    """Strip markdown code fences from a code block."""
    import re

    text = re.sub(r"^```(?:javascript|js)?\s*", "", text.strip(), flags=re.MULTILINE)
    text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
    return text.strip()
