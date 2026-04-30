#!/usr/bin/env python3
"""
Interactive chat CLI — mirrors the platform's chat page experience.

Runs the multi-turn product agent clarification loop, then shows the
component picker (Backend / Widget / Admin UI), then runs the generation
pipeline phase by phase. Use --stop-after to halt at a specific phase, or
--resume to continue a prior run that was interrupted or failed.

USAGE
-----
  python chat_local.py                        # full pipeline
  python chat_local.py --stop-after arch      # product + architect only, prints plan
  python chat_local.py --stop-after codegen   # + codegen + static validation
  python chat_local.py --stop-after validator # + LLM validator + revision pass
  python chat_local.py --no-db                # skip writing the bundle to postgres

RESUME
------
  Every run writes a state.json into its run dir after each phase. Use these
  flags to recover a run without re-paying tokens for phases that already
  succeeded:

    python chat_local.py --list-resume         # show every resumable run
    python chat_local.py --resume <RUN_ID>     # continue a specific run

  The CLI dispatches into the right phase based on the saved checkpoint:

    intent     → re-runs from architect onwards
    arch       → re-runs from codegen onwards
    arch + codegen_failed
               → re-runs codegen, reusing artifacts that already passed
                 validation (only the failed/missing generators are billed)
    codegen    → re-runs from validator onwards
    validator + (kept_originals | revision_failed)
               → re-runs only the revision agent against the saved
                 validator issues — the validator LLM call is skipped
                 entirely (this is the main token-saver)
    validator (no halt) / revision
               → skips straight to explanation
    done + (kept_originals | revision_failed)
               → run shipped with unresolved findings; --resume re-runs
                 just the revision step

  Robustness: missing/corrupt/wrong-version state.json files are silently
  dropped from --list-resume; --resume fails with exit code 2 and a clear
  message rather than a traceback.

OUTPUT
------
  Console: live per-agent progress lines with token counts
  File (stop-after=arch):     test_results/<ts>_<slug>_arch.json
  File (stop-after=codegen/validator or full): test_results/<ts>_<slug>.md
  File (every run):           test_results/<ts>_<slug>/state.json  (resume index)
"""
from __future__ import annotations

import argparse
import atexit
import dataclasses
import itertools
import json
import os
import re
import shutil
import sys
import textwrap
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

_HERE = Path(__file__).resolve().parent
_GENERATOR_ROOT = _HERE.parent
os.chdir(_GENERATOR_ROOT)
sys.path.insert(0, str(_GENERATOR_ROOT))
sys.path.insert(0, str(_HERE))  # allow importing cli/db_local

# Redirect all generator logs to file — keeps the terminal output clean
import logging as _log

(_HERE / "test_results").mkdir(exist_ok=True)
_log.basicConfig(
    handlers=[_log.FileHandler(_HERE / "test_results" / "generation.log")],
    level=_log.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    force=True,
)

from models.adapter import input_log
from subagents.architect_agent import run_architect_agent, _ARCHITECT_USER_TEMPLATE
from subagents.base import CodegenContext
from subagents.explanation_agent import run_explanation_agent
from subagents.product_agent import run_product_agent_analyze
from subagents.revision_agent import run_revision_agent
from llm_validations.arch_plan import validate_architect_plan
from subagents.validators import run_llm_validators
from crews.feature_generator.crew import (
    run_codegen_parallel,
    validate_artifacts,
    _revision_locked_artifacts,
)

TEST_RESULTS_DIR = _HERE / "test_results"
_MAX_ARCH_ATTEMPTS = 2  # matches crew.py
_MAX_CODEGEN_RETRIES = 3  # matches crew.py _MAX_RETRIES

StopAfter = Literal["arch", "codegen", "validator", "full"]

# ── Display helpers ────────────────────────────────────────────────────────────
#
# Terminal UI constraints:
#   - Stdlib only (no `rich`, `prompt_toolkit`, etc.) — this CLI is part of
#     platform-ai and we don't want to drag a UI dep into the generator's
#     runtime dependency graph. That rules out things like Live renderables
#     and reactive tables. We get by with ANSI escapes + a threaded spinner.
#   - Respect NO_COLOR (https://no-color.org) and honour TTY detection so
#     piped output stays clean. All styling routes through `_c()` which
#     short-circuits to the raw string when colour is off.
#   - Width is recomputed from `shutil.get_terminal_size` so resizes between
#     phases don't misalign rules; clamped to [60, 120] for readability.

# Width is read once at import; most terminals don't change size mid-run
# and recomputing on every line would cost a syscall per print.
_W = max(60, min(120, shutil.get_terminal_size((100, 20)).columns))

# Colour gate — honour NO_COLOR and non-TTY stdout (pipes, CI logs).
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
_BRIGHT_GREEN = "\033[92m"
_GRAY = "\033[90m"

# Per-agent accent colours so the progress lines don't look like a grey
# wall of text. Keys match the labels passed to `_spinner` / `_agent_line`.
_AGENT_COLOR: Dict[str, str] = {
    "Prefetch": _GRAY,
    "Architect": _MAGENTA,
    "Handler": _BLUE,
    "Migration": _CYAN,
    "Widget JS": _YELLOW,
    "Admin UI": _YELLOW,
    "Validation": _GREEN,
    "Validator": _MAGENTA,
    "Revision": _BLUE,
    "Explanation": _CYAN,
}


def _c(text: str, *codes: str) -> str:
    """Wrap text in ANSI codes, or return unchanged when colour is off."""
    return f"{''.join(codes)}{text}{_RESET}" if _USE_COLOR else text


# ── Banner ────────────────────────────────────────────────────────────────────

# ASCII "TON" (stacked compact blocks). Printed once at startup. The per-
# character colour step gives a subtle magenta→cyan gradient without the
# cost of truecolour support detection.
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
    for row, color in zip(_BANNER_ROWS, _BANNER_COLORS):
        print(f"  {_c(row, color, _BOLD)}")
    print(f"\n  {_c('◆', _MAGENTA)} {_c(subtitle, _BOLD)}")
    print(f"  {_c('Ctrl+C at any prompt to bail.', _DIM)}\n")


# ── Phase rule + summary box ──────────────────────────────────────────────────


def _hr(char: str = "─") -> None:
    print(_c(char * _W, _DIM))


def _phase_header(label: str) -> None:
    """Bold divider between major pipeline phases."""
    bar = "─" * (_W - len(label) - 6)
    print(f"\n  {_c('◆', _MAGENTA)} {_c(label, _BOLD)}  {_c(bar, _DIM)}\n")


# Pre-compiled to strip ANSI SGR escapes when measuring display width.
# `_c()` wraps text in colour codes that expand the string's byte length
# while taking zero visible columns — padding math must ignore them or
# the box's right border drifts by exactly the sum of invisible bytes in
# each row.
_ANSI_SGR_RE = re.compile(r"\x1b\[[0-9;]*m")


def _visible_len(s: str) -> int:
    return len(_ANSI_SGR_RE.sub("", s))


def _summary_box(title: str, rows: List[Tuple[str, str]]) -> None:
    """Rounded-corner box with left-aligned labels. Widths computed per call."""
    label_w = max((_visible_len(l) for l, _ in rows), default=8)
    value_w = max((_visible_len(v) for _, v in rows), default=8)
    title_w = _visible_len(title)
    inner_w = max(title_w + 2, label_w + value_w + 5)

    top = "╭" + "─" * (inner_w + 2) + "╮"
    bottom = "╰" + "─" * (inner_w + 2) + "╯"
    print(f"  {_c(top, _MAGENTA)}")
    print(
        f"  {_c('│', _MAGENTA)} "
        f"{_c(title, _BOLD)}{' ' * (inner_w - title_w)} "
        f"{_c('│', _MAGENTA)}"
    )
    print(f"  {_c('│', _MAGENTA)} {_c('─' * inner_w, _DIM)} {_c('│', _MAGENTA)}")
    for label, value in rows:
        # Row width math: ` {label}{label-pad} · {pad}{value} ` between │…│
        # = 4 + label_w + pad + value_visible_w content chars; wrapped row
        # is inner_w + 4 visible chars (matching the top/bottom border), so
        # pad = inner_w - label_w - value_visible_w - 2.
        pad = inner_w - label_w - _visible_len(value) - 2
        if pad < 1:
            pad = 1
        line = (
            f" {_c(label, _DIM)}{' ' * (label_w - _visible_len(label))} "
            f"{_c('·', _DIM)}{' ' * pad}{value} "
        )
        print(f"  {_c('│', _MAGENTA)}{line}{_c('│', _MAGENTA)}")
    print(f"  {_c(bottom, _MAGENTA)}")


# ── Chat helpers ──────────────────────────────────────────────────────────────


def _bot(text: str) -> None:
    """
    Print an assistant message. When `text` is multi-line — e.g. the
    structured `summary` field returned by run_product_agent_analyze in the
    "ready" state, which uses sectioned plain-text format with newlines and
    bullet lines — continuation lines are indented to align under the first
    line's text column (7 visible chars: '▸ Ton  '). Single-line messages
    render exactly as before.
    """
    lines = text.splitlines() if text else [""]
    head = lines[0] if lines else ""
    print(f"\n{_c('▸', _MAGENTA)} {_c('Ton', _CYAN, _BOLD)}  {head}")
    indent = " " * 7  # matches the visible width of '▸ Ton  '
    for line in lines[1:]:
        print(f"{indent}{line}" if line else "")
    print()


def _info(text: str) -> None:
    print(f"  {_c(text, _DIM)}")


# ── Animated spinner (threaded) ───────────────────────────────────────────────
#
# `_spinner(name)` starts a background thread that animates a braille frame
# next to the agent label until the next `_agent_line` / `_retry_line` call
# for any label stops it. Each agent call in the pipeline is strictly
# serial, so a single module-level spinner state is enough.

_SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

_spinner_state: Dict[str, Any] = {"stop": None, "thread": None, "start": None}


def _stop_spinner() -> None:
    stop = _spinner_state.get("stop")
    if stop is not None:
        stop.set()
        t = _spinner_state.get("thread")
        if t is not None:
            t.join(timeout=0.3)
    _spinner_state["stop"] = None
    _spinner_state["thread"] = None
    _spinner_state["start"] = None
    # Clear the spinner line so subsequent output starts clean.
    if _USE_COLOR:
        print(f"\r{' ' * _W}\r", end="", flush=True)


def _spinner(name: str) -> None:
    """Kick off a braille-spinner animation for the given agent label."""
    _stop_spinner()
    _stop_spinner_group()
    if not _USE_COLOR:
        # Non-TTY: one static line, no animation (keeps CI logs readable).
        print(f"  {name:<14} ...", flush=True)
        return

    # Reserve one row for the spinner line + _BOTTOM_MARGIN blank rows
    # below so the active agent isn't glued to the terminal bottom.
    _reserve_below(1)

    stop = threading.Event()
    start = time.monotonic()
    color = _AGENT_COLOR.get(name, _CYAN)

    def _loop() -> None:
        for frame in itertools.cycle(_SPIN_FRAMES):
            if stop.is_set():
                return
            elapsed = time.monotonic() - start
            # Show a running elapsed clock next to long-running agents so
            # it's obvious when the LLM is crawling vs the process hanging.
            elapsed_str = f"{elapsed:4.1f}s" if elapsed >= 1 else "     "
            line = (
                f"  {_c(name.ljust(14), color, _BOLD)} "
                f"{_c(frame, color)}  "
                f"{_c(elapsed_str, _DIM)}"
            )
            print(f"\r{line}", end="", flush=True)
            time.sleep(0.08)

    t = threading.Thread(target=_loop, daemon=True)
    t.start()
    _spinner_state["stop"] = stop
    _spinner_state["thread"] = t
    _spinner_state["start"] = start


def _agent_line(name: str, ok: bool, ms: Optional[int], notes: str = "") -> None:
    # If a multi-line spinner group is active, route to the slot updater
    # so the agent's row updates in place instead of printing a new line
    # beneath the group.
    if _group_state.get("active"):
        _finish_slot(name, ok, ms, notes)
        return
    _stop_spinner()
    icon = _c("✓", _BRIGHT_GREEN, _BOLD) if ok else _c("✗", _RED, _BOLD)
    color = _AGENT_COLOR.get(name, _CYAN)
    label = _c(name.ljust(14), color, _BOLD)
    timing = _c(f"{ms}ms".ljust(7), _DIM) if ms is not None else _c("—".ljust(7), _DIM)
    line = f"  {label} {icon}  {timing}  {notes}".rstrip()
    print(f"\r{line}")


def _retry_line(name: str, notes: str) -> None:
    if _group_state.get("active"):
        # Update the slot's notes in-place and flip status to retry.
        for slot in _group_state["slots"]:
            if slot["name"] == name:
                slot["status"] = "retry"
                slot["notes"] = notes[:60]
                break
        return
    _stop_spinner()
    color = _AGENT_COLOR.get(name, _CYAN)
    line = (
        f"  {_c(name.ljust(14), color, _BOLD)} {_c('↻', _YELLOW, _BOLD)}  "
        f"{'':7}  {_c(notes[:60], _DIM)}"
    )
    print(f"\r{line}")


