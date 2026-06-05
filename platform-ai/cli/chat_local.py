#!/usr/bin/env python3
"""
chat_local.py — interactive CLI for the generation pipeline.

Pipeline: a_product → c_hld → e_hld_v → w_coding_agent.

The product phase is interactive (mirrors the /analyze endpoint): it asks
clarification questions, prints a merchant-facing spec summary, then asks
permission to generate — you can also type more text there to refine the spec.
Once you confirm, HLD → HLD-validation → coding run straight through. When stdin
is not a TTY (piped input), the product phase falls back to the one-shot
classifier with no questions.

This file is the entry point only: argument parsing, run-dir / resume / state
bookkeeping, phase sequencing, and the final summary. Rendering lives in ui.py;
the per-phase agent orchestration lives in pipeline.py.

Requires ANTHROPIC_API_KEY in the environment (or platform-ai/.env).
Run output is written to platform-ai/cli/test_results/<timestamp>_<slug>/.

Usage (executable, or prefix with `python`):
  ./chat_local.py                              # interactive: type your prompt
  ./chat_local.py --prompt-file PATH           # seed the first turn from a file

Stop after a given phase (staged debugging):
  ./chat_local.py --prompt-file PATH --stop-after product
  ./chat_local.py --prompt-file PATH --stop-after hld
  ./chat_local.py --prompt-file PATH --stop-after hld_v
  ./chat_local.py --prompt-file PATH --stop-after coding

Resume a prior run by its directory name (skips phases already in state.json):
  ./chat_local.py --resume 2026-05-22T10-15-03_my-app
  ./chat_local.py --resume 2026-05-22T10-15-03_my-app --stop-after hld_v

Note: --prompt-file and --resume are mutually exclusive.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

# ── Bootstrap ────────────────────────────────────────────────────────────────

_HERE = Path(__file__).resolve().parent
PLATFORM_AI = _HERE.parent
sys.path.insert(0, str(PLATFORM_AI))  # for `from subagents... import ...`
sys.path.insert(0, str(_HERE))  # for the local `ui` / `pipeline` modules

try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv(PLATFORM_AI / ".env")
except ImportError:
    pass

import ui  # noqa: E402
import pipeline  # noqa: E402

# ── Run dir + state ──────────────────────────────────────────────────────────


def _slugify(text: str) -> str:
    words = re.findall(r"\w+", text.lower())[:6]
    return "-".join(words) or "untitled"


def _save_state(run_dir: Path, **kwargs: Any) -> None:
    state_path = run_dir / "state.json"
    state: Dict[str, Any] = {}
    if state_path.exists():
        state = json.loads(state_path.read_text())
    state.update(kwargs)
    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    state_path.write_text(json.dumps(state, indent=2, default=str))


# ── Initial-prompt acquisition ─────────────────────────────────────────────────


def _read_initial_prompt(prompt_file: str | None) -> str:
    """Get the merchant's first message.

    A file seeds the first turn; an interactive TTY reads one line (so stdin
    stays free for the product agent's clarification answers); piped stdin is
    read whole (non-interactive one-shot path).
    """
    if prompt_file:
        return Path(prompt_file).read_text().strip()
    if sys.stdin.isatty():
        return ui.ask_initial()
    print("Paste merchant prompt (Ctrl-D to end):", file=sys.stderr)
    return sys.stdin.read().strip()


# ── Main ─────────────────────────────────────────────────────────────────────

_PHASES = ("product", "hld", "hld_v", "coding")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Interactive CLI for the a_product → c_hld → e_hld_v → "
        "w_coding_agent pipeline. See module docstring for the full flow."
    )
    src = parser.add_mutually_exclusive_group()
    src.add_argument(
        "--prompt-file",
        help="Path to a merchant prompt file to seed the first turn. "
        "If omitted (and not --resume), reads stdin.",
    )
    src.add_argument(
        "--resume",
        metavar="RUN_ID",
        help="Resume a prior run by its directory name "
        "(e.g. '2026-05-22T10-15-03_my-app'). Skips phases already in state.json.",
    )
    parser.add_argument(
        "--stop-after",
        choices=_PHASES,
        help="Halt after the named phase completes. Useful for staged debugging.",
    )
    args = parser.parse_args()

    if "ANTHROPIC_API_KEY" not in os.environ:
        print("error: ANTHROPIC_API_KEY not set", file=sys.stderr)
        return 1

    ui.banner("Local generation pipeline")

    # ── Resume vs new run ───────────────────────────────────────────────────
    state: Dict[str, Any] = {}
    if args.resume:
        run_dir = PLATFORM_AI / "cli" / "test_results" / args.resume
        state_path = run_dir / "state.json"
        if not state_path.exists():
            print(f"error: no state.json at {state_path}", file=sys.stderr)
            return 1
        state = json.loads(state_path.read_text())
        prompt = state.get("prompt") or ""
        if not prompt:
            print("error: resumed state has no 'prompt'", file=sys.stderr)
            return 1
        ui.note(f"Resume: {run_dir.relative_to(PLATFORM_AI.parent)}", ui.CYAN)
        ui.note(f"Prompt: {prompt[:80]!r}")
    else:
        prompt = _read_initial_prompt(args.prompt_file)
        if not prompt:
            print("error: empty prompt", file=sys.stderr)
            return 1

        ts = time.strftime("%Y-%m-%dT%H-%M-%S")
        slug = _slugify(prompt)
        run_dir = PLATFORM_AI / "cli" / "test_results" / f"{ts}_{slug}"
        run_dir.mkdir(parents=True, exist_ok=False)
        ui.note(f"Run: {run_dir.relative_to(PLATFORM_AI.parent)}", ui.CYAN)
        _save_state(
            run_dir,
            run_ts=ts,
            run_slug=slug,
            prompt=prompt,
            version=2,
            created_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
        )
        state = json.loads((run_dir / "state.json").read_text())

    # ── Phase 1 — Product ───────────────────────────────────────────────────
    if "intent" in state:
        intent = state["intent"]
        ui.agent_line("Product", True, None, ui.c("(resumed)", ui.DIM))
    else:
        result = pipeline.run_product_analysis(prompt, run_dir)
        if result is None:  # merchant cancelled at the generate gate
            print()
            return 0
        intent, p_tokens = result
        _save_state(run_dir, intent=intent, tokens_product=p_tokens)

    if args.stop_after == "product":
        return _final_summary(run_dir, halted_after="product")

    # ── Phase 2 — HLD ───────────────────────────────────────────────────────
    if "plan" in state:
        plan = state["plan"]
        ui.agent_line("HLD", True, None, ui.c("(resumed)", ui.DIM))
    else:
        plan, h_tokens = pipeline.run_hld(prompt, intent, run_dir)
        _save_state(run_dir, plan=plan, tokens_hld=h_tokens)

    if args.stop_after == "hld":
        return _final_summary(run_dir, halted_after="hld")

    # ── Phase 3 — HLD validator (+ optional one-shot revise) ────────────────
    if "hld_v_findings" in state:
        findings = state["hld_v_findings"]
        ui.agent_line("HLD Check", True, None, ui.c("(resumed)", ui.DIM))
    else:
        findings, v_tokens = pipeline.run_hld_validation(plan, prompt, intent, run_dir)
        _save_state(run_dir, hld_v_findings=findings, tokens_hld_v=v_tokens)

    if findings and "tokens_hld_revise" not in state:
        hint = "\n".join(
            f"- [{f.get('severity', '?')}] {f.get('location', '')}: "
            f"{f.get('issue', '')} Fix: {f.get('fix', '')}"
            for f in findings
        )
        plan, h2_tokens = pipeline.run_hld(prompt, intent, run_dir, validator_hint=hint)
        _save_state(run_dir, plan=plan, tokens_hld_revise=h2_tokens)

    if args.stop_after == "hld_v":
        return _final_summary(run_dir, halted_after="hld_v")

    # ── Phase 4 — Coding agent ──────────────────────────────────────────────
    if state.get("coding_done_called"):
        ui.agent_line(
            "Coding", True, None, ui.c("(resumed — already complete)", ui.DIM)
        )
        return _final_summary(run_dir, halted_after="coding")

    result = pipeline.run_coding(prompt, intent, plan, run_dir)
    rr = result.run_result
    vu = result.validator_usage or {}
    _save_state(
        run_dir,
        tokens_coding={
            "in": rr.total_input_tokens,
            "out": rr.total_output_tokens,
            "cache_read": rr.cache_read_tokens,
            "cache_create": rr.cache_creation_tokens,
        },
        tokens_validators={
            "in": vu.get("input_tokens", 0),
            "out": vu.get("output_tokens", 0),
            "cache_read": vu.get("cache_read_tokens", 0),
            "cache_create": vu.get("cache_creation_tokens", 0),
        },
        coding_done_called=rr.done_called,
        coding_turns_used=rr.turns_used,
        checkpoint="done" if rr.done_called else "coding-incomplete",
    )

    return _final_summary(run_dir, halted_after="coding", success=rr.done_called)


# ── Run-cost telemetry ────────────────────────────────────────────────────────
# Directional $ estimate so cost regressions surface in the run summary — NOT a
# billing figure. Approximate list prices, $ per 1M tokens, as
# (input, output, cache_read, cache_write) per model family; cache_write priced
# at the 1h-TTL rate the loop uses. GENERIC — keyed by the model family each
# stage runs on (mirrors models/agent_models.py), never by app.
_PRICE_PER_MTOK: Dict[str, Tuple[float, float, float, float]] = {
    "opus": (15.0, 75.0, 1.50, 30.0),
    "sonnet": (3.0, 15.0, 0.30, 6.0),
    "haiku": (1.0, 5.0, 0.10, 2.0),
}
# Mirrors models/agent_models.py: the first HLD pass is Opus, the revise is
# Sonnet, hld_v is Sonnet. Keep in sync if those change.
_STAGE_MODEL: Dict[str, str] = {
    "tokens_product": "haiku",
    "tokens_hld": "opus",
    "tokens_hld_v": "sonnet",
    "tokens_hld_revise": "sonnet",
    "tokens_coding": "sonnet",
    "tokens_validators": "haiku",
}
_COST_CEILING_USD = 5.0


def _stage_cost_usd(key: str, t: Dict[str, int]) -> float:
    fam = _STAGE_MODEL.get(key, "sonnet")
    pi, po, pr, pw = _PRICE_PER_MTOK[fam]
    return (
        t.get("in", 0) * pi
        + t.get("out", 0) * po
        + t.get("cache_read", 0) * pr
        + t.get("cache_create", 0) * pw
    ) / 1e6


def _final_summary(run_dir: Path, halted_after: str, success: bool = True) -> int:
    print()
    if halted_after == "coding":
        title = (
            ui.c("DONE", ui.GREEN, ui.BOLD)
            if success
            else ui.c("INCOMPLETE", ui.RED, ui.BOLD)
        )
    else:
        title = ui.c(f"STOPPED after {halted_after}", ui.YELLOW, ui.BOLD)
    rel_out = str(run_dir.relative_to(PLATFORM_AI.parent))

    # Best-effort token totals from state.json
    rows: List[Tuple[str, str]] = [("Output", rel_out)]
    total_cost = 0.0
    try:
        state = json.loads((run_dir / "state.json").read_text())
        for key, label in [
            ("tokens_product", "Product"),
            ("tokens_hld", "HLD"),
            ("tokens_hld_v", "HLD Check"),
            ("tokens_hld_revise", "HLD (revise)"),
            ("tokens_coding", "Coding"),
            ("tokens_validators", "Validators"),
        ]:
            t = state.get(key)
            if not t:
                continue
            total_cost += _stage_cost_usd(key, t)
            note = f"in={ui.ktok(t.get('in', 0))} out={ui.ktok(t.get('out', 0))}"
            cache_r = t.get("cache_read", 0)
            if cache_r:
                note += f" (cache_read={ui.ktok(cache_r)})"
            rows.append((label, ui.c(note, ui.DIM)))
        turns = state.get("coding_turns_used")
        if turns is not None:
            rows.append(("Turns", ui.c(str(turns), ui.DIM)))
        # Cost row — green within budget, red over the ceiling.
        over = total_cost > _COST_CEILING_USD
        cost_str = f"~${total_cost:.2f}"
        if over:
            cost_str += f"  ⚠ over ${_COST_CEILING_USD:.0f} ceiling"
        rows.append(("Cost (est.)", ui.c(cost_str, ui.RED if over else ui.GREEN)))
    except Exception:
        pass

    ui.summary_box(title, rows)
    if total_cost > _COST_CEILING_USD:
        print(
            ui.c(
                f"  WARN: estimated generation cost ~${total_cost:.2f} exceeds "
                f"the ${_COST_CEILING_USD:.0f} target — check the per-stage "
                f"breakdown above.",
                ui.RED,
            )
        )
    print()
    return 0 if success else 2


if __name__ == "__main__":
    raise SystemExit(main())
