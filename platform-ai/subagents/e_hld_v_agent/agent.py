"""
HLD validator agent runner.

Semantically reviews the HLD plan emitted by `hld_agent` and returns up to
3 findings ranked by severity (critical → important → minor). If no critical
issues exist the validator escalates to the highest available lower severity
so the caller always gets actionable signal.

Fails open: any LLM or parse error returns an empty findings list and logs a
warning rather than raising, so a validator failure never blocks the pipeline.

Flow
----
1. Build the system prompt via `prompt.build_system_prompt()`.
2. Build a user message with the (authoritative) intent and plan JSON.
3. Invoke the LLM, extract JSON, parse with `HLDVOutput.model_validate_json`.
4. Return `(findings_as_dicts, in_tokens, out_tokens)`.
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
from subagents.e_hld_v_agent.prompt import build_system_prompt
from subagents.e_hld_v_agent.schema import HLDVOutput

log = logging.getLogger(__name__)

# 7K = 3K headroom for up to 5 findings + the 4K thinking budget below
# (Anthropic counts thinking against max_tokens; max_tokens MUST be
# greater than thinking_budget or visible output gets truncated).
_MAX_OUTPUT_TOKENS = 7000
# Aligned with the HLD architect's thinking budget so Anthropic's prompt
# cache can reuse the architect's cached system-prompt prefix on the
# validator's call. Diverging this value invalidates the cache match
# even when the system prompt content is byte-identical.
_THINKING_BUDGET = 4000

_USER_TEMPLATE = """\
INTENT (the authoritative spec — review the plan against THIS, not any raw
merchant request; the qualityBrief is the complete requirement set and
`excluded` lists features that must NOT appear in the plan)
{intent_json}

HLD PLAN
{plan_json}"""


def run_hld_validator(
    plan: Dict[str, Any],
    intent: Dict[str, Any],
) -> Tuple[List[Dict[str, Any]], int, int, int, int]:
    """
    Run the HLD validator. Returns
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
        intent_json=json.dumps(intent),
        plan_json=json.dumps(plan),
    )
    llm = get_llm(
        model=get_agent_model("hld_v"),
        max_tokens=_MAX_OUTPUT_TOKENS,
        thinking_budget=_THINKING_BUDGET,
    )

    # 1-hour TTL: hld_v fires once but the HLD agent itself runs minutes
    # before — keeping the cache hot across the HLD → hld_v → optional
    # HLD-retry boundary is what makes the shared system prefix worth
    # caching at all.
    response = invoke_structured(
        llm,
        system,
        user,
        tool_name="emit_hld_findings",
        tool_description=(
            "Emit the HLD validation findings as a structured object "
            "conforming to the HLDVOutput schema. Call exactly once with "
            "the full findings list as the tool input."
        ),
        tool_input_schema=HLDVOutput.model_json_schema(),
        cache_ttl="1h",
    )
    in_tok = response.input_tokens
    out_tok = response.output_tokens
    cache_r = response.cache_read_tokens
    cache_c = response.cache_creation_tokens
    dump_structured_output(response.structured_output)

    if response.stop_reason == "max_tokens":
        raise RuntimeError(
            f"hld_v: output truncated at max_tokens={_MAX_OUTPUT_TOKENS}; "
            "raise the cap or shorten the prompt"
        )

    try:
        output = HLDVOutput.model_validate(response.structured_output)
    except ValidationError as exc:
        log.warning("hld_v: failed to parse response (%s) — fail-open", exc)
        return [], in_tok, out_tok, cache_r, cache_c

    findings = [f.model_dump(mode="json") for f in output.findings]
    for f in findings:
        log.info(
            "hld_v[%s] %s — %s",
            f["severity"],
            f["location"],
            f["issue"],
        )

    return findings, in_tok, out_tok, cache_r, cache_c
