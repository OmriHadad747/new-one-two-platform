"""
ui.py — terminal rendering for the chat CLI.

Every ANSI colour, layout decision, text-wrap, box, and the threaded spinner
lives here. Orchestration code (pipeline.py, chat_local.py) calls these helpers
and never emits escape codes directly, so the look stays consistent and is
tweakable in one place.

Visual vocabulary
-----------------
  ◆   phase header / banner marker
  ▸   assistant ("Ton") speaker bubble
  ▹   merchant ("You") echo bubble
  ✓✗  agent result (ok / failed)
  ↻   agent retry

Two registers share the palette: conversation turns use chat bubbles
(Ton / You), pipeline phases use compact agent lines with timing + token notes.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
import textwrap
import threading
import time
from typing import Dict, List, Optional, Sequence, Tuple

# ── Colour + width ─────────────────────────────────────────────────────────────

# Read once at import — most terminals don't resize mid-run, and recomputing
# per line would cost a syscall every print. Clamped to [60, 120] for layout.
W = max(60, min(120, shutil.get_terminal_size((100, 20)).columns))

# Honour NO_COLOR (https://no-color.org) and non-TTY stdout (pipes, CI logs).
USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
MAGENTA = "\033[35m"
BLUE = "\033[34m"

# Per-agent accent colours so progress lines don't read as a grey wall.
AGENT_COLOR: Dict[str, str] = {
    "Ton": CYAN,
    "Product": CYAN,
    "HLD": MAGENTA,
    "HLD (revise)": MAGENTA,
    "HLD Check": MAGENTA,
    "Coding": BLUE,
}

# Base indent for every bubble body / hint line.
_PAD = "  "


def c(text: str, *codes: str) -> str:
    """Wrap text in ANSI codes, or pass-through when colour is off."""
    return f"{''.join(codes)}{text}{RESET}" if USE_COLOR else text


# Strip ANSI SGR escapes when measuring display width — colour codes add bytes
# but take zero visible columns; padding math must ignore them.
_ANSI_SGR_RE = re.compile(r"\x1b\[[0-9;]*m")


def visible_len(s: str) -> int:
    return len(_ANSI_SGR_RE.sub("", s))


# ── Banner + headers ────────────────────────────────────────────────────────────

_BANNER_ROWS = [
    "████████╗ ██████╗ ███╗   ██╗",
    "╚══██╔══╝██╔═══██╗████╗  ██║",
    "   ██║   ██║   ██║██╔██╗ ██║",
    "   ██║   ██║   ██║██║╚██╗██║",
    "   ██║   ╚██████╔╝██║ ╚████║",
    "   ╚═╝    ╚═════╝ ╚═╝  ╚═══╝",
]
_BANNER_COLORS = [MAGENTA, MAGENTA, BLUE, BLUE, CYAN, CYAN]


def banner(subtitle: str) -> None:
    """Print the TON banner with a subtle magenta→cyan gradient."""
    print()
    for row, color in zip(_BANNER_ROWS, _BANNER_COLORS):
        print(f"  {c(row, color, BOLD)}")
    print(f"\n  {c('◆', MAGENTA)} {c(subtitle, BOLD)}")
    print(f"  {c('Ctrl+C / Ctrl+D at any prompt to bail.', DIM)}\n")


def hr(char: str = "─") -> None:
    print(c(char * W, DIM))


def phase_header(label: str) -> None:
    """Bold divider between major pipeline phases."""
    bar = "─" * max(0, W - len(label) - 6)
    print(f"\n  {c('◆', MAGENTA)} {c(label, BOLD)}  {c(bar, DIM)}\n")


# ── Token formatting ────────────────────────────────────────────────────────────


def ktok(n: int) -> str:
    """Format token counts: 1234 → '1.2k', 1234567 → '1.2M'."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def tok_note(
    in_tok: int,
    out_tok: int,
    suffix: Optional[str] = None,
    cache_read: int = 0,
    cache_create: int = 0,
) -> str:
    """Dim one-liner: 'in=… (cache hit …) out=… [suffix]'. Already coloured."""
    parts = [f"in={ktok(in_tok)}"]
    if cache_read or cache_create:
        total = in_tok + cache_create + cache_read
        if total:
            hit = (cache_read / total) * 100
            parts.append(f"(cache hit {ktok(cache_read)}={hit:.0f}%)")
    parts.append(f"out={ktok(out_tok)}")
    if suffix:
        parts.append(suffix)
    return c(" ".join(parts), DIM)


# ── Agent lines + retry + spinner ───────────────────────────────────────────────


def agent_line(name: str, ok: bool, ms: Optional[int], notes: str = "") -> None:
    """One compact result line for a pipeline phase: '<name> ✓ 1.2s  notes'."""
    mark = c("✓", GREEN) if ok else c("✗", RED)
    ms_str = f"{ms / 1000:.1f}s" if ms is not None else ""
    color = AGENT_COLOR.get(name, CYAN)
    print(f"  {c(name.ljust(14), color, BOLD)} {mark}  {ms_str:>7s}  {notes}")


def retry_line(name: str, notes: str = "") -> None:
    color = AGENT_COLOR.get(name, CYAN)
    print(f"  {c(name.ljust(14), color, BOLD)} {c('↻', YELLOW)}            {c(notes, DIM)}")


