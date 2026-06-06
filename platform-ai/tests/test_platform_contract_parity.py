"""Parity: the platform-contract DOC the agents read ↔ the validator that enforces it.

The "platform owns email content" rule must live where the design (c_hld_agent)
and review (e_hld_v_agent) agents can SEE it — the `platform_helpers.md` index,
which is injected into both. It is ENFORCED by the `_PLATFORM_OWNED_COLUMNS`
frozenset in `c_hld_agent/schema.py`. Those are two copies of the same fact; if
they drift, an agent stops knowing a rule the validator still enforces — exactly
the false-positive / wasted-loop class this contract was added to kill.

This test pins them together: every forbidden column name must be listed verbatim
in the doc's "Platform contract" section. Add a column to the validator → this
fails until you also document it (and vice-versa).
"""

from __future__ import annotations

from pathlib import Path

from subagents.c_hld_agent.schema import _PLATFORM_OWNED_COLUMNS

_DOC = Path(__file__).resolve().parents[1] / "context" / "platform_helpers.md"


def test_doc_lists_every_platform_owned_column() -> None:
    doc = _DOC.read_text()
    missing = sorted(c for c in _PLATFORM_OWNED_COLUMNS if c not in doc)
    assert not missing, (
        f"platform_helpers.md is missing platform-owned column(s) {missing} that "
        f"_PLATFORM_OWNED_COLUMNS (c_hld_agent/schema.py) rejects. The design and "
        f"review agents read the doc, not the validator — list every rejected "
        f"name in the 'Platform contract' section so they can't drift."
    )


def test_doc_has_platform_contract_section() -> None:
    doc = _DOC.read_text()
    assert "Platform contract" in doc, (
        "platform_helpers.md lost its 'Platform contract' section — that is the "
        "single place the architect and reviewer learn what the platform owns."
    )
