"""
Pre-codegen alignment agent runner.

Reads the finalised LLD plan plus the merchant intent and emits at most
10 short, structured alignment notes. Each note is a cross-surface
ambiguity translated into one imperative line per downstream codegen
agent (db / backend / storefront / admin_ui).

Fails OPEN. Any LLM, parse, or schema-validation failure returns an
empty notes list with a logged warning — codegen continues unchanged.
The agent is a strength multiplier, not a gate; never block the
pipeline on its output.

Flow
----
1. Build system prompt via `prompt.build_system_prompt()`.
2. Build the user message: merchant intent + LLD plan as JSON.
3. Invoke the LLM (Sonnet by default, with a small thinking budget).
4. Extract JSON; parse with `PreCodegenOutput.model_validate_json`.
5. Return `(notes_as_dicts, in_tokens, out_tokens, cache_read, cache_create)`.

Notes are returned as plain dicts (not Pydantic objects) so callers can
serialise them into state.json / context without import-time coupling
to this module.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Literal, Tuple

from pydantic import ValidationError

from models.adapter import (
    dump_structured_output,
    get_llm,
    invoke_structured,
)
from models.agent_models import get_agent_model
from subagents.m_pre_codegen_agent.prompt import build_system_prompt
from subagents.m_pre_codegen_agent.schema import PreCodegenOutput

log = logging.getLogger(__name__)

# Status taxonomy. `[]` notes alone is ambiguous (clean run vs. one of
# four distinct failures); the status makes the outcome diff-able in
# state.json and lets the CLI render a meaningful suffix.
#
#   ok              — LLM returned valid JSON; notes may be 0+.
#   parse_error     — extract_json / json.JSONDecodeError.
#   schema_error    — Pydantic ValidationError.
#   truncated       — stop_reason == "max_tokens".
#   llm_error       — exception during invoke().
#   skipped         — defensive early exit (no LLD provided).
Status = Literal[
    "ok",
    "parse_error",
    "schema_error",
    "truncated",
    "llm_error",
    "skipped",
]

# Output cap. 10 notes × ~400-char instruction + rationale ≈ 8KB JSON,
# well under any per-agent prompt budget.
_MAX_OUTPUT_TOKENS = 2_000
# A small thinking budget lets the agent reason about cross-surface
# patterns without producing prose. The agent is structural, not
# generative — 1024 is enough for this scope.
_THINKING_BUDGET = 1_024

_USER_TEMPLATE = """\
MERCHANT INTENT
{intent_json}

LLD PLAN — what every downstream codegen agent will read (each agent sees
only its slice; your job is to pin alignment across the slices).
{lld_json}"""


def run_pre_codegen(
    lld: Dict[str, Any],
    intent: Dict[str, Any],
) -> Tuple[List[Dict[str, Any]], Status, int, int, int, int]:
    """
    Run the pre-codegen alignment agent. Returns
    `(notes, status, in_tokens, out_tokens, cache_read_tokens, cache_creation_tokens)`.

    `notes` is a list of dicts with keys: `target_agents`, `concern`,
    `surfaces`, `instruction`, `rationale`. An empty list paired with
    `status == "ok"` means the LLM legitimately found no cross-surface
    ambiguity; any other status means the agent failed open and the
    empty list is a fallback, not a finding.

    Callers (the orchestration helper and the shells it powers) should
    branch on `status` for logging — "no alignment needed" is only
    truthful when `status == "ok"`. Treat every other status as a soft
    warning the operator should surface.

    `cache_read_tokens` are the prefix tokens served from Anthropic's
    prompt cache at ~10% of the normal input price; `cache_creation_tokens`
    were written to the cache on this call. Both are reported separately
    from `in_tokens` so the CLI can show actual cost rather than raw
    totals.
    """
    if not lld:
        # Defensive: no LLD → no alignment to find. Skip the call entirely.
        return [], "skipped", 0, 0, 0, 0

    system = build_system_prompt()
    user = _USER_TEMPLATE.format(
        intent_json=json.dumps(intent or {}),
        lld_json=json.dumps(lld),
    )
    llm = get_llm(
        model=get_agent_model("pre_codegen"),
        max_tokens=_MAX_OUTPUT_TOKENS,
        thinking_budget=_THINKING_BUDGET,
    )

    try:
        # 1-hour TTL: pre_codegen runs once between lld_v and the codegen
        # phase — well past the 5-min default cache window. Aligning TTL
        # with the codegen agents keeps the shared LLD prefix hot for
        # this call and any downstream codegen_v retries.
        response = invoke_structured(
            llm,
            system,
            user,
            tool_name="emit_alignment_notes",
            tool_description=(
                "Emit the cross-agent alignment notes (concerns + targeted "
                "agents + instructions) as a structured object conforming "
                "to the PreCodegenOutput schema. Call exactly once with "
                "the full notes list as the tool input."
            ),
            tool_input_schema=PreCodegenOutput.model_json_schema(),
            cache_ttl="1h",
        )
    except Exception as exc:  # noqa: BLE001 — fail-open by design.
        log.warning("pre_codegen: LLM invocation failed (%s) — fail-open", exc)
        return [], "llm_error", 0, 0, 0, 0

    in_tok = response.input_tokens
    out_tok = response.output_tokens
    cache_r = response.cache_read_tokens
    cache_c = response.cache_creation_tokens
    dump_structured_output(response.structured_output)

    if response.stop_reason == "max_tokens":
        # The output was truncated — JSON is almost certainly invalid.
        # Log loudly and fail open rather than half-applying notes.
        log.warning(
            "pre_codegen: output truncated at max_tokens=%d — fail-open",
            _MAX_OUTPUT_TOKENS,
        )
        return [], "truncated", in_tok, out_tok, cache_r, cache_c

    # Tool use guarantees structural shape; only semantic invariants on
    # PreCodegenOutput can still fail (e.g. too many notes, unknown enum
    # values that the schema's Literals reject).
    try:
        output = PreCodegenOutput.model_validate(response.structured_output)
    except ValidationError as exc:
        log.warning("pre_codegen: response did not match schema (%s) — fail-open", exc)
        return [], "schema_error", in_tok, out_tok, cache_r, cache_c

    notes = [n.model_dump(mode="json") for n in output.notes]
    for n in notes:
        log.info(
            "pre_codegen[%s → %s] %s",
            n["concern"],
            ",".join(n["target_agents"]),
            n["instruction"],
        )

    return notes, "ok", in_tok, out_tok, cache_r, cache_c
