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
from llm_validations.handler_artifact import validate_handler_artifact


# ── Finding 4 — singleton ─────────────────────────────────────────────────────
#
# test_architect_plan_rejects_singleton_with_id_column was removed when the
# legacy `llm_validations.arch_plan.validate_architect_plan` was retired
# alongside the architect agent. The singleton-with-id-column rule now
# belongs to the LLD schema validator in
# `subagents/d_lld_agent/schema.py`; equivalent coverage should land there
# (or in d_lld_agent's own test surface), not in this legacy file.


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


# test_architect_plan_rejects_default_outside_enum was removed alongside
# `validate_architect_plan` — the "DEFAULT must be a member of the column
# enum" rule now belongs in the LLD schema validator
# (`subagents/d_lld_agent/schema.py`). Coverage should land there.


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


# test_admin_ui_format_column_enums_emits_vocabulary was removed when the
# legacy `admin_ui_agent._format_column_enums(plan)` was retired. The new
# `e_admin_agent.agent._format_column_enums(lld)` reads from
# `lld.database.tables[]` (column shape: name + enum) rather than
# `plan.appContracts.dbContracts[]` (column shape: name + enum + constraints).
# Equivalent coverage should land in the new e_admin_agent test surface,
# not be force-fit onto the legacy plan-shaped fixtures in this file.
