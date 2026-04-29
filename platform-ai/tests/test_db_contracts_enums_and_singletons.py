"""
Cross-agent contract enforcement around dbContracts:
  - column-level `enum` lists drive the migration's CHECK constraint, the
    handler's literal-write set, and the admin UI's filter vocabulary.
  - table-level `singleton: true` swaps the UUID PK for a BOOLEAN sentinel
    so settings upserts target a stable conflict key.
  - `FOR UPDATE SKIP LOCKED` outside a `sql.begin(...)` block is rejected
    because postgres-js auto-commits per call (lock released too early).

Tests call validators and pure prompt-rendering helpers directly — no
LLM adapter, no anthropic SDK.
"""

from __future__ import annotations

from subagents.handler_agent import _format_db_contracts as handler_format_db
from subagents.migration_agent import _format_db_contracts as migration_format_db
from subagents.admin_ui_agent import _format_column_enums
from llm_validations.admin_ui_artifact import validate_admin_ui_artifact
from llm_validations.arch_plan import validate_architect_plan
from llm_validations.handler_artifact import validate_handler_artifact


# ── Finding 4 — singleton ─────────────────────────────────────────────────────


def test_architect_plan_rejects_singleton_with_id_column() -> None:
    plan = {
        "shopifyPlan": {"webhookTopics": [], "cronSchedule": None},
        "appContracts": {
            "feasibility": "feasible",
            "complexity": "low",
            "edgeCases": ["a", "b", "c"],
            "uxExpectations": {"storefront": None, "admin": "x"},
            "stateMachine": None,
            "platformGaps": [],
            "handlerCapabilities": [],
            "shopifyGraphqlOperations": {"admin": [], "storefront": []},
            "cronBatching": None,
            "dbContracts": [
                {
                    "table": "settings",
                    "singleton": True,
                    "columns": [
                        {
                            "name": "id",
                            "type": "UUID",
                            "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()",
                        },
                        {
                            "name": "delay_minutes",
                            "type": "INTEGER",
                            "constraints": "NOT NULL DEFAULT 60",
                        },
                    ],
                    "uniqueConstraint": None,
                    "indexes": [],
                }
            ],
            "webhookContract": None,
            "cronContract": None,
            "adminApiCatalog": [
                {
                    "path": "/settings",
                    "method": "GET",
                    "requestShape": {},
                    "responseShape": {"delay_minutes": "number"},
                }
            ],
            "adminCapabilities": [],
            "widgetTargetTemplates": None,
            "widgetApiCatalog": None,
            "widgetCapabilities": None,
        },
    }
    errors = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any(
        "singleton: true but also" in e and "'id' column" in e for e in errors
    ), errors


def test_migration_renders_singleton_pk_column() -> None:
    plan = {
        "appContracts": {
            "dbContracts": [
                {
                    "table": "settings",
                    "singleton": True,
                    "columns": [
                        {
                            "name": "delay_minutes",
                            "type": "INTEGER",
                            "constraints": "NOT NULL DEFAULT 60",
                        },
                    ],
                    "uniqueConstraint": None,
                    "indexes": [],
                }
            ]
        }
    }
    rendered = migration_format_db(plan)
    assert (
        "singleton  BOOLEAN  PRIMARY KEY DEFAULT true CHECK (singleton = true)"
        in rendered
    )


def test_handler_render_surfaces_singleton_upsert_pattern() -> None:
    plan = {
        "appContracts": {
            "dbContracts": [
                {
                    "table": "settings",
                    "singleton": True,
                    "columns": [
                        {
                            "name": "delay_minutes",
                            "type": "INTEGER",
                            "constraints": "NOT NULL DEFAULT 60",
                        },
                    ],
                    "uniqueConstraint": None,
                    "indexes": [],
                }
            ]
        }
    }
    rendered = handler_format_db(plan)
    assert "WHERE singleton = true" in rendered
    assert "ON CONFLICT (singleton) DO UPDATE" in rendered


# ── Finding 5 — FOR UPDATE SKIP LOCKED ────────────────────────────────────────


def _make_handler_bundle(cron_body: str) -> str:
    return (
        "===FILE: src/routes/cron.ts===\n"
        'import { sql } from "../lib/db.js";\n'
        'import { platform } from "../lib/platform.js";\n'
        "type JobFn = (payload: unknown) => Promise<void>;\n"
        "export const jobs: Record<string, JobFn> = {\n"
        "  main: async (_payload) => {\n"
        f"{cron_body}\n"
        "  },\n"
        "};\n"
        "===END===\n"
    )


