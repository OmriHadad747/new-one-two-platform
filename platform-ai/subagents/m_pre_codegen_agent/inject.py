"""
Per-agent alignment-note dispatcher.

`format_alignment_for(notes, agent_name)` returns the prompt block that
each codegen agent appends to its user message. Output is empty when no
notes target the requested agent — callers can splice the return value
in unconditionally without an `if` guard.

Notes are dicts (as returned by `agent.run_pre_codegen`). The dispatcher
is deliberately string-based so consumers don't import the Pydantic
models at user-prompt build time.
"""

from __future__ import annotations

from typing import Any, Dict, List

# Header that visually separates the alignment block from the surrounding
# prompt. Matches the heavy-rule style used elsewhere in the codegen
# system prompts.
_HEADER = "━" * 60
_TITLE = "CROSS-AGENT ALIGNMENT — HONOUR THESE RULES VERBATIM"


def format_alignment_for(
    notes: List[Dict[str, Any]] | None,
    agent_name: str,
) -> str:
    """
    Return the alignment prompt block for `agent_name`.

    Empty string when:
      • `notes` is None or empty, OR
      • no note in the list targets `agent_name`.

    The block is short, imperative, and ordered by concern → instruction.
    Rationale is intentionally omitted from the injected text (it's for
    human audit, not for the consuming LLM).
    """
    if not notes:
        return ""

    relevant = [n for n in notes if agent_name in (n.get("target_agents") or [])]
    if not relevant:
        return ""

    lines = ["", _HEADER, _TITLE, _HEADER, ""]
    lines.append(
        "The pre-codegen alignment agent surfaced these cross-agent "
        "constraints by reading the FULL LLD. Apply each one exactly in "
        "the code you generate. These rules override any conflicting "
        "default behaviour:"
    )
    lines.append("")

    for i, note in enumerate(relevant, start=1):
        concern = note.get("concern", "alignment")
        instruction = (note.get("instruction") or "").strip()
        surfaces = note.get("surfaces") or []
        surfaces_str = ", ".join(surfaces[:3])
        if len(surfaces) > 3:
            surfaces_str += f", … (+{len(surfaces) - 3} more)"
        lines.append(f"  {i}. [{concern}] {instruction}")
        if surfaces_str:
            lines.append(f"     surfaces: {surfaces_str}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"
