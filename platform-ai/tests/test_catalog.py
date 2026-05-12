"""
Tests for subagents.c_ops_picker_agent.shopify_ops — load + slice + validate helpers used to
plumb the Shopify GraphQL catalog through the architect (full index) and
handler (sliced to architect-approved ops).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from subagents.c_ops_picker_agent import shopify_ops as catalog_mod
from subagents.c_ops_picker_agent.shopify_ops import (
    load_summary,
    slice_summary,
    validate_op_names,
)


# ── Real-catalog smoke tests (admin) ──────────────────────────────────────────
#
# The admin catalog is committed for 2026-04. Storefront may or may not be
# committed — gated separately.

_ADMIN_PATH = (
    Path(__file__).resolve().parent.parent
    / "catalogs"
    / "shopify_admin"
    / "2026-04"
    / "summary.md"
)
_STOREFRONT_PATH = (
    Path(__file__).resolve().parent.parent
    / "catalogs"
    / "shopify_storefront"
    / "2026-04"
    / "summary.md"
)


@pytest.fixture(autouse=True)
def _reset_caches() -> None:
    catalog_mod._reset_caches()


@pytest.mark.skipif(not _ADMIN_PATH.exists(), reason="admin catalog not committed")
def test_load_summary_returns_real_admin_index() -> None:
    raw = load_summary("admin")
    assert "## Queries" in raw
    assert "## Mutations" in raw
    assert "order(" in raw  # `order(id: ID!): Order` is a stable Admin op


@pytest.mark.skipif(not _ADMIN_PATH.exists(), reason="admin catalog not committed")
def test_slice_summary_picks_only_named_ops() -> None:
    sliced = slice_summary("admin", ["order", "tagsAdd"])
    # Both names must appear
    assert "order(" in sliced or "order:" in sliced
    assert "tagsAdd(" in sliced
    # An unrelated op like `customers(` must NOT
    assert "customers(" not in sliced


@pytest.mark.skipif(not _ADMIN_PATH.exists(), reason="admin catalog not committed")
def test_slice_keeps_query_mutation_split() -> None:
    sliced = slice_summary("admin", ["order", "tagsAdd"])
    # Slice preserves the section header pattern from the source
    assert "## Queries" in sliced
    assert "## Mutations" in sliced


@pytest.mark.skipif(not _ADMIN_PATH.exists(), reason="admin catalog not committed")
def test_validate_op_names_passes_real_ops() -> None:
    invalid = validate_op_names("admin", ["order", "orders", "tagsAdd"])
    assert invalid == []


@pytest.mark.skipif(not _ADMIN_PATH.exists(), reason="admin catalog not committed")
def test_validate_op_names_flags_unknown() -> None:
    invalid = validate_op_names("admin", ["order", "fakeOpXYZ"])
    assert invalid == ["fakeOpXYZ"]


@pytest.mark.skipif(
    not _STOREFRONT_PATH.exists(), reason="storefront catalog not committed"
)
def test_validate_op_names_storefront() -> None:
    # `product` is a Storefront root query
    invalid = validate_op_names("storefront", ["product"])
    assert invalid == []


# ── Behavior tests — graceful skips & shape ───────────────────────────────────


def test_unknown_surface_raises() -> None:
    with pytest.raises(ValueError):
        load_summary("not-a-surface")


def test_validate_op_names_empty_list() -> None:
    assert validate_op_names("admin", []) == []


def test_slice_summary_empty_list_returns_empty_string() -> None:
    assert slice_summary("admin", []) == ""


def test_load_returns_placeholder_when_catalog_missing(tmp_path, monkeypatch) -> None:
    # Point the catalog root at an empty tmpdir → both surfaces missing
    monkeypatch.setattr(catalog_mod, "_CATALOGS_ROOT", tmp_path)
    catalog_mod._reset_caches()
    out = load_summary("admin")
    assert "no Shopify admin catalog committed" in out


def test_slice_returns_empty_when_catalog_missing(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(catalog_mod, "_CATALOGS_ROOT", tmp_path)
    catalog_mod._reset_caches()
    assert slice_summary("admin", ["order"]) == ""


def test_validate_skips_when_catalog_missing(tmp_path, monkeypatch) -> None:
    # Missing catalog → return [] (graceful skip) rather than failing every
    # listed name; otherwise a missing-catalog state would block all runs.
    monkeypatch.setattr(catalog_mod, "_CATALOGS_ROOT", tmp_path)
    catalog_mod._reset_caches()
    assert validate_op_names("admin", ["whatever"]) == []
