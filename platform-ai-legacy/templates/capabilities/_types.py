"""
Shared Capability NamedTuple and registry-rendering helpers.

Kept in a private leaf module so the registry files (handler.py, widget.py,
admin.py) can import it without triggering a circular import via the package
__init__.

Schema — concern-named, not verbosity-graded
---------------------------------------------
Each field describes the CONCERN it addresses, not the length of its content:

  short                         — architect-facing 1-line label (AVAILABLE list).
                                   Describes what the capability IS and when
                                   to declare it.
  docs                          — handler-facing full implementation prose.
                                   JIT-injected into the component prompt when
                                   the capability is declared. Signature, API
                                   examples, when-to-use guidance, detailed
                                   rules.
  packages                      — npm package names this capability authorizes
                                   the handler to require(). Drives
                                   ALLOWED_NPM_PACKAGES.
  usage_rule        — revision-agent-facing 1-line discipline rule
                                   rendered into the compact HARNESS_API_SURFACE
                                   via render_usage_rules(). Use ONLY
                                   when a capability has a "do it this way,
                                   not the other way" rule the revision agent
                                   must see without re-reading the full docs
                                   block. Empty otherwise.
  static_validation_anti_pattern_regex
                                — validator-facing regex. When matched in
                                   handler code the artifact is rejected and
                                   the error cites this capability. Use ONLY
                                   for capabilities that supersede a pattern
                                   the LLM reliably hand-rolls (today: REST
                                   paginate supersedes since_id / page_info).
                                   Not a catch-all discipline slot — patterns
                                   with noisy matches belong in the handler's
                                   dedicated FORBIDDEN_HANDLER_PATTERNS list
                                   (e.g. eval, setInterval, process.env) which
                                   are environment invariants, not capability-
                                   superseded.
"""

from __future__ import annotations

from typing import Mapping, NamedTuple


class Capability(NamedTuple):
    """A single capability entry — see module docstring for the field contract."""

    short: str
    docs: str = ""
    packages: tuple[str, ...] = ()
    usage_rule: str = ""
    static_validation_anti_pattern_regex: str = ""


def render_registry(
    registry: Mapping[str, Capability],
    indent: str = "    ",
) -> str:
    """
    Render a capability registry as an architect-facing bullet list of
    ``short`` entries. Deeper tiers (docs, usage rules) belong to readers
    that need them — the architect decides feasibility off the label alone.
    """
    return "\n".join(
        f'{indent}- "{name}" — {cap.short}' for name, cap in registry.items()
    )


def render_usage_rules(
    registry: Mapping[str, Capability],
    indent: str = "  ",
) -> str:
    """
    Render every capability's ``usage_rule`` as a bulleted block
    for inclusion in the revision agent's compact HARNESS_API_SURFACE prompt.

    Entries without a rule are skipped. Returns an empty string when no
    capability in the registry declares a rule, so the caller can include
    the block unconditionally without producing a dangling header.
    """
    lines = [
        f"{indent}- {cap.usage_rule}" for cap in registry.values() if cap.usage_rule
    ]
    return "\n".join(lines)
