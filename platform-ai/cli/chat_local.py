#!/usr/bin/env python3
"""
Interactive chat CLI — mirrors the platform's chat page experience.

Runs the multi-turn product agent clarification loop, then shows the
component picker (Backend / Widget / Admin UI), then runs the generation
pipeline phase by phase. Use --stop-after to halt at a specific phase, or
--resume to continue a prior run that was interrupted or failed.

USAGE
-----
  python chat_local.py                            # full pipeline
  python chat_local.py --stop-after hld           # HLD only, prints plan
  python chat_local.py --stop-after lld           # + LLD
  python chat_local.py --stop-after pre-codegen   # + cross-agent alignment notes
  python chat_local.py --stop-after codegen       # + codegen + static validation
  python chat_local.py --stop-after validator     # + LLM validator + revision pass
  python chat_local.py --no-db                    # skip writing the bundle to postgres

  # Iterate on the HLD agent — chat once, then resume with --stop-after hld
  # to skip the chat loop and re-run only the HLD step.
  python cli/chat_local.py --stop-after hld --no-db
  python cli/chat_local.py --list-resume                      # see candidate runs
  python cli/chat_local.py --resume <RUN_ID> --stop-after hld # repeats from intent → hld

RESUME
------
  Every run writes a state.json into its run dir after each phase. Use these
  flags to recover a run without re-paying tokens for phases that already
  succeeded:

    python chat_local.py --list-resume         # show every resumable run
    python chat_local.py --resume <RUN_ID>     # continue a specific run

  The CLI dispatches into the right phase based on the saved checkpoint:

    intent     → re-runs from hld onwards
    hld       → re-runs from codegen onwards
    hld + codegen_failed
               → re-runs codegen, reusing artifacts that already passed
                 validation (only the failed/missing generators are billed)
    pre-codegen → re-runs from codegen onwards, reusing the saved
                 alignment notes (delete `alignment_notes` from
                 state.json first to force a fresh pre-codegen pass)
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
  File (stop-after=hld):     test_results/<ts>_<slug>/hld.json
  File (stop-after=codegen/validator or full): test_results/<ts>_<slug>/report.md
  File (every run):           test_results/<ts>_<slug>/state.json  (resume index)

ARCHITECTURE
------------
  - cli/chat_local.py    — orchestrator (this file): argparse, chat loop,
                           component picker, run-dir + resume state, output
                           writers (md report / hld.json), DB bundle, main().
  - cli/pipeline_local.py — LLM pipeline phases: _phase_hld, _phase_codegen,
                           _phase_validator, _phase_explanation, plus their
                           failure-persistence helpers and on-disk artifact
                           writer (_save_generated_files).
"""

from __future__ import annotations

import argparse
import atexit
import itertools
import json
import os
import re
import shutil
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

_HERE = Path(__file__).resolve().parent
_GENERATOR_ROOT = _HERE.parent
# Capture the user's invocation cwd BEFORE the os.chdir below — argparse
# values like --prompt-file are relative to where the user launched the
# command, not the generator root we chdir into for imports. Without this,
# `./chat_local.py --prompt-file ./test_prompts/foo.txt` from inside cli/
# would resolve foo.txt relative to platform-ai/ and 404.
_INVOCATION_CWD = Path.cwd()
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

from subagents.base import CodegenContext
from subagents._product_agent.agent import run_product_agent_analyze
from models.adapter import input_log
from cli.pipeline_local import (
    _MAX_CODEGEN_RETRIES,
    _REVISION_TRACES_SUBDIR,
    _phase_codegen,
    _phase_explanation,
    _phase_hld,
    _phase_lld,
    _phase_ops_picker,
    _phase_validator,
    _save_generated_files,
)

TEST_RESULTS_DIR = _HERE / "test_results"

StopAfter = Literal[
    "hld", "ops-picker", "lld", "pre-codegen", "codegen", "validator", "full"
]

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
# 24-bit truecolour escape (supported by every modern terminal we target
# — iTerm2, macOS Terminal.app, modern Linux/Windows terminals). Falls
# back gracefully on non-truecolour terminals because the codes parse
# but render as a close 256-colour approximation.
_PASTEL_RED = "\033[38;2;255;120;130m"

