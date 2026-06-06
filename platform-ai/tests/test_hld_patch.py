"""Unit tests for the HLD revise patch helper (`c_hld_agent.patch.apply_edits`).

`apply_edits` is the mechanism behind the revise pass: it applies the edits a
reviewer finding requires to the prior plan, addressed by capability `id` /
table `name`, and returns a NEW dict. It is schema-agnostic on purpose — the
loop re-validates the result against `HLDPlan` — so these tests pin the
addressing/mutation/atomicity contract, not plan validity.
"""

from __future__ import annotations

import copy

import pytest

from subagents.c_hld_agent.patch import PatchError, apply_edits


def _plan() -> dict:
    return {
        "complexity": "high",
        "dataFlow": "original",
        "edgeCases": ["a", "b"],
        "capabilities": [
            {"id": "process-restock-queue", "kind": "compute", "usesWorkflow": True,
             "shopifySteps": [{"op": "productVariant"}]},
            {"id": "send-email", "kind": "notify", "usesWorkflow": False},
        ],
        "persistence": [
            {"name": "restock_events", "keyedByColumns": ["id"]},
            {"name": "waitlist", "keyedByColumns": ["email", "item_external_id"]},
        ],
    }


def test_set_capability_field_by_id():
    out = apply_edits(
        _plan(), [{"path": "capabilities[process-restock-queue].kind", "value": "write"}]
    )
    assert out["capabilities"][0]["kind"] == "write"
    # untouched sibling unchanged
    assert out["capabilities"][1] == _plan()["capabilities"][1]


def test_set_table_list_field_by_name():
    out = apply_edits(
        _plan(),
        [{
            "path": "persistence[restock_events].keyedByColumns",
            "value": ["item_external_id", "status"],
        }],
    )
    assert out["persistence"][0]["keyedByColumns"] == ["item_external_id", "status"]


def test_set_top_level_scalar_and_list():
    out = apply_edits(_plan(), [
        {"path": "complexity", "value": "medium"},
        {"path": "edgeCases", "value": ["x", "y", "z"]},
    ])
    assert out["complexity"] == "medium"
    assert out["edgeCases"] == ["x", "y", "z"]


def test_replace_whole_element_by_id():
    new_cap = {"id": "process-restock-queue", "kind": "write", "usesWorkflow": True}
    out = apply_edits(_plan(), [{"path": "capabilities[process-restock-queue]", "value": new_cap}])
    assert out["capabilities"][0] == new_cap


def test_multiple_edits_apply_together():
    out = apply_edits(_plan(), [
        {"path": "capabilities[process-restock-queue].kind", "value": "write"},
        {"path": "capabilities[send-email].usesWorkflow", "value": True},
        {"path": "persistence[restock_events].keyedByColumns",
         "value": ["item_external_id", "status"]},
    ])
    assert out["capabilities"][0]["kind"] == "write"
    assert out["capabilities"][1]["usesWorkflow"] is True
    assert out["persistence"][0]["keyedByColumns"] == ["item_external_id", "status"]


def test_input_is_never_mutated():
    plan = _plan()
    snapshot = copy.deepcopy(plan)
    apply_edits(plan, [{"path": "capabilities[process-restock-queue].kind", "value": "write"}])
    assert plan == snapshot


def test_missing_id_raises():
    with pytest.raises(PatchError, match="no capabilities element"):
        apply_edits(_plan(), [{"path": "capabilities[does-not-exist].kind", "value": "write"}])


def test_missing_table_name_raises():
    with pytest.raises(PatchError, match="no persistence element"):
        apply_edits(_plan(), [{"path": "persistence[nope].keyedByColumns", "value": []}])


def test_ambiguous_id_raises():
    plan = _plan()
    plan["capabilities"].append({"id": "process-restock-queue", "kind": "read"})  # duplicate id
    with pytest.raises(PatchError, match="ambiguous"):
        apply_edits(plan, [{"path": "capabilities[process-restock-queue].kind", "value": "write"}])


def test_replace_whole_element_requires_object():
    with pytest.raises(PatchError, match="needs an object value"):
        apply_edits(_plan(), [{"path": "capabilities[send-email]", "value": "not-an-object"}])


def test_unknown_collection_raises():
    with pytest.raises(PatchError, match="not addressable by key"):
        apply_edits(_plan(), [{"path": "triggers[foo].kind", "value": "x"}])


def test_empty_edits_raises():
    with pytest.raises(PatchError, match="non-empty list"):
        apply_edits(_plan(), [])


def test_malformed_edit_raises():
    with pytest.raises(PatchError, match="'path' and 'value'"):
        apply_edits(_plan(), [{"path": "complexity"}])  # missing value