# ── Multi-line spinner group ──────────────────────────────────────────────────
#
# Codegen runs handler/migration/widget/admin in parallel via a
# ThreadPoolExecutor in crew.run_codegen_parallel. The single-slot spinner
# can only animate one label at a time, so the CLI used to show whichever
# _spinner() was called last (the admin_ui slot) and hid the fact that
# three agents were racing beneath it.
#
# _spinner_group(labels) starts an animated row per label, redrawing all
# rows on each frame. Per-agent lifecycle callbacks wire in through
# run_codegen_parallel(on_start=…, on_done=…), so the rows transition
# from spinning → done in the order the threads actually finish, not
# submission order.
#
# Concurrency notes:
#   - The animation thread is the only writer during the group's lifetime;
#     on_start / on_done callbacks only MUTATE slot state, never print.
#     That keeps us clear of the classic "two threads print at once"
#     garbled-line hazard.
#   - ANSI cursor save/restore (\0337 / \0338 via \033[s / \033[u) pins
#     the redraw anchor across scroll events. `\033[K` clears each line
#     so a shorter new value doesn't leave stale characters behind.

_group_state: Dict[str, Any] = {
    "active": False,
    "slots": [],  # list of {name, status: running|retry|done, start, ms, notes, icon}
    "thread": None,
    "stop": None,
    "lock": threading.Lock(),
}


def _format_slot(slot: Dict[str, Any], frame: str) -> str:
    name = slot["name"]
    color = _AGENT_COLOR.get(name, _CYAN)
    label = _c(name.ljust(14), color, _BOLD)
    status = slot["status"]

    if status == "running":
        elapsed = time.monotonic() - slot["start"]
        elapsed_str = f"{elapsed:5.1f}s" if elapsed >= 1 else "      "
        return f"  {label} {_c(frame, color)}  " f"{_c(elapsed_str, _DIM)}"
    if status == "retry":
        return (
            f"  {label} {_c('↻', _YELLOW, _BOLD)}  "
            f"{'':7}  {_c(slot.get('notes', '')[:60], _DIM)}"
        )
    # done
    icon = slot.get("icon") or _c("✓", _BRIGHT_GREEN, _BOLD)
    ms = slot.get("ms")
    timing = _c(f"{ms}ms".ljust(7), _DIM) if ms is not None else _c("—".ljust(7), _DIM)
    notes = slot.get("notes", "")
    return f"  {label} {icon}  {timing}  {notes}".rstrip()


def _spinner_group(labels: List[str]) -> None:
    """Start a multi-line animated spinner group — one row per label."""
    _stop_spinner()
    _stop_spinner_group()

    slots: List[Dict[str, Any]] = [
        {
            "name": name,
            "status": "running",
            "start": time.monotonic(),
            "ms": None,
            "notes": "",
            "icon": None,
        }
        for name in labels
    ]

    if not _USE_COLOR:
        # Non-TTY: print one static start line per slot; per-agent
        # _agent_line calls will print their completion lines beneath.
        for s in slots:
            print(f"  {s['name']:<14} …", flush=True)
        _group_state["active"] = True
        _group_state["slots"] = slots
        return

    # Reserve (N slot rows + _BOTTOM_MARGIN) and position the cursor at
    # the top of the slot block.
    _reserve_below(len(slots))

    # Prime each row once so cursor save/restore has real lines to land on.
    for _ in slots:
        sys.stdout.write("\n")
    sys.stdout.write(f"\033[{len(slots)}A")
    sys.stdout.flush()

    stop = threading.Event()

    def _loop() -> None:
        for frame in itertools.cycle(_SPIN_FRAMES):
            if stop.is_set():
                return
            with _group_state["lock"]:
                sys.stdout.write("\033[s")  # save cursor
                for i, slot in enumerate(_group_state["slots"]):
                    sys.stdout.write("\r\033[K")
                    sys.stdout.write(_format_slot(slot, frame))
                    if i < len(_group_state["slots"]) - 1:
                        sys.stdout.write("\n")
                sys.stdout.write("\033[u")  # restore cursor
                sys.stdout.flush()
            time.sleep(0.08)

    t = threading.Thread(target=_loop, daemon=True)
    t.start()
    _group_state["active"] = True
    _group_state["slots"] = slots
    _group_state["stop"] = stop
    _group_state["thread"] = t


def _finish_slot(name: str, ok: bool, ms: Optional[int], notes: str = "") -> None:
    """Called by _agent_line when a group is active."""
    if not _group_state.get("active"):
        return
    with _group_state["lock"]:
        for slot in _group_state["slots"]:
            if slot["name"] == name:
                slot["status"] = "done"
                slot["icon"] = (
                    _c("✓", _BRIGHT_GREEN, _BOLD) if ok else _c("✗", _RED, _BOLD)
                )
                slot["ms"] = ms
                slot["notes"] = notes
                break
        all_done = all(s["status"] != "running" for s in _group_state["slots"])
    if all_done:
        _stop_spinner_group()


def _stop_spinner_group() -> None:
    if not _group_state.get("active"):
        return
    stop = _group_state.get("stop")
    if stop is not None:
        stop.set()
    t = _group_state.get("thread")
    if t is not None:
        t.join(timeout=0.3)

    if _USE_COLOR:
        # Freeze frame — one final static redraw of all slots, then move
        # cursor past the block so subsequent output starts below it.
        with _group_state["lock"]:
            sys.stdout.write("\033[s")
            for i, slot in enumerate(_group_state["slots"]):
                sys.stdout.write("\r\033[K")
                sys.stdout.write(_format_slot(slot, _SPIN_FRAMES[0]))
                if i < len(_group_state["slots"]) - 1:
                    sys.stdout.write("\n")
            sys.stdout.write("\n")
            sys.stdout.flush()
    else:
        # Non-TTY: the status lines were already primed at _spinner_group
        # start; emit one completion line per slot now so logs show the
        # final state.
        for slot in _group_state["slots"]:
            icon = (
                "✓"
                if slot["status"] == "done" and slot.get("icon") is not None
                else "·"
            )
            ms = slot.get("ms")
            ms_str = f"{ms}ms" if ms is not None else "—"
            print(
                f"  {slot['name']:<14} {icon}  {ms_str}  {slot.get('notes', '')}".rstrip(),
                flush=True,
            )

    _group_state["active"] = False
    _group_state["slots"] = []
    _group_state["stop"] = None
    _group_state["thread"] = None


def _ktok(n: int) -> str:
    """Format token count as e.g. '2.4k' or '850'."""
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def _tok_note(in_tok: int, out_tok: int, extra: str = "") -> str:
    """'in=2.4k out=0.8k' — append extra if provided."""
    base = f"in={_ktok(in_tok)} out={_ktok(out_tok)}"
    return f"{base}  {extra}" if extra else base


# ── Bottom margin ─────────────────────────────────────────────────────────────
#
# Two-prong strategy:
#
#   1. _reserve_below(content_rows) — called before every spinner draw.
#      Writes (content_rows + _BOTTOM_MARGIN) newlines to scroll the
#      terminal up, then cursor-up that many rows so the caller can draw
#      into `content_rows` rows with `_BOTTOM_MARGIN` blank rows visibly
#      below. Keeps the active agent from sitting flush at the terminal
#      bottom while a run is in progress — which the atexit hook alone
#      can't fix (it only fires on shutdown).
#
#   2. atexit _final_margin() — ensures exits (normal, sys.exit,
#      KeyboardInterrupt) also end with breathing room, not glued to
#      the border.
#
# Both are TTY-gated via _USE_COLOR so piped output / CI logs stay flat.

_BOTTOM_MARGIN = 4


def _reserve_below(content_rows: int) -> None:
    """
    Make sure there are at least `_BOTTOM_MARGIN` blank visual rows below
    the cursor after `content_rows` rows of active content are drawn.
    """
    if not _USE_COLOR:
        return
    total = content_rows + _BOTTOM_MARGIN
    sys.stdout.write("\n" * total)
    sys.stdout.write(f"\033[{total}A")  # cursor up `total` lines
    sys.stdout.flush()


def _final_margin() -> None:
    if not _USE_COLOR:
        return
    _stop_spinner()  # defensive — no in-flight single-spinner
    _stop_spinner_group()  # defensive — no in-flight group
    sys.stdout.write("\n\n")
    sys.stdout.flush()


if _USE_COLOR:
    atexit.register(_final_margin)


# ── Clarification loop ─────────────────────────────────────────────────────────


def _ask_user(prompt_text: str) -> str:
    try:
        return input(prompt_text).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)


def _clarify(
    history: List[Dict[str, str]],
) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    """
    Drive the multi-turn product agent until it returns status='ready'.
    Accepts an existing history (so clarification can be resumed after a 'ready' response).
    Returns (intent, updated_history) — history includes the final assistant 'ready' turn.
    """
    while True:
        _info("thinking…")
        response = run_product_agent_analyze(history)
        status = response.get("status")

        if status == "ready":
            summary = response.get("summary", "")
            _bot(summary)
            history = history + [{"role": "assistant", "content": json.dumps(response)}]
            return response.get("intent") or {}, history

        if status == "needs_clarification":
            question = response.get("question", "")
            suggestions = response.get("suggestions") or []
            _bot(question)
            if suggestions:
                for i, s in enumerate(suggestions, 1):
                    print(f"  {_DIM}[{i}]{_RESET} {s}")
                print()
                _info("Pick a number or type your own answer.")
        else:
            _bot("Could you rephrase your request?")
            suggestions = []

        user_input = _ask_user(f"\n{_BOLD}You{_RESET}  ")
        if not user_input:
            continue

        if suggestions and user_input.isdigit():
            idx = int(user_input) - 1
            if 0 <= idx < len(suggestions):
                user_input = suggestions[idx]
                _info(f"→ {user_input}")

        history = history + [
            {"role": "assistant", "content": json.dumps(response)},
            {"role": "user", "content": user_input},
        ]


# ── Component picker ───────────────────────────────────────────────────────────
#
# Mirrors the ConfirmCard component in ChatMessages.tsx:
#   - Backend is always locked/on
#   - Widget and Admin UI can be toggled
#   - If merchant adds a component the AI didn't suggest, a description is required
#   - "Change request" returns None → caller loops back to clarification


