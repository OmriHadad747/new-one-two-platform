"""
chat_local.py — interactive CLI for the new pipeline.

Pipeline: a_product → c_hld → e_hld_v → w_coding_agent.

Usage:
  python platform-ai/cli/chat_local.py                       # read prompt from stdin
  python platform-ai/cli/chat_local.py --prompt-file PATH    # read prompt from file
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ── Bootstrap ────────────────────────────────────────────────────────────────

PLATFORM_AI = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLATFORM_AI))

try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv(PLATFORM_AI / ".env")
except ImportError:
    pass

from models.adapter import input_log  # noqa: E402
from subagents.a_product_agent.agent import run_product_agent  # noqa: E402
from subagents.c_hld_agent.agent import HLDValidationError, run_hld_agent  # noqa: E402
from subagents.e_hld_v_agent.agent import run_hld_validator  # noqa: E402
from subagents.w_coding_agent.agent import run_coding_agent  # noqa: E402


# ── Display helpers ──────────────────────────────────────────────────────────

# Terminal width — clamped to [60, 120] for readability.
_W = max(60, min(120, shutil.get_terminal_size((100, 20)).columns))

# Honour NO_COLOR + TTY detection so piped output stays clean.
_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None

_RESET = "\033[0m"
_BOLD = "\033[1m"
_DIM = "\033[2m"
_CYAN = "\033[36m"
_GREEN = "\033[32m"
_YELLOW = "\033[33m"
_RED = "\033[31m"
_MAGENTA = "\033[35m"
_BLUE = "\033[34m"

# Per-agent accent colours so progress lines don't look like a grey wall.
_AGENT_COLOR: Dict[str, str] = {
    "Product": _CYAN,
    "HLD": _MAGENTA,
    "HLD (revise)": _MAGENTA,
    "HLD Check": _MAGENTA,
    "Coding": _BLUE,
}


def _c(text: str, *codes: str) -> str:
    """Wrap text in ANSI codes, or pass-through when colour is off."""
    return f"{''.join(codes)}{text}{_RESET}" if _USE_COLOR else text


# ── Banner ────────────────────────────────────────────────────────────────────

_BANNER_ROWS = [
    "████████╗ ██████╗ ███╗   ██╗",
    "╚══██╔══╝██╔═══██╗████╗  ██║",
    "   ██║   ██║   ██║██╔██╗ ██║",
    "   ██║   ██║   ██║██║╚██╗██║",
    "   ██║   ╚██████╔╝██║ ╚████║",
    "   ╚═╝    ╚═════╝ ╚═╝  ╚═══╝",
]
_BANNER_COLORS = [_MAGENTA, _MAGENTA, _BLUE, _BLUE, _CYAN, _CYAN]


def _render_banner(subtitle: str) -> None:
    """Print the TON banner with subtle magenta→cyan gradient."""
    print()
    for row, color in zip(_BANNER_ROWS, _BANNER_COLORS):
        print(f"  {_c(row, color, _BOLD)}")
    print(f"\n  {_c('◆', _MAGENTA)} {_c(subtitle, _BOLD)}")
    print(f"  {_c('Ctrl+C at any prompt to bail.', _DIM)}\n")


def _hr(char: str = "─") -> None:
    print(_c(char * _W, _DIM))


def _phase_header(label: str) -> None:
    """Bold divider between major pipeline phases."""
    bar = "─" * max(0, _W - len(label) - 6)
    print(f"\n  {_c('◆', _MAGENTA)} {_c(label, _BOLD)}  {_c(bar, _DIM)}\n")


# Strip ANSI SGR escapes when measuring display width — colour codes
# add bytes but take zero visible columns; padding math must ignore them.
_ANSI_SGR_RE = re.compile(r"\x1b\[[0-9;]*m")


def _visible_len(s: str) -> int:
    return len(_ANSI_SGR_RE.sub("", s))


def _summary_box(title: str, rows: List[Tuple[str, str]]) -> None:
    """Rounded-corner box for the run summary."""
    label_w = max((_visible_len(l) for l, _ in rows), default=8)
    value_w = max((_visible_len(v) for _, v in rows), default=8)
    inner = max(label_w + value_w + 5, _visible_len(title) + 4)
    print(f"  {_c('╭' + '─' * inner + '╮', _DIM)}")
    pad = inner - _visible_len(title) - 2
    print(f"  {_c('│', _DIM)} {_c(title, _BOLD)}{' ' * pad} {_c('│', _DIM)}")
    print(f"  {_c('├' + '─' * inner + '┤', _DIM)}")
    for label, value in rows:
        lpad = label_w - _visible_len(label)
        vpad = value_w - _visible_len(value)
        print(
            f"  {_c('│', _DIM)} {_c(label, _DIM)}{' ' * lpad}  "
            f"{value}{' ' * vpad}  {_c('│', _DIM)}"
        )
    print(f"  {_c('╰' + '─' * inner + '╯', _DIM)}")


# ── Number + token formatters ────────────────────────────────────────────────


def _ktok(n: int) -> str:
    """Format token counts: 1234 → '1.2k', 1234567 → '1.2M'."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def _tok_note(
    in_tok: int,
    out_tok: int,
    suffix: Optional[str] = None,
    cache_read: int = 0,
    cache_create: int = 0,
) -> str:
    parts = [f"in={_ktok(in_tok)}"]
    if cache_read or cache_create:
        total = in_tok + cache_create + cache_read
        if total:
            hit = (cache_read / total) * 100
            parts.append(f"(cache hit {_ktok(cache_read)}={hit:.0f}%)")
    parts.append(f"out={_ktok(out_tok)}")
    if suffix:
        parts.append(suffix)
    return _c(" ".join(parts), _DIM)


