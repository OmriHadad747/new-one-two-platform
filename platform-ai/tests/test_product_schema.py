"""Unit tests for the `ProductIntent` schema's `excluded` field.

`excluded` is the blocklist the HLD family treats as authoritative: features
the merchant dropped during clarification or that were redirected as
out-of-scope. The design agents no longer see the raw merchant prompt, so
the intent (qualityBrief + excluded) is the SOLE source of scope — this test
pins the field's defaulting, round-trip, and the still-strict `extra="forbid"`
contract that guards against hallucinated keys.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from subagents.a_product_agent.schema import ProductIntent


def _base_kwargs(**overrides) -> dict:
    """A minimal valid backend intent; override fields per-test."""
    kwargs = {
        "triggerTypes": ["webhook"],
        "resources": ["orders"],
        "desiredOutcome": "Tag every paid order so the merchant can segment them.",
        "cronHint": None,
        "appCategory": "backend",
        "qualityBrief": "Tag each paid order exactly once; dedupe duplicate "
        "webhook deliveries; skip orders that are already tagged.",
    }
    kwargs.update(overrides)
    return kwargs


def test_excluded_defaults_to_empty_list():
    """Omitting `excluded` yields [] — the one-shot/no-drop common case."""
    intent = ProductIntent(**_base_kwargs())
    assert intent.excluded == []
    # Round-trips through the JSON dump the pipeline hands downstream.
    assert intent.model_dump(mode="json")["excluded"] == []


def test_excluded_records_dropped_features():
    """Explicitly ruled-out features survive validation + serialization."""
    dropped = ["quiet-hours / send-time windows", "purchase-conversion metric"]
    intent = ProductIntent(**_base_kwargs(excluded=dropped))
    assert intent.excluded == dropped
    assert intent.model_dump(mode="json")["excluded"] == dropped


def test_excluded_parses_from_json():
    """The agent emits JSON; `model_validate_json` is the real entry point."""
    intent = ProductIntent.model_validate_json(
        '{"triggerTypes": ["webhook"], "resources": ["orders"], '
        '"desiredOutcome": "Tag paid orders.", "cronHint": null, '
        '"appCategory": "backend", "qualityBrief": "Tag once, dedupe retries.", '
        '"excluded": ["quiet hours"]}'
    )
    assert intent.excluded == ["quiet hours"]


def test_extra_keys_still_forbidden():
    """`extra="forbid"` is unchanged — a hallucinated sibling key is rejected."""
    with pytest.raises(ValidationError):
        ProductIntent(**_base_kwargs(includedExtras=["nope"]))