# Per-agent accent colours so the progress lines don't look like a grey
# wall of text. Keys match the labels passed to `_spinner` / `_agent_line`.
_AGENT_COLOR: Dict[str, str] = {
    "HLD": _MAGENTA,
    "HLD Check": _MAGENTA,
    "LLD": _MAGENTA,
    "LLD Check": _MAGENTA,
    "Ops Picker": _PASTEL_RED,
    "Backend": _BLUE,
    "DB": _CYAN,
    "Storefront": _YELLOW,
    "Admin UI": _YELLOW,
    "Static Validation": _GREEN,
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
    timing = _c(f"{ms / 1000:.1f}s".ljust(7), _DIM) if ms is not None else _c("—".ljust(7), _DIM)
    line = f"  {label} {icon}  {timing}  {notes}".rstrip()
    print(f"\r{line}")


def _retry_line(name: str, notes: str) -> None:
    """
    Print (or, when a multi-line spinner group is active, in-place update)
    a retry indicator for the named agent.

    Used by phase runners to surface "validator rejected, retrying" cues
    live, instead of letting the spinner sit silent through 30s+ of retry
    work. Routes through the group when one is active so the row updates
    in place; falls back to a single-line print otherwise.
    """
    if _group_state.get("active"):
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
# Codegen runs backend/db/storefront/admin_ui in parallel via a
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
    timing = _c(f"{ms / 1000:.1f}s".ljust(7), _DIM) if ms is not None else _c("—".ljust(7), _DIM)
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
            ms_str = f"{ms / 1000:.1f}s" if ms is not None else "—"
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


def _tok_note(
    in_tok: int,
    out_tok: int,
    extra: str = "",
    cache_read: int = 0,
    cache_create: int = 0,
) -> str:
    """
    Render a token-count summary line for an agent run.

    Without cache numbers (`cache_read == cache_create == 0`):
        'in=2.4k out=0.8k'

    With cache hits (the common case after the first call within the cache
    TTL), the input figure becomes the TOTAL (uncached + cache-read +
    cache-create) so totals match the run summary, and a parenthetical
    breakdown surfaces the cache hit ratio:
        'in=14.3k (cache hit 9.1k=64%) out=0.8k'

    cache_read tokens are billed at ~10% of the full input price; cache_create
    tokens at ~125% (only on the first call within the TTL). Surfacing the
    cache hit ratio lets the operator see when reuse is working and when a
    new prefix forced a cache-create.
    """
    cached_total = cache_read + cache_create
    if cached_total > 0:
        total_in = in_tok + cached_total
        pct = round(cache_read * 100 / total_in) if total_in else 0
        base = (
            f"in={_ktok(total_in)} (cache hit {_ktok(cache_read)}={pct}%)"
            f" out={_ktok(out_tok)}"
        )
    else:
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
        response, metrics = run_product_agent_analyze(history)
        # Per-turn token + cache hit. Rendered as a dim one-liner so the
        # operator can see when caching kicks in: a 5-second pause between
        # turns should show cache_read ≈ system-prompt size; a >5-min pause
        # with the default ephemeral TTL would drop to cache_read=0 and
        # cache_create ≈ system-prompt size. With the product agent's
        # `cache_ttl="1h"` opt-in, that 5-min gap stays in cache.
        in_t = metrics.get("in", 0)
        out_t = metrics.get("out", 0)
        cache_r = metrics.get("cache_read", 0)
        cache_c = metrics.get("cache_create", 0)
        _info(_tok_note(in_t, out_t, cache_read=cache_r, cache_create=cache_c))

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
            # Echo the resolved choice so the merchant sees what their
            # keypress did — symmetric with `_clarify` printing `→ <text>`
            # when the merchant picks a numbered suggestion. Without this
            # echo, pressing Enter alone looks like it did nothing until
            # the next phase header appears.
            _info("→ Generate")
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
# already persists the per-phase outputs (hld.json, generated files,
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
_PHASE_ORDER: List[str] = [
    "intent",
    "hld",
    "ops-picker",
    "lld",
    "pre-codegen",
    "codegen",
    "validator",
    "revision",
    "done",
]


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
    # paired with checkpoint=hld (codegen never reaches done after a
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
    reason_w = max(len("HALT"), max(len(str(r["halt_reason"] or "")) for r in rows))
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


def _resolve_resume_target(
    run_id: str, stop_after: Optional[str] = None
) -> Tuple[Path, Dict[str, Any]]:
    """
    Validate `run_id` and return (run_dir, state). Exits with a clear message
    on any failure mode (missing dir, missing state.json, corrupted JSON,
    completed run, missing required fields).

    `stop_after` is consulted only to decide whether a `done` run is still
    resumable for the purpose of backfilling a phase that didn't exist
    when the run originally completed (currently: lld). Pass None to keep
    the strict policy (done = nothing to do).
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
    #
    # Exception: when the run pre-dates a newer phase (e.g. it finished
    # before LLD existed and so has no `lld` field), and the operator is
    # asking to stop at exactly that newer phase, treat the run as
    # resumable — they want to backfill the missing phase artifact, not
    # re-run anything already done. The phase block itself short-circuits
    # cleanly when the field is present and runs the LLM otherwise, so the
    # gate just needs to let them in.
    _MISSING_PHASE_FIELDS = {
        "lld": "lld",
        # Add new phases here when they're introduced post-launch.
    }
    asks_to_backfill_missing = stop_after in _MISSING_PHASE_FIELDS and not state.get(
        _MISSING_PHASE_FIELDS[stop_after]
    )

    if (
        checkpoint == "done"
        and halt not in ("kept_originals", "revision_failed")
        and not asks_to_backfill_missing
    ):
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


# ── Output helpers ─────────────────────────────────────────────────────────────


def _slug(text: str, max_words: int = 6) -> str:
    words = re.sub(r"[^a-z0-9 ]", "", text.lower()).split()
    return "-".join(words[:max_words])


def _save_hld_json(
    run_dir: Path,
    prompt: str,
    intent: Dict,
    plan: Dict,
    errors: List[str],
    product_prompt: str = "",
    hld_v_findings: Optional[List] = None,
) -> Path:
    payload: Dict[str, Any] = {
        "prompt": prompt,
        "intent": intent,
        "plan": plan,
        "validation_errors": errors,
    }
    if product_prompt:
        payload["product_prompt"] = product_prompt
    if hld_v_findings is not None:
        payload["hld_v_findings"] = hld_v_findings
    path = run_dir / "hld.json"
    path.write_text(json.dumps(payload, indent=2))
    return run_dir


def _save_ops_picks_json(run_dir: Path, picks: Dict[str, Any]) -> Path:
    """
    Persist the ops-picker output as a sibling to hld.json. Same pattern
    as `_save_hld_json` — the stop=ops report links to this file rather
    than inlining the JSON.
    """
    path = run_dir / "ops_picks.json"
    path.write_text(json.dumps(picks, indent=2))
    return path


def _save_lld_json(run_dir: Path, lld: Dict[str, Any]) -> Path:
    """
    Persist the LLD output as a sibling to hld.json + ops_picks.json.
    The LLD plan contains the complete codegen spec — stop=lld report
    links to this file rather than inlining the (large) JSON.
    """
    path = run_dir / "lld.json"
    path.write_text(json.dumps(lld, indent=2))
    return path


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
    "hld": "HLD Stop",
    "ops-picker": "Ops Picker Stop",
    "lld": "LLD Stop",
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
    Standard report-md header used by every stop mode (hld / codegen /
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
        f"**Total:** {total_ms / 1000:.1f}s  ",
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


def _save_run_artifacts(
    run_dir: Path,
    prompt: str,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    intent: Optional[Dict] = None,
    plan: Optional[Dict] = None,
    hld_v_findings: Optional[List] = None,
) -> Path:
    """
    Persist the run's canonical artefacts to ``run_dir`` and return the dir.

    Writes:
      - per-generator artefact files (parsed handler bundle + db.sql + the
        storefront / admin_ui single-file modules) via _save_generated_files.
      - hld.json alongside, whenever an HLD plan is present.

    Token totals + retry trail + validator trace live in state.json (written
    by the resume-state machinery) — no Markdown report duplicates them
    anymore.
    """
    _save_generated_files(run_dir, artifacts, is_storefront, is_admin_ui, plan)
    if plan:
        _save_hld_json(run_dir, prompt, intent or {}, plan, [], "", hld_v_findings)
    return run_dir


def _email_metadata_md_lines(meta: Dict[str, Any]) -> List[str]:
    """
    Render the handler's email-metadata sidecar for the test-results report.

    Makes sidecar presence, declared variables, and starter content inspectable
    at a glance — matches the email-metadata sidecar contract documented
    in subagents/f_codegen_agent/backend_agent/prompt.py. Empty/None
    metadata produces nothing.
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


def _print_artifacts(artifacts: Dict[str, str]) -> None:
    print()
    _hr()
    for key, code in artifacts.items():
        if code:
            lines = len(code.strip().splitlines())
            print(f"  {_BOLD}{key}{_RESET}  ({lines} lines)")
    _hr()


def _print_token_summary(token_map: Dict[str, Tuple[int, ...]]) -> None:
    """Print a per-agent token breakdown and grand total.

    `token_map` values are positional tuples; the first two elements are
    always (in_tokens, out_tokens). Codegen agents pack two more
    (cache_read, cache_create); non-codegen agents stop at length 2.
    Read positionally so both shapes work.
    """
    if not token_map:
        return
    total_in = sum(v[0] for v in token_map.values())
    total_out = sum(v[1] for v in token_map.values())
    # Token summary is a quiet recap — render every per-agent entry in DIM
    # so the line reads as one uniform footer. Phase-level accent colours
    # belong on the live progress rows above, not here. (The previous
    # `_AGENT_COLOR.get(name.capitalize(), _DIM)` lookup leaked YELLOW for
    # storefront and BLUE for backend because their canonical labels matched
    # while hld/lld/ops_picker/db/lld_v fell through to DIM, producing a
    # visually uneven footer.)
    # Token-map entries are heterogeneous: non-codegen agents save 2-tuples
    # (in, out); codegen agents save 4-tuples (in, out, cache_read,
    # cache_create) so the cache hit ratio survives into the final
    # summary. Read positionally to tolerate both shapes.
    parts = "  ".join(
        _c(f"{name}({_ktok(tokens[0])}+{_ktok(tokens[1])})", _DIM)
        for name, tokens in token_map.items()
        if len(tokens) >= 2 and (tokens[0] or tokens[1])
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
    backend_email_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Assemble the FeatureBundle dict from generation outputs.
    Mirrors _publish_success in crew.py so the DB bundle is identical to what
    the production generator publishes via Pub/Sub.

    Email metadata flow matches crew.py — see _publish_success for the full
    rationale. usesEmail / emailTypeSuggestion come from the hld plan;
    emailVariables / emailStarterContent come from the handler's structured
    sidecar (captured by BackendGenerator.generate() onto base_ctx).
    """
    backend_raw = artifacts.get("backend", "")
    shopify_plan = plan.get("shopifyPlan", {})
    technical = explanation.get("technical", {})
    app_contracts = plan.get("appContracts") or {}

    uses_email = "email" in (app_contracts.get("handlerCapabilities") or [])
    email_spec = app_contracts.get("emailSpec") or {}
    sidecar = backend_email_metadata or {}
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

    handler_files = parse_file_bundle(backend_raw) if backend_raw else []

    return {
        "widgetModule": artifacts.get("storefront") if is_storefront else None,
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
            "contents": artifacts.get("db", ""),
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
        choices=[
            "hld",
            "ops-picker",
            "lld",
            "pre-codegen",
            "codegen",
            "validator",
        ],
        default=None,
        help=(
            "Stop after a specific phase: "
            "'hld' = HLD only, "
            "'ops-picker' = + ops picker (LLD stage 1), "
            "'lld' = + LLD (LLD stage 2 — full codegen spec), "
            "'pre-codegen' = + pre-codegen alignment notes, "
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
            "tokens (intent, hld, clean codegen artifacts, validator "
            "issues) aren't paid again. Use --list-resume to see candidate "
            "RUN_IDs."
        ),
    )
    parser.add_argument(
        "--prompt-file",
        metavar="PATH",
        default=None,
        help=(
            "Read the initial merchant prompt from a file instead of "
            "stdin. Bypasses the TTY canonical-mode 1024-char line buffer "
            "that truncates long pasted prompts. The file's full contents "
            "(stripped of leading/trailing whitespace) become the first "
            "user message; clarification still runs interactively from "
            "there. Ignored on --resume."
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
        resumed_run_dir, resume_state = _resolve_resume_target(
            args.resume, stop_after=stop_after
        )

    save_to_db = not args.no_db and stop_after == "full"

    print()
    mode_note = f"Shopify App Builder  ·  mode: {stop_after}" + (
        f"  ·  resuming {resumed_run_dir.name}" if resumed_run_dir else ""
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
        # --prompt-file lets the merchant skip the interactive paste step
        # entirely. Useful for long prompts that exceed the TTY's
        # canonical-mode line buffer (~1024 chars on macOS / iTerm), which
        # silently truncates pasted text mid-word.
        if args.prompt_file:
            # Resolve relative to the user's invocation cwd, not the
            # generator root we chdir'd into at import time. Absolute paths
            # pass through unchanged.
            prompt_path = Path(args.prompt_file)
            if not prompt_path.is_absolute():
                prompt_path = _INVOCATION_CWD / prompt_path
            try:
                first_message = prompt_path.read_text().strip()
            except OSError as exc:
                print(f"  {_RED}Could not read --prompt-file: {exc}{_RESET}")
                sys.exit(2)
            if not first_message:
                print(
                    f"  {_RED}--prompt-file {args.prompt_file} is empty — "
                    f"nothing to send.{_RESET}"
                )
                sys.exit(2)
            _info(
                f"Loaded prompt from {args.prompt_file} "
                f"({len(first_message)} chars)"
            )
            print(f"\n{_BOLD}You{_RESET}  {first_message}")
        else:
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
        # If the hld dies here, --resume picks up at this checkpoint
        # and re-runs only hld onwards; chat tokens stay paid once.
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
            db=(
                {
                    "app_id": app_id,
                    "job_id": job_id,
                    "session_id": session_id,
                    "slug": slug,
                }
                if save_to_db
                else {}
            ),
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

    # ── Phase: HLD ───────────────────────────────────────────────────────
    if (
        resume_state
        and _resumed_idx >= _phase_index("hld")
        and resume_state.get("plan")
    ):
        plan = resume_state["plan"]
        product_prompt = resume_state.get("product_prompt", "") or ""
        if "hld" in (resume_state.get("all_tokens") or {}):
            saved = resume_state["all_tokens"]["hld"]
            all_tokens["hld"] = tuple(saved) if isinstance(saved, list) else saved
        _info("HLD: reusing saved plan (skipping LLM call)")
    else:
        _phase_header("HLD")
        try:
            plan, product_prompt, hld_in, hld_out, _hld_cr, _hld_cc = _phase_hld(
                intent, prompt, run_dir
            )
        except SystemExit:
            _fail_db("HLD phase failed")
            raise
        all_tokens["hld"] = (hld_in, hld_out)
        # Checkpoint: hld done. Codegen failure persistence (in
        # pipeline_local._phase_codegen) leaves checkpoint at "lld" with
        # halt_reason=codegen_failed, so resume from a codegen-failed run
        # picks up AFTER lld (re-running codegen only).
        _save_state(
            run_dir,
            plan=plan,
            product_prompt=product_prompt,
            all_tokens={k: list(v) for k, v in all_tokens.items()},
            checkpoint="hld",
            halt_reason=None,
        )

    # ── HLD Validator + optional one-shot retry ───────────────────────────────
    hld_v_findings: List[Dict[str, Any]] = []
    if resume_state and resume_state.get("hld_v_findings") is not None:
        hld_v_findings = resume_state["hld_v_findings"]
    else:
        from subagents.b_hld_v_agent.agent import run_hld_validator
        from subagents.a_hld_agent.agent import run_hld_agent

        _spinner("HLD Check")
        _hld_v_t0 = time.monotonic()
        try:
            with input_log("hld_v", run_dir):
                (
                    hld_v_findings,
                    hld_v_in,
                    hld_v_out,
                    hld_v_cr,
                    hld_v_cc,
                ) = run_hld_validator(plan, prompt, intent)
        except Exception as _exc:
            _log.warning("hld_v: failed (%s) — fail-open", _exc)
            hld_v_findings, hld_v_in, hld_v_out, hld_v_cr, hld_v_cc = [], 0, 0, 0, 0
        _hld_v_ms = int((time.monotonic() - _hld_v_t0) * 1000)
        all_tokens["hld_v"] = (hld_v_in, hld_v_out)

        _retryable = list(hld_v_findings)
        _sev_note = f"{len(hld_v_findings)} finding(s)" if hld_v_findings else "clean"
        _agent_line(
            "HLD Check",
            True,
            _hld_v_ms,
            _tok_note(
                hld_v_in, hld_v_out, _sev_note, cache_read=hld_v_cr, cache_create=hld_v_cc
            ),
        )

        # Print findings BEFORE the retry so the operator sees what is being
        # acted on before the next spinner starts. With critical+important
        # both triggering a retry, putting this after the retry block hid
        # the findings behind the spinner until after the re-run finished.
        if hld_v_findings:
            _SEV_COLOR = {"critical": _RED, "important": _YELLOW, "minor": _DIM}
            for _f in hld_v_findings:
                _sc = _SEV_COLOR.get(_f.get("severity", ""), _DIM)
                _sev_label = _f.get("severity", "?")
                _loc = _f.get("location", "")
                _iss = _f.get("issue", "")[:120]
                print(
                    f"    {_c('•', _sc)} {_c('[' + _sev_label + ']', _sc)}"
                    f"  {_c(_loc, _DIM)}  {_iss}"
                )

        if _retryable:
            # One-shot correction: feed every finding back to the HLD agent
            # regardless of severity — if the validator surfaced it, the HLD
            # should address it.
            _hint = "\n".join(
                f"- [{f['severity']}] {f['location']}: {f['issue']} Fix: {f['fix']}"
                for f in _retryable
            )
            _retry_line("HLD", f"retrying with {len(_retryable)} finding(s)")
            _spinner("HLD")

            def _on_retry_attempt_failed(attempt: int, errors: List[str]) -> None:
                """Surface validation errors from the validator-hint retry,
                same shape as the first-pass callback in pipeline_local."""
                first = errors[0] if errors else "validation failed"
                more = f" (+{len(errors) - 1} more)" if len(errors) > 1 else ""
                _agent_line(
                    "HLD",
                    ok=False,
                    ms=None,
                    notes=f"attempt {attempt} rejected: {first}{more}",
                )
                for _e in errors:
                    print(f"    {_DIM}• {_e}{_RESET}")
                _retry_line("HLD", notes=f"retry attempt {attempt + 1}")
                _spinner("HLD")

            try:
                # Wrap in input_log so every retry attempt's prompts + raw
                # model output land in inputs/hld/attempt_N — without this,
                # a 3-attempt validator-hint retry leaves no post-mortem trail.
                with input_log("hld", run_dir):
                    plan, _r_in, _r_out, _r_cr, _r_cc = run_hld_agent(
                        prompt,
                        intent,
                        validator_hint=_hint,
                        prior_plan=plan,
                        on_attempt_failed=_on_retry_attempt_failed,
                    )
                _r_in_prev, _r_out_prev = all_tokens.get("hld", (0, 0))
                all_tokens["hld"] = (_r_in_prev + _r_in, _r_out_prev + _r_out)
                product_prompt = ""
                _agent_line(
                    "HLD",
                    True,
                    None,
                    _tok_note(
                        _r_in, _r_out, "corrected", cache_read=_r_cr, cache_create=_r_cc
                    ),
                )
            except Exception as _exc:
                _log.warning(
                    "hld_v retry: HLD re-run failed (%s) — keeping original", _exc
                )
                _agent_line("HLD", False, None, "retry failed — original kept")

        _save_state(
            run_dir,
            plan=plan,
            hld_v_findings=hld_v_findings,
            all_tokens={k: list(v) for k, v in all_tokens.items()},
        )
        # Always persist hld.json after the HLD phase completes — same
        # pattern as ops_picks.json / lld.json. Without this, mid-pipeline
        # runs would have the HLD only inside state.json with no standalone
        # artifact on disk for inspection.
        _save_hld_json(
            run_dir, prompt, intent, plan, [], product_prompt, hld_v_findings
        )

    if stop_after == "hld":
        # User-requested stop. Mark the run done so it stops appearing in
        # --list-resume — partial-pipeline stops are a deliberate exit, not
        # an interruption. hld.json + state.json are on disk for inspection;
        # the full-pipeline report.md is only written when the run reaches
        # the validator stage without an early stop.
        _save_state(run_dir, checkpoint="done", halt_reason=None)
        total_ms = int((time.monotonic() - total_start) * 1000)
        # `_save_run_artifacts` writes hld.json itself, so no standalone
        # call is needed here.
        _save_run_artifacts(
            run_dir,
            prompt,
            {},
            is_storefront,
            is_admin_ui,
            intent=intent,
            plan=plan,
            hld_v_findings=hld_v_findings,
        )
        print()
        _summary_box(
            "◆  HLD STOP",
            [
                ("Status", _c("✓ HLD plan only", _BRIGHT_GREEN, _BOLD)),
                ("Duration", _c(f"{total_ms / 1000:.1f}s", _CYAN)),
                ("Output", _c(str(run_dir.relative_to(_HERE)) + "/", _BLUE)),
            ],
        )
        _print_token_summary(all_tokens)
        print()
        return

    # ── Phase: Ops Picker (LLD stage 1) ───────────────────────────────────────
    # Picks Shopify GraphQL ops per HLD capability + webhook topic per
    # external-event trigger. Resume rule mirrors HLD: if the saved
    # checkpoint is past "ops-picker" and `ops_picks` is on disk, reuse it.
    if (
        resume_state
        and _resumed_idx >= _phase_index("ops-picker")
        and resume_state.get("ops_picks")
    ):
        ops_picks = resume_state["ops_picks"]
        if "ops_picker" in (resume_state.get("all_tokens") or {}):
            saved = resume_state["all_tokens"]["ops_picker"]
            all_tokens["ops_picker"] = (
                tuple(saved) if isinstance(saved, list) else saved
            )
        _info("Ops Picker: reusing saved picks (skipping LLM call)")
    else:
        _phase_header("OPS PICKER")
        try:
            ops_picks, ops_in, ops_out = _phase_ops_picker(plan, prompt, run_dir)
        except SystemExit:
            _fail_db("Ops Picker phase failed")
            raise
        all_tokens["ops_picker"] = (ops_in, ops_out)
        _save_ops_picks_json(run_dir, ops_picks)
        _save_state(
            run_dir,
            ops_picks=ops_picks,
            all_tokens={k: list(v) for k, v in all_tokens.items()},
            checkpoint="ops-picker",
            halt_reason=None,
        )

    if stop_after == "ops-picker":
        # User-requested stop — same finalisation pattern as stop=hld.
        # ops_picks.json + state.json are on disk for inspection; the run
        # is marked done so it stops appearing in --list-resume.
        _save_state(run_dir, checkpoint="done", halt_reason=None)
        total_ms = int((time.monotonic() - total_start) * 1000)
        _save_run_artifacts(
            run_dir,
            prompt,
            {},
            is_storefront,
            is_admin_ui,
            intent=intent,
            plan=plan,
            hld_v_findings=hld_v_findings,
        )
        print()
        _summary_box(
            "◆  OPS PICKER STOP",
            [
                ("Status", _c("✓ ops picks ready", _BRIGHT_GREEN, _BOLD)),
                ("Duration", _c(f"{total_ms / 1000:.1f}s", _CYAN)),
                ("Output", _c(str(run_dir.relative_to(_HERE)) + "/", _BLUE)),
            ],
        )
        _print_token_summary(all_tokens)
        print()
        return

    # ── Phase: LLD (LLD stage 2) ──────────────────────────────────────────────
    # Translates HLD + ops-picks into the complete codegen spec
    # (database, recipes, routes, state machine). Resume rule mirrors
    # ops-picker: if the saved checkpoint is past "lld" and `lld` is on
    # disk, reuse it.
    #
    # Old runs saved before the ops-picker enrichment landed have bare
    # ops_picks (just name/surface/note). Re-enrich on load so the LLD
    # always sees the full per-op detail (`load_op_details` is lru_cached
    # and idempotent — re-enriching an already-enriched op is a no-op).
    from subagents.c_ops_picker_agent.agent import _enrich_with_op_details

    ops_picks = _enrich_with_op_details(ops_picks)

    if resume_state and _resumed_idx >= _phase_index("lld") and resume_state.get("lld"):
        lld = resume_state["lld"]
        if "lld" in (resume_state.get("all_tokens") or {}):
            saved = resume_state["all_tokens"]["lld"]
            all_tokens["lld"] = tuple(saved) if isinstance(saved, list) else saved
        _info("LLD: reusing saved spec (skipping LLM call)")
    else:
        _phase_header("LLD")
        try:
            lld, lld_in, lld_out, _lld_cr, _lld_cc = _phase_lld(
                plan, ops_picks, prompt, run_dir
            )
        except SystemExit:
            _fail_db("LLD phase failed")
            raise
        all_tokens["lld"] = (lld_in, lld_out)
        _save_lld_json(run_dir, lld)
        _save_state(
            run_dir,
            lld=lld,
            all_tokens={k: list(v) for k, v in all_tokens.items()},
            checkpoint="lld",
            halt_reason=None,
        )

    # ── LLD Validator + optional one-shot retry ───────────────────────────────
    lld_v_findings: List[Dict[str, Any]] = []
    if resume_state and resume_state.get("lld_v_findings") is not None:
        lld_v_findings = resume_state["lld_v_findings"]
    else:
        from subagents.e_lld_v_agent.agent import run_lld_validator
        from subagents.d_lld_agent.agent import run_lld_agent as _rerun_lld

        _spinner("LLD Check")
        _lld_v_t0 = time.monotonic()
        try:
            with input_log("lld_v", run_dir):
                (
                    lld_v_findings,
                    lld_v_in,
                    lld_v_out,
                    lld_v_cr,
                    lld_v_cc,
                ) = run_lld_validator(plan, ops_picks, lld, prompt)
        except Exception as _exc:
            _log.warning("lld_v: failed (%s) — fail-open", _exc)
            lld_v_findings, lld_v_in, lld_v_out, lld_v_cr, lld_v_cc = [], 0, 0, 0, 0
        _lld_v_ms = int((time.monotonic() - _lld_v_t0) * 1000)
        all_tokens["lld_v"] = (lld_v_in, lld_v_out)

        _retryable_lld = list(lld_v_findings)
        _sev_note = f"{len(lld_v_findings)} finding(s)" if lld_v_findings else "clean"
        _agent_line(
            "LLD Check",
            True,
            _lld_v_ms,
            _tok_note(
                lld_v_in, lld_v_out, _sev_note, cache_read=lld_v_cr, cache_create=lld_v_cc
            ),
        )

        if lld_v_findings:
            _SEV_COLOR = {"critical": _RED, "important": _YELLOW, "minor": _DIM}
            for _f in lld_v_findings:
                _sc = _SEV_COLOR.get(_f.get("severity", ""), _DIM)
                _sev_label = _f.get("severity", "?")
                _loc = _f.get("location", "")
                _iss = _f.get("issue", "")[:120]
                print(
                    f"    {_c('•', _sc)} {_c('[' + _sev_label + ']', _sc)}"
                    f"  {_c(_loc, _DIM)}  {_iss}"
                )

        if _retryable_lld:
            # One-shot correction: feed every finding back to the LLD agent
            # regardless of severity — mirrors the hld_v retry contract.
            _hint = "\n".join(
                f"- [{f['severity']}] {f['location']}: {f['issue']} Fix: {f['fix']}"
                for f in _retryable_lld
            )
            _retry_line("LLD", f"retrying with {len(_retryable_lld)} finding(s)")
            _spinner("LLD")

            def _on_lld_retry_attempt_failed(attempt: int, errors: List[str]) -> None:
                first = errors[0] if errors else "validation failed"
                more = f" (+{len(errors) - 1} more)" if len(errors) > 1 else ""
                _agent_line(
                    "LLD",
                    ok=False,
                    ms=None,
                    notes=f"attempt {attempt} rejected: {first}{more}",
                )
                for _e in errors:
                    print(f"    {_DIM}• {_e}{_RESET}")
                _retry_line("LLD", notes=f"retry attempt {attempt + 1}")
                _spinner("LLD")

            try:
                with input_log("lld", run_dir):
                    lld, _r_in, _r_out, _r_cr, _r_cc = _rerun_lld(
                        prompt=prompt,
                        plan=plan,
                        ops_picks=ops_picks,
                        validator_hint=_hint,
                        prior_plan=lld,
                        on_attempt_failed=_on_lld_retry_attempt_failed,
                    )
                _r_in_prev, _r_out_prev = all_tokens.get("lld", (0, 0))
                all_tokens["lld"] = (_r_in_prev + _r_in, _r_out_prev + _r_out)
                _agent_line(
                    "LLD",
                    True,
                    None,
                    _tok_note(
                        _r_in, _r_out, "corrected", cache_read=_r_cr, cache_create=_r_cc
                    ),
                )
                _save_lld_json(run_dir, lld)
            except Exception as _exc:
                _log.warning(
                    "lld_v retry: LLD re-run failed (%s) — keeping original", _exc
                )
                _agent_line("LLD", False, None, "retry failed — original kept")

        _save_state(
            run_dir,
            lld=lld,
            lld_v_findings=lld_v_findings,
            all_tokens={k: list(v) for k, v in all_tokens.items()},
        )

    if stop_after == "lld":
        # User-requested stop. Mark done, write report, exit cleanly.
        _save_state(run_dir, checkpoint="done", halt_reason=None)
        total_ms = int((time.monotonic() - total_start) * 1000)
        _save_run_artifacts(
            run_dir,
            prompt,
            {},
            is_storefront,
            is_admin_ui,
            intent=intent,
            plan=plan,
            hld_v_findings=hld_v_findings,
        )
        print()
        _summary_box(
            "◆  LLD STOP",
            [
                ("Status", _c("✓ LLD spec ready", _BRIGHT_GREEN, _BOLD)),
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
        lld=lld or {},
        platform_api_catalog=(plan.get("appContracts") or {}).get("widgetApiCatalog")
        or [],
    )

    # Pre-codegen alignment phase — runs once between final LLD and the
    # codegen fan-out. Lives in the shared orchestrator so CLI and the
    # production crew take the same path. Fails open: empty notes is the
    # normal "no alignment needed" answer.
    #
    # On resume we reuse the persisted notes whenever they exist (the
    # phase already produced them) — we don't gate on _resumed_idx so an
    # operator can rebuild the alignment in-place by deleting the field
    # from state.json and resuming with --stop-after pre-codegen.
    from subagents.f_codegen_agent.orchestration import run_pre_codegen_phase

    _cached_alignment = (
        resume_state.get("alignment_notes")
        if resume_state and resume_state.get("alignment_notes") is not None
        else None
    )

    if _cached_alignment is not None:
        # Match the upstream-agent resume idiom (HLD / Ops Picker / LLD):
        # one compact info line, no phase header, no inline dump — the
        # findings were already inspected on the run that produced them.
        # Token totals carry through state.json so the resume summary is
        # accurate even without re-rendering them here.
        if "pre_codegen" in (resume_state.get("all_tokens") or {}):
            saved = resume_state["all_tokens"]["pre_codegen"]
            all_tokens["pre_codegen"] = (
                tuple(saved) if isinstance(saved, list) else saved
            )
        _info(
            f"Pre-Codegen Alignment: reusing saved notes "
            f"({len(_cached_alignment)} note(s)) — skipping LLM call"
        )
        with input_log("pre_codegen", run_dir):
            alignment_notes, _pre_status, _ = run_pre_codegen_phase(
                base_ctx,
                cached_notes=_cached_alignment,
                on_done=None,
            )
    else:
        # Fresh run — give the phase its own visual separator and the
        # full agent-line treatment with token + status output, plus the
        # inline note dump so the operator can audit findings at a
        # glance without opening state.json.
        _phase_header("PRE-CODEGEN ALIGNMENT")

        # `ok` is the only status whose 0 is truthful; everything else
        # is a soft warning surfaced here so the operator notices
        # without having to grep logs.
        _PRECODEGEN_FAIL_OPEN_LABELS = {
            "parse_error": "fail-open (response was not valid JSON)",
            "schema_error": "fail-open (response did not match schema)",
            "truncated": "fail-open (output truncated at max_tokens)",
            "llm_error": "fail-open (LLM call raised)",
        }

        def _on_pre_codegen_done(
            status: str,
            note_count: int,
            ms_pre: int,
            in_tok: int,
            out_tok: int,
            cache_r: int,
            cache_c: int,
        ) -> None:
            all_tokens["pre_codegen"] = (in_tok, out_tok)
            if status == "ok":
                notes_label = (
                    f"{note_count} note(s)" if note_count else "no alignment needed"
                )
            elif status == "skipped_no_lld":
                notes_label = "skipped (no LLD)"
            else:
                notes_label = _PRECODEGEN_FAIL_OPEN_LABELS.get(
                    status, f"fail-open ({status})"
                )
            # Treat non-ok as a warning row so it stands out in the
            # agent log without halting the pipeline.
            ok_row = status in ("ok", "skipped_no_lld")
            _agent_line(
                "Pre-Codegen Alignment",
                ok_row,
                ms_pre,
                _tok_note(
                    in_tok,
                    out_tok,
                    notes_label,
                    cache_read=cache_r,
                    cache_create=cache_c,
                ),
            )

        _spinner("Pre-Codegen Alignment")
        with input_log("pre_codegen", run_dir):
            alignment_notes, _pre_status, _ = run_pre_codegen_phase(
                base_ctx,
                cached_notes=None,
                on_done=_on_pre_codegen_done,
            )
        for _n in alignment_notes:
            _targets = ",".join(_n.get("target_agents") or [])
            _concern = _n.get("concern", "?")
            _instruction = (_n.get("instruction") or "")[:120]
            print(
                f"    {_c('•', _CYAN)} {_c('[' + _concern + ' → ' + _targets + ']', _DIM)}"
                f"  {_instruction}"
            )
    # Always stamp checkpoint="pre-codegen" when the phase finishes (cached
    # or live) so _phase_index() math lets resume continue from the right
    # spot. We DELIBERATELY do NOT stamp checkpoint="done" when stopping
    # here — the user explicitly asked that --stop-after pre-codegen leave
    # the run resumable from this phase without manual state surgery.
    #
    # `pre_codegen_status` is the outcome taxonomy from
    # subagents.f_codegen_agent.pre_codegen.agent.Status plus the two
    # phase-level statuses ("cached", "skipped_no_lld"). Persisting it
    # disambiguates `alignment_notes == []` after the fact — a clean
    # empty run vs a fail-open hides under the same notes list.
    _save_state(
        run_dir,
        alignment_notes=alignment_notes,
        pre_codegen_status=_pre_status,
        all_tokens={k: list(v) for k, v in all_tokens.items()},
        checkpoint="pre-codegen",
        halt_reason=None,
    )

    if stop_after == "pre-codegen":
        # User-requested stop. Mark the phase, write the run report, exit
        # cleanly. The checkpoint stays at "pre-codegen" (not "done") so a
        # follow-up resume picks up at codegen without any state edit.
        total_ms = int((time.monotonic() - total_start) * 1000)
        _save_run_artifacts(
            run_dir,
            prompt,
            {},
            is_storefront,
            is_admin_ui,
            intent=intent,
            plan=plan,
            hld_v_findings=hld_v_findings,
        )
        print()
        _summary_box(
            "◆  PRE-CODEGEN STOP",
            [
                (
                    "Status",
                    _c(
                        f"✓ {len(alignment_notes)} alignment note(s)"
                        if alignment_notes
                        else "✓ no alignment needed",
                        _BRIGHT_GREEN,
                        _BOLD,
                    ),
                ),
                ("Duration", _c(f"{total_ms / 1000:.1f}s", _CYAN)),
                ("Output", _c(str(run_dir.relative_to(_HERE)) + "/", _BLUE)),
            ],
        )
        _print_token_summary(all_tokens)
        print()
        return
    # Restore handler side-bands when resuming so the bundle build / report
    # match the prior run.
    if resume_state and resume_state.get("backend_email_metadata") is not None:
        base_ctx.backend_email_metadata = resume_state["backend_email_metadata"]
    if resume_state and resume_state.get("backend_raw_response") is not None:
        base_ctx.backend_raw_response = resume_state["backend_raw_response"]

    # Resume into codegen if:
    #   - checkpoint is past codegen (skip entirely; reuse artifacts)
    #   - checkpoint==hld but halt_reason==codegen_failed (re-run with
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
            all_tokens[name] = tuple(tokens) if isinstance(tokens, list) else tokens
        _info("Codegen: reusing saved artifacts (skipping LLM call)")
    else:
        _phase_header("CODEGEN")
        prior_artifacts = None
        prior_error_map = None
        prior_retry_log = None
        prior_token_totals = None

        if resume_state:
            # Always carry forward any clean artifacts the prior run produced —
            # `_phase_codegen` filters on artifacts presence + error_map to
            # decide which generators run this attempt, so passing the saved
            # bundle is the entire mechanism for "skip what already passed".
            # Covers two scenarios on a single code path:
            #
            #   (a) halt_reason == "codegen_failed" — codegen got partway
            #       through, some agents passed, others failed. error_map and
            #       retry_log are also carried so the failed ones re-run with
            #       their prior error feedback.
            #
            #   (b) halt_reason is None but checkpoint was rolled back below
            #       the codegen phase (e.g. operator manually reset the
            #       checkpoint to add storefront/admin_ui to a previously-
            #       complete run). No error_map to carry, just the artifacts
            #       — `_phase_codegen` will run only the generators whose
            #       names aren't already in `artifacts`.
            saved_artifacts = resume_state.get("artifacts") or {}
            if saved_artifacts:
                prior_artifacts = dict(saved_artifacts)
                prior_retry_log = list(resume_state.get("retry_log") or [])
                saved_tokens = resume_state.get("codegen_token_totals") or {}
                prior_token_totals = {
                    k: tuple(v) if isinstance(v, list) else v
                    for k, v in saved_tokens.items()
                }
                if _resumed_halt == "codegen_failed":
                    prior_error_map = resume_state.get("codegen_error_map") or {}
                    failed_summary = (
                        ", ".join(prior_error_map.keys()) or "missing"
                    )
                    _info(
                        f"Codegen resume: re-running {failed_summary} "
                        f"(reusing {len(prior_artifacts)} clean artifact(s))"
                    )
                else:
                    _info(
                        f"Codegen resume: reusing "
                        f"{len(prior_artifacts)} prior artifact(s) "
                        f"({', '.join(sorted(prior_artifacts.keys()))}); "
                        f"running only missing generators"
                    )
        try:
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
        _save_state(run_dir, all_tokens={k: list(v) for k, v in all_tokens.items()})

    if stop_after == "codegen":
        # User-requested stop — mark done so the run drops out of the
        # resume list (same reasoning as stop_after=hld).
        _save_state(run_dir, checkpoint="done", halt_reason=None)
        total_ms = int((time.monotonic() - total_start) * 1000)
        _save_run_artifacts(
            run_dir,
            prompt,
            artifacts,
            is_storefront,
            is_admin_ui,
            intent=intent,
            plan=plan,
            hld_v_findings=hld_v_findings,
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
    if (
        resume_state
        and _resumed_idx >= _phase_index("validator")
        and _resumed_halt not in ("kept_originals", "revision_failed")
    ):
        # Validator+revision already settled successfully (no unresolved
        # findings). Reuse artifacts + tokens, no LLM calls.
        if resume_state.get("validator_tokens"):
            tk = resume_state["validator_tokens"]
            all_tokens["validator"] = (int(tk.get("in", 0)), int(tk.get("out", 0)))
        # Use the merged artifacts from the prior run if revision swapped
        # storefront / admin_ui in.
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
        pre = resume_state.get("pre_revision_artifacts") or resume_state.get(
            "artifacts"
        )
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
            "duration_ms": (resume_state.get("validator_tokens") or {}).get(
                "duration_ms", 0
            ),
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
        _save_state(run_dir, all_tokens={k: list(v) for k, v in all_tokens.items()})
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
        _save_state(run_dir, all_tokens={k: list(v) for k, v in all_tokens.items()})

    if stop_after == "validator":
        # User-requested stop — mark done so the run drops out of the
        # resume list (same reasoning as stop_after=hld).
        _save_state(run_dir, checkpoint="done")
        total_ms = int((time.monotonic() - total_start) * 1000)
        _save_run_artifacts(
            run_dir,
            prompt,
            artifacts,
            is_storefront,
            is_admin_ui,
            intent=intent,
            plan=plan,
            hld_v_findings=hld_v_findings,
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
    explanation, exp_in, exp_out = _phase_explanation(
        intent, plan, artifacts, is_storefront, run_dir
    )
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
                backend_email_metadata=base_ctx.backend_email_metadata,
            )
            db_local.store_bundle(job_id, app_id, bundle)
        except Exception as exc:
            _log.info("DB bundle save failed: %s", exc, exc_info=True)
            _info(f"DB bundle save failed: {exc}")

    total_ms = int((time.monotonic() - total_start) * 1000)

    # ── Save report + generated files ─────────────────────────────────────────
    _save_generated_files(run_dir, artifacts, is_storefront, is_admin_ui, plan)
    # Always persist the canonical HLD output alongside the report.
    _save_hld_json(run_dir, prompt, intent, plan, [], "", hld_v_findings)
    merchant_facing = explanation.get("merchantFacing", "")
    lines = _md_pipeline_header("full", prompt, total_ms, all_tokens)
    lines += [
        "## Intent (Product Agent)",
        "",
        "```json",
        json.dumps(intent, indent=2),
        "```",
        "",
        "## HLD Plan",
        "",
        "See [`hld.json`](hld.json) for the canonical plan.",
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
    if base_ctx.backend_email_metadata is not None:
        lines += _email_metadata_md_lines(base_ctx.backend_email_metadata)
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
        ("backend", "handler.js"),
        ("migration", "migration.sql"),
        ("storefront", "widget.js"),
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
    try:
        main()
    except KeyboardInterrupt:
        # Stop spinners synchronously so the cancel message lands on a
        # clean line instead of being chewed by the live redraw loop.
        # `atexit._final_margin()` would also do this, but only after the
        # message we want to print here.
        _stop_spinner()
        _stop_spinner_group()
        print(f"\n  {_RED}Interrupted by user (Ctrl+C). Aborting.{_RESET}")
        # 130 is the conventional exit code for SIGINT.
        sys.exit(130)
    except Exception as exc:
        # Surface Anthropic API failures (overloaded, rate-limited, auth,
        # timeout) as a one-line message instead of a 30-frame traceback.
        # Imported here so the CLI still loads when `anthropic` is missing.
        from anthropic import APIError, APIStatusError, APITimeoutError

        if isinstance(exc, (APIError, APITimeoutError)):
            _stop_spinner()
            _stop_spinner_group()
            kind = "request timed out"
            hint = "rerun in a few seconds"
            if isinstance(exc, APIStatusError):
                status = getattr(exc, "status_code", "?")
                if status == 529:
                    kind = f"Anthropic API overloaded (HTTP {status})"
                    hint = "their servers are at capacity — wait ~30s and rerun"
                elif status == 429:
                    kind = f"rate limit hit (HTTP {status})"
                    hint = "wait a minute and rerun, or lower concurrency"
                elif status in (401, 403):
                    kind = f"auth error (HTTP {status})"
                    hint = "check ANTHROPIC_API_KEY"
                else:
                    kind = f"Anthropic API error (HTTP {status})"
                    hint = "retry; if it persists, check status.anthropic.com"
            req_id = getattr(getattr(exc, "response", None), "headers", {}).get(
                "request-id"
            ) if isinstance(exc, APIStatusError) else None
            print(f"\n  {_RED}✗ {kind}.{_RESET} {hint}.")
            if req_id:
                print(f"  {_DIM}request id: {req_id}{_RESET}")
            print(
                f"  {_DIM}resume this run:{_RESET} "
                f"./chat_local.py --resume <run-id> [--stop-after <phase>]"
            )
            sys.exit(2)
        # Anything else — let it surface as a traceback for debugging.
        raise