def _pick_components(intent: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Terminal equivalent of the web ConfirmCard component picker.
    Returns updated intent dict, or None if user chose "Change request".
    """
    archetype = intent.get("appCategory", "backend")
    ai_has_widget = archetype in ("storefront_backend", "storefront_backend_admin")
    ai_has_admin = archetype in ("storefront_backend_admin", "backend_admin")

    has_widget = ai_has_widget
    has_admin = ai_has_admin
    widget_desc = ""
    admin_desc = ""

    def _render() -> None:
        _hr()
        print(f"\n  {_BOLD}COMPONENTS{_RESET}\n")

        # Backend — always on, locked
        print(
            f"  {_GREEN}[✓]{_RESET} Backend             {_DIM}(always included){_RESET}"
        )

        # Widget
        if has_widget:
            tag = (
                f"{_DIM}AI suggested{_RESET}"
                if ai_has_widget
                else f"{_YELLOW}you added{_RESET}"
            )
            print(f"  {_GREEN}[✓]{_RESET} Storefront Widget   {tag}")
            if has_widget and not ai_has_widget and widget_desc:
                print(f"      {_DIM}└ {widget_desc}{_RESET}")
        else:
            print(f"  {_DIM}[ ]{_RESET} Storefront Widget")

        # Admin UI
        if has_admin:
            tag = (
                f"{_DIM}AI suggested{_RESET}"
                if ai_has_admin
                else f"{_YELLOW}you added{_RESET}"
            )
            print(f"  {_GREEN}[✓]{_RESET} Admin UI            {tag}")
            if has_admin and not ai_has_admin and admin_desc:
                print(f"      {_DIM}└ {admin_desc}{_RESET}")
        else:
            print(f"  {_DIM}[ ]{_RESET} Admin UI")

        print()
        print(
            f"  {_DIM}Backend is always included. Toggle optional components.{_RESET}"
        )
        print(
            f"  {_DIM}w{_RESET} = Widget   "
            f"{_DIM}a{_RESET} = Admin   "
            f"{_DIM}↵{_RESET} = Generate   "
            f"{_DIM}c{_RESET} = Change request"
        )
        print()

    while True:
        _render()
        cmd = _ask_user(f"{_BOLD}Choice{_RESET}  ").strip().lower()

        if cmd == "w":
            has_widget = not has_widget
            if not has_widget:
                widget_desc = ""

        elif cmd == "a":
            has_admin = not has_admin
            if not has_admin:
                admin_desc = ""

        elif cmd in ("c", "change", "change request"):
            return None

        elif cmd in ("", "g", "generate"):
            # Mandatory description when merchant adds a component the AI didn't suggest
            if has_widget and not ai_has_widget and not widget_desc:
                _bot("You added Storefront Widget — what should it display?")
                _info("e.g. show loyalty points balance on the product page")
                desc = _ask_user(f"\n{_BOLD}You{_RESET}  ")
                if not desc.strip():
                    _info("Description required to add the Widget.")
                    continue
                widget_desc = desc.strip()

            if has_admin and not ai_has_admin and not admin_desc:
                _bot("You added Admin UI — what should it manage?")
                _info("e.g. dashboard to configure reward tiers and view analytics")
                desc = _ask_user(f"\n{_BOLD}You{_RESET}  ")
                if not desc.strip():
                    _info("Description required to add the Admin UI.")
                    continue
                admin_desc = desc.strip()

            break

    # Resolve updated appCategory
    cat = (
        "storefront_backend_admin"
        if has_widget and has_admin
        else (
            "storefront_backend"
            if has_widget
            else "backend_admin" if has_admin else "backend"
        )
    )
    updated: Dict[str, Any] = {**intent, "appCategory": cat}
    if has_widget and not ai_has_widget and widget_desc:
        updated["widgetDescription"] = widget_desc
    if has_admin and not ai_has_admin and admin_desc:
        updated["adminDescription"] = admin_desc
    return updated


# ── Phase runners ──────────────────────────────────────────────────────────────


def _phase_architect(
    intent: Dict[str, Any], prompt: str
) -> Tuple[Dict[str, Any], str, int, int]:
    """
    Run architect with validation retry.
    Returns (plan, arch_prompt, total_in_tokens, total_out_tokens).
    """
    archetype = intent.get("appCategory", "")

    quality_brief = intent.get("qualityBrief", "")
    quality_brief_section = (
        f"\nQuality brief (use this to inform edgeCases and uxExpectations):\n{quality_brief}\n"
        if quality_brief
        else ""
    )

    comp_parts = []
    if intent.get("widgetDescription"):
        comp_parts.append(f"  Widget (merchant-added): {intent['widgetDescription']}")
    if intent.get("adminDescription"):
        comp_parts.append(
            f"  Admin panel (merchant-added): {intent['adminDescription']}"
        )
    component_descriptions_section = (
        "\nMerchant-provided component descriptions (components added beyond the AI suggestion — "
        "incorporate these requirements into the contracts):\n"
        + "\n".join(comp_parts)
        + "\n"
        if comp_parts
        else ""
    )

    product_prompt = _ARCHITECT_USER_TEMPLATE.format(
        error_block="",
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
        archetype=archetype,
        quality_brief_section=quality_brief_section,
        component_descriptions_section=component_descriptions_section,
    )

    plan: Dict[str, Any] = {}
    errors: List[str] = []
    total_in = total_out = 0

    for attempt in range(1, _MAX_ARCH_ATTEMPTS + 1):
        _spinner("Architect")
        t0 = time.monotonic()
        plan, arch_in, arch_out = run_architect_agent(
            prompt=prompt,
            intent=intent,
            app_archetype=archetype,
            validation_errors=errors if attempt > 1 else None,
        )
        ms = int((time.monotonic() - t0) * 1000)
        total_in += arch_in
        total_out += arch_out
        errors = validate_architect_plan(plan, app_archetype=archetype)

        if not errors:
            attempt_note = f"attempt {attempt}  " if attempt > 1 else ""
            _agent_line(
                "Architect",
                ok=True,
                ms=ms,
                notes=attempt_note + _tok_note(total_in, total_out),
            )
            contracts = plan.get("appContracts") or {}
            if contracts.get("feasibility") == "blocked":
                blocked_reason = contracts.get(
                    "blockedReason",
                    "This app requires capabilities that aren't available on the platform yet.",
                )
                print(f"\n  {_RED}Platform limitation:{_RESET} {blocked_reason}")
                sys.exit(1)
            return plan, product_prompt, total_in, total_out

        _agent_line(
            "Architect",
            ok=False,
            ms=ms,
            notes=f"attempt {attempt} — {len(errors)} error(s)  "
            + _tok_note(arch_in, arch_out),
        )
        if attempt < _MAX_ARCH_ATTEMPTS:
            _retry_line("Architect", notes="; ".join(errors[:2]))

    print(f"\n  {_RED}Architect failed after {_MAX_ARCH_ATTEMPTS} attempts:{_RESET}")
    for e in errors:
        print(f"    • {e}")
    sys.exit(1)


def _phase_codegen(
    base_ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
    run_dir: Path,
    *,
    prior_artifacts: Optional[Dict[str, str]] = None,
    prior_error_map: Optional[Dict[str, List[str]]] = None,
    prior_retry_log: Optional[List[Dict]] = None,
    prior_token_totals: Optional[Dict[str, Tuple[int, int]]] = None,
) -> Tuple[Dict[str, str], List[Dict], Dict[str, Tuple[int, int]]]:
    """
    Run parallel codegen with static validation retries.

    Returns (artifacts, retry_log, token_totals) where:
      retry_log    — list of {attempt, errors} dicts for every failed round
      token_totals — {agent_name: (total_in, total_out)} accumulated across all attempts

    Resume path: when `prior_artifacts` / `prior_error_map` are passed, the
    first iteration starts from that state instead of the empty dicts. The
    crew's `_plan_codegen_batch` already short-circuits any generator whose
    artifact is present and has no errors, so passing the saved bundle from
    a previous run is the entire mechanism for "skip handler/widget/admin if
    they already passed". `prior_retry_log` and `prior_token_totals` carry
    the audit trail forward so a resumed run's report.md / per-agent token
    summary reflects the cumulative cost, not just this resumed segment.
    """
    artifacts: Dict[str, str] = dict(prior_artifacts or {})
    error_map: Dict[str, List[str]] = {k: list(v) for k, v in (prior_error_map or {}).items()}
    cumulative_errors: Dict[str, List[str]] = {}
    retry_log: List[Dict] = list(prior_retry_log or [])
    token_totals: Dict[str, Tuple[int, int]] = dict(prior_token_totals or {})

    _CODEGEN_LABELS = {
        "handler": "Handler",
        "migration": "Migration",
        "widget_js": "Widget JS",
        "admin_ui": "Admin UI",
    }

    # Resume case: when prior_artifacts arrives with an error_map (codegen
    # was halted mid-pipeline), the first attempt should display only the
    # failed/missing generators in the spinner — same as a normal retry —
    # rather than spinning rows for handler/migration/widget/admin and
    # never advancing the ones that won't run. The crew already filters
    # correctly via _plan_codegen_batch; this is purely the label list.
    _is_resumed_first = prior_artifacts and (prior_error_map or any(
        n not in artifacts for n in (
            ["handler", "migration"]
            + (["widget_js"] if is_storefront else [])
            + (["admin_ui"] if is_admin_ui else [])
        )
    ))

    for attempt in range(1, _MAX_CODEGEN_RETRIES + 1):
        if attempt > 1 or _is_resumed_first:
            generators_this_round = list(error_map.keys()) or [
                n for n in (
                    ["handler", "migration"]
                    + (["widget_js"] if is_storefront else [])
                    + (["admin_ui"] if is_admin_ui else [])
                ) if n not in artifacts
            ]
        else:
            generators_this_round = (
                ["handler", "migration"]
                + (["widget_js"] if is_storefront else [])
                + (["admin_ui"] if is_admin_ui else [])
            )
        # After the first iteration we don't want this resume-mode label
        # filter to keep firing — clear it so subsequent retries follow
        # the normal `attempt > 1 → error_map.keys()` path.
        _is_resumed_first = False

        labels = [_CODEGEN_LABELS.get(n, n) for n in generators_this_round]
        # Start one animated row per parallel generator so the merchant sees
        # all three racing, not just the last _spinner call.
        _spinner_group(labels)

        # Map crew-side internal names → CLI labels for the callback.
        label_of = {n: _CODEGEN_LABELS.get(n, n) for n in generators_this_round}

        # Callbacks fire on worker threads the instant each generator
        # finishes — the group's redraw loop picks up the slot transition
        # on its next tick.
        def _on_done(
            name: str,
            ms_agent: int,
            in_tok: int,
            out_tok: int,
            _attempt: int = attempt,
        ) -> None:
            retry_sfx = f"  retry {_attempt}" if _attempt > 1 else ""
            tok_str = (
                _tok_note(in_tok, out_tok, extra=retry_sfx)
                if (in_tok or out_tok)
                else retry_sfx.strip()
            )
            _agent_line(label_of.get(name, name), ok=True, ms=ms_agent, notes=tok_str)

        artifacts, attempt_tokens = run_codegen_parallel(
            base_ctx,
            is_storefront=is_storefront,
            is_admin_ui=is_admin_ui,
            error_map=error_map,
            cumulative_errors=cumulative_errors,
            artifacts=artifacts,
            on_done=_on_done,
        )

        # Accumulate token totals across retries
        for name, (in_t, out_t) in attempt_tokens.items():
            prev_in, prev_out = token_totals.get(name, (0, 0))
            token_totals[name] = (prev_in + in_t, prev_out + out_t)

        _spinner("Validation")
        t0 = time.monotonic()
        error_map = validate_artifacts(artifacts, base_ctx, is_storefront, is_admin_ui)
        ms_val = int((time.monotonic() - t0) * 1000)

        if not error_map:
            _agent_line("Validation", ok=True, ms=ms_val, notes="all artifacts pass")
            _save_state(
                run_dir,
                checkpoint="codegen",
                halt_reason=None,
                artifacts=artifacts,
                retry_log=retry_log,
                codegen_token_totals={k: list(v) for k, v in token_totals.items()},
                codegen_error_map=None,
                handler_email_metadata=base_ctx.handler_email_metadata,
                handler_raw_response=base_ctx.handler_raw_response,
            )
            return artifacts, retry_log, token_totals

        for name, errs in error_map.items():
            existing = cumulative_errors.setdefault(name, [])
            for err in errs:
                if err not in existing:
                    existing.append(err)

        retry_log.append(
            {
                "attempt": attempt,
                "errors": {gen: list(errs) for gen, errs in error_map.items()},
            }
        )

        failed_summary = ", ".join(error_map.keys())
        _agent_line(
            "Validation",
            ok=False,
            ms=ms_val,
            notes=f"{len(error_map)} artifact(s) failed: {failed_summary}",
        )
        for gen_name, errs in error_map.items():
            for e in errs:
                print(f"    {_DIM}• {gen_name}: {e}{_RESET}")

        if attempt < _MAX_CODEGEN_RETRIES:
            _retry_line("Validation", notes=f"fixing {failed_summary}")

    # All retries exhausted. Persist whatever the last attempt produced —
    # the artifacts live only in this stack frame and would otherwise be
    # lost when sys.exit(1) runs, leaving the merchant with errors but
    # nothing to inspect. Dump in the same shape as a successful run so
    # the same workflow (open files in IDE, diff against prior run, etc.)
    # works for failures too.
    failure_path = _save_codegen_failure_local(
        run_dir,
        artifacts,
        is_storefront,
        is_admin_ui,
        retry_log,
        error_map,
        token_totals,
        plan=base_ctx.plan,
    )

    # Persist partial state so the run is resumable. checkpoint stays at
    # "arch" (the last phase that fully succeeded); halt_reason flags this
    # as a codegen failure so --resume re-runs codegen and the crew's
    # batch planner re-runs only the failed/missing generators.
    _save_state(
        run_dir,
        checkpoint="arch",
        halt_reason="codegen_failed",
        artifacts=artifacts,
        retry_log=retry_log,
        codegen_token_totals={k: list(v) for k, v in token_totals.items()},
        codegen_error_map={k: list(v) for k, v in error_map.items()},
        handler_email_metadata=base_ctx.handler_email_metadata,
        handler_raw_response=base_ctx.handler_raw_response,
    )

    all_errors = [f"{n}: {e}" for n, errs in error_map.items() for e in errs]
    print(
        f"\n  {_RED}Codegen validation failed after {_MAX_CODEGEN_RETRIES} attempts:{_RESET}"
    )
    for e in all_errors[:5]:
        print(f"    • {e}")
    print(
        f"\n  {_DIM}Final-attempt artifacts saved to: "
        f"{run_dir.relative_to(_HERE)}/{_RESET}"
    )
    print(f"  {_DIM}Validation summary: {failure_path.relative_to(_HERE)}{_RESET}")
    print(
        f"  {_DIM}Resume with:  python chat_local.py --resume "
        f"{run_dir.name}{_RESET}"
    )
    sys.exit(1)


_REVISION_TRACES_SUBDIR = "revision_traces"


def _make_run_dir(run_ts: str, run_slug: str) -> Path:
    """Create and return the per-run output directory."""
    run_dir = TEST_RESULTS_DIR / f"{run_ts}_{run_slug}"
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


# ── Resume support ────────────────────────────────────────────────────────────
#
# Each run dir gets a single state.json that's written incrementally after
# every phase. It's the sole source of truth for `--list-resume` / `--resume`
# — we don't reconstruct from the scattered per-phase files. The pipeline
# already persists the per-phase outputs (arch.json, generated files,
# revision_traces/) for human inspection; state.json layers a machine-readable
# index on top so resume can dispatch without re-parsing those.
#
# Robustness: every loader tolerates missing files, JSON parse errors, and
# partial / unexpected fields. The lister silently drops bad entries; the
# resume dispatcher fails loudly with a specific message naming the missing
# field so the merchant knows what's wrong with that run.

_STATE_FILE_NAME = "state.json"
_STATE_VERSION = 1

# Phase order. Each name is the checkpoint stamped when the phase finishes
# its successful path. _phase_index() lets us compare checkpoints by ordinal.
_PHASE_ORDER: List[str] = ["intent", "arch", "codegen", "validator", "revision", "done"]


def _phase_index(name: Optional[str]) -> int:
    """Ordinal of a checkpoint name; -1 if unset/unknown so any phase is 'after' it."""
    if not name:
        return -1
    try:
        return _PHASE_ORDER.index(name)
    except ValueError:
        return -1


def _state_path(run_dir: Path) -> Path:
    return run_dir / _STATE_FILE_NAME


def _load_state(run_dir: Path) -> Optional[Dict[str, Any]]:
    """
    Return the parsed state dict, or None if the file is missing / unreadable
    / not valid JSON / not a dict / wrong schema version. Never raises — the
    caller decides how to handle a missing state (the lister drops it; resume
    fails loudly).
    """
    path = _state_path(run_dir)
    if not path.is_file():
        return None
    try:
        raw = path.read_text()
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    # Forward-compat: ignore states from a future schema we don't understand.
    # Older states without `version` are treated as v1 (pre-versioning).
    version = data.get("version", _STATE_VERSION)
    if not isinstance(version, int) or version > _STATE_VERSION:
        return None
    return data


def _save_state(run_dir: Path, **patch: Any) -> None:
    """
    Merge `patch` into the existing state.json (or create it) and write atomically.

    Atomic write prevents a half-written state.json on Ctrl+C between phases:
    a corrupted state file would render the run un-resumable, which is exactly
    the failure mode resume is supposed to fix. We still tolerate corrupted
    state on read (returns None), but we do our best not to create one.
    """
    existing = _load_state(run_dir) or {}
    existing.update(patch)
    existing["version"] = _STATE_VERSION
    existing["updated_at"] = datetime.now().isoformat(timespec="seconds")
    existing.setdefault("created_at", existing["updated_at"])
    path = _state_path(run_dir)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps(existing, indent=2, default=str))
        os.replace(tmp, path)
    except OSError as exc:
        # State write failure is non-fatal — the user can still inspect the
        # generated files; they just can't resume this run cheaply.
        _log.warning("could not write %s: %s", path, exc)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _list_resumable() -> List[Dict[str, Any]]:
    """
    Walk TEST_RESULTS_DIR, return resumable runs sorted newest-first.

    Skips:
      - non-directories (a stray file in test_results/)
      - dirs without state.json (legacy runs from before resume support)
      - dirs whose state.json fails to load (corrupted / wrong version)
      - runs already at checkpoint=done (nothing to resume)

    Each entry is a small summary dict — full state is loaded on demand by
    the resume dispatcher, not here, so a single corrupt entry can't
    poison the listing.
    """
    if not TEST_RESULTS_DIR.is_dir():
        return []
    rows: List[Dict[str, Any]] = []
    # `_RESUMABLE_HALTS` are halt_reasons that mean "the run finished its
    # pipeline but with unresolved problems the merchant may want to retry".
    # Even if checkpoint=done, these stay listed so the merchant can re-run
    # just the revision step against the saved validator issues.
    # codegen_failed is intentionally NOT here — that halt is only ever
    # paired with checkpoint=arch (codegen never reaches done after a
    # failure), so adding it would just hide bugs if the pairing ever broke.
    _RESUMABLE_HALTS = {"kept_originals", "revision_failed"}
    for entry in sorted(TEST_RESULTS_DIR.iterdir(), reverse=True):
        if not entry.is_dir():
            continue
        state = _load_state(entry)
        if state is None:
            continue
        checkpoint = state.get("checkpoint")
        halt = state.get("halt_reason")
        # A state with neither a known checkpoint nor a prompt is junk —
        # likely a half-written file or a manually-created skeleton. Drop
        # it from the list rather than offering an unresumable entry.
        if (
            _phase_index(checkpoint) < 0
            and not state.get("prompt")
            and not state.get("intent")
        ):
            continue
        if checkpoint == "done" and halt not in _RESUMABLE_HALTS:
            continue
        prompt = state.get("prompt") or ""
        rows.append(
            {
                "run_id": entry.name,
                "checkpoint": checkpoint or "?",
                "halt_reason": halt,
                "prompt": prompt,
                "updated_at": state.get("updated_at") or "",
            }
        )
    return rows


def _print_resume_list() -> None:
    """Print the resumable-runs table. Tolerant of empty / bad entries."""
    rows = _list_resumable()
    if not rows:
        print()
        _info("No resumable runs found in test_results/.")
        _info(
            "(Runs are tracked once they save a state.json — older runs "
            "from before resume support are skipped.)"
        )
        print()
        return

    print()
    print(f"  {_BOLD}Resumable runs{_RESET}  {_DIM}(newest first){_RESET}\n")
    # Column widths
    id_w = max(len("RUN ID"), max(len(r["run_id"]) for r in rows))
    cp_w = max(len("CHECKPOINT"), max(len(str(r["checkpoint"])) for r in rows))
    reason_w = max(
        len("HALT"), max(len(str(r["halt_reason"] or "")) for r in rows)
    )
    print(
        f"  {_DIM}{'RUN ID'.ljust(id_w)}  "
        f"{'CHECKPOINT'.ljust(cp_w)}  "
        f"{'HALT'.ljust(reason_w)}  PROMPT{_RESET}"
    )
    for r in rows:
        prompt = r["prompt"]
        if len(prompt) > 60:
            prompt = prompt[:57] + "…"
        halt = r["halt_reason"] or ""
        halt_color = _YELLOW if halt else _DIM
        print(
            f"  {r['run_id'].ljust(id_w)}  "
            f"{_c(str(r['checkpoint']).ljust(cp_w), _CYAN)}  "
            f"{_c(halt.ljust(reason_w), halt_color)}  "
            f"{_DIM}{prompt}{_RESET}"
        )
    print()
    _info("Resume with:  python chat_local.py --resume <RUN ID>")
    print()


def _resolve_resume_target(run_id: str) -> Tuple[Path, Dict[str, Any]]:
    """
    Validate `run_id` and return (run_dir, state). Exits with a clear message
    on any failure mode (missing dir, missing state.json, corrupted JSON,
    completed run, missing required fields).
    """
    run_dir = TEST_RESULTS_DIR / run_id
    if not run_dir.is_dir():
        print(f"\n  {_RED}No such run:{_RESET} {run_id}")
        _info(f"Looked in {TEST_RESULTS_DIR.relative_to(_HERE)}/")
        _info("Use --list-resume to see what's available.")
        sys.exit(2)

    state = _load_state(run_dir)
    if state is None:
        print(f"\n  {_RED}Run is not resumable:{_RESET} {run_id}")
        _info(
            "state.json is missing, unreadable, or from a newer schema. "
            "This run predates resume support or was corrupted."
        )
        sys.exit(2)

    checkpoint = state.get("checkpoint")
    halt = state.get("halt_reason")
    # done + clean = nothing to do. done + unresolved-halt (kept_originals /
    # revision_failed) is still resumable: the merchant wants to re-run
    # revision against the saved validator issues.
    if checkpoint == "done" and halt not in ("kept_originals", "revision_failed"):
        print(f"\n  {_GREEN}Run already complete — nothing to resume:{_RESET} {run_id}")
        print(f"  {_DIM}Outputs: {run_dir.relative_to(_HERE)}/{_RESET}\n")
        sys.exit(0)

    # Every resumable run must at minimum have intent + prompt — that's the
    # output of the chat phase, which we save first. Without it, we can't
    # rebuild the codegen context.
    if not state.get("intent") or not state.get("prompt"):
        print(f"\n  {_RED}Run is not resumable:{_RESET} {run_id}")
        _info(
            "state.json is missing 'intent' or 'prompt' — the chat phase "
            "didn't complete, so there's nothing meaningful to resume from."
        )
        sys.exit(2)

    return run_dir, state


def _save_generated_files(
    run_dir: Path,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    plan: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Write generated artifacts as individual files within run_dir.

    For widget.js / admin_ui.js, prepend the same `window.__PLATFORM_CATALOG__`
    manifest the platform-back bundle-storage saver uses on deploy, so the
    locally-saved file is byte-identical to the served bundle. Without the
    prelude, locally-tested code would behave differently from deployed code
    (the SDK would default to all-POST). When `plan` is omitted (legacy
    callers), fall back to no prelude — the SDK will treat absent manifest
    as all-POST, matching the pre-method-aware-SDK behaviour.
    """
    from utils.file_bundle import parse_file_bundle, ParseError

    handler_raw = artifacts.get("handler", "")
    if handler_raw:
        try:
            for f in parse_file_bundle(handler_raw):
                dest = run_dir / f["path"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(f["contents"])
        except ParseError:
            (run_dir / "handler_bundle.ts").write_text(handler_raw)

    migration = artifacts.get("migration", "")
    if migration:
        migrations_dir = run_dir / "migrations"
        migrations_dir.mkdir(exist_ok=True)
        (migrations_dir / "generated.sql").write_text(migration)

    contracts = ((plan or {}).get("appContracts") or {}) if plan else {}

    def _prelude(catalog_rows: List[Dict[str, Any]]) -> str:
        slim = [
            {"path": r["path"], "method": (r.get("method") or "POST").upper()}
            for r in catalog_rows or []
            if isinstance(r, dict) and isinstance(r.get("path"), str)
        ]
        # Mirror the platform-back bundle-storage saver's `</script>`
        # escape so locally-saved bundles are byte-identical to the
        # deployed bundle. Defense in depth — bundles are loaded via
        # `<script src=...>` not inlined, but the dev/prod parity matters.
        # Capture-group preserves the matched case (`</SCRIPT` →
        # `<\/SCRIPT`). Mirrors the TypeScript regex shape so the locally-
        # saved bundle is byte-identical to the platform-back one.
        encoded = re.sub(
            r"</(script)", r"<\\/\1", json.dumps(slim), flags=re.IGNORECASE
        )
        return f"window.__PLATFORM_CATALOG__ = {encoded};\n"

    if is_storefront and artifacts.get("widget_js"):
        prelude = _prelude(contracts.get("widgetApiCatalog") or []) if plan else ""
        (run_dir / "widget.js").write_text(prelude + artifacts["widget_js"])

    if is_admin_ui and artifacts.get("admin_ui"):
        prelude = _prelude(contracts.get("adminApiCatalog") or []) if plan else ""
        (run_dir / "admin_ui.js").write_text(prelude + artifacts["admin_ui"])


def _save_revision_failure_local(
    run_dir: Path,
    bad_artifacts: Dict[str, str],
    errors: Dict[str, List[str]],
) -> Path:
    failure_dir = run_dir / "revision_failures"
    failure_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = failure_dir / f"{ts}_revision_failure.json"
    payload = {"timestamp": ts, "errors": errors, "artifacts": bad_artifacts}
    path.write_text(json.dumps(payload, indent=2))
    return path


def _save_codegen_failure_local(
    run_dir: Path,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    retry_log: List[Dict],
    final_errors: Dict[str, List[str]],
    token_totals: Dict[str, Tuple[int, int]],
    plan: Optional[Dict[str, Any]] = None,
) -> Path:
    """
    Persist the LAST-attempt artifacts and the full retry trail when codegen
    static validation fails after `_MAX_CODEGEN_RETRIES` attempts.

    Without this, the failed-attempt code lives only in memory and is lost
    when the process exits — leaving the merchant with errors but nothing
    to inspect. The dumped files use the SAME layout as a successful run
    (handler split via `===FILE:===` markers, migration in migrations/,
    single-file widget/admin at the run-dir root) so the same inspection
    workflow applies to a failed run. `plan` is forwarded so the saved
    widget.js / admin_ui.js get the same `__PLATFORM_CATALOG__` prelude
    the deployed bundles get.

    Returns the path to the validation_failure.json summary so the caller
    can print it to the merchant.
    """
    # Dump artifacts as proper files — same shape as a successful run.
    # Wrap in try/except so a disk-full / permission error during failure-
    # handling doesn't replace the merchant's "validation failed" output
    # with a Python traceback. We still want the partial state if some
    # writes succeeded.
    try:
        _save_generated_files(run_dir, artifacts, is_storefront, is_admin_ui, plan)
    except OSError as exc:
        _log.warning(
            "could not persist failed-attempt artifacts to %s: %s", run_dir, exc
        )

    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = run_dir / "validation_failure.json"
    payload = {
        "timestamp": ts,
        "phase": "codegen",
        "max_retries": _MAX_CODEGEN_RETRIES,
        "final_errors": final_errors,
        "retry_log": retry_log,
        "token_totals": {k: {"in": v[0], "out": v[1]} for k, v in token_totals.items()},
        "artifact_keys": sorted(artifacts.keys()),
    }
    try:
        path.write_text(json.dumps(payload, indent=2))
    except OSError as exc:
        _log.warning("could not write %s: %s", path, exc)
    return path


def _save_revision_trace(
    run_dir: Path, run_ts: str, slug: str, trace: Dict[str, Any]
) -> Path:
    trace_dir = run_dir / _REVISION_TRACES_SUBDIR
    trace_dir.mkdir(parents=True, exist_ok=True)
    path = trace_dir / f"{run_ts}_{slug}.json"
    path.write_text(json.dumps(trace, indent=2))
    return path


def _phase_validator(
    base_ctx: CodegenContext,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    run_dir: Path,
    run_ts: str,
    run_slug: str,
    *,
    resumed_validator: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, str], int, int, Optional[Dict[str, Any]]]:
    """
    Run LLM validator + optional revision pass.

    The revision agent fixes only widget_js / admin_ui (handler and migration are
    locked as read-only context). Revision output is statically validated; if both
    attempts fail the run exits with an error and saves the bad artifacts.

    Returns (artifacts, total_in_tokens, total_out_tokens, trace). `trace` is None
    when no revision was attempted (validator skipped or passed on first pass); a
    dict otherwise, always persisted to test_results/revision_traces/ keyed by
    run_ts + slug so the report .md can link to it.

    Resume path: when `resumed_validator` is passed, the LLM validator call is
    skipped entirely — we trust the saved issues from the previous run and go
    straight to revision. This is the cost-saver: validator tokens already paid,
    don't pay them again. Required keys: `issues`, `in_tokens`, `out_tokens`,
    `duration_ms`. Token counts are reported back so the run summary still shows
    the original cost; they are NOT re-added to `total_in/out` here because the
    caller credits them separately for resumed runs.
    """
    from config import get_settings

    if resumed_validator is not None:
        # Skip the validator LLM call — reuse saved issues. Falls through to
        # the revision branch below using `issues` from saved state.
        issues = resumed_validator.get("issues") or []
        val_in = int(resumed_validator.get("in_tokens", 0))
        val_out = int(resumed_validator.get("out_tokens", 0))
        ms = int(resumed_validator.get("duration_ms", 0))
        _info(
            f"Validator: reusing {len(issues)} saved issue(s) from prior run "
            f"(no LLM call)"
        )
    elif not get_settings().llm_validation_enabled:
        _info("Validator skipped (LLM_VALIDATION_ENABLED not set)")
        _save_state(
            run_dir,
            checkpoint="validator",
            halt_reason=None,
            validator_issues=[],
            validator_tokens={"in": 0, "out": 0, "duration_ms": 0},
            pre_revision_artifacts=dict(artifacts),
        )
        return artifacts, 0, 0, None
    else:
        _spinner("Validator")
        t0 = time.monotonic()
        with input_log("validator", run_dir):
            issues, val_in, val_out, per_validator = run_llm_validators(
                artifacts, base_ctx, is_storefront, is_admin_ui
            )
        ms = int((time.monotonic() - t0) * 1000)
        # Surface per-validator latency / errors so a silent fail-open is
        # visible in the local CLI run, not just the production logs. Only
        # available when we actually invoked the validator — resumed runs
        # skip this since the per-validator breakdown wasn't persisted.
        for name, result in per_validator.items():
            suffix = f" error={result.error}" if result.error else ""
            _info(
                f"  ↳ {name}: {result.latency_ms}ms "
                f"in={result.input_tokens} out={result.output_tokens} "
                f"findings={len(result.findings)}{suffix}"
            )

    if not issues:
        _agent_line(
            "Validator",
            ok=True,
            ms=ms,
            notes=_tok_note(val_in, val_out, extra="semantic check passed"),
        )
        _save_state(
            run_dir,
            checkpoint="validator",
            halt_reason=None,
            validator_issues=[],
            validator_tokens={"in": val_in, "out": val_out, "duration_ms": ms},
            pre_revision_artifacts=dict(artifacts),
        )
        return artifacts, val_in, val_out, None

    issue_summary = ", ".join(i["question"] for i in issues)
    _agent_line(
        "Validator",
        ok=True,
        ms=ms,
        notes=_tok_note(
            val_in, val_out, extra=f"{len(issues)} issue(s): {issue_summary}"
        ),
    )
    # Print each issue fully, wrapped at terminal width with indented
    # continuation lines. The previous [:80] cap silently truncated
    # issue messages mid-sentence, hiding the actual diagnosis.
    term_w = max(60, shutil.get_terminal_size((100, 20)).columns)
    initial_indent = "    • "
    subsequent_indent = "      "
    for iss in issues:
        header = f"{iss.get('question', '?')}: {iss.get('issue', '')}"
        wrapped = textwrap.fill(
            header,
            width=term_w,
            initial_indent=initial_indent,
            subsequent_indent=subsequent_indent,
            break_long_words=False,
            break_on_hyphens=False,
        )
        print(f"{_DIM}{wrapped}{_RESET}")

    # Build context from the fresh codegen output so the revision agent works from
    # the actual code it needs to fix, not from a (possibly absent) prior bundle.
    revision_ctx = dataclasses.replace(
        base_ctx,
        prior_handler_code=artifacts.get("handler") or base_ctx.prior_handler_code,
        prior_migration_sql=artifacts.get("migration") or base_ctx.prior_migration_sql,
        prior_widget_code=artifacts.get("widget_js") or base_ctx.prior_widget_code,
        prior_admin_ui_code=artifacts.get("admin_ui") or base_ctx.prior_admin_ui_code,
    )
    _LOCKED = _revision_locked_artifacts(issues)

    # Accumulate a trace that gets persisted no matter which branch we exit on.
    trace: Dict[str, Any] = {
        "run_ts": run_ts,
        "slug": run_slug,
        "validator": {
            "duration_ms": ms,
            "in_tokens": val_in,
            "out_tokens": val_out,
            "issues": issues,
        },
        "locked_artifacts": sorted(_LOCKED),
        "pre_artifacts": dict(artifacts),
        "attempts": [],
        "final_outcome": None,
    }

    # Persist the validator findings + pre-revision artifacts up front. If
    # the process is killed mid-revision (or revision punts), --resume picks
    # this up and re-runs only revision against the saved issues, NOT the
    # validator — that's the point of trusting saved issues.
    _save_state(
        run_dir,
        validator_issues=issues,
        validator_tokens={"in": val_in, "out": val_out, "duration_ms": ms},
        pre_revision_artifacts=dict(artifacts),
    )

    def _finalize(outcome: str, *, final_artifacts: Optional[Dict[str, str]] = None) -> None:
        trace["final_outcome"] = outcome
        _save_revision_trace(run_dir, run_ts, run_slug, trace)
        # halt_reason is set only for outcomes the user can resume from.
        # 'resolved' / 'resolved_on_retry' are clean successes — checkpoint
        # advances to 'revision' and resume goes straight to explanation.
        if outcome in ("resolved", "resolved_on_retry"):
            cp, halt = "revision", None
        elif outcome == "kept_originals":
            cp, halt = "validator", "kept_originals"
        else:  # "failed"
            cp, halt = "validator", "revision_failed"
        patch: Dict[str, Any] = {
            "checkpoint": cp,
            "halt_reason": halt,
            "revision_outcome": outcome,
        }
        if final_artifacts is not None:
            patch["artifacts"] = final_artifacts
        _save_state(run_dir, **patch)

    _spinner("Revision")
    t0 = time.monotonic()
    with input_log("revision", run_dir):
        revised, rev_in, rev_out = run_revision_agent(
            revision_ctx,
            is_storefront=is_storefront,
            is_admin_ui=is_admin_ui,
            validation_issues=issues,
            locked_artifacts=_LOCKED,
        )
    ms = int((time.monotonic() - t0) * 1000)

    total_in = val_in + rev_in
    total_out = val_out + rev_out

    frontend_revised = {k: v for k, v in revised.items() if k not in _LOCKED}
    trace["attempts"].append(
        {
            "attempt": 1,
            "duration_ms": ms,
            "in_tokens": rev_in,
            "out_tokens": rev_out,
            "returned_artifacts": sorted(frontend_revised.keys()),
            "post": frontend_revised,
            "static_errors": {},
            "outcome": None,
        }
    )

    if not frontend_revised:
        _agent_line(
            "Revision",
            ok=False,
            ms=ms,
            notes=_tok_note(
                rev_in,
                rev_out,
                extra="no frontend artifacts returned — keeping originals",
            ),
        )
        trace["attempts"][-1]["outcome"] = "no_output"
        _finalize("kept_originals", final_artifacts=dict(artifacts))
        return artifacts, total_in, total_out, trace

    # Statically validate the revised frontend artifacts before accepting them.
    merged = {**artifacts, **frontend_revised}
    all_errors = validate_artifacts(merged, revision_ctx, is_storefront, is_admin_ui)
    static_errors: Dict[str, List[str]] = {
        k: v for k, v in all_errors.items() if k in frontend_revised
    }

    if not static_errors:
        _agent_line(
            "Revision",
            ok=True,
            ms=ms,
            notes=_tok_note(rev_in, rev_out, extra="semantic issues resolved"),
        )
        trace["attempts"][-1]["outcome"] = "accepted"
        _finalize("resolved", final_artifacts=dict(merged))
        return merged, total_in, total_out, trace

    # First revision failed static validation — retry once with errors fed back.
    trace["attempts"][-1]["static_errors"] = static_errors
    trace["attempts"][-1]["outcome"] = "retrying"
    _agent_line(
        "Revision",
        ok=False,
        ms=ms,
        notes=_tok_note(
            rev_in,
            rev_out,
            extra=f"static validation failed ({len(static_errors)} artifact(s)) — retrying",
        ),
    )
    for gen_name, errs in static_errors.items():
        for e in errs:
            print(f"    {_DIM}• [{gen_name}] {e[:80]}{_RESET}")

    _spinner("Revision (static retry)")
    t0 = time.monotonic()
    # Reusing agent="revision" — _dump_inputs counts existing attempt_* dirs
    # so this lands in inputs/revision/attempt_2/ alongside attempt_1/.
    with input_log("revision", run_dir):
        revised2, rev2_in, rev2_out = run_revision_agent(
            revision_ctx,
            is_storefront=is_storefront,
            is_admin_ui=is_admin_ui,
            validation_issues=issues,
            locked_artifacts=_LOCKED,
            static_errors=static_errors,
        )
    ms2 = int((time.monotonic() - t0) * 1000)

    total_in += rev2_in
    total_out += rev2_out

    frontend_revised2 = {k: v for k, v in revised2.items() if k not in _LOCKED}
    merged2 = {**artifacts, **frontend_revised2}
    all_errors2 = validate_artifacts(merged2, revision_ctx, is_storefront, is_admin_ui)
    static_errors2: Dict[str, List[str]] = {
        k: v for k, v in all_errors2.items() if k in frontend_revised2
    }

    trace["attempts"].append(
        {
            "attempt": 2,
            "duration_ms": ms2,
            "in_tokens": rev2_in,
            "out_tokens": rev2_out,
            "returned_artifacts": sorted(frontend_revised2.keys()),
            "post": frontend_revised2,
            "static_errors": static_errors2,
            "outcome": None,
        }
    )

    if not static_errors2:
        _agent_line(
            "Revision",
            ok=True,
            ms=ms2,
            notes=_tok_note(
                rev2_in, rev2_out, extra="semantic issues resolved (static retry)"
            ),
        )
        trace["attempts"][-1]["outcome"] = "accepted"
        _finalize("resolved_on_retry", final_artifacts=dict(merged2))
        return merged2, total_in, total_out, trace

    # Both revision attempts produced structurally invalid code — fail the run.
    trace["attempts"][-1]["outcome"] = "failed"
    # Don't pass final_artifacts here — we want the next --resume to start
    # from the pre-revision artifacts (saved separately as
    # `pre_revision_artifacts`), NOT the broken merged2 bundle. Re-running
    # revision against the broken output would compound the damage.
    _finalize("failed")
    bad = {**frontend_revised, **frontend_revised2}
    path = _save_revision_failure_local(run_dir, bad, static_errors2)
    # Also dump the final merged bundle as proper files at the run-dir root
    # — same shape as a successful run, so the merchant can open the broken
    # widget.js / admin_ui.js in their editor instead of fishing them out
    # of a JSON blob.
    _save_generated_files(
        run_dir, merged2, is_storefront, is_admin_ui, plan=revision_ctx.plan
    )
    _agent_line(
        "Revision",
        ok=False,
        ms=ms2,
        notes=_tok_note(
            rev2_in, rev2_out, extra="static validation failed after 2 attempts"
        ),
    )
    print(
        f"\n  {_RED}Revision agent produced structurally invalid code after 2 attempts.{_RESET}"
    )
    for gen_name, errs in static_errors2.items():
        for e in errs:
            print(f"    • [{gen_name}] {e}")
    print(f"  {_DIM}Failure summary: {path.relative_to(_HERE)}{_RESET}")
    print(
        f"  {_DIM}Final-attempt artifacts saved to: "
        f"{run_dir.relative_to(_HERE)}/{_RESET}"
    )
    print(
        f"  {_DIM}Resume with:  python chat_local.py --resume "
        f"{run_dir.name}{_RESET}"
    )
    sys.exit(1)


# ── Output helpers ─────────────────────────────────────────────────────────────


def _slug(text: str, max_words: int = 6) -> str:
    words = re.sub(r"[^a-z0-9 ]", "", text.lower()).split()
    return "-".join(words[:max_words])


def _save_arch_json(
    run_dir: Path,
    prompt: str,
    intent: Dict,
    plan: Dict,
    errors: List[str],
    product_prompt: str = "",
) -> Path:
    payload: Dict[str, Any] = {
        "prompt": prompt,
        "intent": intent,
        "plan": plan,
        "validation_errors": errors,
    }
    if product_prompt:
        payload["product_prompt"] = product_prompt
    path = run_dir / "arch.json"
    path.write_text(json.dumps(payload, indent=2))
    return run_dir


def _validator_revision_md_lines(trace: Dict[str, Any]) -> List[str]:
    """Render a concise '## Validator + Revision' section from a trace dict.
    Includes a relative-path link back to the full trace JSON on disk."""
    issues = trace.get("validator", {}).get("issues") or []
    attempts = trace.get("attempts") or []
    final = trace.get("final_outcome") or "?"
    lines = ["## Validator + Revision", ""]
    lines.append(f"**Final outcome:** `{final}`  ")
    lines.append(f"**Validator issues:** {len(issues)}  ")
    lines.append(f"**Revision attempts:** {len(attempts)}")
    lines.append("")
    if issues:
        lines.append("**Issues raised by validator:**")
        lines.append("")
        for iss in issues:
            q = iss.get("question", "?")
            msg = str(iss.get("issue", "")).strip()
            lines.append(f"- *{q}*: {msg}")
        lines.append("")
    for att in attempts:
        lines.append(
            f"- Attempt {att.get('attempt')}: "
            f"{att.get('duration_ms', 0)}ms · "
            f"in={att.get('in_tokens', 0)} out={att.get('out_tokens', 0)} · "
            f"returned={att.get('returned_artifacts') or []} · "
            f"outcome=`{att.get('outcome')}`"
        )
        se = att.get("static_errors") or {}
        for gen, errs in se.items():
            for e in errs:
                lines.append(f"    - [{gen}] {e}")
    trace_rel = f"{_REVISION_TRACES_SUBDIR}/{trace['run_ts']}_{trace['slug']}.json"
    lines.append("")
    lines.append(f"**Full trace:** [{trace_rel}]({trace_rel})")
    lines.append("")
    return lines


_STOP_LABEL_TITLES: Dict[str, str] = {
    "arch": "Architect Stop",
    "codegen": "Codegen Stop",
    "validator": "Validator Stop",
    "full": "Full Pipeline",
}


def _md_pipeline_header(
    stop_label: str,
    prompt: str,
    total_ms: int,
    all_tokens: Dict[str, Tuple[int, int]],
    *,
    status: str = "✅ SUCCESS",
) -> List[str]:
    """
    Standard report-md header used by every stop mode (arch / codegen /
    validator / full). Mirrors the full-pipeline header so a partial run is
    inspectable the same way as a complete one.

    Includes:
      - Title + Date / Status / Total / Tokens (rolled up) / Prompt
      - Per-agent token table (one row per agent that did any work)
    """
    title = _STOP_LABEL_TITLES.get(stop_label, stop_label.capitalize())
    total_in = sum(v[0] for v in all_tokens.values())
    total_out = sum(v[1] for v in all_tokens.values())
    lines: List[str] = [
        f"# Chat Local — {title}",
        "",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ",
        f"**Status:** {status}  ",
        f"**Total:** {total_ms}ms  ",
        f"**Tokens:** in={total_in} out={total_out} total={total_in + total_out}  ",
        f"**Prompt:** {prompt}",
        "",
    ]
    rows = [
        (name, in_t, out_t)
        for name, (in_t, out_t) in all_tokens.items()
        if in_t or out_t
    ]
    if rows:
        lines += [
            "## Per-agent tokens",
            "",
            "| Agent | Input | Output | Total |",
            "|---|---:|---:|---:|",
        ]
        for name, in_t, out_t in rows:
            lines.append(f"| {name} | {in_t:,} | {out_t:,} | {in_t + out_t:,} |")
        lines.append("")
    return lines


def _save_artifacts_md(
    run_dir: Path,
    prompt: str,
    artifacts: Dict[str, str],
    stop_label: str,
    is_storefront: bool,
    is_admin_ui: bool,
    retry_log: Optional[List[Dict]] = None,
    intent: Optional[Dict] = None,
    plan: Optional[Dict] = None,
    validator_trace: Optional[Dict[str, Any]] = None,
    handler_email_metadata: Optional[Dict[str, Any]] = None,
    total_ms: int = 0,
    all_tokens: Optional[Dict[str, Tuple[int, int]]] = None,
) -> Path:
    _save_generated_files(run_dir, artifacts, is_storefront, is_admin_ui, plan)
    path = run_dir / "report.md"

    lines = _md_pipeline_header(stop_label, prompt, total_ms, all_tokens or {})

    if intent:
        lines += [
            "## Intent (Product Agent)",
            "",
            "```json",
            json.dumps(intent, indent=2),
            "```",
            "",
        ]
    if plan:
        lines += [
            "## Architect Plan",
            "",
            "```json",
            json.dumps(plan, indent=2),
            "```",
            "",
        ]

    if retry_log:
        resolved = (
            stop_label != "codegen"
            or not retry_log
            or all(entry["attempt"] < _MAX_CODEGEN_RETRIES for entry in retry_log)
        )
        heading = "## Validation Retries" + (
            " (all resolved)" if resolved else " (UNRESOLVED — max retries hit)"
        )
        lines += [heading, ""]
        for entry in retry_log:
            lines.append(f"### Attempt {entry['attempt']}")
            for gen_name, errs in entry["errors"].items():
                for e in errs:
                    lines.append(f"- **{gen_name}**: {e}")
            lines.append("")

    if validator_trace:
        lines += _validator_revision_md_lines(validator_trace)

    lines += ["## Artifacts", ""]
    if artifacts.get("handler"):
        lines += [
            "### handler.js",
            "",
            "```javascript",
            artifacts["handler"],
            "```",
            "",
        ]
    if handler_email_metadata is not None:
        lines += _email_metadata_md_lines(handler_email_metadata)
    if artifacts.get("migration"):
        lines += ["### migration.sql", "", "```sql", artifacts["migration"], "```", ""]
    if is_storefront and artifacts.get("widget_js"):
        lines += [
            "### widget.js",
            "",
            "```javascript",
            artifacts["widget_js"],
            "```",
            "",
        ]
    if is_admin_ui and artifacts.get("admin_ui"):
        lines += [
            "### admin_ui.js",
            "",
            "```javascript",
            artifacts["admin_ui"],
            "```",
            "",
        ]

    path.write_text("\n".join(lines) + "\n")
    return path


def _email_metadata_md_lines(meta: Dict[str, Any]) -> List[str]:
    """
    Render the handler's email-metadata sidecar for the test-results report.

    Makes sidecar presence, declared variables, and starter content inspectable
    at a glance — matches the contract in subagents/prompts/capabilities/handler.py
    ("Email metadata sidecar"). Empty/None metadata produces nothing.
    """
    if not meta:
        return []
    return [
        "### handler email metadata (sidecar)",
        "",
        "```json",
        json.dumps(meta, indent=2),
        "```",
        "",
    ]


def _print_arch(intent: Dict, plan: Dict) -> None:
    print()
    _hr("━")
    print(json.dumps({"intent": intent, "plan": plan}, indent=2))
    _hr("━")


def _print_artifacts(artifacts: Dict[str, str]) -> None:
    print()
    _hr()
    for key, code in artifacts.items():
        if code:
            lines = len(code.strip().splitlines())
            print(f"  {_BOLD}{key}{_RESET}  ({lines} lines)")
    _hr()


def _print_token_summary(token_map: Dict[str, Tuple[int, int]]) -> None:
    """Print a per-agent token breakdown and grand total."""
    if not token_map:
        return
    total_in = sum(v[0] for v in token_map.values())
    total_out = sum(v[1] for v in token_map.values())
    parts = "  ".join(
        _c(
            f"{name}({_ktok(in_t)}+{_ktok(out_t)})",
            _AGENT_COLOR.get(name.capitalize(), _DIM),
        )
        for name, (in_t, out_t) in token_map.items()
        if in_t or out_t
    )
    total_str = (
        f"{_c('Tokens', _DIM)}  "
        f"{_c(f'in={_ktok(total_in)}', _CYAN)}  "
        f"{_c(f'out={_ktok(total_out)}', _MAGENTA)}  "
        f"{_c(f'total={_ktok(total_in + total_out)}', _BOLD)}"
    )
    print(f"\n  {total_str}")
    if parts:
        print(f"  {_c('Agents', _DIM)}  {parts}")


# ── Main ───────────────────────────────────────────────────────────────────────


def _build_bundle(
    artifacts: Dict[str, Any],
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    explanation: Dict[str, Any],
    is_storefront: bool,
    is_admin_ui: bool,
    handler_email_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Assemble the FeatureBundle dict from generation outputs.
    Mirrors _publish_success in crew.py so the DB bundle is identical to what
    the production generator publishes via Pub/Sub.

    Email metadata flow matches crew.py — see _publish_success for the full
    rationale. usesEmail / emailTypeSuggestion come from the architect plan;
    emailVariables / emailStarterContent come from the handler's structured
    sidecar (captured by HandlerGenerator.generate() onto base_ctx).
    """
    handler_raw = artifacts.get("handler", "")
    shopify_plan = plan.get("shopifyPlan", {})
    technical = explanation.get("technical", {})
    app_contracts = plan.get("appContracts") or {}

    uses_email = "email" in (app_contracts.get("handlerCapabilities") or [])
    email_spec = app_contracts.get("emailSpec") or {}
    sidecar = handler_email_metadata or {}
    raw_variables = sidecar.get("variables")
    email_variables: List[str] = [
        v for v in (raw_variables or []) if isinstance(v, str)
    ]
    starter_raw = sidecar.get("starterContent")
    starter = (
        starter_raw
        if isinstance(starter_raw, dict)
        and starter_raw.get("subject")
        and starter_raw.get("body")
        else None
    )

    from utils.file_bundle import parse_file_bundle

    handler_files = parse_file_bundle(handler_raw) if handler_raw else []

    return {
        "widgetModule": artifacts.get("widget_js") if is_storefront else None,
        "adminUiModule": artifacts.get("admin_ui") if is_admin_ui else None,
        "widgetTargetTemplates": (
            (app_contracts.get("widgetTargetTemplates") or None)
            if is_storefront
            else None
        ),
        "handlerModule": {
            "files": handler_files,
            "webhookTopics": shopify_plan.get("webhookTopics", []),
            "cronSchedule": shopify_plan.get("cronSchedule"),
        },
        "dbMigration": {
            "path": "migrations/generated.sql",
            "contents": artifacts.get("migration", ""),
        },
        "explanation": {
            "merchantFacing": explanation.get("merchantFacing", ""),
            "technical": {
                "webhookTopics": technical.get("webhookTopics", []),
                "dbTables": technical.get("dbTables", []),
                "estimatedMonthlyExecutions": technical.get(
                    "estimatedMonthlyExecutions", 0
                ),
                "estimatedMonthlyCost": technical.get("estimatedMonthlyCost", "$0"),
            },
        },
        "usesEmail": uses_email,
        "emailVariables": email_variables,
        "emailTypeSuggestion": email_spec.get("type"),
        "emailStarterContent": starter,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Interactive chat CLI with optional pipeline stop points.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--stop-after",
        choices=["arch", "codegen", "validator"],
        default=None,
        help=(
            "Stop after a specific phase: "
            "'arch' = product + architect only, "
            "'codegen' = + codegen + static validation, "
            "'validator' = + LLM validator + revision. "
            "Omit to run the full pipeline."
        ),
    )
    parser.add_argument(
        "--no-db",
        action="store_true",
        default=False,
        help="Skip writing the bundle to the local postgres DB.",
    )
    parser.add_argument(
        "--list-resume",
        action="store_true",
        default=False,
        help=(
            "List runs in test_results/ that can be resumed, then exit. "
            "Each resumable run shows its last successful checkpoint and, "
            "if applicable, the halt reason (codegen_failed, kept_originals, "
            "revision_failed). Use --resume <RUN ID> to continue one."
        ),
    )
    parser.add_argument(
        "--resume",
        metavar="RUN_ID",
        default=None,
        help=(
            "Resume the run at test_results/<RUN_ID>/. The CLI loads the "
            "saved state.json and restarts from the phase after the last "
            "successful checkpoint, reusing prior artifacts so already-paid "
            "tokens (intent, architect, clean codegen artifacts, validator "
            "issues) aren't paid again. Use --list-resume to see candidate "
            "RUN_IDs."
        ),
    )
    args = parser.parse_args()

    # ── --list-resume: print and exit before doing anything else ──────────────
    if args.list_resume:
        _print_resume_list()
        return

    stop_after: StopAfter = args.stop_after or "full"
    resume_state: Optional[Dict[str, Any]] = None
    resumed_run_dir: Optional[Path] = None

    if args.resume:
        resumed_run_dir, resume_state = _resolve_resume_target(args.resume)

    save_to_db = not args.no_db and stop_after == "full"

    print()
    mode_note = (
        f"Shopify App Builder  ·  mode: {stop_after}"
        + (f"  ·  resuming {resumed_run_dir.name}" if resumed_run_dir else "")
    )
    _render_banner(mode_note)

    # ── Resume path: skip chat / picker / DB-create; rebuild from state ───────
    if resume_state is not None and resumed_run_dir is not None:
        prompt = resume_state["prompt"]
        intent = resume_state["intent"]
        archetype = resume_state.get("archetype") or intent.get("appCategory", "")
        is_storefront = bool(resume_state.get("is_storefront"))
        is_admin_ui = bool(resume_state.get("is_admin_ui"))
        run_dir = resumed_run_dir
        run_ts = resume_state.get("run_ts") or run_dir.name.split("_", 1)[0]
        run_slug = resume_state.get("run_slug") or "_".join(run_dir.name.split("_")[1:])
        # DB: reuse saved ids when present. We do NOT re-create rows — they
        # already exist (possibly marked failed); store_bundle/mark_failed
        # later will operate on the existing job_id.
        db_info = resume_state.get("db") or {}
        app_id = db_info.get("app_id")
        job_id = db_info.get("job_id")
        session_id = db_info.get("session_id")
        slug = db_info.get("slug")
        save_to_db = bool(db_info) and not args.no_db and stop_after == "full"
        if save_to_db:
            import db_local  # noqa: F401  — needed for _fail_db / store_bundle below

            _info(f"Resuming run {run_dir.name}  ·  DB app id: {app_id}")
        else:
            _info(f"Resuming run {run_dir.name}  ·  no DB (resumed)")
        all_tokens = {
            k: tuple(v) if isinstance(v, list) else v
            for k, v in (resume_state.get("all_tokens") or {}).items()
        }
        total_start = time.monotonic()
    else:
        # ── Step 1: Chat until intent is ready ─────────────────────────────
        first_message = _ask_user(f"\n{_BOLD}You{_RESET}  ")
        if not first_message:
            print("Nothing entered — exiting.")
            return

        history: List[Dict[str, str]] = [{"role": "user", "content": first_message}]
        intent, history = _clarify(history)
        prompt = intent.get("desiredOutcome") or first_message

        # ── Step 2: Confirm or keep refining ───────────────────────────────
        _info(
            "Press Enter to continue to components  |  type more to refine  |  'n' to cancel"
        )
        while True:
            user_input = _ask_user(f"\n{_BOLD}You{_RESET}  ")
            if not user_input or user_input.lower() in ("y", "yes"):
                break
            if user_input.lower() in ("n", "no"):
                print("\nAborted.")
                return
            history = history + [{"role": "user", "content": user_input}]
            intent, history = _clarify(history)
            prompt = intent.get("desiredOutcome") or first_message
            _info(
                "Press Enter to continue to components  |  type more to refine  |  'n' to cancel"
            )

        # ── Step 3: Component picker (mirrors ConfirmCard) ─────────────────
        while True:
            updated_intent = _pick_components(intent)
            if updated_intent is not None:
                intent = updated_intent
                break
            # "Change request" — resume clarification from current history
            _bot("Sure, what would you like to change?")
            user_input = _ask_user(f"\n{_BOLD}You{_RESET}  ")
            if not user_input:
                continue
            history = history + [{"role": "user", "content": user_input}]
            intent, history = _clarify(history)
            prompt = intent.get("desiredOutcome") or first_message

        # ── DB: create app + session before pipeline starts ───────────────
        app_name = (intent.get("desiredOutcome") or prompt)[:60]
        app_id = job_id = session_id = slug = None
        if save_to_db:
            try:
                import uuid
                import db_local

                app_id, slug = db_local.create_app(app_name)
                job_id = str(uuid.uuid4())
                session_id = db_local.create_session(app_id, prompt, job_id)
                _info(f"DB: created app '{slug}'")
            except Exception as exc:
                _info(f"DB setup failed — continuing without DB: {exc}")
                save_to_db = False

        archetype = intent.get("appCategory", "")
        is_storefront = archetype in ("storefront_backend", "storefront_backend_admin")
        is_admin_ui = archetype in ("storefront_backend_admin", "backend_admin")

        total_start = time.monotonic()
        run_ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
        run_slug = _slug(prompt)
        run_dir = _make_run_dir(run_ts, run_slug)
        all_tokens: Dict[str, Tuple[int, int]] = {}

        # ── Checkpoint: intent + DB ids saved before any LLM phase ────────
        # If the architect dies here, --resume picks up at this checkpoint
        # and re-runs only architect onwards; chat tokens stay paid once.
        _save_state(
            run_dir,
            run_ts=run_ts,
            run_slug=run_slug,
            prompt=prompt,
            intent=intent,
            archetype=archetype,
            is_storefront=is_storefront,
            is_admin_ui=is_admin_ui,
            save_to_db=save_to_db,
            db={
                "app_id": app_id,
                "job_id": job_id,
                "session_id": session_id,
                "slug": slug,
            } if save_to_db else {},
            all_tokens={},
            checkpoint="intent",
            halt_reason=None,
        )

    def _fail_db(reason: str) -> None:
        """Mark the DB session+app as failed before exiting."""
        if save_to_db and app_id and job_id:
            try:
                db_local.mark_session_failed(job_id, app_id, reason)
            except Exception:
                pass

    # Where in the pipeline did the previous run get to? -1 means "no
    # state / fresh run" — every phase runs. Each phase compares against
    # _phase_index(<phase_name>) and skips itself when its output is already
    # in the saved state. Halt-reasons override this for resume-and-retry:
    # codegen_failed forces codegen to re-run with prior partial artifacts;
    # kept_originals / revision_failed forces revision to re-run with saved
    # validator issues.
    _resumed_idx = _phase_index(resume_state.get("checkpoint")) if resume_state else -1
    _resumed_halt = (resume_state or {}).get("halt_reason")

    # ── Phase: Architect ───────────────────────────────────────────────────────
    if resume_state and _resumed_idx >= _phase_index("arch") and resume_state.get("plan"):
        plan = resume_state["plan"]
        product_prompt = resume_state.get("product_prompt", "") or ""
        if "architect" in (resume_state.get("all_tokens") or {}):
            saved = resume_state["all_tokens"]["architect"]
            all_tokens["architect"] = tuple(saved) if isinstance(saved, list) else saved
        _info("Architect: reusing saved plan (skipping LLM call)")
    else:
        _phase_header("ARCHITECT")
        try:
            with input_log("architect", run_dir):
                plan, product_prompt, arch_in, arch_out = _phase_architect(intent, prompt)
        except SystemExit:
            _fail_db("Architect phase failed")
            raise
        all_tokens["architect"] = (arch_in, arch_out)
        # Checkpoint: arch done. Codegen failure persistence (below) leaves
        # checkpoint at "arch" with halt_reason=codegen_failed, so this is
        # the same level resume picks up at after codegen blows up.
        _save_state(
            run_dir,
            plan=plan,
            product_prompt=product_prompt,
            all_tokens={k: list(v) for k, v in all_tokens.items()},
            checkpoint="arch",
            halt_reason=None,
        )

    if stop_after == "arch":
        # User-requested stop. Mark the run done so it stops appearing in
        # --list-resume — partial-pipeline stops are a deliberate exit, not
        # an interruption. The arch.json + report.md are still on disk for
        # inspection.
        _save_state(run_dir, checkpoint="done", halt_reason=None)
        total_ms = int((time.monotonic() - total_start) * 1000)
        _save_arch_json(run_dir, prompt, intent, plan, [], product_prompt)
        # No artifacts at arch stop, but the report still carries the standard
        # header + intent + plan so it's inspectable the same way as later stops.
        _save_artifacts_md(
            run_dir,
            prompt,
            {},
            "arch",
            is_storefront,
            is_admin_ui,
            intent=intent,
            plan=plan,
            total_ms=total_ms,
            all_tokens=all_tokens,
        )
        print()
        _summary_box(
            "◆  ARCH STOP",
            [
                ("Status", _c("✓ architect plan only", _BRIGHT_GREEN, _BOLD)),
                ("Duration", _c(f"{total_ms / 1000:.1f}s", _CYAN)),
                ("Output", _c(str(run_dir.relative_to(_HERE)) + "/", _BLUE)),
            ],
        )
        _print_token_summary(all_tokens)
        print()
        return

    # ── Phase: CodeGen + Static Validation ────────────────────────────────────
    base_ctx = CodegenContext(
        intent=intent,
        plan=plan,
        platform_api_catalog=(plan.get("appContracts") or {}).get("widgetApiCatalog")
        or [],
    )
    # Restore handler side-bands when resuming so the bundle build / report
    # match the prior run.
    if resume_state and resume_state.get("handler_email_metadata") is not None:
        base_ctx.handler_email_metadata = resume_state["handler_email_metadata"]
    if resume_state and resume_state.get("handler_raw_response") is not None:
        base_ctx.handler_raw_response = resume_state["handler_raw_response"]

    # Resume into codegen if:
    #   - checkpoint is past codegen (skip entirely; reuse artifacts)
    #   - checkpoint==arch but halt_reason==codegen_failed (re-run with
    #     prior partial artifacts and saved error_map)
    skip_codegen = (
        resume_state is not None
        and _resumed_idx >= _phase_index("codegen")
        and resume_state.get("artifacts")
    )
    if skip_codegen:
        artifacts = dict(resume_state["artifacts"] or {})
        retry_log = list(resume_state.get("retry_log") or [])
        # `codegen_tokens` doesn't exist on the resume path — keep an empty
        # placeholder so any code below that touches it stays happy. The
        # rolled-up totals come from `codegen_token_totals` instead.
        codegen_tokens: Dict[str, Tuple[int, int]] = {}
        # Restore codegen token totals into all_tokens.
        for name, tokens in (resume_state.get("codegen_token_totals") or {}).items():
            all_tokens[name] = (
                tuple(tokens) if isinstance(tokens, list) else tokens
            )
        _info("Codegen: reusing saved artifacts (skipping LLM call)")
    else:
        _phase_header("CODEGEN")
        prior_artifacts = None
        prior_error_map = None
        prior_retry_log = None
        prior_token_totals = None
        if resume_state and _resumed_halt == "codegen_failed":
            prior_artifacts = resume_state.get("artifacts") or {}
            prior_error_map = resume_state.get("codegen_error_map") or {}
            prior_retry_log = resume_state.get("retry_log") or []
            saved_tokens = resume_state.get("codegen_token_totals") or {}
            prior_token_totals = {
                k: tuple(v) if isinstance(v, list) else v
                for k, v in saved_tokens.items()
            }
            _info(
                f"Codegen resume: re-running "
                f"{', '.join(prior_error_map.keys()) or 'missing'} "
                f"(reusing {len(prior_artifacts)} clean artifact(s))"
            )
        try:
            # The agent name "codegen" here is a placeholder — workers in
            # run_codegen_parallel re-enter input_log() with codegen_<gen> per
            # generator, so individual prompts land in inputs/codegen_handler/,
            # inputs/codegen_migration/, etc., not under a shared dir.
            with input_log("codegen", run_dir):
                artifacts, retry_log, codegen_tokens = _phase_codegen(
                    base_ctx,
                    is_storefront,
                    is_admin_ui,
                    run_dir,
                    prior_artifacts=prior_artifacts,
                    prior_error_map=prior_error_map,
                    prior_retry_log=prior_retry_log,
                    prior_token_totals=prior_token_totals,
                )
        except SystemExit:
            _fail_db("Codegen validation failed after max retries")
            raise
        all_tokens.update(codegen_tokens)
        # Re-persist all_tokens after codegen rolls in. State already has
        # checkpoint=codegen written by _phase_codegen on success.
        _save_state(
            run_dir, all_tokens={k: list(v) for k, v in all_tokens.items()}
        )

    if stop_after == "codegen":
        # User-requested stop — mark done so the run drops out of the
        # resume list (same reasoning as stop_after=arch).
        _save_state(run_dir, checkpoint="done", halt_reason=None)
        total_ms = int((time.monotonic() - total_start) * 1000)
        _save_artifacts_md(
            run_dir,
            prompt,
            artifacts,
            "codegen",
            is_storefront,
            is_admin_ui,
            retry_log or None,
            intent=intent,
            plan=plan,
            handler_email_metadata=base_ctx.handler_email_metadata,
            total_ms=total_ms,
            all_tokens=all_tokens,
        )
        print()
        _summary_box(
            "◆  CODEGEN STOP",
            [
                ("Status", _c("✓ static validation passed", _BRIGHT_GREEN, _BOLD)),
                ("Duration", _c(f"{total_ms / 1000:.1f}s", _CYAN)),
                ("Output", _c(str(run_dir.relative_to(_HERE)) + "/", _BLUE)),
            ],
        )
        _print_artifacts(artifacts)
        _print_token_summary(all_tokens)
        print()
        return

    # ── Phase: LLM Validator + Revision ───────────────────────────────────────
    # Resume rules for this combined phase:
    #   1. checkpoint >= "validator" with NO halt          → skip entirely
    #   2. checkpoint == "validator" AND halt in
    #      {kept_originals, revision_failed}                → skip validator,
    #      re-run revision with saved issues + pre-revision artifacts
    #   3. checkpoint == "revision" (resolved or resolved_on_retry)
    #                                                       → skip entirely
    validator_trace = None
    if resume_state and _resumed_idx >= _phase_index("validator") and _resumed_halt not in (
        "kept_originals", "revision_failed"
    ):
        # Validator+revision already settled successfully (no unresolved
        # findings). Reuse artifacts + tokens, no LLM calls.
        if resume_state.get("validator_tokens"):
            tk = resume_state["validator_tokens"]
            all_tokens["validator"] = (int(tk.get("in", 0)), int(tk.get("out", 0)))
        # Use the merged artifacts from the prior run if revision swapped
        # widget/admin in.
        if resume_state.get("artifacts"):
            artifacts = dict(resume_state["artifacts"])
        # Try to recover the prior revision trace so the resumed report.md
        # carries the same Validator + Revision section as the original.
        # Best-effort: if the trace file is missing/unreadable we just skip
        # that section (the run still completes).
        trace_path = run_dir / _REVISION_TRACES_SUBDIR / f"{run_ts}_{run_slug}.json"
        if trace_path.is_file():
            try:
                validator_trace = json.loads(trace_path.read_text())
            except (OSError, json.JSONDecodeError):
                validator_trace = None
        _info("Validator + Revision: reusing saved outcome (skipping LLM call)")
    elif (
        resume_state
        and _resumed_idx >= _phase_index("validator")
        and _resumed_halt in ("kept_originals", "revision_failed")
    ):
        # Resume only the revision step. Feed it the saved validator issues
        # and the pre-revision artifacts (NOT the broken merged output from
        # the failed revision — we want a fresh attempt at fixing the same
        # problem, not to compound prior damage).
        _phase_header("VALIDATOR + REVISION (revision-only resume)")
        pre = resume_state.get("pre_revision_artifacts") or resume_state.get("artifacts")
        if not pre or not resume_state.get("validator_issues"):
            print(
                f"\n  {_RED}Cannot resume revision — saved state is missing "
                f"pre_revision_artifacts or validator_issues.{_RESET}"
            )
            _fail_db("Resume revision failed: incomplete saved state")
            sys.exit(2)
        resumed_validator = {
            "issues": resume_state["validator_issues"],
            "in_tokens": (resume_state.get("validator_tokens") or {}).get("in", 0),
            "out_tokens": (resume_state.get("validator_tokens") or {}).get("out", 0),
            "duration_ms": (resume_state.get("validator_tokens") or {}).get("duration_ms", 0),
        }
        artifacts, val_in, val_out, validator_trace = _phase_validator(
            base_ctx,
            dict(pre),
            is_storefront,
            is_admin_ui,
            run_dir,
            run_ts,
            run_slug,
            resumed_validator=resumed_validator,
        )
        # The validator wasn't actually called on this resume path, so the
        # values returned in val_in/val_out are *revision* tokens — fresh
        # spend the merchant just paid. The validator's prior cost is
        # already in the loaded all_tokens snapshot. Track the new revision
        # spend under a separate key so per-agent reporting stays accurate
        # (and a follow-up resume reads the cumulative cost from state).
        prior_rev_in, prior_rev_out = all_tokens.get("revision", (0, 0))
        all_tokens["revision"] = (prior_rev_in + val_in, prior_rev_out + val_out)
        _save_state(
            run_dir, all_tokens={k: list(v) for k, v in all_tokens.items()}
        )
    else:
        _phase_header("VALIDATOR + REVISION")
        artifacts, val_in, val_out, validator_trace = _phase_validator(
            base_ctx,
            artifacts,
            is_storefront,
            is_admin_ui,
            run_dir,
            run_ts,
            run_slug,
        )
        if val_in or val_out:
            all_tokens["validator"] = (val_in, val_out)
        # Persist the rolled-up token totals so a resume after revision
        # success doesn't lose them.
        _save_state(
            run_dir, all_tokens={k: list(v) for k, v in all_tokens.items()}
        )

    if stop_after == "validator":
        # User-requested stop — mark done so the run drops out of the
        # resume list (same reasoning as stop_after=arch).
        _save_state(run_dir, checkpoint="done")
        total_ms = int((time.monotonic() - total_start) * 1000)
        _save_artifacts_md(
            run_dir,
            prompt,
            artifacts,
            "validator",
            is_storefront,
            is_admin_ui,
            retry_log or None,
            intent=intent,
            plan=plan,
            validator_trace=validator_trace,
            handler_email_metadata=base_ctx.handler_email_metadata,
            total_ms=total_ms,
            all_tokens=all_tokens,
        )
        print()
        _summary_box(
            "◆  VALIDATOR STOP",
            [
                ("Status", _c("✓ semantic check passed", _BRIGHT_GREEN, _BOLD)),
                ("Duration", _c(f"{total_ms / 1000:.1f}s", _CYAN)),
                ("Output", _c(str(run_dir.relative_to(_HERE)) + "/", _BLUE)),
            ],
        )
        _print_artifacts(artifacts)
        _print_token_summary(all_tokens)
        print()
        return

    # ── Phase: Explanation ────────────────────────────────────────────────────
    _phase_header("EXPLANATION")
    _spinner("Explanation")
    t0 = time.monotonic()
    with input_log("explanation", run_dir):
        explanation, exp_in, exp_out = run_explanation_agent(
            intent=intent,
            plan=plan,
            widget_js_code=artifacts.get("widget_js", "") if is_storefront else "",
            migration_sql=artifacts.get("migration", ""),
        )
    ms = int((time.monotonic() - t0) * 1000)
    _agent_line("Explanation", ok=True, ms=ms, notes=_tok_note(exp_in, exp_out))
    all_tokens["explanation"] = (exp_in, exp_out)

    # ── DB: store bundle ──────────────────────────────────────────────────────
    if save_to_db and app_id and job_id:
        try:
            bundle = _build_bundle(
                artifacts,
                intent,
                plan,
                explanation,
                is_storefront,
                is_admin_ui,
                handler_email_metadata=base_ctx.handler_email_metadata,
            )
            db_local.store_bundle(job_id, app_id, bundle)
        except Exception as exc:
            _log.info("DB bundle save failed: %s", exc, exc_info=True)
            _info(f"DB bundle save failed: {exc}")

    total_ms = int((time.monotonic() - total_start) * 1000)

    # ── Save report + generated files ─────────────────────────────────────────
    _save_generated_files(run_dir, artifacts, is_storefront, is_admin_ui, plan)
    merchant_facing = explanation.get("merchantFacing", "")
    lines = _md_pipeline_header("full", prompt, total_ms, all_tokens)
    lines += [
        "## Intent (Product Agent)",
        "",
        "```json",
        json.dumps(intent, indent=2),
        "```",
        "",
        "## Architect Plan",
        "",
        "```json",
        json.dumps(plan, indent=2),
        "```",
        "",
    ]
    if retry_log:
        lines += ["## Validation Retries (resolved)", ""]
        for entry in retry_log:
            lines.append(f"### Attempt {entry['attempt']}")
            for gen_name, errs in entry["errors"].items():
                for e in errs:
                    lines.append(f"- **{gen_name}**: {e}")
            lines.append("")
    if validator_trace:
        lines += _validator_revision_md_lines(validator_trace)
    if base_ctx.handler_email_metadata is not None:
        lines += _email_metadata_md_lines(base_ctx.handler_email_metadata)
    if merchant_facing:
        lines += ["## Explanation", "", merchant_facing]
    (run_dir / "report.md").write_text("\n".join(lines) + "\n")
    report = run_dir

    # ── Final summary ──────────────────────────────────────────────────────────
    # Tokens intentionally omitted here — _print_token_summary() just below
    # shows them with the per-agent breakdown, which is strictly more useful
    # than a rolled-up total in the box.
    #
    # Detect the silent-failure path: validator found high-confidence issues
    # and revision punted (returned [] / no_output / merge dropped frontend
    # artifacts). The pipeline exits cleanly with the original (broken) code,
    # which historically read identically to a real success. Promote it to a
    # warning so the merchant sees that real findings were not addressed.
    unresolved_issues: List[Dict[str, Any]] = []
    revision_outcome: Optional[str] = None
    if validator_trace:
        revision_outcome = validator_trace.get("final_outcome")
        if revision_outcome in ("kept_originals", "failed"):
            raw = validator_trace.get("validator", {}).get("issues") or []
            if isinstance(raw, list):
                unresolved_issues = [i for i in raw if isinstance(i, dict)]

    if unresolved_issues:
        status_label = _c(
            f"⚠ shipped with {len(unresolved_issues)} unresolved finding(s)",
            _YELLOW,
            _BOLD,
        )
    else:
        status_label = _c("✓ success", _BRIGHT_GREEN, _BOLD)

    rows: List[Tuple[str, str]] = [
        ("Status", status_label),
        ("Duration", _c(f"{total_ms / 1000:.1f}s", _CYAN)),
        ("Output", _c(str(run_dir.relative_to(_HERE)) + "/", _BLUE)),
    ]
    for key, label in [
        ("handler", "handler.js"),
        ("migration", "migration.sql"),
        ("widget_js", "widget.js"),
        ("admin_ui", "admin_ui.js"),
    ]:
        code = artifacts.get(key, "")
        if code:
            rows.append((label, _c(f"{len(code.strip().splitlines())} lines", _DIM)))

    # Carry over halt_reason on completed runs that shipped with unresolved
    # findings (kept_originals / revision_failed in revision_outcome). The
    # lister keeps these visible so the merchant can resume just-revision
    # later.
    final_halt: Optional[str] = None
    if revision_outcome == "kept_originals":
        final_halt = "kept_originals"
    elif revision_outcome == "failed":
        final_halt = "revision_failed"
    _save_state(
        run_dir,
        checkpoint="done",
        halt_reason=final_halt,
        artifacts=artifacts,
        all_tokens={k: list(v) for k, v in all_tokens.items()},
    )

    print()
    _summary_box("◆  RUN COMPLETE", rows)
    _print_token_summary(all_tokens)

    # Banner with the unresolved findings — printed AFTER the box so it's the
    # last thing on screen before the merchant-facing prose. Goal: a merchant
    # who shipped a broken bundle cannot miss that real bugs were detected
    # and not fixed. Shows the first 3 findings inline; the rest live in the
    # report.md and the revision_traces JSON the box already points at.
    if unresolved_issues:
        reason_label = {
            "kept_originals": "revision returned no usable output — originals kept",
            "failed": "revision retried twice and still failed static validation",
        }.get(revision_outcome or "", "revision did not complete")
        print(
            f"  {_YELLOW}{_BOLD}⚠  Validator found {len(unresolved_issues)} "
            f"high-confidence issue(s) — {reason_label}.{_RESET}"
        )
        print(
            f"  {_DIM}The artifacts above MAY break at deploy or runtime. "
            f"Review the findings before deploying:{_RESET}"
        )
        for issue in unresolved_issues[:3]:
            q = issue.get("question") or issue.get("location") or "?"
            i = issue.get("issue") or ""
            print(f"    {_YELLOW}•{_RESET} {_DIM}[{q}]{_RESET} {i[:140]}")
        if len(unresolved_issues) > 3:
            print(
                f"    {_DIM}… and {len(unresolved_issues) - 3} more in "
                f"{run_dir.relative_to(_HERE)}/report.md{_RESET}"
            )
        print()

    print()

    if merchant_facing:
        _bot(merchant_facing)


if __name__ == "__main__":
    main()
