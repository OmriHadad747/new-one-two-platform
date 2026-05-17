"""
Tests for the method-aware cross-handler validators —
`validate_widget_backend_contract` and `validate_admin_backend_contract`.

The architect catalog declares `method: "GET" | "POST"` per path; the SDK
(host.call / bridge.call) encodes args as a query string for GET and as a
JSON body for POST. The cross-handler validators receive the catalog and
branch the slot they scan for in the route body — `req.query` for GET
routes, `req.body` for POST routes.

The four scenarios named in the post-mortem commit
(d46003a feat(sdk): method-aware host.call / bridge.call) plus the edge
cases the audit surfaced live here, so a regression in the branching
logic surfaces in CI rather than in the next failed merchant generation.

Both surfaces (widget host.call and admin bridge.call) share the helper
shape, so we parametrize across them.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

import pytest

from subagents.o_codegen_agent.cross_admin_backend import validate_admin_backend_contract
from subagents.o_codegen_agent.cross_widget_backend import validate_widget_backend_contract


# ── Surface fixtures ──────────────────────────────────────────────────────────

# Each surface is a triple of (validator, call-fn name, router name) so the
# parametrized cases below can construct admin/widget code interchangeably.
Surface = Dict[str, Any]

ADMIN_SURFACE: Surface = {
    "validator": validate_admin_backend_contract,
    "client_label": "admin UI",
    "ui_artifact_key": "admin_ui",
    "call_fn": "bridge.call",
    "mount_param": "bridge",
    "router": "adminRouter",
}

WIDGET_SURFACE: Surface = {
    "validator": validate_widget_backend_contract,
    "client_label": "widget",
    "ui_artifact_key": "storefront",
    "call_fn": "host.call",
    "mount_param": "host",
    "router": "widgetRouter",
}

ALL_SURFACES = [ADMIN_SURFACE, WIDGET_SURFACE]


def _ui(surface: Surface, call_body: str) -> str:
    return (
        f"export function mount(container, {surface['mount_param']}) {{\n"
        f"  {call_body}\n"
        f"}}\n"
    )


def _route(
    surface: Surface, method: str, path: str, body: str
) -> str:
    return (
        f"{surface['router']}.{method.lower()}('{path}', "
        "async (req, res) => {\n"
        f"  {body}\n"
        f"  res.json({{ ok: true }});\n"
        "});\n"
    )


def _run(
    surface: Surface,
    ui: str,
    handler: str,
    catalog: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, List[str]]:
    return surface["validator"](ui, handler, catalog)


# ── Scenario 1: GET-correct (catalog GET, handler reads req.query) ────────────


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_get_correct_no_errors(surface: Surface) -> None:
    catalog = [{"path": "/list", "method": "GET"}]
    ui = _ui(surface, f"{surface['call_fn']}('/list', {{ status: 'pending', limit: 25 }});")
    handler = _route(surface, "get", "/list", "const { status, limit } = req.query;")
    assert _run(surface, ui, handler, catalog) == {}


# ── Scenario 2: GET-wrong-bug (catalog GET, handler reads req.body) ───────────
# The exact failure that motivated this branch: cart-recovery generation
# 2026-04-28 had GET routes in the catalog but POST-shaped handlers.


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_get_wrong_bug_flagged_on_both_sides(surface: Surface) -> None:
    catalog = [{"path": "/list", "method": "GET"}]
    ui = _ui(surface, f"{surface['call_fn']}('/list', {{ status: 'pending' }});")
    handler = _route(surface, "get", "/list", "const { status } = req.body;")
    errors = _run(surface, ui, handler, catalog)
    # Both generators receive the error so retry feedback reaches each side.
    assert "backend" in errors
    assert surface["ui_artifact_key"] in errors
    msg = errors["backend"][0]
    assert "(GET)" in msg
    assert "req.query" in msg
    assert "silently discarded" in msg


# ── Scenario 3: POST-correct (catalog POST, handler reads req.body) ───────────


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_post_correct_no_errors(surface: Surface) -> None:
    catalog = [{"path": "/save", "method": "POST"}]
    ui = _ui(surface, f"{surface['call_fn']}('/save', {{ customerId: id, dark: true }});")
    handler = _route(
        surface, "post", "/save", "const { customerId, dark } = req.body;"
    )
    assert _run(surface, ui, handler, catalog) == {}


# ── Scenario 4: no-catalog-fallback (defaults to POST) ────────────────────────


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
@pytest.mark.parametrize("catalog", [None, []], ids=["none", "empty"])
def test_no_catalog_defaults_to_post(
    surface: Surface, catalog: Optional[List[Dict[str, Any]]]
) -> None:
    """Match the SDK fallback: a path absent from the manifest is POST."""
    ui = _ui(surface, f"{surface['call_fn']}('/save', {{ x: 1 }});")
    handler = _route(surface, "post", "/save", "const { x } = req.body;")
    assert _run(surface, ui, handler, catalog) == {}


# ── Field-mismatch scenarios ──────────────────────────────────────────────────


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_get_extra_field_flagged(surface: Surface) -> None:
    """Sender includes a field the handler doesn't read — flagged."""
    catalog = [{"path": "/list", "method": "GET"}]
    ui = _ui(
        surface,
        f"{surface['call_fn']}('/list', {{ status: 'x', limit: 1, sortBy: 'date' }});",
    )
    handler = _route(surface, "get", "/list", "const { status, limit } = req.query;")
    errors = _run(surface, ui, handler, catalog)
    assert "backend" in errors
    assert "sortBy" in errors["backend"][0]
    assert "(GET)" in errors["backend"][0]


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_post_extra_field_flagged(surface: Surface) -> None:
    catalog = [{"path": "/save", "method": "POST"}]
    ui = _ui(surface, f"{surface['call_fn']}('/save', {{ a: 1, b: 2, c: 3 }});")
    handler = _route(surface, "post", "/save", "const { a, b } = req.body;")
    errors = _run(surface, ui, handler, catalog)
    assert "backend" in errors
    assert "c" in errors["backend"][0]
    assert "(POST)" in errors["backend"][0]


