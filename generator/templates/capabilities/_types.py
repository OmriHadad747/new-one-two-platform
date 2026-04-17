"""
Shared Capability NamedTuple and registry-rendering helper.

Kept in a private leaf module so the registry files (handler.py, widget.py,
admin.py) can import it without triggering a circular import via the package
__init__.
"""

from __future__ import annotations

from typing import Mapping, NamedTuple


class Capability(NamedTuple):
    """
    A single capability entry.

    short — architect-facing summary. Appears in FEASIBILITY's AVAILABLE list.
            Keep to 1–2 lines; the architect uses it to decide whether to
            declare the capability, not to implement against it.
    docs  — component-generator-facing implementation prose. Injected
            verbatim into the component's prompt by the JIT when the
            capability appears in the declaration list. Include section
            header, API signature, usage rules, and examples.
            Empty string when no JIT'able docs exist yet (e.g. widget /
            admin capabilities whose JIT isn't built).
    """

    short: str
    docs: str = ""


def render_registry(
    registry: Mapping[str, Capability],
    indent: str = "    ",
) -> str:
    """
    Render a capability registry as an architect-facing bullet list.

    Only ``Capability.short`` is emitted — the full ``.docs`` blocks are consumed
    downstream by the handler (or future widget / admin) JIT, not by the architect.
    """
    return "\n".join(
        f'{indent}- "{name}" — {cap.short}' for name, cap in registry.items()
    )