# ── Finding 6 — enum cross-check ──────────────────────────────────────────────


_QUEUE_CONTRACTS = [
    {
        "table": "abandoned_cart_queue",
        "columns": [
            {
                "name": "id",
                "type": "UUID",
                "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()",
            },
            {
                "name": "status",
                "type": "TEXT",
                "constraints": "NOT NULL DEFAULT 'pending'",
                "enum": ["pending", "sent", "failed"],
            },
        ],
        "uniqueConstraint": None,
        "indexes": [],
    }
]


def test_architect_plan_rejects_default_outside_enum() -> None:
    plan = {
        "shopifyPlan": {"webhookTopics": [], "cronSchedule": None},
        "appContracts": {
            "feasibility": "feasible",
            "complexity": "low",
            "edgeCases": ["a", "b", "c"],
            "uxExpectations": {"storefront": None, "admin": "x"},
            "stateMachine": None,
            "platformGaps": [],
            "handlerCapabilities": [],
            "shopifyGraphqlOperations": {"admin": [], "storefront": []},
            "cronBatching": None,
            "dbContracts": [
                {
                    "table": "abandoned_cart_queue",
                    "columns": [
                        {
                            "name": "id",
                            "type": "UUID",
                            "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()",
                        },
                        {
                            "name": "status",
                            "type": "TEXT",
                            "constraints": "NOT NULL DEFAULT 'queued'",
                            "enum": ["pending", "sent", "failed"],
                        },
                    ],
                    "uniqueConstraint": None,
                    "indexes": [],
                }
            ],
            "webhookContract": None,
            "cronContract": None,
            "adminApiCatalog": [
                {
                    "path": "/queue",
                    "method": "GET",
                    "requestShape": {},
                    "responseShape": {"items": []},
                }
            ],
            "adminCapabilities": [],
            "widgetTargetTemplates": None,
            "widgetApiCatalog": None,
            "widgetCapabilities": None,
        },
    }
    errors = validate_architect_plan(plan, app_archetype="backend_admin")
    assert any("DEFAULT 'queued'" in e and "not in" in e for e in errors), errors


def test_migration_render_emits_check_for_enum() -> None:
    rendered = migration_format_db({"appContracts": {"dbContracts": _QUEUE_CONTRACTS}})
    assert "CHECK (status IN ('pending', 'sent', 'failed'))" in rendered


def test_handler_validator_flags_insert_with_unknown_status_literal() -> None:
    body = (
        "    await sql`INSERT INTO abandoned_cart_queue (id, status) "
        "VALUES (gen_random_uuid(), 'queued')`;"
    )
    errors = validate_handler_artifact(
        _make_handler_bundle(body),
        api_plan_topics=[],
        db_contracts=_QUEUE_CONTRACTS,
    )
    assert any(
        "'queued'" in e and "abandoned_cart_queue.status" in e for e in errors
    ), errors


def test_handler_validator_passes_when_literals_match_enum() -> None:
    body = (
        "    await sql`INSERT INTO abandoned_cart_queue (id, status) "
        "VALUES (gen_random_uuid(), 'pending')`;\n"
        "    await sql`UPDATE abandoned_cart_queue SET status = 'sent' WHERE id = ${id}`;"
    )
    errors = validate_handler_artifact(
        _make_handler_bundle(body),
        api_plan_topics=[],
        db_contracts=_QUEUE_CONTRACTS,
    )
    assert not any(
        "abandoned_cart_queue.status" in e or "column 'status'" in e for e in errors
    ), errors


# test_admin_ui_validator_flags_invented_status_filters was removed when
# the static `_check_admin_ui_enum_filters` heuristic was reclassified to
# `llm` (see ADMIN_UI_RULES.md row 23). The check failed three of four
# bars in the static-validation policy — non-trivial FP risk against
# UI-only `data-status` attributes (e.g. `data-status="loading"`) and
# error messages embedding literal comparisons; UX-degradation rather
# than catastrophic blast radius; and the canonical detection requires
# distinguishing UI-state attributes from dbContracts-column filter
# attributes, which is semantic work agent_rules can do but a regex
# cannot. The vocabulary is now enforced by the `agent_rules` LLM
# validator using the cross-artifact context (admin UI + dbContracts +
# stateMachine + handler writes).


def test_admin_ui_format_column_enums_emits_vocabulary() -> None:
    rendered = _format_column_enums({"appContracts": {"dbContracts": _QUEUE_CONTRACTS}})
    assert 'abandoned_cart_queue.status: ["pending", "sent", "failed"]' in rendered
