"""
Coding-agent runner.

Top-level entry point — the CLI calls `run_coding_agent(...)` after HLD
validation passes. This module:

  1. Sets up the run directory (`test_results/<ts>_<slug>/codegen/`).
  2. Builds the user message from intent + HLD.
  3. Builds the cached system prompt.
  4. Runs the multi-turn loop (loop.run_loop).
  5. Returns the result with token totals.

Out of scope for this module (handled elsewhere):
  - `app.json → migrations/0001_app.sql` rendering (renderer.py — TODO)
  - `app.json → src/server.ts` rendering (renderer.py — TODO)
  - `tsc --noEmit` execution (tsc_runner.py — TODO)
  - Final integrity checks (integrity.py — TODO)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from subagents.w_coding_agent.loop import RunResult, run_loop
from subagents.w_coding_agent.prompt import build_full_system_prompt
from subagents.w_coding_agent.tools import RunnerContext


REPO_ROOT = Path(__file__).resolve().parents[3]


# ── Public entry point ──────────────────────────────────────────────────────


@dataclass
class CodingAgentResult:
    run_result: RunResult
    work_dir: Path           # the scaffold/ dir is at work_dir/scaffold
    run_dir: Path            # logs + tool_calls
    todos: list              # final todo list from the agent
    incomplete_reason: Optional[str] = None  # set if the run ended without a clean done()
    # Token usage of the done()-gate micro-validators (Haiku), summed over
    # the run. The coding agent's own tokens live in `run_result`.
    validator_usage: Optional[Dict[str, int]] = None


def run_coding_agent(
    *,
    merchant_prompt: str,
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    run_dir: Path,
    on_tool_call: Optional[Callable[[str], None]] = None,
) -> CodingAgentResult:
    """Run the coding agent end-to-end for one app generation.

    Parameters
    ----------
    merchant_prompt:
        The merchant's verbatim request.
    intent:
        Structured intent from a_product_agent.
    plan:
        Validated HLD from c_hld_agent + e_hld_v_agent.
    run_dir:
        Caller-owned dir for logs and the scaffold/. The agent creates
        `tool_calls/` and `scaffold/` under it.
    on_tool_call:
        Optional callable invoked with each tool call's one-line CLI
        summary, so the CLI can render live progress.
    """
    run_dir.mkdir(parents=True, exist_ok=True)
    work_dir = run_dir  # scaffold/ lives directly under run_dir

    ctx = RunnerContext(
        repo_root=REPO_ROOT,
        work_dir=work_dir,
        run_dir=run_dir,
        plan=plan,
    )

    system_prompt = build_full_system_prompt()
    user_message = _build_user_message(merchant_prompt, intent, plan)

    # Persist the prompts so they're inspectable post-run.
    _persist_prompts(run_dir, system_prompt, user_message)

    result = run_loop(
        ctx,
        system_prompt=system_prompt,
        user_message=user_message,
        on_tool_call=on_tool_call,
    )

    if result.done_called:
        incomplete_reason = None
    elif result.hit_turn_cap:
        incomplete_reason = "hit the turn cap before the done() gate passed"
    else:
        incomplete_reason = "the agent stopped before calling done()"

    _persist_token_usage(run_dir, result, ctx.validator_usage)

    return CodingAgentResult(
        run_result=result,
        work_dir=work_dir,
        run_dir=run_dir,
        todos=ctx.todos,
        incomplete_reason=incomplete_reason,
        validator_usage=ctx.validator_usage,
    )


# ── Internals ───────────────────────────────────────────────────────────────


_USER_TEMPLATE = """\
You are starting a new run. Read everything in this message carefully — it is the only application-specific information you will receive.

═══ MERCHANT REQUEST ═══

{merchant_prompt}

═══ PRODUCT INTENT (from a_product_agent) ═══

{intent_json}

═══ HLD PLAN (validated by e_hld_v_agent) ═══

{plan_json}

═══ YOUR JOB ═══

Build the app under `scaffold/`. Follow the loop: plan (todo_write) → spine (app.json, contracts.ts) → bodies (per-file) → verify (run_tsc) → done().

Start with `todo_write` to lay out your plan."""


def _build_user_message(
    merchant_prompt: str,
    intent: Dict[str, Any],
    plan: Dict[str, Any],
) -> str:
    return _USER_TEMPLATE.format(
        merchant_prompt=merchant_prompt.strip(),
        intent_json=json.dumps(intent, indent=2),
        plan_json=json.dumps(plan, indent=2),
    )


def _persist_prompts(run_dir: Path, system: str, user: str) -> None:
    """Write the prompts to disk for post-hoc inspection. Mirrors the
    `inputs/<agent>/attempt_N/` convention of the existing pipeline, but
    one attempt total — the agent loop owns retries internally."""
    inputs_dir = run_dir / "inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    (inputs_dir / "system.txt").write_text(system)
    (inputs_dir / "user.txt").write_text(user)


def _persist_token_usage(
    run_dir: Path, run_result: RunResult, validator_usage: Dict[str, int]
) -> None:
    """Write `token_usage.json` so each run yields a measurable cost delta —
    the coding agent's own loop tokens alongside the done()-gate validators'
    Haiku tokens. (HLD tokens are reported separately by run_hld_agent.)"""
    payload = {
        "coding_agent": {
            "input_tokens": run_result.total_input_tokens,
            "output_tokens": run_result.total_output_tokens,
            "cache_read_tokens": run_result.cache_read_tokens,
            "cache_creation_tokens": run_result.cache_creation_tokens,
            "turns_used": run_result.turns_used,
        },
        "validators": validator_usage,
    }
    (run_dir / "token_usage.json").write_text(json.dumps(payload, indent=2))
