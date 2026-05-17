"""
LLD (low-level design) agent runner — stage 2 of the LLD-replacing-architect chain.

Replaces the legacy architect's structural plan with a complete, codegen-ready
implementation specification. The LLD reads the HLD plan + the ops-picker's
enriched picks, and emits an `LLDPlan` covering: physical SQL schema, wire
HTTP route shapes, Shopify integration plan (webhook topics + cron expression),
and per-capability ordered algorithm recipes.

Flow
----
1. Build the system prompt via `prompt.build_system_prompt()` — static text
   + `LLDPlan.model_json_schema()`. Single source of truth.
2. Build a user message containing the merchant prompt, the HLD plan, and
   the enriched ops-picks (each pick already carries args, returnTypeSdl,
   inputTypesSdl, examples — added by the ops-picker runner).
3. Invoke the LLM, extract JSON, parse with `LLDPlan.model_validate_json`.
4. Enrich the parsed plan in place with platform-runtime examples
   (`platform_runtime_examples.example_for_step`). The runner stamps each
   external-call step with the matching working-TS snippet so codegen
   downstream never has to JIT-load Shopify / platform docs.
5. On `pydantic.ValidationError` (rule violation) or `json.JSONDecodeError`
   (malformed output), format the errors into a retry suffix and re-invoke
   with the same cached system prompt up to `_MAX_ATTEMPTS` times.

Returns the parsed plan as a JSON-shape dict (keys mirror the wire format)
plus token totals.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from pydantic import ValidationError

from models.adapter import dump_output, extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.i_lld_agent.platform_helpers_prose import (
    CONFIG_HELPER_CONTRACT,
    MONEY_HELPER_CONTRACT,
    PAGINATE_HELPER_CONTRACT,
    WORKFLOW_HELPER_CONTRACT,
)
from subagents.i_lld_agent.platform_runtime_examples import (
    example_for_step,
    paginate_snippet,
)
from subagents.i_lld_agent.prompt import build_system_prompt
from subagents.i_lld_agent.schema import LLDPlan

_MAX_ATTEMPTS = 3
_MAX_TOKENS = 40_000
_THINKING_BUDGET = 0


_USER_TEMPLATE = """\
Merchant request: {prompt}

HLD plan (schema-agnostic, integration-agnostic — your domain spine):
{hld_json}

Ops-picker output (Shopify GraphQL ops + webhook topics, with each op
enriched with its signature, return-type SDL, input types, and real
example queries from Shopify's docs — use these to write the actual
GraphQL strings inside your shopify_query / shopify_mutation steps):
{ops_picks_json}

Produce the LLD plan as JSON conforming to the appended schema."""


_REVISE_SUFFIX_TEMPLATE = """\


REVISE the previous attempt below to address every finding. Sections the
validator did NOT flag must be copied character-for-character from the
previous attempt — same table names and column orders, same recipe ids,
same step ordering, same SQL templates, same GraphQL strings, same
contract paths, same edge-case wording. Do not drop, rename, reword, or
reorder anything outside the flagged scope. Do not add new sections
beyond what a finding's fix explicitly requires.

OUTPUT FORMAT — strictly enforced:
  - JSON only. Your response MUST start with `{{` and end with `}}`.
  - No preamble ("Looking at the finding…", "I see that…", etc.).
  - No markdown fences.
  - No commentary after the JSON.
  Anything outside that contract is rejected as invalid output.

PREVIOUS ATTEMPT:
{prior_output}

