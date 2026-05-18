"""
HLD (high-level design) agent runner.

Produces a high-level plan that the LLD agent + downstream e_*_agents
consume. (The legacy architect_agent was retired during the
legacy-architect cleanup.)

Flow
----
1. Build the system prompt via `prompt.build_system_prompt()` — static text
   + `HLDPlan.model_json_schema()`. Single source of truth.
2. Build a user message containing the merchant prompt and the product
   agent's intent JSON.
3. Invoke the LLM, extract JSON, parse with `HLDPlan.model_validate_json`.
4. On `pydantic.ValidationError` (rule violation) or `json.JSONDecodeError`
   (malformed output), format the errors into a retry suffix and re-invoke
   with the same cached system prompt up to `_MAX_ATTEMPTS` times.

Returns the parsed plan as a JSON-shape dict (keys mirror the wire format —
e.g. transitions use `from`, not `from_`) plus token totals.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Tuple

from pydantic import ValidationError

from models.adapter import (
    dump_structured_output,
    get_llm,
    invoke_structured,
)
from models.agent_models import get_agent_model
from subagents.c_hld_agent.prompt import build_system_prompt
from subagents.c_hld_agent.schema import HLDPlan

_MAX_ATTEMPTS = 3
_MAX_TOKENS = 7000
_THINKING_BUDGET = 4000


_USER_TEMPLATE = """\
Merchant request: {prompt}

