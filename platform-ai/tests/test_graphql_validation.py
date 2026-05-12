"""
Tests for the offline GraphQL validator.

Two tiers:
  - Unit tests with a tiny in-memory schema: cover query extraction,
    surface routing, parse-error handling, and validation findings.
    Run anywhere — no network, no committed catalog needed.
  - One real-catalog smoke test: runs against the committed admin schema
    if it's present. Skipped when the catalog isn't built yet.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from subagents.e_codegen_agent.backend_agent import graphql_check as graphql_validation
from subagents.e_codegen_agent.backend_agent.graphql_check import (
    _ADMIN_HELPERS,
    _STOREFRONT_HELPERS,
    _extract_queries,
    validate_handler_graphql,
)


# ── Helpers ────────────────────────────────────────────────────────────────────


_TINY_ADMIN_SDL = """
schema { query: Query mutation: Mutation }

type Query {
  order(id: ID!): Order
  orders(first: Int!, after: String): OrderConnection!
}

type Mutation {
  tagsAdd(id: ID!, tags: [String!]!): TagsAddPayload
}

type Order {
  id: ID!
  name: String!
  fulfillments: [Fulfillment!]!
}

type Fulfillment {
  trackingInfo: TrackingInfo
}

type TrackingInfo {
  number: String
  company: String
}

type OrderConnection {
  pageInfo: PageInfo!
  edges: [OrderEdge!]!
}

type OrderEdge {
  node: Order!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  endCursor: String
}

type TagsAddPayload {
  node: Order
  userErrors: [UserError!]!
}

