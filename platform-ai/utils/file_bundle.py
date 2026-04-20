"""
File-bundle parser — the generator's multi-file output format.

The handler prompt (prompts/handler/_core.py) instructs the model to emit
one or more files inside explicit marker blocks:

  ===FILE: src/routes/webhook.ts===
  ... contents ...
  ===END===
  ===FILE: src/routes/admin.ts===
  ... contents ...
  ===END===

This module parses that format into a list of {path, contents} dicts.
Kept here (not inside handler_agent.py) because the same parser is used
by the static validator (per-file TS checks) and, after phase 2, by any
future generator that emits multi-file output.

Returned shape intentionally mirrors contract/validators.GeneratedFile
without importing it — this module is a low-level text helper and must
not pull in pydantic on import.
"""

from __future__ import annotations

import re
from typing import Dict, List

# Open and close markers. Anchored to line starts so an embedded string
# literal inside the file body (e.g. a comment referencing the marker
# format) can't be mistaken for a boundary.
_OPEN_RE = re.compile(r"^===FILE:\s*(?P<path>[^=\n]+?)\s*===\s*$", re.MULTILINE)
_CLOSE_RE = re.compile(r"^===END===\s*$", re.MULTILINE)


def parse_file_bundle(raw: str) -> List[Dict[str, str]]:
    """
    Parse a generator file-bundle string into [{path, contents}, ...].

    Behavior
    --------
    - Returns an empty list when the input contains no ``===FILE:`` marker.
      Callers decide whether that's an error (handler output must have
      files) or a fallback (migration output is single-file, no markers).
    - Duplicates on the same path are a protocol violation — the caller's
      validator surfaces them; this function just returns them in order.
    - Whitespace around the path name is stripped; the file contents are
      the raw text between the open-marker EOL and the close-marker line,
      with ONE leading newline trimmed (the open-marker line itself ended
      with "\\n"), preserving exact indentation on every other line.

    Malformed bundles (unclosed FILE blocks, overlapping markers, content
    before the first ``===FILE:``) are reported via ParseError so the
    caller can route them to the retry loop with a precise message.
    """
    entries: List[Dict[str, str]] = []
    opens = list(_OPEN_RE.finditer(raw))
    closes = list(_CLOSE_RE.finditer(raw))

    if not opens:
        return []

    if len(opens) != len(closes):
        raise ParseError(
            f"file bundle has {len(opens)} ===FILE:=== markers but "
            f"{len(closes)} ===END=== markers — every file must be closed"
        )

    for idx, open_m in enumerate(opens):
        close_m = closes[idx]
        if close_m.start() < open_m.end():
            raise ParseError(
                f"file #{idx + 1}: ===END=== appears before the matching "
                f"===FILE:=== marker"
            )
        # Confirm no second ===FILE:=== sits between this pair — that
        # would be a nested open, which the format doesn't allow.
        for other_open in opens[idx + 1 :]:
            if open_m.end() < other_open.start() < close_m.start():
                raise ParseError(
                    f"file #{idx + 1}: another ===FILE:=== marker appears "
                    f"before the closing ===END===; nesting is not allowed"
                )
            break  # only need to check the next open

        path = open_m.group("path").strip()
        if not path:
            raise ParseError(f"file #{idx + 1}: empty path in ===FILE:=== marker")
        # Content is the text between the open-marker's trailing newline
        # and the close-marker's line start. The open marker match ends
        # at the "===" on its own line; skip the following newline so the
        # first line of file contents starts at column 0.
        start = open_m.end()
        if raw[start : start + 1] == "\n":
            start += 1
        contents = raw[start : close_m.start()]
        # Trim exactly one trailing newline if present — it's an artifact
        # of the marker being on its own line, not part of the file.
        if contents.endswith("\n"):
            contents = contents[:-1]
        entries.append({"path": path, "contents": contents})

    return entries


def is_file_bundle(raw: str) -> bool:
    """True iff the string contains at least one ===FILE:=== marker."""
    return _OPEN_RE.search(raw) is not None


class ParseError(ValueError):
    """Raised when a file bundle's marker structure is malformed."""
