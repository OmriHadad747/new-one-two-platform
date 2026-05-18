"""
LLD validator agent runner.

Semantically reviews the LLD plan emitted by `d_lld_agent` and returns
up to 5 findings ranked by severity (critical → important → minor).

Fails open: any LLM or parse error returns an empty findings list and
logs a warning rather than raising, so a validator failure never blocks
the pipeline.

Flow
----
1. Build the system prompt via `prompt.build_system_prompt()` —
   [lld_spec, validator_wrapper] for cache-prefix reuse with the LLD
   engineer's own call.
2. Build a user message with the merchant request, HLD plan, ops-picks,
   and LLD plan.
3. Invoke the LLM, extract JSON, parse with `LLDVOutput.model_validate_json`.
4. Return `(findings_as_dicts, in_tokens, out_tokens, cache_read_tokens,
   cache_creation_tokens)`.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Tuple

from pydantic import ValidationError

from models.adapter import (
    dump_structured_output,
    get_llm,
    invoke_structured,
)
from models.agent_models import get_agent_model
from subagents.k_lld_v_agent.prompt import build_system_prompt
from subagents.k_lld_v_agent.schema import LLDVOutput

log = logging.getLogger(__name__)

_MAX_OUTPUT_TOKENS = 4_000
_THINKING_BUDGET = 1024

_USER_TEMPLATE = """\
MERCHANT REQUEST
{prompt}

HLD PLAN
{plan_json}

OPS-PICKS (enriched: SDL, examples, payloadFields)
{ops_picks_json}

LLD PLAN — the one you are reviewing
{lld_json}"""


def run_lld_validator(
    plan: Dict[str, Any],
    ops_picks: Dict[str, Any],
    lld: Dict[str, Any],
    prompt: str,
) -> Tuple[List[Dict[str, Any]], int, int, int, int]:
    """
    Run the LLD validator. Returns
    `(findings, in_tokens, out_tokens, cache_read_tokens, cache_creation_tokens)`.

    `findings` is a list of dicts with keys: severity, location, issue, fix.
    Empty list means either no issues were found or the validator failed open.
    `cache_read_tokens` are the prefix tokens served from Anthropic's prompt
    cache at ~10% of the normal input price; `cache_creation_tokens` were
    written to the cache on this call at ~125%. Both are reported separately
    from `in_tokens` so the CLI can show actual cost rather than raw totals.
    """
    system = build_system_prompt()
    user = _USER_TEMPLATE.format(
        prompt=prompt,
        plan_json=json.dumps(plan),
        ops_picks_json=json.dumps(ops_picks),
        lld_json=json.dumps(lld),
    )
    llm = get_llm(
        model=get_agent_model("lld_v"),
        max_tokens=_MAX_OUTPUT_TOKENS,
        thinking_budget=_THINKING_BUDGET,
    )

    # 1-hour TTL: lld_v fires after the LLD agent's 5-15 min run; the
    # default 5-min cache has already evicted the shared system prefix
    # by the time we get here. 1h lets the cache survive into any LLD
    # retry that lld_v findings trigger.
    response = invoke_structured(
        llm,
        system,
        user,
        tool_name="emit_lld_findings",
        tool_description=(
            "Emit the LLD validation findings as a structured object "
            "conforming to the LLDVOutput schema. Call exactly once with "
            "the full findings list as the tool input."
        ),
        tool_input_schema=LLDVOutput.model_json_schema(),
        cache_ttl="1h",
    )
    in_tok = response.input_tokens
    out_tok = response.output_tokens
    cache_r = response.cache_read_tokens
    cache_c = response.cache_creation_tokens
    dump_structured_output(response.structured_output)

    if response.stop_reason == "max_tokens":
        raise RuntimeError(
            f"lld_v: output truncated at max_tokens={_MAX_OUTPUT_TOKENS}; "
            "raise the cap or shorten the prompt"
        )

    try:
        output = LLDVOutput.model_validate(response.structured_output)
    except ValidationError as exc:
        log.warning("lld_v: failed to parse response (%s) — fail-open", exc)
        return [], in_tok, out_tok, cache_r, cache_c

    findings = [f.model_dump(mode="json") for f in output.findings]
    for f in findings:
        log.info(
            "lld_v[%s] %s — %s",
            f["severity"],
            f["location"],
            f["issue"],
        )

    return findings, in_tok, out_tok, cache_r, cache_c
