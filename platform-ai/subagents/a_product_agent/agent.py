"""
Product Agent runner — Agent 1 of the FeatureGenerator pipeline.

Two entry points:
  run_product_agent()         — one-shot: translate a merchant prompt into a
                                 typed feature spec (ProductIntent).
  run_product_agent_analyze() — multi-turn: interactive clarification loop
                                 used by the /analyze API endpoint before
                                 generation is triggered.

Flow (one-shot)
---------------
1. Invoke the LLM with PRODUCT_BASE + the merchant prompt.
2. Extract JSON, parse with `ProductIntent.model_validate_json`.
3. On `pydantic.ValidationError` (rule violation) or `json.JSONDecodeError`
   (malformed output), format errors into a retry suffix and re-invoke
   up to `_MAX_ATTEMPTS` times.
4. After exhausting retries, raise `ProductIntentValidationError`.

The schema lives in `schema.py` — closed-set fields use `Literal[...]`;
cross-field rules (cron coupling, widget/storefront biconditional, admin
coupling) live as `@model_validator(mode="after")` methods.

Model: claude-haiku (fast; purely classification + JSON extraction).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Tuple

log = logging.getLogger(__name__)

from pydantic import ValidationError

from models.adapter import dump_output, extract_json, get_llm, invoke, invoke_conversation
from models.agent_models import get_agent_model
from subagents.a_product_agent.prompt import (
    PRODUCT_ANALYZE_BASE,
    PRODUCT_BASE,
)
from subagents.a_product_agent.schema import ProductIntent

_MAX_ATTEMPTS = 3
_MAX_TOKENS = 1500


def run_product_agent(prompt: str) -> Tuple[Dict[str, Any], int, int]:
    """
    Parse a merchant prompt into a typed `ProductIntent`.

    Returns `(intent_dict, in_tokens, out_tokens)` — the dict is the JSON
    serialisation of a validated ProductIntent. Validation lives inside
    the schema; the agent retries up to `_MAX_ATTEMPTS` on its own when
    validation fails — the caller does not need an outer retry loop.

    Raises
    ------
    ProductIntentValidationError
        When all `_MAX_ATTEMPTS` attempts fail validation. Carries the
        most-recent error list so the operator can debug the prompt.
    """
    llm = get_llm(
        model=get_agent_model("product"),
        max_tokens=_MAX_TOKENS,
        cache_ttl="1h",
    )
    base_user = f"Merchant request: {prompt}"
    total_in = 0
    total_out = 0
    last_errors: List[str] = []

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        retry_suffix = _format_retry_suffix(last_errors) if last_errors else ""
        # `cache_ttl="1h"` keeps the shared `_CORE_RULES` system-prompt prefix
        # cached for an hour instead of the 5-min default. Costs 2× on the
        # cache write (vs 1.25×) but pays off when the same merchant returns
        # mid-conversation, or when the one-shot agent runs minutes after the
        # analyze loop populated the same prefix. See models/adapter.py.
        result = invoke(
            llm,
            PRODUCT_BASE,
            base_user,
            retry_suffix=retry_suffix,
            cache_ttl="1h",
        )
        total_in += result.input_tokens
        total_out += result.output_tokens
        dump_output(result.content)  # trace alongside the attempt's system/user

        try:
            raw_json = extract_json(result.content)
        except Exception as err:
            last_errors = [f"could not extract a JSON object from output: {err}"]
            continue

        try:
            intent = ProductIntent.model_validate_json(raw_json)
        except ValidationError as err:
            last_errors = _format_pydantic_errors(err)
            continue
        except json.JSONDecodeError as err:
            last_errors = [f"output is not valid JSON: {err}"]
            continue

        return intent.model_dump(mode="json"), total_in, total_out

    raise ProductIntentValidationError(_MAX_ATTEMPTS, last_errors, total_in, total_out)


def run_product_agent_analyze(
    history: List[Dict[str, Any]],
) -> Tuple[Dict[str, Any], Dict[str, int]]:
    """
    Multi-turn product agent for the interactive /analyze endpoint.

    history: list of {"role": "user"|"assistant", "content": str}

    Returns (response_dict, metrics_dict):
      response_dict is one of:
        {"status": "needs_clarification", "question": "...", "suggestions": [...]}
        {"status": "ready", "summary": "...", "intent": {<ProductIntent>}}
      metrics_dict carries the per-call token totals so the CLI can render
      cache-hit ratios live during the clarification loop:
        {"in": int, "out": int, "cache_read": int, "cache_create": int}

    Only the "ready" branch is schema-validated. A model output that
    looks "ready" but fails ProductIntent validation degrades to
    "needs_clarification" so the conversation can continue rather than
    hand a malformed intent to the rest of the pipeline.
    """
    # The `ready` response carries the full intent dict + a ≤200-word
    # merchant-facing summary; 512 tokens truncates the JSON mid-string and
    # makes extract_json fail. 4000 fits the longest realistic ready
    # response with headroom for follow-up suggestions on a clarify turn.
    # `cache_ttl="1h"` attaches the Anthropic beta header that makes the
    # 1-hour `cache_control.ttl` we set in `invoke_conversation()` actually
    # register — without it Anthropic silently ignores the marker.
    llm = get_llm(
        model=get_agent_model("product"),
        max_tokens=4000,
        cache_ttl="1h",
    )
    # `cache_ttl="1h"` — the analyze loop is the canonical merchant-pace
    # conversation; turns may arrive minutes apart. The 1-hour cache
    # covers walking-away-and-returning gaps that would otherwise force a
    # cold cache rebuild on every resumed turn.
    result = invoke_conversation(
        llm, PRODUCT_ANALYZE_BASE, history, cache_ttl="1h"
    )
    dump_output(result.content)  # trace alongside the attempt's system/user
    metrics: Dict[str, int] = {
        "in": result.input_tokens,
        "out": result.output_tokens,
        "cache_read": result.cache_read_tokens,
        "cache_create": result.cache_creation_tokens,
    }

    # Truncation is the dominant cause of "couldn't parse the response" on
    # this path: a `ready` response (full intent + 200-word summary) can
    # cleanly exceed any tight max_tokens cap, and the resulting partial
    # JSON fails extract_json silently. Detect it explicitly so the
    # merchant sees something useful instead of the generic
    # `_default_clarification_question()` fallback loop, and so the
    # operator notices in the log.
    truncated = result.stop_reason == "max_tokens"
    if truncated:
        log.warning(
            "product_analyze: response truncated at max_tokens "
            "(out=%d) — surfacing as clarification rather than silent fail-open",
            result.output_tokens,
        )

    try:
        raw = extract_json(result.content)
        parsed = json.loads(raw) if raw else None
    except (Exception, json.JSONDecodeError):
        parsed = None

    if not isinstance(parsed, dict):
        return _truncated_clarification() if truncated else _needs_clarification(), metrics

    status = parsed.get("status")
    if status == "ready":
        try:
            intent = ProductIntent.model_validate(parsed.get("intent") or {})
        except ValidationError:
            return _truncated_clarification() if truncated else _needs_clarification(), metrics
        return (
            {
                "status": "ready",
                "summary": parsed.get("summary", ""),
                "intent": intent.model_dump(mode="json"),
            },
            metrics,
        )

    # Anything other than "ready" — including missing status — falls back
    # to a clarification request the API endpoint can show the merchant.
    return (
        {
            "status": "needs_clarification",
            "question": parsed.get("question") or _default_clarification_question(),
            "suggestions": parsed.get("suggestions") or [],
        },
        metrics,
    )


# ── Internals ──────────────────────────────────────────────────────────


class ProductIntentValidationError(RuntimeError):
    """Raised when the product agent exhausts its retry budget."""

    def __init__(
        self,
        attempts: int,
        errors: List[str],
        in_tokens: int,
        out_tokens: int,
    ) -> None:
        self.attempts = attempts
        self.errors = errors
        self.in_tokens = in_tokens
        self.out_tokens = out_tokens
        bullets = "\n".join(f"  - {e}" for e in errors)
        super().__init__(
            f"Product agent failed after {attempts} attempt(s):\n{bullets}"
        )


def _format_pydantic_errors(err: ValidationError) -> List[str]:
    """Render a Pydantic ValidationError as bullet-friendly lines
    (`<json.path>: <message>`) the model can re-read on retry."""
    out: List[str] = []
    for e in err.errors():
        loc = ".".join(str(p) for p in e.get("loc", ())) or "<root>"
        msg = e.get("msg", "validation error")
        out.append(f"{loc}: {msg}")
    return out


def _format_retry_suffix(errors: List[str]) -> str:
    bullets = "\n".join(f"  - {e}" for e in errors)
    return (
        f"\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n{bullets}\n"
        "Fix ALL listed errors in this new attempt. Emit a single JSON "
        "object — no markdown fences, no prose.\n"
    )


def _needs_clarification() -> Dict[str, Any]:
    return {
        "status": "needs_clarification",
        "question": _default_clarification_question(),
        "suggestions": [],
    }


def _truncated_clarification() -> Dict[str, Any]:
    """
    Used when the model's response was cut off at max_tokens and the
    partial JSON failed to parse. We can't recover the truncated content
    on this turn, but surfacing the cause (instead of falling back to the
    generic `_default_clarification_question`) breaks the silent-loop
    failure mode where the same vague question fires repeatedly. The
    operator sees the warning in the log; the merchant sees a question
    that prompts them to compress their answer.
    """
    return {
        "status": "needs_clarification",
        "question": (
            "I started to draft your app spec but ran out of room before "
            "finishing. Could you state the most important requirement in "
            "one short sentence so I can produce the spec?"
        ),
        "suggestions": [],
    }


def _default_clarification_question() -> str:
    return "Could you tell me more about what you'd like to build?"