# ── Agent line + retry + spinner ──────────────────────────────────────────────


def _agent_line(name: str, ok: bool, ms: Optional[int], notes: str = "") -> None:
    mark = _c("✓", _GREEN) if ok else _c("✗", _RED)
    ms_str = f"{ms / 1000:.1f}s" if ms is not None else ""
    color = _AGENT_COLOR.get(name, _CYAN)
    print(f"  {_c(name.ljust(14), color, _BOLD)} {mark}  {ms_str:>7s}  {notes}")


def _retry_line(name: str, notes: str = "") -> None:
    color = _AGENT_COLOR.get(name, _CYAN)
    print(f"  {_c(name.ljust(14), color, _BOLD)} {_c('↻', _YELLOW)}            {_c(notes, _DIM)}")


class _Spinner:
    """Background braille spinner. No-op on non-TTY."""

    _chars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

    def __init__(self, label: str) -> None:
        self.label = label
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if not _USE_COLOR:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        color = _AGENT_COLOR.get(self.label, _CYAN)
        i = 0
        while not self._stop.is_set():
            sys.stdout.write(
                f"\r  {_c(self.label.ljust(14), color, _BOLD)} "
                f"{_c(self._chars[i], _DIM)}  "
            )
            sys.stdout.flush()
            i = (i + 1) % len(self._chars)
            time.sleep(0.1)

    def stop(self) -> None:
        if self._thread is None:
            return
        self._stop.set()
        self._thread.join(timeout=1)
        self._thread = None
        sys.stdout.write("\r" + " " * 40 + "\r")
        sys.stdout.flush()


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


# ── Phase functions ──────────────────────────────────────────────────────────


def _phase_product(prompt: str, run_dir: Path) -> tuple[Dict[str, Any], int, int]:
    _phase_header("Product analysis")
    sp = _Spinner("Product")
    sp.start()
    t0 = time.monotonic()
    try:
        with input_log("product", run_dir):
            intent, in_tok, out_tok = run_product_agent(prompt)
    finally:
        sp.stop()
    ms = int((time.monotonic() - t0) * 1000)
    _agent_line("Product", True, ms, _tok_note(in_tok, out_tok))
    return intent, in_tok, out_tok


def _phase_hld(
    prompt: str,
    intent: Dict[str, Any],
    run_dir: Path,
    validator_hint: Optional[str] = None,
) -> tuple[Dict[str, Any], int, int, int, int]:
    label = "HLD" if validator_hint is None else "HLD (revise)"
    _phase_header("HLD design" if validator_hint is None else "HLD revision")
    sp = _Spinner(label)
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
        tok = _tok_note(in_tok, out_tok, cache_read=cache_r, cache_create=cache_c)
        _agent_line(label, False, None, f"attempt {attempt} rejected: {first}{more}  {tok}")
        for e in errors:
            print(f"    {_c('•', _DIM)} {_c(e, _DIM)}")
        _retry_line(label, f"retry attempt {attempt + 1}")

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
        _agent_line(
            label,
            False,
            ms,
            f"failed after {err.attempts} attempt(s)  "
            + _tok_note(
                err.in_tokens,
                err.out_tokens,
                cache_read=err.cache_read_tokens,
                cache_create=err.cache_creation_tokens,
            ),
        )
        print(f"\n  {_c('HLD failed:', _RED)}")
        for e in err.errors:
            print(f"    • {e}")
        sys.exit(1)
    finally:
        sp.stop()

    ms = int((time.monotonic() - t0) * 1000)
    _agent_line(label, True, ms, _tok_note(in_tok, out_tok, cache_read=cache_r, cache_create=cache_c))

    if plan.get("feasibility") == "blocked":
        reason = plan.get("blockedReason", "Platform limitation.")
        print(f"\n  {_c('Platform limitation:', _RED)} {reason}")
        sys.exit(1)

    return plan, in_tok, out_tok, cache_r, cache_c


