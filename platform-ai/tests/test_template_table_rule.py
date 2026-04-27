"""
Tests for the mechanical rule that blocks handler code from touching
template-owned tables (cron_queue, processed_webhooks) directly. The
rule lives in static_validation.FORBIDDEN_HANDLER_PATTERNS and is
sourced from template_tables.TEMPLATE_OWNED_TABLES so the prompt
guidance and the regex stay in lockstep.
"""

from __future__ import annotations

import re

from subagents.prompts.topics.template_tables import TEMPLATE_OWNED_TABLES
from llm_validations.handler_artifact import FORBIDDEN_HANDLER_PATTERNS


def _template_table_rule() -> tuple[str, str]:
    """Return the (pattern, message) tuple for the template-owned-table rule."""
    for pattern, message in FORBIDDEN_HANDLER_PATTERNS:
        if (
            "TEMPLATE-OWNED" in pattern.upper()
            or "cron_queue" in pattern
            or "INSERT\\s+INTO" in pattern
        ):
            # Match by content — the rule references the template table names
            # in its alternation.
            if any(t in pattern for t in TEMPLATE_OWNED_TABLES):
                return pattern, message
    raise AssertionError(
        "template-owned-table rule not found in FORBIDDEN_HANDLER_PATTERNS"
    )


PATTERN, MESSAGE = _template_table_rule()


# ── Positive cases — these MUST be flagged ────────────────────────────────────


def test_insert_into_cron_queue_uppercase() -> None:
    code = "await sql`INSERT INTO cron_queue (job_name) VALUES (${name})`;"
    assert re.search(PATTERN, code) is not None


def test_insert_into_cron_queue_lowercase() -> None:
    code = "await sql`insert into cron_queue (job_name) values (${name})`;"
    assert re.search(PATTERN, code) is not None


def test_select_from_cron_queue() -> None:
    code = "const r = await sql`SELECT * FROM cron_queue WHERE id = ${id}`;"
    assert re.search(PATTERN, code) is not None


def test_select_from_processed_webhooks() -> None:
    code = "await sql`SELECT 1 FROM processed_webhooks LIMIT 1`;"
    assert re.search(PATTERN, code) is not None


def test_update_cron_queue() -> None:
    code = "await sql`UPDATE cron_queue SET status = 'done' WHERE id = ${id}`;"
    assert re.search(PATTERN, code) is not None


def test_delete_from_processed_webhooks() -> None:
    code = "await sql`DELETE FROM processed_webhooks WHERE webhook_id = ${id}`;"
    assert re.search(PATTERN, code) is not None


def test_join_against_cron_queue() -> None:
    code = "await sql`SELECT u.* FROM users u JOIN cron_queue c ON c.payload->>'userId' = u.id`;"
    assert re.search(PATTERN, code) is not None


def test_typed_sql_template_literal() -> None:
    code = "await sql<Row[]>`SELECT * FROM cron_queue WHERE status = 'pending'`;"
    assert re.search(PATTERN, code) is not None


def test_multi_line_sql() -> None:
    code = (
        "await sql`\n"
        "  SELECT id, job_name\n"
        "  FROM cron_queue\n"
        "  WHERE status = 'pending'\n"
        "`;"
    )
    assert re.search(PATTERN, code) is not None


# ── Negative cases — these MUST NOT be flagged ────────────────────────────────


def test_user_table_with_similar_prefix_is_safe() -> None:
    code = "await sql`INSERT INTO cron_queue_logs (event) VALUES (${e})`;"
    assert re.search(PATTERN, code) is None


def test_processed_webhooks_archive_is_safe() -> None:
    code = "await sql`SELECT * FROM processed_webhooks_archive WHERE shop_id = ${id}`;"
    assert re.search(PATTERN, code) is None


def test_js_comment_referencing_table_name_is_safe() -> None:
    code = "// the cron_queue table is template-owned; do not touch"
    assert re.search(PATTERN, code) is None


def test_string_literal_referencing_table_name_is_safe() -> None:
    code = 'console.log("debug: cron_queue health check");'
    assert re.search(PATTERN, code) is None


def test_handler_using_enqueueJob_is_safe() -> None:
    code = (
        'import { enqueueJob } from "../lib/cron-enqueue.js";\n'
        'await enqueueJob("reconcile", { orderId });\n'
    )
    assert re.search(PATTERN, code) is None


def test_user_table_named_cron_jobs_is_safe() -> None:
    code = "await sql`SELECT * FROM cron_jobs WHERE active = true`;"
    assert re.search(PATTERN, code) is None


# ── Wiring guarantees ─────────────────────────────────────────────────────────


def test_message_directs_to_enqueueJob() -> None:
    assert "enqueueJob" in MESSAGE
    assert "cron-enqueue" in MESSAGE


def test_rule_covers_every_template_owned_table() -> None:
    """Adding a new template-owned table must extend the rule automatically."""
    for table in TEMPLATE_OWNED_TABLES:
        assert table in PATTERN, (
            f"table {table!r} listed in TEMPLATE_OWNED_TABLES but not present "
            f"in the regex — the rule and the prompt are out of sync"
        )
