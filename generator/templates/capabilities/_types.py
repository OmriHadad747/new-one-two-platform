"""
Shared Capability NamedTuple used by every scoped registry.

Kept in a private leaf module so the registry files (handler.py, widget.py,
admin.py) can import it without triggering a circular import via the package
__init__.
"""

from __future__ import annotations

from typing import NamedTuple


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
