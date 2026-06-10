"""
HLD validator agent runner.

Semantically reviews the HLD plan emitted by `hld_agent` and returns up to
5 findings ranked by severity (critical → important → minor).

Fails open: any LLM or parse error returns an empty findings list and logs a
warning rather than raising, so a validator failure never blocks the pipeline.

Request shape — shared with the architect on purpose
----------------------------------------------------
The validator runs through the SAME loop as the HLD architect/revise
(`c_hld_agent.loop.run_hld_loop`, mode="validate"): identical tools array,
and the architect's system text as the first cached system block (the
validator wrapper is a second, separately cached block). Anthropic's prompt
cache matches the request prefix [tools][system][messages] byte-for-byte,
so this is what lets the validator READ the architect's ~38KB cached system
block at ~10% input price instead of writing its own ~24K entry that
nothing else reads. Extended thinking only invalidates message-level cache
breakpoints — the tools/system prefix survives it — so the validator keeps
its thinking budget without losing the shared cache.

Running in the loop also gives the validator the read-only catalog tools,
so it can VERIFY a suspect Phase-2 binding (topic, payload path, op) with a
real lookup instead of flagging from memory.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Tuple

from models.adapter import dump_input, dump_structured_output
from models.agent_models import get_agent_model
from subagents.c_hld_agent.loop import run_hld_loop
from subagents.e_hld_v_agent.prompt import build_system_prompt
from subagents.w_coding_agent.tools import RunnerContext

log = logging.getLogger(__name__)

# platform-ai/subagents/e_hld_v_agent/agent.py → repo root is parents[3].
REPO_ROOT = Path(__file__).resolve().parents[3]

# 7K visible-output headroom for up to 5 findings; thinking tokens count
# against max_tokens, so the loop is given the sum of both budgets.
_MAX_OUTPUT_TOKENS = 7000
_THINKING_BUDGET = 4000
# Review is a few catalog verifications + one terminal call — not a design
# session. The cap bounds a runaway reviewer, not normal behavior.
_MAX_TURNS = 10

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
    written to the cache on this call at a write surcharge. Both are reported
    separately from `in_tokens` so the CLI can show actual cost rather than
    raw totals.
    """
    system = build_system_prompt()  # [architect spec, validator wrapper]
    user = _USER_TEMPLATE.format(
        intent_json=json.dumps(intent),
        plan_json=json.dumps(plan),
    )
    # Catalog tools resolve repo-relative paths off repo_root; the validator
    # has no scaffold, so work_dir / run_dir are unused (set to repo_root).
    ctx = RunnerContext(repo_root=REPO_ROOT, work_dir=REPO_ROOT, run_dir=REPO_ROOT)

    # The loop bypasses invoke(), so trace the prompt here — same
    # inputs/hld_v/attempt_1/{system.txt,user.txt} trail as before.
    dump_input(system, user)

    try:
        result = run_hld_loop(
            ctx,
            system_prompt=system,
            user_message=user,
            model=get_agent_model("hld_v"),
            mode="validate",
            max_turns=_MAX_TURNS,
            max_tokens=_MAX_OUTPUT_TOKENS + _THINKING_BUDGET,
            thinking_budget=_THINKING_BUDGET,
            log_agent="hld_v",
        )
    except Exception as exc:  # fail-open: a validator error never blocks the run
        log.warning("hld_v: loop error (%s) — fail-open", exc)
        return [], 0, 0, 0, 0

    in_tok = result.total_input_tokens
    out_tok = result.total_output_tokens
    cache_r = result.cache_read_tokens
    cache_c = result.cache_creation_tokens

    if result.plan is None:
        # No valid emit_hld_findings call — turn cap, truncation, or the
        # model stopped with prose. Fail open with usage so cost still shows.
        log.warning(
            "hld_v: no valid emit_hld_findings (turns=%d, stop=%s) — fail-open",
            result.turns_used,
            result.final_stop_reason,
        )
        return [], in_tok, out_tok, cache_r, cache_c

    dump_structured_output(result.plan)
    findings = list(result.plan.get("findings", []))
    for f in findings:
        log.info(
            "hld_v[%s] %s — %s",
            f["severity"],
            f["location"],
            f["issue"],
        )

    return findings, in_tok, out_tok, cache_r, cache_c
