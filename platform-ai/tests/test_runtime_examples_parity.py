"""Parity: the runtime_examples docs on disk ↔ the registries that surface them.

Runtime examples are NOT auto-discovered — the coding agent only learns a
kind exists from the hardcoded "Available kinds" list in
`w_coding_agent/prompt.py` (§4). A doc that exists on disk but is missing
from that list is invisible to the agent (the `shopify_resolutions` gap
this guards against); a kind listed in the prompt with no file behind it
sends the agent on a failing `read_file`.

These tests pin the two together in both directions.
"""

from __future__ import annotations

import re
from pathlib import Path

from subagents.w_coding_agent.prompt import SYSTEM_PROMPT_TEMPLATE

_EXAMPLES_DIR = Path(__file__).resolve().parents[1] / "context" / "runtime_examples"


def _kinds_on_disk() -> set[str]:
    return {p.stem for p in _EXAMPLES_DIR.glob("*.md")}


def _kinds_in_prompt() -> set[str]:
    m = re.search(r"Available kinds:\s*(.*?)\.\n", SYSTEM_PROMPT_TEMPLATE, re.DOTALL)
    assert m, (
        "w_coding_agent/prompt.py lost its 'Available kinds:' list — that is "
        "the only place the coding agent learns which runtime_examples exist."
    )
    return {k.strip() for k in m.group(1).replace("\n", " ").split(",") if k.strip()}


def test_every_doc_on_disk_is_listed_in_the_prompt() -> None:
    missing = sorted(_kinds_on_disk() - _kinds_in_prompt())
    assert not missing, (
        f"context/runtime_examples/ has doc(s) {missing} that the coding "
        f"agent's 'Available kinds' list (w_coding_agent/prompt.py §4) does "
        f"not mention. The agent reads docs on demand by kind name — an "
        f"unlisted doc is never read. Add the kind(s) to the list."
    )


def test_every_listed_kind_has_a_doc_on_disk() -> None:
    phantom = sorted(_kinds_in_prompt() - _kinds_on_disk())
    assert not phantom, (
        f"The coding agent's 'Available kinds' list names {phantom} but "
        f"context/runtime_examples/ has no such file(s) — the agent's "
        f"read_file on them will fail. Create the doc(s) or drop the entries."
    )


def test_resolutions_doc_has_discovery_procedure() -> None:
    doc = (_EXAMPLES_DIR / "shopify_resolutions.md").read_text()
    for needle in ("DISCOVERY PROCEDURE", "search_shopify_ops"):
        assert needle in doc, (
            f"shopify_resolutions.md lost its '{needle}' section — the doc is "
            f"a fast-path, NOT a closed whitelist; without the discovery "
            f"fallback the model dead-ends (and fabricates) on uncovered needs."
        )
