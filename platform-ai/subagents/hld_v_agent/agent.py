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
2. Build a user message with the merchant request, intent, and plan JSON.
3. Invoke the LLM, extract JSON, parse with `HLDVOutput.model_validate_json`.
4. Return `(findings_as_dicts, in_tokens, out_tokens)`.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Tuple

from pydantic import ValidationError

from models.adapter import dump_output, extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.hld_v_agent.prompt import build_system_prompt
from subagents.hld_v_agent.schema import HLDVOutput

log = logging.getLogger(__name__)

_MAX_OUTPUT_TOKENS = 3000
_THINKING_BUDGET = 1024

_USER_TEMPLATE = """\
MERCHANT REQUEST
{prompt}

INTENT
{intent_json}

HLD PLAN
{plan_json}"""


def run_hld_validator(
    plan: Dict[str, Any],
    prompt: str,
    intent: Dict[str, Any],
) -> Tuple[List[Dict[str, Any]], int, int]:
    """
    Run the HLD validator. Returns (findings, in_tokens, out_tokens).

    `findings` is a list of dicts with keys: severity, location, issue, fix.
    Empty list means either no issues were found or the validator failed open.
    """
    system = build_system_prompt()
    user = _USER_TEMPLATE.format(
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
        plan_json=json.dumps(plan, indent=2),
    )
    llm = get_llm(model=get_agent_model("hld_v"), max_tokens=_MAX_OUTPUT_TOKENS, thinking_budget=_THINKING_BUDGET)

    in_tok = 0
    out_tok = 0

    try:
        response = invoke(llm, system, user)
        in_tok = response.input_tokens
        out_tok = response.output_tokens
        dump_output(response.content)
        raw_json = extract_json(response.content)
        output = HLDVOutput.model_validate_json(raw_json)
    except (ValidationError, json.JSONDecodeError, Exception) as exc:
        log.warning("hld_v: failed to get/parse response (%s) — fail-open", exc)
        return [], in_tok, out_tok

    findings = [f.model_dump(mode="json") for f in output.findings]
    for f in findings:
        log.info(
            "hld_v[%s] %s — %s",
            f["severity"],
            f["location"],
            f["issue"],
        )

    return findings, in_tok, out_tok
