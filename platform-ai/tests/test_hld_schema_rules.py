"""Unit tests for HLD structural validators (rules C, d1, and source:shopify).

All are deterministic, zero-FP cross-field checks added to `c_hld_agent.schema`:

  - C  (`Table._no_timestamp_in_uniqueness_key`): a `timestamp`-role column may
        not appear in `keyedByColumns` — a per-instant key defeats "once per X".
  - d1 (`ExternalContract._pagination_response_implies_list`): a responseShape
        that advertises pagination (a cursor field) but returns no `list` value
        is a single record masquerading as a paginated collection.
  - source:shopify (`Capability._shopify_needs_have_a_step`): a `dataNeed` marked
        `source:"shopify"` must live on a shopify-typed capability whose
        `shopifySteps` produce it — closes the dropped/fabricated live-value bug.

Each rule gets a positive (must reject) and negative (must accept) case so the
test doubles as the false-positive guard.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from subagents.c_hld_agent.schema import (
    Capability,
    Column,
    DataNeed,
    ExternalContract,
    ShopifyStep,
    Table,
)

# ── Rule C — timestamp not in uniqueness key ──────────────────────────


def _columns_with_detected() -> list[Column]:
    return [
        Column(name="id", role="identifier", nullable=False),
        Column(name="item_external_id", role="reference", nullable=False),
        Column(name="detected_at", role="timestamp", nullable=False),
        Column(
            name="detected_date",
            role="text",
            nullable=False,
            purpose="calendar day of detected_at, so dedup fires once per day",
        ),
    ]


def test_rule_C_rejects_timestamp_in_key():
    """The NM·Opus shape: keying on the raw `detected_at` timestamp."""
    with pytest.raises(ValidationError, match="role 'timestamp'"):
        Table(
            name="restock_detections",
            purpose="one detection per item per day",
            columns=_columns_with_detected(),
            keyedByColumns=["item_external_id", "detected_at"],
        )


def test_rule_C_accepts_derived_date_in_key():
    """The corrected shape: a derived calendar-day column in the key passes."""
    t = Table(
        name="restock_detections",
        purpose="one detection per item per day",
        columns=_columns_with_detected(),
        keyedByColumns=["item_external_id", "detected_date"],
    )
    assert t.keyedByColumns == ["item_external_id", "detected_date"]


def test_rule_C_inert_when_no_key():
    """A table with no dedup key is unaffected (timestamp column allowed)."""
    t = Table(
        name="events",
        purpose="append-only log",
        columns=_columns_with_detected(),
        keyedByColumns=[],
    )
    assert t.keyedByColumns == []


# ── Rule d1 — pagination in responseShape implies a list ──────────────


def _contract(response: dict[str, str], request: dict[str, str] | None = None) -> ExternalContract:
    return ExternalContract(
        surface="admin",
        path="/bundles",
        method="GET",
        purpose="list bundles",
        requestShape=request or {"cursor": "text"},
        responseShape=response,
    )


def test_rule_d1_rejects_cursor_without_list():
    """The BD·Sonnet shape: next_cursor + total_count on a single object."""
    with pytest.raises(ValidationError, match="advertises pagination"):
        _contract(
            {"bundle": "object", "next_cursor": "text", "total_count": "count"},
        )


def test_rule_d1_accepts_cursor_with_list():
    """A real paginated collection (cursor + list) passes."""
    c = _contract({"bundles": "list", "next_cursor": "text"})
    assert "bundles" in c.responseShape


def test_rule_d1_accepts_single_record_without_cursor():
    """A plain single-object response (no cursor) is fine — no FP."""
    c = ExternalContract(
        surface="admin",
        path="/bundle",
        method="GET",
        purpose="get one bundle",
        requestShape={"id": "identifier"},
        responseShape={"bundle": "object", "item_count": "count"},
    )
    assert c.responseShape["item_count"] == "count"


# ── source:shopify need must have a producing shopifyStep ─────────────
#
# (`Capability._shopify_needs_have_a_step`) The dropped-live-total bug: a
# capability promises a Shopify-owned value but carries no op to fetch it.


def _cap(*, integration, data_needs, steps=()):
    return Capability(
        id="compute-bundle-total",
        description="compute the bundle's live total",
        kind="compute",
        dataNeeds=list(data_needs),
        integration=integration,
        shopifySteps=list(steps),
    )


def test_shopify_need_on_non_shopify_capability_rejected():
    """The exact bug: a live price need on a compute/null capability."""
    with pytest.raises(ValidationError, match="source 'shopify'"):
        _cap(
            integration=None,
            data_needs=[DataNeed(name="variant live price", source="shopify")],
        )


def test_shopify_need_without_producing_step_rejected():
    """Shopify-typed with a step — but the step produces something else."""
    with pytest.raises(ValidationError, match="no shopifyStep produces it"):
        _cap(
            integration="shopify-storefront",
            data_needs=[DataNeed(name="variant live price", source="shopify")],
            steps=[ShopifyStep(op="node", produces="product title")],
        )


def test_shopify_need_with_matching_step_accepted():
    """The corrected shape: the step produces the named value (normalized)."""
    c = _cap(
        integration="shopify-storefront",
        data_needs=[DataNeed(name="variant live price", source="shopify")],
        steps=[ShopifyStep(op="node", produces="Variant_Live  Price")],
    )
    assert c.dataNeeds[0].source == "shopify"


def test_non_shopify_sources_need_no_step():
    """config / trigger / upstream needs on a null capability are fine — no FP."""
    c = _cap(
        integration=None,
        data_needs=[
            DataNeed(name="discount rate", source="config"),
            DataNeed(name="order total", source="trigger"),
            DataNeed(name="issuance id", source="upstream"),
        ],
    )
    assert [n.source for n in c.dataNeeds] == ["config", "trigger", "upstream"]