Product-agent intent (use as context — pick the archetype, capabilities,
and contracts from the merchant's actual needs):
{intent_json}

Produce the HLD plan as JSON conforming to the appended schema."""

# Retry template — used when the validator finds issues. The prior plan is
# embedded in full so the model can copy unflagged sections verbatim instead
# of regenerating them from prompt+intent (which silently drops content the
# original generation included but the prompt doesn't mandate).
_REVISE_TEMPLATE = """\
Merchant request: {prompt}

Product-agent intent (use as context):
{intent_json}

REVISE the prior HLD plan below to address every reviewer finding. Output
a single JSON object conforming to the appended schema.

PRIOR PLAN — this is what you produced previously. Sections the reviewer
did NOT flag must be copied character-for-character into your revision.
Do not drop, rename, reorder, or reword unflagged capabilities, tables,
columns, contracts, edge cases, or dataFlow phrasing. Do not add new
capabilities, tables, or edge cases beyond what a finding's fix
explicitly requires. When renumbering is required (e.g. splitting one
contract into two), update only the affected indices and any explicit
cross-references.

```json
{prior_plan_json}
```

REVIEWER FINDINGS — apply each finding's fix to the relevant section of
the prior plan; leave everything else untouched.

{findings_text}"""


def run_hld_agent(
    prompt: str,
    intent: Dict[str, Any],
    on_attempt_failed: Optional[Callable[[int, List[str], int, int, int, int], None]] = None,
    validator_hint: Optional[str] = None,
    prior_plan: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], int, int, int, int]:
    """
    Run the HLD agent. Returns
    `(plan_dict, in_tokens, out_tokens, cache_read_tokens, cache_creation_tokens)`.
    Cache fields are summed across retry attempts so the caller can show
    actual cost rather than raw input totals.

    Validation lives inside the schema (`HLDPlan`); the agent retries on
    its own when validation fails — the caller does not need an outer
    retry loop.

    Parameters
    ----------
    on_attempt_failed:
        Optional callback invoked when an attempt is rejected, before the
        next attempt fires. Receives `(attempt_index, errors, in_tokens,
        out_tokens, cache_read_tokens, cache_creation_tokens)` — running
        totals through this just-failed attempt — so the CLI can surface
        live retry feedback (including spend) instead of the spinner
        sitting silent for ~30s × N attempts. Not called on the final
        failure (`HLDValidationError` carries the same totals directly).

    Raises
    ------
    HLDValidationError
        When all `_MAX_ATTEMPTS` attempts fail validation. Message contains
        the most recent error list so the operator can debug the prompt.
    """
    system = build_system_prompt()
    if validator_hint and prior_plan is not None:
        # Revise mode — embed the prior plan so unflagged sections can be
        # copied verbatim instead of silently regenerated.
        base_user = _REVISE_TEMPLATE.format(
            prompt=prompt,
            intent_json=json.dumps(intent),
            prior_plan_json=json.dumps(prior_plan),
            findings_text=validator_hint,
        )
    else:
        base_user = _USER_TEMPLATE.format(
            prompt=prompt,
            intent_json=json.dumps(intent),
        )
    llm = get_llm(
        model=get_agent_model("hld"),
        max_tokens=_MAX_TOKENS,
        thinking_budget=_THINKING_BUDGET,
    )

    total_in = 0
    total_out = 0
    total_cache_r = 0
    total_cache_c = 0
    last_errors: List[str] = []

    hld_schema = HLDPlan.model_json_schema()

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        retry_suffix = _format_retry_suffix(last_errors) if last_errors else ""
        # 1-hour TTL: HLD attempts often run 30-90s each, and the
        # downstream hld_v retry can land well past 5 min. With the
        # default TTL retries pay cache_create on every attempt; 1h
        # keeps the system + HLD prefix hot for the full pipeline.
        result = invoke_structured(
            llm,
            system,
            base_user,
            tool_name="emit_hld_plan",
            tool_description=(
                "Emit the complete High-Level Design plan as a structured "
                "object conforming to the HLDPlan schema. Call exactly "
                "once with the full plan as the tool input."
            ),
            tool_input_schema=hld_schema,
            retry_suffix=retry_suffix,
            cache_ttl="1h",
        )
        total_in += result.input_tokens
        total_out += result.output_tokens
        total_cache_r += result.cache_read_tokens
        total_cache_c += result.cache_creation_tokens

        # Persist the structured output next to the prompt files (as
        # output.json) so a failure is fully post-mortem-able without
        # re-running. No-op outside an active `input_log` block.
        dump_structured_output(result.structured_output)

        # Truncation is a config problem (cap too low for the schema), not a
        # model error to retry against — the next attempt only adds suffix
        # bytes and shrinks the output budget further. Fail loudly.
        if result.stop_reason == "max_tokens":
            raise HLDValidationError(
                attempt,
                [
                    f"output truncated at max_tokens={_MAX_TOKENS}; raise the cap or shorten the prompt"
                ],
                total_in,
                total_out,
                total_cache_r,
                total_cache_c,
            )

        # Tool use guarantees structural shape; only semantic invariants
        # (cross-field model_validators on HLDPlan) can still fail.
        try:
            plan = HLDPlan.model_validate(result.structured_output)
        except ValidationError as err:
            last_errors = _format_pydantic_errors(err)
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(
                    attempt, last_errors, total_in, total_out, total_cache_r, total_cache_c
                )
            continue

        # `by_alias=True` so transitions use `from` (not `from_`) on the
        # wire — matches the schema the model was prompted with.
        return (
            plan.model_dump(mode="json", by_alias=True),
            total_in,
            total_out,
            total_cache_r,
            total_cache_c,
        )

    raise HLDValidationError(
        _MAX_ATTEMPTS, last_errors, total_in, total_out, total_cache_r, total_cache_c
    )


# ── Internals ─────────────────────────────────────────────────────────


class HLDValidationError(RuntimeError):
    """Raised when the HLD agent exhausts its retry budget."""

    def __init__(
        self,
        attempts: int,
        errors: List[str],
        in_tokens: int,
        out_tokens: int,
        cache_read_tokens: int = 0,
        cache_creation_tokens: int = 0,
    ) -> None:
        self.attempts = attempts
        self.errors = errors
        self.in_tokens = in_tokens
        self.out_tokens = out_tokens
        self.cache_read_tokens = cache_read_tokens
        self.cache_creation_tokens = cache_creation_tokens
        bullets = "\n".join(f"  - {e}" for e in errors)
        super().__init__(f"HLD agent failed after {attempts} attempt(s):\n{bullets}")


def _format_pydantic_errors(err: ValidationError) -> List[str]:
    """
    Turn a Pydantic ValidationError into compact, model-friendly bullet
    lines: `<json.path>: <message>`. The `loc` tuple is rendered as a
    JSON-pointer-ish path so the model can locate the offending field
    in its own output.
    """
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
        "object that conforms to the schema; no markdown fences, no prose.\n"
    )