FINDINGS:
{findings_text}"""


def run_lld_agent(
    prompt: str,
    plan: Dict[str, Any],
    ops_picks: Dict[str, Any],
    on_attempt_failed: Optional[Callable[[int, List[str]], None]] = None,
    validator_hint: Optional[str] = None,
    prior_plan: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], int, int, int, int]:
    """
    Run the LLD agent. Returns
    `(lld_dict, in_tokens, out_tokens, cache_read_tokens, cache_creation_tokens)`.
    Cache fields are summed across retry attempts so the caller can show
    actual cost rather than raw input totals.

    Validation lives inside the schema (`LLDPlan`). The agent retries on
    its own when validation fails — the caller does not need an outer
    retry loop.

    Parameters
    ----------
    prompt:
        Merchant request — kept in the user message for context.
    plan:
        The parsed HLDPlan dict (output of `run_hld_agent`).
    ops_picks:
        The enriched ops-picks dict (output of `run_ops_picker_agent`,
        already merged with per-op catalog detail).
    on_attempt_failed:
        Optional callback invoked when an attempt is rejected, before the
        next attempt fires. Receives `(attempt_index, errors)` so the CLI
        can surface live retry feedback. Not called on the final failure
        (`LLDValidationError` carries those errors directly).
    validator_hint:
        Optional pre-seeded findings (e.g. from a future `lld_v` validator)
        appended to the first user message.

    Raises
    ------
    LLDValidationError
        When all `_MAX_ATTEMPTS` attempts fail validation.
    """
    system = build_system_prompt()
    base_user = _USER_TEMPLATE.format(
        prompt=prompt,
        hld_json=json.dumps(plan),
        ops_picks_json=json.dumps(ops_picks),
    )

    if _hld_has_list_capability(plan):
        base_user += "\n\n" + PAGINATE_HELPER_CONTRACT

    if _hld_has_money_capability(plan):
        base_user += "\n\n" + MONEY_HELPER_CONTRACT

    if _hld_uses_config(plan):
        base_user += "\n\n" + CONFIG_HELPER_CONTRACT

    if _hld_uses_workflow(plan):
        base_user += "\n\n" + WORKFLOW_HELPER_CONTRACT

    llm = get_llm(
        model=get_agent_model("lld"),
        max_tokens=_MAX_TOKENS,
        thinking_budget=_THINKING_BUDGET,
    )

    total_in = 0
    total_out = 0
    total_cache_r = 0
    total_cache_c = 0
    last_errors: List[str] = []
    # Carry the prior attempt's raw output so the model can revise it
    # character-for-character on retry instead of regenerating from scratch.
    # Seeded from `prior_plan` when the caller (e.g. a future lld_v retry)
    # passes one alongside `validator_hint`.
    last_output: Optional[str] = (
        json.dumps(prior_plan) if prior_plan is not None else None
    )
    if validator_hint and last_output is not None:
        last_errors = [validator_hint]

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        if last_errors and last_output is not None:
            retry_suffix = _REVISE_SUFFIX_TEMPLATE.format(
                prior_output=last_output,
                findings_text="\n".join(f"  - {e}" for e in last_errors),
            )
        else:
            retry_suffix = ""
        result = invoke(llm, system, base_user, retry_suffix=retry_suffix)
        total_in += result.input_tokens
        total_out += result.output_tokens
        total_cache_r += result.cache_read_tokens
        total_cache_c += result.cache_creation_tokens

        # Persist the raw model response next to the prompt files. No-op
        # outside an active `input_log` block.
        dump_output(result.content)
        # Minify the prior output before echoing it back on the next retry:
        #   - strips markdown fences (avoid nested ``` in the retry template)
        #   - drops whatever indentation the model chose, saving ~30% of
        #     retry-suffix tokens.
        # Fall back to the raw content when the response isn't parseable —
        # the next attempt's validator will surface the same parse error
        # we hit here.
        try:
            last_output = json.dumps(json.loads(extract_json(result.content)))
        except (ValueError, json.JSONDecodeError):
            last_output = result.content

        # Truncation is a config problem (cap too low for the schema), not a
        # model error to retry against — the next attempt only adds suffix
        # bytes and shrinks the output budget further. Fail loudly.
        if result.stop_reason == "max_tokens":
            raise LLDValidationError(
                attempt,
                [
                    f"output truncated at max_tokens={_MAX_TOKENS}; raise the cap or shorten the prompt"
                ],
                total_in,
                total_out,
                total_cache_r,
                total_cache_c,
            )

        try:
            raw_json = extract_json(result.content)
        except Exception as err:
            last_errors = [f"could not extract a JSON object from output: {err}"]
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue

        try:
            parsed = LLDPlan.model_validate_json(raw_json)
        except ValidationError as err:
            last_errors = _format_pydantic_errors(err)
            last_errors = _enrich_with_byte_context(last_errors, raw_json)
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue
        except json.JSONDecodeError as err:
            last_errors = _enrich_with_byte_context(
                [f"output is not valid JSON: {err}"], raw_json
            )
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue

        # `by_alias=True` so transitions use `from` (not `from_`) on the
        # wire — matches the schema the model was prompted with.
        lld_dict = parsed.model_dump(mode="json", by_alias=True)
        _enrich_with_runtime_examples(lld_dict, ops_picks)
        return lld_dict, total_in, total_out, total_cache_r, total_cache_c

    raise LLDValidationError(
        _MAX_ATTEMPTS, last_errors, total_in, total_out, total_cache_r, total_cache_c
    )


# ── Internals ─────────────────────────────────────────────────────────


class LLDValidationError(RuntimeError):
    """Raised when the LLD agent exhausts its retry budget."""

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
        super().__init__(f"LLD agent failed after {attempts} attempt(s):\n{bullets}")


def _format_pydantic_errors(err: ValidationError) -> List[str]:
    """
    Turn a Pydantic ValidationError into compact, model-friendly bullet
    lines: `<json.path>: <message>`. Same shape as HLD/ops-picker.
    """
    out: List[str] = []
    for e in err.errors():
        loc = ".".join(str(p) for p in e.get("loc", ())) or "<root>"
        msg = e.get("msg", "validation error")
        out.append(f"{loc}: {msg}")
    return out


# Match `column N` or `char N` from Pydantic / json error messages so we can
# splice the offending byte window from the raw output into the retry note.
_PARSE_COLUMN_RE = re.compile(r"\b(?:column|char)\s+(\d+)", re.IGNORECASE)


def _enrich_with_byte_context(errors: List[str], raw_json: str) -> List[str]:
    """
    When an error message names a column / char offset into the raw model
    output (Pydantic + json.JSONDecodeError both do), append a ±60-byte
    window around that offset so the model can SEE its own slip on retry.

    Without this the model receives only the column number ("column 13082")
    and has to guess where it went wrong inside ~50k characters of its own
    output — a single-character autoregressive slip then often survives the
    retry. With the window it sees e.g. `},(` vs the expected `},"` and
    fixes the typo in one pass.

    Only enriches the first error string that names a column. Errors with
    no column reference (most schema rule violations) pass through unchanged.
    """
    enriched: List[str] = []
    annotated = False
    for line in errors:
        if annotated or not raw_json:
            enriched.append(line)
            continue
        m = _PARSE_COLUMN_RE.search(line)
        if not m:
            enriched.append(line)
            continue
        # column/char counts are 1-based in error messages but indexed into
        # the raw string. Treat as char offset; clamp to bounds.
        pos = max(0, min(int(m.group(1)) - 1, len(raw_json) - 1))
        start = max(0, pos - 60)
        end = min(len(raw_json), pos + 60)
        window = raw_json[start:end].replace("\n", "\\n")
        enriched.append(f"{line}\n    near col {pos + 1}: ...{window}...")
        annotated = True
    return enriched


# ── HLD signal helpers ────────────────────────────────────────────────────────


def _hld_has_list_capability(plan: Dict[str, Any]) -> bool:
    """True when the HLD declares any capability with returnsList=true."""
    for cap in plan.get("capabilities") or []:
        if cap.get("returnsList") is True:
            return True
    return False


def _hld_has_money_capability(plan: Dict[str, Any]) -> bool:
    """True when the HLD declares any capability with touchesMoney=true."""
    for cap in plan.get("capabilities") or []:
        if cap.get("touchesMoney") is True:
            return True
    return False


def _hld_uses_config(plan: Dict[str, Any]) -> bool:
    """True when the HLD declares any capability with usesConfig=true."""
    for cap in plan.get("capabilities") or []:
        if cap.get("usesConfig") is True:
            return True
    return False


def _hld_uses_workflow(plan: Dict[str, Any]) -> bool:
    """True when the HLD declares any capability with usesWorkflow=true."""
    for cap in plan.get("capabilities") or []:
        if cap.get("usesWorkflow") is True:
            return True
    return False


# ── Runtime-example enrichment ────────────────────────────────────────────────


def _build_op_surface_index(ops_picks: Dict[str, Any]) -> Dict[str, str]:
    """
    Build {op_name: surface} from enriched ops-picks. Used to stamp the
    `surface` field on each shopify_query step before snippet selection,
    so storefront vs admin queries get the right example.
    """
    out: Dict[str, str] = {}
    for cap in ops_picks.get("capabilities") or []:
        for op in cap.get("ops") or []:
            name = op.get("name")
            surface = op.get("surface")
            if name and surface:
                out[name] = surface
    return out


def _build_offset_route_index(lld_dict: Dict[str, Any]) -> set:
    """
    Build the set of triggeredBy strings
    ("widget:<METHOD>:<path>" / "admin:<METHOD>:<path>") for every route
    declared with paginationKind="offset".

    Used to stamp the paginate_offset snippet on the recipe's sql_select
    step before per-step walking — sql_select alone can't tell whether
    its enclosing route is paginated, so this needs route context.
    """
    triggers: set = set()
    routes = lld_dict.get("httpRoutes") or {}
    for surface_name in ("widget", "admin"):
        for route in routes.get(surface_name) or []:
            if route.get("paginationKind") == "offset":
                triggers.add(
                    f"{surface_name}:{route.get('method')}:{route.get('path')}"
                )
    return triggers


def _stamp_paginate_on_sql_select(steps: List[Dict[str, Any]]) -> bool:
    """
    Find the recipe's sql_select step and stamp the paginate_offset
    snippet onto it. Returns True after the first hit so we don't stamp
    twice (the LLD validator already guarantees exactly one sql_select
    in offset routes; this is belt-and-braces).
    """
    for step in steps:
        kind = step.get("kind")
        if kind == "sql_select":
            step["example"] = paginate_snippet()
            return True
        if kind == "decision":
            if _stamp_paginate_on_sql_select(step.get("ifTrue") or []):
                return True
            if _stamp_paginate_on_sql_select(step.get("ifFalse") or []):
                return True
        elif kind == "for_each":
            if _stamp_paginate_on_sql_select(step.get("steps") or []):
                return True
        elif kind == "sql_transaction":
            if _stamp_paginate_on_sql_select(step.get("steps") or []):
                return True
        elif kind == "try_catch":
            if _stamp_paginate_on_sql_select(step.get("try") or step.get("try_") or []):
                return True
            if _stamp_paginate_on_sql_select(step.get("catch") or []):
                return True
    return False


def _enrich_with_runtime_examples(
    lld_dict: Dict[str, Any], ops_picks: Dict[str, Any]
) -> None:
    """
    Walk every step in every recipe and stamp `step["example"]` with the
    matching working-TS snippet from `platform_runtime_examples`. Steps
    that need no example (control-flow / log / response / fetch /
    generic sql_*) are left untouched.

    Two-pass:
      1. For recipes triggered by an offset-paginated route, stamp the
         paginate_offset snippet onto the recipe's sql_select step.
         (sql_select alone can't see paginationKind — needs route ctx.)
      2. Walk every step (incl. nested containers) and apply the
         per-step `example_for_step` dispatch — which covers shopify_*,
         email_*, files_*, enqueue, and compute (money/config).

    Walks into nested step containers (decision.ifTrue/ifFalse,
    for_each.steps, sql_transaction.steps, try_catch.try/catch) so
    deeply-nested calls also receive their snippet.
    """
    op_surface = _build_op_surface_index(ops_picks)
    offset_triggers = _build_offset_route_index(lld_dict)

    for recipe in (lld_dict.get("capabilityRecipes") or {}).values():
        steps = recipe.get("steps") or []
        if recipe.get("triggeredBy") in offset_triggers:
            _stamp_paginate_on_sql_select(steps)
        _walk_steps(steps, op_surface)


def _walk_steps(steps: List[Dict[str, Any]], op_surface: Dict[str, str]) -> None:
    """Stamp `example` onto every external-call step, recursing into nested containers."""
    for step in steps:
        kind = step.get("kind")
        # For shopify_query steps, look up the picked op's surface so the
        # snippet picker can route storefront vs admin examples.
        if kind == "shopify_query":
            op_name = step.get("op")
            if op_name and op_name in op_surface and "surface" not in step:
                step["surface"] = op_surface[op_name]
        snippet = example_for_step(step)
        if snippet is not None:
            step["example"] = snippet
        # Recurse into containers.
        if kind == "decision":
            _walk_steps(step.get("ifTrue") or [], op_surface)
            _walk_steps(step.get("ifFalse") or [], op_surface)
        elif kind == "for_each":
            _walk_steps(step.get("steps") or [], op_surface)
        elif kind == "sql_transaction":
            _walk_steps(step.get("steps") or [], op_surface)
        elif kind == "try_catch":
            # Wire-format key is "try" (alias); Pydantic dump uses "try" via
            # by_alias=True. Fall back to "try_" defensively in case the
            # caller passed a non-aliased dump.
            _walk_steps(step.get("try") or step.get("try_") or [], op_surface)
            _walk_steps(step.get("catch") or [], op_surface)