def _phase_hld_v(
    plan: Dict[str, Any],
    prompt: str,
    intent: Dict[str, Any],
    run_dir: Path,
) -> tuple[List[Dict[str, Any]], int, int, int, int]:
    _phase_header("HLD validation")
    sp = _Spinner("HLD Check")
    sp.start()
    t0 = time.monotonic()
    findings: List[Dict[str, Any]] = []
    in_tok = out_tok = cache_r = cache_c = 0
    try:
        with input_log("hld_v", run_dir):
            findings, in_tok, out_tok, cache_r, cache_c = run_hld_validator(plan, prompt, intent)
    except Exception as exc:
        sp.stop()
        print(f"  hld_v failed ({exc}) — fail-open")
    finally:
        sp.stop()

    ms = int((time.monotonic() - t0) * 1000)
    sev_note = f"{len(findings)} finding(s)" if findings else "clean"
    _agent_line(
        "HLD Check",
        True,
        ms,
        _tok_note(in_tok, out_tok, sev_note, cache_read=cache_r, cache_create=cache_c),
    )

    if findings:
        sev_color = {"critical": _RED, "important": _YELLOW, "minor": _DIM}
        for f in findings:
            sc = sev_color.get(f.get("severity", ""), _DIM)
            sev = f.get("severity", "?")
            loc = f.get("location", "")
            issue = (f.get("issue", "") or "")[:120]
            print(f"    {_c('•', sc)} {_c('[' + sev + ']', sc)}  {_c(loc, _DIM)}  {issue}")

    return findings, in_tok, out_tok, cache_r, cache_c


def _phase_coding(
    prompt: str,
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    run_dir: Path,
) -> Any:
    _phase_header("Coding agent")
    print(_c("  ─── Live tool calls ───", _DIM))

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
    parts.append(_c("done", _GREEN) if rr.done_called else _c("NO DONE", _RED))
    if rr.hit_turn_cap:
        parts.append(_c("cap hit", _YELLOW))
    summary = ", ".join(parts)

    _agent_line(
        "Coding",
        rr.done_called,
        ms,
        _tok_note(
            rr.total_input_tokens,
            rr.total_output_tokens,
            summary,
            cache_read=rr.cache_read_tokens,
            cache_create=rr.cache_creation_tokens,
        ),
    )

    return result


# ── Main ─────────────────────────────────────────────────────────────────────