type UserError {
  field: [String!]
  message: String!
  code: String
}
"""


def _bundle(*files: tuple[str, str]) -> str:
    parts = []
    for path, contents in files:
        parts.append(f"===FILE: {path}===\n{contents}\n===END===")
    return "\n".join(parts)


def _patch_admin_schema(monkeypatch):
    """Patch _load_schema to return the tiny admin schema for the admin surface."""
    from graphql import build_schema

    schema = build_schema(_TINY_ADMIN_SDL)

    def _fake_load(surface, version=None):
        if surface == "admin":
            return schema
        return None  # storefront catalog not patched in

    monkeypatch.setattr(graphql_validation, "_load_schema", _fake_load)


# ── Query extraction ──────────────────────────────────────────────────────────


def test_extract_simple_graphql_call() -> None:
    src = 'const r = await shopify.graphql(`query { order(id: "x") { id } }`);'
    out = _extract_queries("src/routes/cron.ts", src)
    assert len(out) == 1
    assert out[0][1] == "graphql"
    assert "order(id" in out[0][2]


def test_extract_paginate_call() -> None:
    src = (
        "for await (const nodes of shopify.graphqlPaginate(\n"
        "  `query Orders($cursor: String) { orders(first: 50, after: $cursor) { edges { node { id } } pageInfo { hasNextPage endCursor } } }`,\n"
        "  {}, 'orders'))"
    )
    out = _extract_queries("src/routes/cron.ts", src)
    assert len(out) == 1
    assert out[0][1] == "graphqlPaginate"


def test_extract_bulkquery_call() -> None:
    src = "for await (const o of shopify.bulkQuery(`{ orders { edges { node { id } } } }`)) {}"
    out = _extract_queries("src/routes/cron.ts", src)
    assert len(out) == 1
    assert out[0][1] == "bulkQuery"


def test_extract_storefront_call() -> None:
    src = 'const r = await shopify.storefront(`query { productByHandle(handle: "x") { id } }`);'
    out = _extract_queries("src/routes/cron.ts", src)
    assert len(out) == 1
    assert out[0][1] == "storefront"


def test_extract_typed_generic_call() -> None:
    # `shopify.graphql<OrderQuery>(\`...\`)` — the typed generic between name and parens.
    src = 'const r = await shopify.graphql<OrderQuery>(`query { order(id: "x") { id } }`);'
    out = _extract_queries("src/routes/cron.ts", src)
    assert len(out) == 1
    assert out[0][1] == "graphql"


def test_extract_replaces_template_interpolation() -> None:
    """`${id}` should become `_X` so graphql-core can still parse the query."""
    src = 'const r = await shopify.graphql(`query { order(id: "${orderId}") { id } }`);'
    out = _extract_queries("src/routes/cron.ts", src)
    assert "${orderId}" not in out[0][2]
    assert "_X" in out[0][2]


def test_extract_ignores_non_shopify_calls() -> None:
    src = (
        "const r = await someOther.graphql(`{ foo }`);\n"
        "const s = sql`SELECT * FROM x`;\n"
    )
    out = _extract_queries("src/routes/cron.ts", src)
    assert out == []


def test_extract_multiple_calls_in_one_file() -> None:
    src = (
        'const a = await shopify.graphql(`query A { order(id: "1") { id } }`);\n'
        'const b = await shopify.storefront(`query B { product(id: "2") { id } }`);\n'
    )
    out = _extract_queries("src/routes/cron.ts", src)
    assert len(out) == 2
    assert {o[1] for o in out} == {"graphql", "storefront"}


# ── Validation against tiny schema ────────────────────────────────────────────


def test_clean_query_passes(monkeypatch) -> None:
    _patch_admin_schema(monkeypatch)
    bundle = _bundle(
        (
            "src/routes/cron.ts",
            'await shopify.graphql(`query { order(id: "x") { id name } }`);',
        ),
    )
    assert validate_handler_graphql(bundle) == []


def test_unknown_field_is_flagged(monkeypatch) -> None:
    _patch_admin_schema(monkeypatch)
    bundle = _bundle(
        # `customer` is not a field on Order
        (
            "src/routes/cron.ts",
            'await shopify.graphql(`query { order(id: "x") { id customer } }`);',
        ),
    )
    findings = validate_handler_graphql(bundle)
    assert any("customer" in f for f in findings)


def test_missing_required_arg_is_flagged(monkeypatch) -> None:
    _patch_admin_schema(monkeypatch)
    bundle = _bundle(
        # orders requires `first: Int!`
        (
            "src/routes/cron.ts",
            "await shopify.graphql(`query { orders { edges { node { id } } } }`);",
        ),
    )
    findings = validate_handler_graphql(bundle)
    assert any("first" in f.lower() for f in findings)


def test_wrong_arg_type_is_flagged(monkeypatch) -> None:
    _patch_admin_schema(monkeypatch)
    bundle = _bundle(
        # orders expects `first: Int!`, we pass a String
        (
            "src/routes/cron.ts",
            'await shopify.graphql(`query { orders(first: "fifty") { edges { node { id } } } }`);',
        ),
    )
    findings = validate_handler_graphql(bundle)
    assert findings, "expected validation error for non-Int first arg"


def test_parse_error_is_flagged(monkeypatch) -> None:
    _patch_admin_schema(monkeypatch)
    bundle = _bundle(
        # missing closing brace
        (
            "src/routes/cron.ts",
            'await shopify.graphql(`query { order(id: "x") { id `);',
        ),
    )
    findings = validate_handler_graphql(bundle)
    assert findings
    assert any("parse error" in f.lower() for f in findings)


def test_finding_includes_file_path_and_helper(monkeypatch) -> None:
    _patch_admin_schema(monkeypatch)
    bundle = _bundle(
        (
            "src/routes/cron.ts",
            'await shopify.graphql(`query { order(id: "x") { fakeField } }`);',
        ),
    )
    findings = validate_handler_graphql(bundle)
    assert findings
    assert "src/routes/cron.ts" in findings[0]
    assert "shopify.graphql" in findings[0]


def test_storefront_query_skipped_when_catalog_missing(monkeypatch) -> None:
    """If only admin schema is patched in, storefront queries skip silently."""
    _patch_admin_schema(monkeypatch)
    bundle = _bundle(
        (
            "src/routes/widget.ts",
            'await shopify.storefront(`query { product(id: "x") { fakeField } }`);',
        ),
    )
    # No findings — storefront catalog returns None → skip.
    assert validate_handler_graphql(bundle) == []


def test_admin_and_storefront_routed_independently(monkeypatch) -> None:
    """Admin queries validate, storefront queries skip when only admin loaded."""
    _patch_admin_schema(monkeypatch)
    bundle = _bundle(
        (
            "src/routes/admin.ts",
            'await shopify.graphql(`query { order(id: "x") { fakeAdminField } }`);',
        ),
        (
            "src/routes/widget.ts",
            'await shopify.storefront(`query { product(id: "x") { fakeField } }`);',
        ),
    )
    findings = validate_handler_graphql(bundle)
    # Only the admin finding fires — storefront query has no schema to check against.
    assert len(findings) >= 1
    assert all("shopify.graphql" in f for f in findings)
    assert all("shopify.storefront" not in f for f in findings)


# ── Graceful skips ────────────────────────────────────────────────────────────


def test_returns_empty_for_empty_bundle() -> None:
    assert validate_handler_graphql("") == []


def test_returns_empty_for_non_bundle_input() -> None:
    assert validate_handler_graphql("just plain text, no markers") == []


def test_returns_empty_when_no_shopify_calls(monkeypatch) -> None:
    _patch_admin_schema(monkeypatch)
    bundle = _bundle(
        ("src/routes/cron.ts", "const r = await sql`SELECT * FROM orders`;"),
    )
    assert validate_handler_graphql(bundle) == []


# ── Routing constants ─────────────────────────────────────────────────────────


def test_admin_helpers_set() -> None:
    assert _ADMIN_HELPERS == {"graphql", "graphqlPaginate", "bulkQuery"}


def test_storefront_helpers_set() -> None:
    assert _STOREFRONT_HELPERS == {"storefront"}


def test_helpers_disjoint() -> None:
    assert _ADMIN_HELPERS.isdisjoint(_STOREFRONT_HELPERS)


# ── Real-catalog smoke test ───────────────────────────────────────────────────
#
# Only runs if the admin catalog is committed. Catches regressions in schema
# loading, regex extraction against real handler shapes, and graphql-core
# version drift that mocks would miss.


_CATALOG_PRESENT = (
    Path(__file__).resolve().parent.parent
    / "catalogs"
    / "shopify_admin"
    / "2026-04"
    / "schema.graphql"
).exists()


@pytest.mark.skipif(
    not _CATALOG_PRESENT,
    reason="admin catalog not committed for 2026-04; run refresh_shopify_graphql_catalog.py",
)
def test_real_catalog_catches_unknown_field() -> None:
    # Clear the schema cache so we hit the real catalog, not whatever a
    # previous test patched in.
    graphql_validation._schema_cache.clear()
    bundle = _bundle(
        (
            "src/routes/cron.ts",
            (
                # `fakeFieldXYZ` does not exist on Order in the real schema.
                'await shopify.graphql(`query { order(id: "gid://shopify/Order/1") '
                "{ id fakeFieldXYZ } }`);"
            ),
        ),
    )
    findings = validate_handler_graphql(bundle)
    assert findings, "expected real catalog to flag fakeFieldXYZ as unknown"
    assert any("fakeFieldXYZ" in f for f in findings)


@pytest.mark.skipif(
    not _CATALOG_PRESENT,
    reason="admin catalog not committed for 2026-04",
)
def test_real_catalog_passes_clean_query() -> None:
    graphql_validation._schema_cache.clear()
    bundle = _bundle(
        (
            "src/routes/cron.ts",
            (
                "await shopify.graphql(`query GetOrder($id: ID!) { order(id: $id) "
                "{ id name } }`);"
            ),
        ),
    )
    assert validate_handler_graphql(bundle) == []
