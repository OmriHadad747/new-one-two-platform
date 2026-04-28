"""
Tests for the architect-plan catalog gate added to `validate_architect_plan`.

The gate fails the architect attempt when a catalog row would later fail
either the Pydantic CatalogEntry constraints or the Zod CatalogEntrySchema
constraints at the wire boundary — empty path, leading-slash, length, and
method ∈ {GET, POST}. Without this gate, an invalid catalog passes
codegen and dead-letters at the Pub/Sub subscriber's Zod parse with no
signal in the codegen retry loop.

Regression armor for the post-mortem branch
(feature/sdk-method-aware-and-failure-debuggability) plus the audit
fix (claude/sdk-method-aware-fixups Commit 1).
"""

from __future__ import annotations

from typing import Any, Dict, List

from llm_validations.arch_plan import validate_architect_plan


# ── Helpers ────────────────────────────────────────────────────────────────────


def _plan_with_catalog(
    catalog: List[Dict[str, Any]],
    *,
    catalog_field: str = "adminApiCatalog",
    archetype: str = "backend_admin",
) -> Dict[str, Any]:
    """Build a minimal valid plan with the catalog under test."""
    return {
        "shopifyPlan": {"webhookTopics": [], "cronSchedule": None},
        "appContracts": {
            "handlerCapabilities": [],
            "shopifyGraphqlOperations": {"admin": [], "storefront": []},
            catalog_field: catalog,
        },
    }


def _catalog_errors(errors: List[str]) -> List[str]:
    """Filter to errors that mention catalog rows / paths / methods."""
    needles = ("path", "method", "Catalog", "Api")
    return [
        e
        for e in errors
        if any(n in e for n in needles)
        or "catalog" in e.lower()
    ]


# ── Path validation ──────────────────────────────────────────────────────────