_PHASES = ("product", "hld", "hld_v", "coding")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    src = parser.add_mutually_exclusive_group()
    src.add_argument(
        "--prompt-file",
        help="Path to merchant prompt file. If omitted (and not --resume), reads stdin.",
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

    _render_banner("Single-agent codegen — local pipeline")

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
        print(_c(f"\nResume: {run_dir.relative_to(PLATFORM_AI.parent)}", _CYAN))
    else:
        if args.prompt_file:
            prompt = Path(args.prompt_file).read_text().strip()
        else:
            print("Paste merchant prompt (Ctrl-D to end):", file=sys.stderr)
            prompt = sys.stdin.read().strip()
        if not prompt:
            print("error: empty prompt", file=sys.stderr)
            return 1

        ts = time.strftime("%Y-%m-%dT%H-%M-%S")
        slug = _slugify(prompt)
        run_dir = PLATFORM_AI / "cli" / "test_results" / f"{ts}_{slug}"
        run_dir.mkdir(parents=True, exist_ok=False)
        print(_c(f"\nRun: {run_dir.relative_to(PLATFORM_AI.parent)}", _CYAN))

        _save_state(
            run_dir,
            run_ts=ts,
            run_slug=slug,
            prompt=prompt,
            version=2,
            created_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
        )
        state = json.loads((run_dir / "state.json").read_text())

    print(_c(f"Prompt: {prompt[:80]!r}...", _DIM))

    # ── Phase 1 — Product ───────────────────────────────────────────────────
    if "intent" in state:
        intent = state["intent"]
        _agent_line("Product", True, None, _c("(resumed)", _DIM))
    else:
        intent, p_in, p_out = _phase_product(prompt, run_dir)
        _save_state(run_dir, intent=intent, tokens_product={"in": p_in, "out": p_out})

    if args.stop_after == "product":
        return _final_summary(run_dir, halted_after="product")

    # ── Phase 2 — HLD ───────────────────────────────────────────────────────
    if "plan" in state:
        plan = state["plan"]
        _agent_line("HLD", True, None, _c("(resumed)", _DIM))
    else:
        plan, h_in, h_out, h_cr, h_cc = _phase_hld(prompt, intent, run_dir)
        _save_state(
            run_dir,
            plan=plan,
            tokens_hld={"in": h_in, "out": h_out, "cache_read": h_cr, "cache_create": h_cc},
        )

    if args.stop_after == "hld":
        return _final_summary(run_dir, halted_after="hld")

    # ── Phase 3 — HLD validator (+ optional one-shot revise) ────────────────
    if "hld_v_findings" in state:
        findings = state["hld_v_findings"]
        _agent_line("HLD Check", True, None, _c("(resumed)", _DIM))
    else:
        findings, v_in, v_out, v_cr, v_cc = _phase_hld_v(plan, prompt, intent, run_dir)
        _save_state(
            run_dir,
            hld_v_findings=findings,
            tokens_hld_v={"in": v_in, "out": v_out, "cache_read": v_cr, "cache_create": v_cc},
        )

    if findings and "tokens_hld_revise" not in state:
        hint = "\n".join(
            f"- [{f.get('severity', '?')}] {f.get('location', '')}: "
            f"{f.get('issue', '')} Fix: {f.get('fix', '')}"
            for f in findings
        )
        plan, h2_in, h2_out, h2_cr, h2_cc = _phase_hld(
            prompt, intent, run_dir, validator_hint=hint
        )
        _save_state(
            run_dir,
            plan=plan,
            tokens_hld_revise={
                "in": h2_in,
                "out": h2_out,
                "cache_read": h2_cr,
                "cache_create": h2_cc,
            },
        )

    if args.stop_after == "hld_v":
        return _final_summary(run_dir, halted_after="hld_v")

    # ── Phase 4 — Coding agent ──────────────────────────────────────────────
    if state.get("coding_done_called"):
        _agent_line("Coding", True, None, _c("(resumed — already complete)", _DIM))
        return _final_summary(run_dir, halted_after="coding")

    result = _phase_coding(prompt, intent, plan, run_dir)
    rr = result.run_result
    _save_state(
        run_dir,
        tokens_coding={
            "in": rr.total_input_tokens,
            "out": rr.total_output_tokens,
            "cache_read": rr.cache_read_tokens,
            "cache_create": rr.cache_creation_tokens,
        },
        coding_done_called=rr.done_called,
        coding_turns_used=rr.turns_used,
        checkpoint="done" if rr.done_called else "coding-incomplete",
    )

    return _final_summary(run_dir, halted_after="coding", success=rr.done_called)


def _final_summary(run_dir: Path, halted_after: str, success: bool = True) -> int:
    print()
    if halted_after == "coding":
        title = _c("DONE", _GREEN, _BOLD) if success else _c("INCOMPLETE", _RED, _BOLD)
    else:
        title = _c(f"STOPPED after {halted_after}", _YELLOW, _BOLD)
    rel_out = str(run_dir.relative_to(PLATFORM_AI.parent))

    # Best-effort token totals from state.json
    rows: List[Tuple[str, str]] = [("Output", rel_out)]
    try:
        state = json.loads((run_dir / "state.json").read_text())
        for key, label in [
            ("tokens_product", "Product"),
            ("tokens_hld", "HLD"),
            ("tokens_hld_v", "HLD Check"),
            ("tokens_hld_revise", "HLD (revise)"),
            ("tokens_coding", "Coding"),
        ]:
            t = state.get(key)
            if not t:
                continue
            in_tok = t.get("in", 0)
            out_tok = t.get("out", 0)
            cache_r = t.get("cache_read", 0)
            note = f"in={_ktok(in_tok)} out={_ktok(out_tok)}"
            if cache_r:
                note += f" (cache_read={_ktok(cache_r)})"
            rows.append((label, _c(note, _DIM)))
        turns = state.get("coding_turns_used")
        if turns is not None:
            rows.append(("Turns", _c(str(turns), _DIM)))
    except Exception:
        pass

    _summary_box(title, rows)
    print()
    return 0 if success else 2


if __name__ == "__main__":
    raise SystemExit(main())
