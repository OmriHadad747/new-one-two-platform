"""
Contract test: the LLD runner stamps `step.example` onto every external-call
step before handing the plan to the backend codegen.

The backend prompt now relies on `step.example` as the canonical TypeScript
pattern for each external-call step. If a new external-call step kind is
added to the schema but its snippet bucket is not registered in
`platform_runtime_examples.py`, the backend model has nowhere to learn the
idiom. This test breaks loudly in that case.

Coverage:
  - every external-call step kind (shopify_query [single/paginate/bulk],
    shopify_mutation, email_send, email_send_batch, files_upload
    [small/large], enqueue, compute with money/config/workflow expressions)
  - sql_select inside an offset-paginated route
  - recursion into nested containers (decision / for_each / try_catch /
    sql_transaction)
"""

from __future__ import annotations

from subagents.i_lld_agent.agent import _enrich_with_runtime_examples


def _enrich(steps, *, route=None, ops_surface=None):
    """
    Run the runner's enrichment over a single recipe and return the
    mutated steps list. `route` lets the caller wire an offset-paginated
    route so the sql_select case fires.
    """
    triggered_by = route or "webhook:orders/paid"
    http_routes = {"widget": [], "admin": []}
    if route and route.startswith("admin:"):
        _, method, path = route.split(":", 2)
        http_routes["admin"].append(
            {"method": method, "path": path, "paginationKind": "offset"}
        )

    lld = {
        "capabilityRecipes": {
            "r1": {"triggeredBy": triggered_by, "steps": steps}
        },
        "httpRoutes": http_routes,
    }
    ops_picks = {
        "capabilities": [
            {"ops": [{"name": name, "surface": surface}]}
            for name, surface in (ops_surface or {}).items()
        ]
    }
    _enrich_with_runtime_examples(lld, ops_picks)
    return lld["capabilityRecipes"]["r1"]["steps"]


def test_shopify_query_single_gets_example() -> None:
    steps = _enrich(
        [{"kind": "shopify_query", "op": "customer", "paginationStrategy": "single"}],
        ops_surface={"customer": "admin"},
    )
    assert steps[0].get("example", "").strip(), "single shopify_query missing example"


def test_shopify_query_paginate_and_bulk_get_examples() -> None:
    steps = _enrich(
        [
            {"kind": "shopify_query", "op": "ordersConn", "paginationStrategy": "graphqlPaginate"},
            {"kind": "shopify_query", "op": "ordersBulk", "paginationStrategy": "bulkQuery"},
        ],
        ops_surface={"ordersConn": "admin", "ordersBulk": "admin"},
    )
    assert "graphqlPaginate" in steps[0]["example"]
    assert "bulkQuery" in steps[1]["example"]


def test_shopify_query_storefront_surface_gets_storefront_example() -> None:
    steps = _enrich(
        [{"kind": "shopify_query", "op": "publicProducts", "paginationStrategy": "single"}],
        ops_surface={"publicProducts": "storefront"},
    )
    assert "storefront" in steps[0]["example"].lower()


def test_shopify_mutation_gets_example() -> None:
    steps = _enrich([{"kind": "shopify_mutation", "op": "tagsAdd"}])
    assert "userErrors" in steps[0]["example"]


def test_email_send_and_batch_get_examples() -> None:
    steps = _enrich(
        [
            {"kind": "email_send", "to": "$email", "dataKeys": ["name"]},
            {"kind": "email_send_batch", "itemsBinding": "$rows"},
        ]
    )
    assert "platform.email.send" in steps[0]["example"]
    assert "sendBatch" in steps[1]["example"]


def test_files_upload_small_and_large_get_examples() -> None:
    steps = _enrich(
        [
            {"kind": "files_upload", "size": "small"},
            {"kind": "files_upload", "size": "large"},
        ]
    )
    assert "platform.files.upload" in steps[0]["example"]
    assert "uploadLarge" in steps[1]["example"]


def test_enqueue_gets_example() -> None:
    steps = _enrich([{"kind": "enqueue", "jobName": "process_row"}])
    assert "enqueueJob" in steps[0]["example"]


def test_compute_with_money_config_workflow_gets_example() -> None:
    steps = _enrich(
        [
            {"kind": "compute", "expression": "money.toMinorUnits(x, 'USD')"},
            {"kind": "compute", "expression": "await config.get('rate', 1)"},
            {"kind": "compute", "expression": "await workflow.attempt('t', id, {from: 'a'}, fn)"},
        ]
    )
    assert "money." in steps[0]["example"]
    assert "config." in steps[1]["example"]
    assert "workflow." in steps[2]["example"]


def test_compute_without_helper_call_has_no_example() -> None:
    # Plain JS compute (no money/config/workflow reference) intentionally
    # gets no snippet — the dispatch line in the backend prompt covers it.
    steps = _enrich([{"kind": "compute", "expression": "customerIdRaw ?? null"}])
    assert "example" not in steps[0]


def test_sql_select_in_offset_route_gets_paginate_example() -> None:
    steps = _enrich(
        [{"kind": "sql_select", "template": "SELECT * FROM t", "bindings": []}],
        route="admin:GET:/items",
    )
    assert "paginate" in steps[0]["example"]


def test_sql_select_outside_offset_route_has_no_example() -> None:
    steps = _enrich(
        [{"kind": "sql_select", "template": "SELECT * FROM t", "bindings": []}],
    )
    assert "example" not in steps[0]


def test_examples_propagate_into_nested_containers() -> None:
    # Cover all four nested-container kinds in one shot so a regression in
    # _walk_steps recursion shows up immediately.
    steps = _enrich(
        [
            {
                "kind": "decision",
                "condition": "x",
                "ifTrue": [{"kind": "shopify_mutation", "op": "tagsAdd"}],
                "ifFalse": [{"kind": "email_send", "to": "$e", "dataKeys": []}],
            },
            {
                "kind": "for_each",
                "source": "$rows",
                "iterationBinding": "row",
                "steps": [{"kind": "enqueue", "jobName": "j"}],
            },
            {
                "kind": "try_catch",
                "errorBinding": "err",
                "try": [{"kind": "shopify_query", "op": "q", "paginationStrategy": "single"}],
                "catch": [{"kind": "files_upload", "size": "small"}],
            },
            {
                "kind": "sql_transaction",
                "steps": [{"kind": "shopify_mutation", "op": "tagsAdd"}],
            },
        ],
        ops_surface={"q": "admin"},
    )

    decision, for_each, try_catch, sql_tx = steps
    assert decision["ifTrue"][0].get("example", "").strip()
    assert decision["ifFalse"][0].get("example", "").strip()
    assert for_each["steps"][0].get("example", "").strip()
    assert try_catch["try"][0].get("example", "").strip()
    assert try_catch["catch"][0].get("example", "").strip()
    assert sql_tx["steps"][0].get("example", "").strip()