# ── Edge cases — silent-skip behavior is documented; verify it stays silent ──


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_dynamic_path_silently_skipped(surface: Surface) -> None:
    """Template-literal path can't be statically matched → silent skip."""
    catalog: List[Dict[str, Any]] = []
    ui = _ui(surface, f"{surface['call_fn']}(`/runs/${{id}}`, {{ dryRun: true }});")
    handler = _route(surface, "post", "/runs/:id", "const { dryRun } = req.body;")
    assert _run(surface, ui, handler, catalog) == {}


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_call_with_no_args_silently_skipped(surface: Surface) -> None:
    """Call with no body block doesn't match the regex → no false flag."""
    catalog = [{"path": "/ping", "method": "POST"}]
    ui = _ui(surface, f"{surface['call_fn']}('/ping');")
    handler = _route(surface, "post", "/ping", "")
    assert _run(surface, ui, handler, catalog) == {}


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_route_absent_from_handler_skipped(surface: Surface) -> None:
    """Route-existence is checked elsewhere; cross-validator stays silent."""
    catalog = [{"path": "/missing", "method": "POST"}]
    ui = _ui(surface, f"{surface['call_fn']}('/missing', {{ x: 1 }});")
    handler = _route(surface, "post", "/other", "const { x } = req.body;")
    assert _run(surface, ui, handler, catalog) == {}


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_lowercase_method_in_catalog_normalized(surface: Surface) -> None:
    """`method: 'get'` should normalize to GET and trigger query-slot scan."""
    catalog = [{"path": "/list", "method": "get"}]
    ui = _ui(surface, f"{surface['call_fn']}('/list', {{ status: 'x' }});")
    # Handler reads req.body — wrong slot for GET — flagged.
    handler = _route(surface, "get", "/list", "const { status } = req.body;")
    errors = _run(surface, ui, handler, catalog)
    assert "backend" in errors
    assert "req.query" in errors["backend"][0]


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_unrecognized_method_silently_downgrades_to_post(
    surface: Surface,
) -> None:
    """`method: 'DELETE'` is not in {GET,POST} → falls back to POST.

    Note: the upstream gate is `arch_plan.py`'s catalog validation, which
    rejects unknown methods loudly. This test documents the cross-handler
    validator's defense-in-depth fallback (silent POST default) for the
    case where the upstream gate is bypassed.
    """
    catalog = [{"path": "/save", "method": "DELETE"}]
    ui = _ui(surface, f"{surface['call_fn']}('/save', {{ x: 1 }});")
    handler = _route(surface, "post", "/save", "const { x } = req.body;")
    assert _run(surface, ui, handler, catalog) == {}


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_non_string_path_in_catalog_skipped(surface: Surface) -> None:
    """Catalog rows with non-string path are dropped from the method-map."""
    catalog: List[Dict[str, Any]] = [
        {"path": 42, "method": "POST"},  # garbage row
        {"path": "/save", "method": "POST"},
    ]
    ui = _ui(surface, f"{surface['call_fn']}('/save', {{ x: 1 }});")
    handler = _route(surface, "post", "/save", "const { x } = req.body;")
    assert _run(surface, ui, handler, catalog) == {}


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_duplicate_path_last_method_wins(surface: Surface) -> None:
    """When the catalog has two rows for the same path, last write wins.

    Real catalogs shouldn't have duplicates; this test documents the
    deterministic behavior for defensive understanding.
    """
    catalog = [
        {"path": "/p", "method": "GET"},
        {"path": "/p", "method": "POST"},
    ]
    ui = _ui(surface, f"{surface['call_fn']}('/p', {{ x: 1 }});")
    # Method-map ends up POST; handler reads req.body → no error.
    handler = _route(surface, "post", "/p", "const { x } = req.body;")
    assert _run(surface, ui, handler, catalog) == {}


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_handler_reads_req_body_field_access(surface: Surface) -> None:
    """`req.body.x` direct-access is captured (not just destructure)."""
    catalog = [{"path": "/save", "method": "POST"}]
    ui = _ui(surface, f"{surface['call_fn']}('/save', {{ value: 1 }});")
    handler = _route(surface, "post", "/save", "const v = req.body.value;")
    assert _run(surface, ui, handler, catalog) == {}


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_handler_reads_req_query_field_access(surface: Surface) -> None:
    """`req.query.x` direct-access is captured for GET routes."""
    catalog = [{"path": "/list", "method": "GET"}]
    ui = _ui(surface, f"{surface['call_fn']}('/list', {{ status: 'x' }});")
    handler = _route(surface, "get", "/list", "const s = req.query.status;")
    assert _run(surface, ui, handler, catalog) == {}