class Spinner:
    """Background braille spinner next to an agent label. No-op on non-TTY."""

    _chars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

    def __init__(self, label: str) -> None:
        self.label = label
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if not USE_COLOR:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        color = AGENT_COLOR.get(self.label, CYAN)
        start = time.monotonic()
        i = 0
        while not self._stop.is_set():
            elapsed = time.monotonic() - start
            # Live elapsed clock so it's obvious the agent is working (and
            # whether the LLM is crawling vs the process hanging). Blank for
            # the first second to avoid a flickery "0.0s".
            clock = f"{elapsed:4.1f}s" if elapsed >= 1 else "     "
            sys.stdout.write(
                f"\r  {c(self.label.ljust(14), color, BOLD)} "
                f"{c(self._chars[i], DIM)}  {c(clock, DIM)}"
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


# ── Run summary box ─────────────────────────────────────────────────────────────


def summary_box(title: str, rows: List[Tuple[str, str]]) -> None:
    """Rounded-corner box for the final run summary."""
    label_w = max((visible_len(l) for l, _ in rows), default=8)
    value_w = max((visible_len(v) for _, v in rows), default=8)
    inner = max(label_w + value_w + 5, visible_len(title) + 4)
    print(f"  {c('╭' + '─' * inner + '╮', DIM)}")
    pad = inner - visible_len(title) - 2
    print(f"  {c('│', DIM)} {c(title, BOLD)}{' ' * pad} {c('│', DIM)}")
    print(f"  {c('├' + '─' * inner + '┤', DIM)}")
    for label, value in rows:
        lpad = label_w - visible_len(label)
        vpad = value_w - visible_len(value)
        print(
            f"  {c('│', DIM)} {c(label, DIM)}{' ' * lpad}  "
            f"{value}{' ' * vpad}  {c('│', DIM)}"
        )
    print(f"  {c('╰' + '─' * inner + '╯', DIM)}")


# ── Chat bubbles + conversation ──────────────────────────────────────────────────


def _wrap_body(text: str, width: int) -> List[str]:
    """Wrap a (possibly multi-line) body to `width`, preserving blank lines and
    giving bullet lines ('• …') a hanging indent so continuations align."""
    out: List[str] = []
    for raw in text.splitlines() or [""]:
        line = raw.rstrip()
        if not line:
            out.append("")
            continue
        stripped = line.lstrip()
        lead = len(line) - len(stripped)
        hang = " " * (lead + 2) if stripped.startswith("• ") else " " * lead
        wrapped = textwrap.fill(
            line,
            width=max(20, width),
            subsequent_indent=hang,
            break_long_words=False,
            break_on_hyphens=False,
        )
        out.extend(wrapped.splitlines())
    return out


def _bubble(text: str, marker: str, marker_color: str, label: str, label_color: str) -> None:
    print()
    print(f"{c(marker, marker_color)} {c(label, label_color, BOLD)}")
    for line in _wrap_body(text, W - len(_PAD)):
        print(f"{_PAD}{line}" if line else "")


def bot(text: str, label: str = "Ton") -> None:
    """Assistant message bubble — wrapped under a 'Ton' speaker label."""
    _bubble(text, "▸", MAGENTA, label, CYAN)


def you(text: str) -> None:
    """Echo a merchant message as a 'You' bubble (initial / file prompt)."""
    _bubble(text, "▹", BLUE, "You", BLUE)


def suggestions(items: Sequence[str]) -> None:
    """Numbered, wrapped suggestion list under a question."""
    print()
    pad = 8  # '    NN  '
    for i, s in enumerate(items, 1):
        lines = textwrap.wrap(
            s, width=max(20, W - pad), break_long_words=False, break_on_hyphens=False
        ) or [""]
        print(f"    {c(f'{i:>2}', CYAN, BOLD)}  {lines[0]}")
        for cont in lines[1:]:
            print(f"{' ' * pad}{cont}")
    print()


def hint(text: str) -> None:
    """Dim guidance line at base indent (applies its own colour)."""
    print(f"{_PAD}{c(text, DIM)}")


def meta(text: str) -> None:
    """Print an already-styled line (e.g. tok_note) at base indent — no extra colour."""
    print(f"{_PAD}{text}")


def echo_choice(text: str) -> None:
    """Confirm a picked suggestion: '  → <text>'."""
    print(f"{_PAD}{c('→ ' + text, DIM)}")


def spec_summary(summary: str) -> None:
    """Render the merchant-facing `ready` summary as a framed block."""
    print()
    print(f"  {c('◆', GREEN)} {c('Spec summary', BOLD)}")
    rule = "─" * max(0, W - len(_PAD) - 2)
    print(f"{_PAD}{c(rule, DIM)}")
    for line in _wrap_body(summary, W - len(_PAD)):
        print(f"{_PAD}{line}" if line else "")
    print(f"{_PAD}{c(rule, DIM)}")


def ask(label: str = "You") -> str:
    """Read one line of merchant input. Ctrl-C / Ctrl-D bail the run cleanly."""
    try:
        raw = input(f"\n{c(label, BLUE, BOLD)} {c('›', DIM)} ")
    except (EOFError, KeyboardInterrupt):
        print(f"\n{_PAD}{c('bye.', DIM)}")
        sys.exit(0)
    return raw.strip()


def ask_initial() -> str:
    """First-turn prompt for a fresh interactive run."""
    bot("What would you like to build? Describe your app in a sentence or two.")
    return ask("You")


# ── Findings (HLD validator) ─────────────────────────────────────────────────────


def findings(items: Sequence[Dict]) -> None:
    sev_color = {"critical": RED, "important": YELLOW, "minor": DIM}
    for f in items:
        sev = f.get("severity", "?")
        sc = sev_color.get(sev, DIM)
        loc = f.get("location", "")
        issue = (f.get("issue", "") or "")[:120]
        print(f"    {c('•', sc)} {c('[' + sev + ']', sc)}  {c(loc, DIM)}  {issue}")


# ── Misc lines ───────────────────────────────────────────────────────────────────


def note(text: str, color: str = DIM) -> None:
    """A single coloured line at base indent."""
    print(f"{_PAD}{c(text, color)}")


def error(text: str) -> None:
    print(f"\n  {c(text, RED)}")
