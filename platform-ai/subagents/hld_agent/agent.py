"""
HLD (high-level design) agent runner.

Replaces the legacy architect agent for plans that stop at the HLD phase.
The legacy `subagents/architect_agent.py` is intentionally kept for
reference until the LLD agent + downstream wiring are ready.

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

from models.adapter import dump_output, extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.hld_agent.prompt import build_system_prompt
from subagents.hld_agent.schema import HLDPlan

_MAX_ATTEMPTS = 3
_MAX_TOKENS = 4000
_THINKING_BUDGET = 4000


_USER_TEMPLATE = """\
Merchant request: {prompt}

Product-agent intent (use as context — pick the archetype, capabilities,
and contracts from the merchant's actual needs):
{intent_json}

Produce the HLD plan as JSON conforming to the appended schema."""

_VALIDATOR_HINT_SUFFIX = """\


SEMANTIC REVIEW FEEDBACK — you already produced an HLD plan for this
request and a reviewer flagged the issues below. Your job now is to emit a
corrected version with MINIMAL changes:

  - Address every finding listed.
  - Keep everything the reviewer did NOT flag exactly as it was — same
    capability ids, same table names and column orders, same contract
    paths, same edge-case wording, same dataFlow phrasing where unaffected.
  - Do not refactor, rename, reorder, or reword sections that are not part
    of a finding. Do not add new capabilities, tables, or edge cases beyond
    what the findings require.
  - When a finding requires renumbering (e.g. splitting one contract into
    two), update only the affected indices and any explicit cross-references.

Findings:
{findings_text}"""


def run_hld_agent(
    prompt: str,
    intent: Dict[str, Any],
    on_attempt_failed: Optional[Callable[[int, List[str]], None]] = None,
    validator_hint: Optional[str] = None,
) -> Tuple[Dict[str, Any], int, int]:
    """
    Run the HLD agent. Returns (plan_dict, in_tokens, out_tokens).

    Validation lives inside the schema (`HLDPlan`); the agent retries on
    its own when validation fails — the caller does not need an outer
    retry loop.

    Parameters
    ----------
    on_attempt_failed:
        Optional callback invoked when an attempt is rejected, before the
        next attempt fires. Receives `(attempt_index, errors)` so the CLI
        can surface live retry feedback instead of the spinner sitting
        silent for ~30s × N attempts. Not called on the final failure
        (`HLDValidationError` carries those errors directly).

    Raises
    ------
    HLDValidationError
        When all `_MAX_ATTEMPTS` attempts fail validation. Message contains
        the most recent error list so the operator can debug the prompt.
    """
    system = build_system_prompt()
    base_user = _USER_TEMPLATE.format(
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
    )
    if validator_hint:
        base_user += _VALIDATOR_HINT_SUFFIX.format(findings_text=validator_hint)
    llm = get_llm(model=get_agent_model("hld"), max_tokens=_MAX_TOKENS, thinking_budget=_THINKING_BUDGET)

    total_in = 0
    total_out = 0
    last_errors: List[str] = []

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        retry_suffix = _format_retry_suffix(last_errors) if last_errors else ""
        result = invoke(llm, system, base_user, retry_suffix=retry_suffix)
        total_in += result.input_tokens
        total_out += result.output_tokens

        # Persist the raw model response next to the prompt files, so a
        # 3-attempt failure is fully post-mortem-able without re-running.
        # No-op outside an active `input_log` block.
        dump_output(result.content)

        try:
            raw_json = extract_json(result.content)
        except Exception as err:
            last_errors = [f"could not extract a JSON object from output: {err}"]
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue

        try:
            plan = HLDPlan.model_validate_json(raw_json)
        except ValidationError as err:
            last_errors = _format_pydantic_errors(err)
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue
        except json.JSONDecodeError as err:
            last_errors = [f"output is not valid JSON: {err}"]
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue

        # `by_alias=True` so transitions use `from` (not `from_`) on the
        # wire — matches the schema the model was prompted with.
        return (
            plan.model_dump(mode="json", by_alias=True),
            total_in,
            total_out,
        )

    raise HLDValidationError(_MAX_ATTEMPTS, last_errors, total_in, total_out)


# ── Internals ─────────────────────────────────────────────────────────


class HLDValidationError(RuntimeError):
    """Raised when the HLD agent exhausts its retry budget."""

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