@pytest.mark.parametrize("surface", ALL_SURFACES, ids=["admin", "widget"])
def test_empty_artifacts_short_circuit(surface: Surface) -> None:
    """Either side empty → returns immediately with no errors."""
    assert _run(surface, "", "handler code", None) == {}
    assert _run(surface, "ui code", "", None) == {}


# ── Observability: build_method_map warns on dropped rows ────────────────────
# The shared cross_handler.build_method_map silently defaults invalid
# methods to POST as defense-in-depth (arch_plan.py is the upstream
# loud-fail gate), but it logs WARNING when it does so. A real catalog
# coming from the architect should never trigger these — any line in
# production logs signals upstream drift worth investigating.


def test_build_method_map_warns_on_unknown_method(caplog) -> None:
    import logging

    from utils.static_validations.cross_handler import build_method_map

    with caplog.at_level(logging.WARNING, logger="utils.static_validations.cross_handler"):
        out = build_method_map([{"path": "/x", "method": "DELETE"}])
    assert out == {"/x": "POST"}
    assert any("DELETE" in rec.getMessage() for rec in caplog.records)


def test_build_method_map_warns_on_non_dict_entry(caplog) -> None:
    import logging

    from utils.static_validations.cross_handler import build_method_map

    with caplog.at_level(logging.WARNING, logger="utils.static_validations.cross_handler"):
        out = build_method_map(["not-a-dict", {"path": "/x", "method": "GET"}])
    assert out == {"/x": "GET"}
    assert any("not a dict" in rec.getMessage() for rec in caplog.records)


def test_build_method_map_warns_on_non_string_path(caplog) -> None:
    import logging

    from utils.static_validations.cross_handler import build_method_map

    with caplog.at_level(logging.WARNING, logger="utils.static_validations.cross_handler"):
        out = build_method_map([{"path": 42, "method": "GET"}])
    assert out == {}
    assert any("non-string path" in rec.getMessage() for rec in caplog.records)


def test_build_method_map_silent_on_valid_input(caplog) -> None:
    import logging

    from utils.static_validations.cross_handler import build_method_map

    with caplog.at_level(logging.WARNING, logger="utils.static_validations.cross_handler"):
        out = build_method_map(
            [{"path": "/a", "method": "GET"}, {"path": "/b", "method": "POST"}]
        )
    assert out == {"/a": "GET", "/b": "POST"}
    assert caplog.records == []
