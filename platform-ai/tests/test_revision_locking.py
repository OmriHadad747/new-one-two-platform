"""
Tests for _revision_locked_artifacts — the function that decides which
artifacts the revision agent may edit based on which validator questions fired.

The function lives in crew.py alongside GCP/contract imports that require
external services. We stub those modules before importing so these tests run
in any environment (CI, local, no credentials needed).
"""

from __future__ import annotations

import sys
from typing import Dict, List
from unittest.mock import MagicMock

# Stub cloud/contract deps before importing crew so the test needs no GCP creds
for _mod in [
    "contract",
    "contract.publisher",
    "contract.validators",
]:
    sys.modules.setdefault(_mod, MagicMock())

from crews.feature_generator.crew import _revision_locked_artifacts  # noqa: E402


# ── Helpers ────────────────────────────────────────────────────────────────────


def _q(question: str) -> Dict:
    """Build a Part A issue dict."""
    return {"question": question}


def _open(artifact: str) -> Dict:
    """Build a Part B open-finding dict."""
    return {"question": "open_finding", "artifact": artifact}


# ── Migration-broken questions (q1, q7) → unlock both ────────────────────────


def test_q1_unlocks_both() -> None:
    # q1 = missing table: migration is broken, both need to be regenerated
    result = _revision_locked_artifacts([_q("q1_table_names")])
    assert result == frozenset(), f"expected both unlocked, got {result}"


def test_q7_unlocks_both() -> None:
    # q7 = schema completeness failure: migration is the source of truth gap
    result = _revision_locked_artifacts([_q("q7_schema_completeness")])
    assert result == frozenset(), f"expected both unlocked, got {result}"


def test_q1_and_q7_together_unlock_both() -> None:
    result = _revision_locked_artifacts([_q("q1_table_names"), _q("q7_schema_completeness")])
    assert result == frozenset()


def test_q1_with_frontend_question_still_unlocks_both() -> None:
    # Migration-broken takes precedence over any co-occurring frontend issues
    result = _revision_locked_artifacts([_q("q1_table_names"), _q("q3_widget_fields")])
    assert result == frozenset()


# ── Backend questions (q2, q5, q6) → lock migration only ─────────────────────


def test_q2_locks_migration_only() -> None:
    # q2 = column mismatch: migration is correct, handler uses wrong column
    result = _revision_locked_artifacts([_q("q2_column_names")])
    assert result == frozenset({"migration"})


def test_q5_locks_migration_only() -> None:
    result = _revision_locked_artifacts([_q("q5_cron_bulk_fetch")])
    assert result == frozenset({"migration"})


def test_q6_locks_migration_only() -> None:
    result = _revision_locked_artifacts([_q("q6_state_machine")])
    assert result == frozenset({"migration"})


def test_multiple_backend_questions_lock_migration_only() -> None:
    result = _revision_locked_artifacts([_q("q2_column_names"), _q("q5_cron_bulk_fetch")])
    assert result == frozenset({"migration"})


# ── Frontend-only questions (q3, q4) → lock both ─────────────────────────────


def test_q3_locks_both() -> None:
    # q3 = widget/handler field mismatch: handler is ground truth, fix frontend
    result = _revision_locked_artifacts([_q("q3_widget_fields")])
    assert result == frozenset({"handler", "migration"})


def test_q4_locks_both() -> None:
    result = _revision_locked_artifacts([_q("q4_admin_fields")])
    assert result == frozenset({"handler", "migration"})


def test_empty_issues_locks_both() -> None:
    # No validator findings → treat as frontend-only (conservative default)
    result = _revision_locked_artifacts([])
    assert result == frozenset({"handler", "migration"})


# ── Part B open findings ───────────────────────────────────────────────────────


def test_open_finding_on_handler_locks_migration_only() -> None:
    result = _revision_locked_artifacts([_open("handler")])
    assert result == frozenset({"migration"})


def test_open_finding_on_migration_locks_migration_only() -> None:
    # migration open finding = backend problem → unlock handler, keep migration locked
    result = _revision_locked_artifacts([_open("migration")])
    assert result == frozenset({"migration"})


def test_open_finding_on_widget_locks_both() -> None:
    result = _revision_locked_artifacts([_open("widget_js")])
    assert result == frozenset({"handler", "migration"})


def test_open_finding_on_admin_ui_locks_both() -> None:
    result = _revision_locked_artifacts([_open("admin_ui")])
    assert result == frozenset({"handler", "migration"})


def test_mixed_backend_open_finding_and_frontend_question_locks_migration_only() -> None:
    # Backend open finding overrides a co-occurring frontend-only Q-check
    result = _revision_locked_artifacts([_q("q3_widget_fields"), _open("handler")])
    assert result == frozenset({"migration"})