def test_empty_path_rejected() -> None:
    plan = _plan_with_catalog(
        [{"path": "", "method": "GET"}], archetype="backend_admin"
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any("non-empty path" in e for e in errs), errs


def test_missing_path_field_rejected() -> None:
    plan = _plan_with_catalog([{"method": "GET"}], archetype="backend_admin")
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any("missing/empty `path`" in e for e in errs), errs


def test_path_without_leading_slash_rejected() -> None:
    plan = _plan_with_catalog(
        [{"path": "save", "method": "POST"}], archetype="backend_admin"
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any("must start with '/'" in e for e in errs), errs


def test_path_over_max_length_rejected() -> None:
    long_path = "/" + "x" * 600
    plan = _plan_with_catalog(
        [{"path": long_path, "method": "GET"}], archetype="backend_admin"
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any("chars (max 512" in e for e in errs), errs


def test_path_at_max_length_accepted() -> None:
    """511 chars (incl. leading /) is within the budget."""
    long_path = "/" + "x" * 511
    plan = _plan_with_catalog(
        [
            {
                "path": long_path,
                "method": "GET",
                "requestShape": {},
                "responseShape": {},
            }
        ],
        archetype="backend_admin",
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert not any("chars (max" in e for e in errs), errs


def test_path_parameter_still_rejected() -> None:
    """The pre-existing `:id` rule is preserved by the rewrite."""
    plan = _plan_with_catalog(
        [{"path": "/runs/:id", "method": "GET"}], archetype="backend_admin"
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any("path parameter" in e for e in errs), errs


# ── Method validation ────────────────────────────────────────────────────────


def test_method_get_accepted() -> None:
    plan = _plan_with_catalog(
        [
            {
                "path": "/list",
                "method": "GET",
                "requestShape": {},
                "responseShape": {},
            }
        ],
        archetype="backend_admin",
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert _catalog_errors(errs) == [], errs


def test_method_post_accepted() -> None:
    plan = _plan_with_catalog(
        [
            {
                "path": "/save",
                "method": "POST",
                "requestShape": {},
                "responseShape": {},
            }
        ],
        archetype="backend_admin",
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert _catalog_errors(errs) == [], errs


def test_method_delete_rejected() -> None:
    plan = _plan_with_catalog(
        [{"path": "/save", "method": "DELETE"}], archetype="backend_admin"
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any("'DELETE'" in e and "GET" in e for e in errs), errs


def test_method_patch_rejected() -> None:
    plan = _plan_with_catalog(
        [{"path": "/save", "method": "PATCH"}], archetype="backend_admin"
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any("'PATCH'" in e for e in errs), errs


def test_method_lowercase_accepted_via_upper() -> None:
    """Lowercase 'get' is normalized via .upper() before the membership check."""
    plan = _plan_with_catalog(
        [
            {
                "path": "/list",
                "method": "get",
                "requestShape": {},
                "responseShape": {},
            }
        ],
        archetype="backend_admin",
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert not any("must be 'GET' or 'POST'" in e for e in errs), errs


def test_method_omitted_accepted() -> None:
    """Method is optional — omitting it is legal (downstream defaults POST)."""
    plan = _plan_with_catalog(
        [
            {
                "path": "/save",
                "requestShape": {},
                "responseShape": {},
            }
        ],
        archetype="backend_admin",
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert not any("must be 'GET' or 'POST'" in e for e in errs), errs


def test_method_non_string_rejected() -> None:
    plan = _plan_with_catalog(
        [{"path": "/save", "method": 42}], archetype="backend_admin"
    )
    errs = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any("must be 'GET' or 'POST'" in e for e in errs), errs


# ── Both surfaces gated identically ──────────────────────────────────────────


def test_widget_catalog_gated() -> None:
    """The same rules apply to widgetApiCatalog."""
    plan = {
        "shopifyPlan": {"webhookTopics": [], "cronSchedule": None},
        "appContracts": {
            "handlerCapabilities": [],
            "shopifyGraphqlOperations": {"admin": [], "storefront": []},
            "widgetApiCatalog": [{"path": "save", "method": "DELETE"}],
            "widgetTargetTemplates": ["product"],
        },
    }
    errs = validate_architect_plan(plan, app_archetype="storefront_backend")
    assert any("must start with '/'" in e for e in errs), errs
    assert any("'DELETE'" in e for e in errs), errs


# ── Pydantic CatalogEntry parity (the wire boundary the gate defends) ────────


def test_pydantic_rejects_what_arch_plan_rejects() -> None:
    """
    Defense-in-depth: every shape `arch_plan.py` rejects must also fail
    Pydantic CatalogEntry construction. If this test fails, the two
    layers have drifted and an invalid catalog could slip through one
    gate but not the other.
    """
    from contract.validators import CatalogEntry
    from pydantic import ValidationError

    bad_inputs = [
        {"path": "", "method": "GET"},  # empty
        {"path": "/" + "x" * 600, "method": "GET"},  # too long
    ]
    for bad in bad_inputs:
        try:
            CatalogEntry(**bad)
            raise AssertionError(f"Pydantic accepted invalid catalog row: {bad}")
        except ValidationError:
            pass


def test_pydantic_accepts_what_arch_plan_accepts() -> None:
    """Inverse: a row that arch_plan deems valid must also build a CatalogEntry."""
    from contract.validators import CatalogEntry

    good = CatalogEntry(path="/foo", method="GET")
    assert good.path == "/foo" and good.method == "GET"
    # Lowercase is rejected by Pydantic Literal but arch_plan tolerates and
    # the slim builder upper-cases. Document the gap explicitly so a future
    # change that tightens arch_plan to reject lowercase keeps Pydantic
    # honest, and a relaxation in Pydantic flags here.
    from pydantic import ValidationError
    try:
        CatalogEntry(path="/foo", method="get")
        raise AssertionError("Pydantic should reject lowercase method")
    except ValidationError:
        pass
