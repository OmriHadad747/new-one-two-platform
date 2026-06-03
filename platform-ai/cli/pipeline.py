"""
pipeline.py — agent orchestration for the chat CLI.

Each phase runs one pipeline agent, drives progress display through `ui`, and
returns its payload plus a token dict. No ANSI escapes live here — all visuals
go through `ui`, all model calls go through the subagents.

Token dicts are uniform: {"in", "out", "cache_read", "cache_create"}.

Phases
------
  run_product_analysis  — interactive /analyze loop: clarify → summary → gate.
                          Falls back to the one-shot classifier on non-TTY stdin.
  run_hld               — high-level design (with optional validator-hint revise).
  run_hld_validation    — semantic review of the plan (fail-open).
  run_coding            — the coding agent; streams live tool calls.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from models.adapter import input_log
from subagents.a_product_agent.agent import (
    run_product_agent,
    run_product_agent_analyze,
)
from subagents.c_hld_agent.agent import HLDValidationError, run_hld_agent
from subagents.e_hld_v_agent.agent import run_hld_validator
from subagents.w_coding_agent.agent import run_coding_agent

import ui

Tokens = Dict[str, int]


def _tokens(in_tok: int, out_tok: int, cache_r: int, cache_c: int) -> Tokens:
    return {"in": in_tok, "out": out_tok, "cache_read": cache_r, "cache_create": cache_c}


def _add(acc: Tokens, metrics: Dict[str, int]) -> None:
    acc["in"] += metrics.get("in", 0)
    acc["out"] += metrics.get("out", 0)
    acc["cache_read"] += metrics.get("cache_read", 0)
    acc["cache_create"] += metrics.get("cache_create", 0)


# ── Phase 1 — Product analysis (interactive) ─────────────────────────────────────


def run_product_analysis(
    prompt: str, run_dir: Path
) -> Optional[Tuple[Dict[str, Any], Tokens]]:
    """Interactive product analysis — mirrors the /analyze endpoint.

    Holds a clarification conversation (questions + suggestions), prints the
    merchant-facing summary on `ready`, then asks permission to generate while
    letting the merchant type more raw text to refine. Returns (intent, tokens)
    once the merchant confirms, or None if they cancel.

    When stdin is not a TTY (piped / automated), there is no human to answer, so
    it falls back to the one-shot classifier with no questions.
    """
    ui.phase_header("Product analysis")

    if not sys.stdin.isatty():
        sp = ui.Spinner("Product")
        sp.start()
        t0 = time.monotonic()
        try:
            with input_log("product", run_dir):
                intent, in_tok, out_tok = run_product_agent(prompt)
        finally:
            sp.stop()
        ms = int((time.monotonic() - t0) * 1000)
        ui.agent_line(
            "Product",
            True,
            ms,
            ui.tok_note(in_tok, out_tok)
            + "  "
            + ui.c("(one-shot — non-interactive stdin)", ui.DIM),
        )
        return intent, _tokens(in_tok, out_tok, 0, 0)

    ui.you(prompt)
    history: List[Dict[str, str]] = [{"role": "user", "content": prompt}]
    totals = _tokens(0, 0, 0, 0)

    with input_log("product", run_dir):
        while True:
            sp = ui.Spinner("Ton")
            sp.start()
            t0 = time.monotonic()
            try:
                response, metrics = run_product_agent_analyze(history)
            finally:
                sp.stop()
            _add(totals, metrics)

            status = response.get("status")

            if status == "ready":
                ui.spec_summary(response.get("summary", ""))
                ui.meta(
                    ui.tok_note(
                        metrics["in"],
                        metrics["out"],
                        cache_read=metrics["cache_read"],
                        cache_create=metrics["cache_create"],
                    )
                )
                ui.hint("Press Enter to generate · type a change to refine · 'n' to cancel")
                choice = ui.ask("You")
                if choice == "" or choice.lower() in ("y", "yes", "g", "generate"):
                    ui.echo_choice("↵ generate")
                    return response.get("intent") or {}, totals
                if choice.lower() in ("n", "no", "cancel"):
                    ui.echo_choice("✗ cancel")
                    ui.note("Cancelled — nothing generated.")
                    return None
                # Anything else is a refinement — keep the conversation going.
                # Store the model's own JSON as the assistant turn so history
                # matches what it actually emitted (its prompt is "JSON only").
                history += [
                    {"role": "assistant", "content": json.dumps(response)},
                    {"role": "user", "content": choice},
                ]
                continue

            if status == "needs_clarification":
                # NEW shape: list of {question, suggestions}. Falls back
                # to the old singular shape when an older model run or
                # un-updated path emits it.
                questions = response.get("questions") or []
                if not questions and response.get("question"):
                    questions = [
                        {
                            "question": response["question"],
                            "suggestions": list(response.get("suggestions") or []),
                        }
                    ]
            else:
                questions = [
                    {"question": "Could you rephrase your request?", "suggestions": []}
                ]

            # Ask one-by-one (numbered, e.g. "(1 of 2)" when more than one).
            # Each question keeps the existing single-question UX — picking
            # a numbered suggestion OR typing free-form. All answers are
            # combined into one user message returned to the model.
            total = len(questions)
            collected: list = []
            for i, q in enumerate(questions, start=1):
                q_text = (q.get("question") or "").strip()
                sugg = list(q.get("suggestions") or [])
                label = q_text if total == 1 else f"({i} of {total}) {q_text}"
                ui.bot(label)
                if sugg:
                    ui.suggestions(sugg)
                    ui.hint("Pick a number, or type your own answer.")
                answer = ui.ask("You")
                while not answer:
                    answer = ui.ask("You")
                if sugg and answer.isdigit() and 1 <= int(answer) <= len(sugg):
                    answer = sugg[int(answer) - 1]
                    ui.echo_choice(answer)
                collected.append((q_text, answer))

            # Aggregate into one user turn. Single Q stays terse (the
            # bare answer, like today). Multi-Q sends a labelled block so
            # the model can match each answer to its question.
            if total == 1:
                combined = collected[0][1]
            else:
                combined = "\n".join(
                    f"- {q}: {a}" for q, a in collected
                )
            history += [
                {"role": "assistant", "content": json.dumps(response)},
                {"role": "user", "content": combined},
            ]


# ── Phase 2 — HLD design (+ optional validator-hint revise) ──────────────────────


def run_hld(
    prompt: str,
    intent: Dict[str, Any],
    run_dir: Path,
    validator_hint: Optional[str] = None,
) -> Tuple[Dict[str, Any], Tokens]:
    label = "HLD" if validator_hint is None else "HLD (revise)"
    ui.phase_header("HLD design" if validator_hint is None else "HLD revision")
    sp = ui.Spinner(label)
    sp.start()
    t0 = time.monotonic()

    def _on_attempt_failed(
        attempt: int,
        errors: List[str],
        in_tok: int,
        out_tok: int,
        cache_r: int,
        cache_c: int,
    ) -> None:
        sp.stop()
        first = errors[0] if errors else "validation failed"
        more = f" (+{len(errors) - 1} more)" if len(errors) > 1 else ""
        tok = ui.tok_note(in_tok, out_tok, cache_read=cache_r, cache_create=cache_c)
        ui.agent_line(label, False, None, f"attempt {attempt} rejected: {first}{more}  {tok}")
        for e in errors:
            print(f"    {ui.c('•', ui.DIM)} {ui.c(e, ui.DIM)}")
        ui.retry_line(label, f"retry attempt {attempt + 1}")

    try:
        log_name = "hld" if validator_hint is None else "hld_revise"
        with input_log(log_name, run_dir):
            plan, in_tok, out_tok, cache_r, cache_c = run_hld_agent(
                prompt=prompt,
                intent=intent,
                on_attempt_failed=_on_attempt_failed,
                validator_hint=validator_hint,
            )
    except HLDValidationError as err:
        sp.stop()
        ms = int((time.monotonic() - t0) * 1000)
        ui.agent_line(
            label,
            False,
            ms,
            f"failed after {err.attempts} attempt(s)  "
            + ui.tok_note(
                err.in_tokens,
                err.out_tokens,
                cache_read=err.cache_read_tokens,
                cache_create=err.cache_creation_tokens,
            ),
        )
        ui.error("HLD failed:")
        for e in err.errors:
            print(f"    • {e}")
        sys.exit(1)
    finally:
        sp.stop()

    ms = int((time.monotonic() - t0) * 1000)
    ui.agent_line(
        label, True, ms, ui.tok_note(in_tok, out_tok, cache_read=cache_r, cache_create=cache_c)
    )

    if plan.get("feasibility") == "blocked":
        reason = plan.get("blockedReason", "Platform limitation.")
        ui.error(f"Platform limitation: {reason}")
        sys.exit(1)

    return plan, _tokens(in_tok, out_tok, cache_r, cache_c)


# ── Phase 3 — HLD validation ─────────────────────────────────────────────────────


def run_hld_validation(
    plan: Dict[str, Any],
    prompt: str,
    intent: Dict[str, Any],
    run_dir: Path,
) -> Tuple[List[Dict[str, Any]], Tokens]:
    ui.phase_header("HLD validation")
    sp = ui.Spinner("HLD Check")
    sp.start()
    t0 = time.monotonic()
    found: List[Dict[str, Any]] = []
    in_tok = out_tok = cache_r = cache_c = 0
    try:
        with input_log("hld_v", run_dir):
            found, in_tok, out_tok, cache_r, cache_c = run_hld_validator(plan, prompt, intent)
    except Exception as exc:
        sp.stop()
        ui.note(f"hld_v failed ({exc}) — fail-open", ui.YELLOW)
    finally:
        sp.stop()

    ms = int((time.monotonic() - t0) * 1000)
    sev_note = f"{len(found)} finding(s)" if found else "clean"
    ui.agent_line(
        "HLD Check",
        True,
        ms,
        ui.tok_note(in_tok, out_tok, sev_note, cache_read=cache_r, cache_create=cache_c),
    )
    if found:
        ui.findings(found)

    return found, _tokens(in_tok, out_tok, cache_r, cache_c)


# ── Phase 4 — Coding agent ───────────────────────────────────────────────────────


def run_coding(
    prompt: str,
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    run_dir: Path,
) -> Any:
    ui.phase_header("Coding agent")
    ui.note("─── live tool calls ───")

    def _on_tool_call(line: str) -> None:
        print(f"  {line}")

    t0 = time.monotonic()
    result = run_coding_agent(
        merchant_prompt=prompt,
        intent=intent,
        plan=plan,
        run_dir=run_dir,
        on_tool_call=_on_tool_call,
    )
    ms = int((time.monotonic() - t0) * 1000)

    rr = result.run_result
    parts = [f"{rr.turns_used} turns"]
    parts.append(ui.c("done", ui.GREEN) if rr.done_called else ui.c("NO DONE", ui.RED))
    if rr.hit_turn_cap:
        parts.append(ui.c("cap hit", ui.YELLOW))
    summary = ", ".join(parts)

    ui.agent_line(
        "Coding",
        rr.done_called,
        ms,
        ui.tok_note(
            rr.total_input_tokens,
            rr.total_output_tokens,
            summary,
            cache_read=rr.cache_read_tokens,
            cache_create=rr.cache_creation_tokens,
        ),
    )

    return result
