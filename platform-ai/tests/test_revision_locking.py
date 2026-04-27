"""
Tests for _revision_locked_artifacts — decides which artifacts the revision
agent may edit based on which LLM-validator findings fired.

The new validator layer (subagents/validators) emits a uniform Finding shape
where every entry carries an `artifact` field. The locking policy reads only
that field — no Q-key categories.

Locking rules:
    artifact == "migration"   →  migration itself is broken; unlock both.
    artifact == "handler"     →  backend problem; lock migration, fix handler.
    artifact ∈ {widget_js,
                admin_ui}     →  frontend misalignment; keep backend locked.
    artifact == "plan"        →  informational; revision can't re-run architect.
    no findings               →  conservative default; lock both.

The function lives in crew.py alongside GCP/contract imports that require
external services. We stub those modules before importing so these tests run
in any environment (CI, local, no credentials needed).
"""

from __future__ import annotations

import sys
from typing import Dict
from unittest.mock import MagicMock

# Stub cloud/contract deps before importing crew so the test needs no GCP creds
for _mod in [
    "contract",
    "contract.publisher",
    "contract.validators",
]:
    sys.modules.setdefault(_mod, MagicMock())

from crews.feature_generator.crew import _revision_locked_artifacts  # noqa: E402


def _f(artifact: str, validator: str = "agent_rules") -> Dict:
    """Build a Finding-shaped issue dict (mirrors Finding.to_issue_dict)."""
    return {
        "question": f"{validator}[{artifact}]",
        "issue": "test",
        "confidence": "high",
        "artifact": artifact,
        "validator": validator,
    }


# ── Migration broken → unlock both ────────────────────────────────────────────


def test_migration_finding_unlocks_both() -> None:
    # Migration itself is incomplete (missing table/column) — both must be
    # editable so revision can fix the schema AND the handler in one pass.
    result = _revision_locked_artifacts([_f("migration")])
    assert result == frozenset(), f"expected both unlocked, got {result}"


def test_migration_finding_with_widget_finding_still_unlocks_both() -> None:
    # Migration-broken takes precedence over any co-occurring frontend finding.
    result = _revision_locked_artifacts(
        [_f("migration"), _f("widget_js")]
    )
    assert result == frozenset()


def test_multiple_migration_findings_unlock_both() -> None:
    result = _revision_locked_artifacts(
        [_f("migration", "agent_rules"), _f("migration", "bug_finder")]
    )
    assert result == frozenset()


# ── Handler finding → lock migration only ─────────────────────────────────────


def test_handler_finding_locks_migration_only() -> None:
    # Handler misuses a correct migration — lock migration, fix handler.
    result = _revision_locked_artifacts([_f("handler")])
    assert result == frozenset({"migration"})


def test_handler_finding_from_bug_finder_locks_migration_only() -> None:
    result = _revision_locked_artifacts([_f("handler", "bug_finder")])
    assert result == frozenset({"migration"})


def test_multiple_handler_findings_lock_migration_only() -> None:
    result = _revision_locked_artifacts(
        [_f("handler"), _f("handler", "bug_finder")]
    )
    assert result == frozenset({"migration"})


# ── Frontend findings → lock both backend artifacts ──────────────────────────


def test_widget_finding_locks_both_backends() -> None:
    result = _revision_locked_artifacts([_f("widget_js")])
    assert result == frozenset({"handler", "migration"})


def test_admin_finding_locks_both_backends() -> None:
    result = _revision_locked_artifacts([_f("admin_ui")])
    assert result == frozenset({"handler", "migration"})


def test_widget_and_admin_findings_lock_both_backends() -> None:
    result = _revision_locked_artifacts([_f("widget_js"), _f("admin_ui")])
    assert result == frozenset({"handler", "migration"})


# ── Mixed cases ───────────────────────────────────────────────────────────────


def test_handler_finding_with_widget_finding_locks_migration_only() -> None:
    # Backend finding upgrades the lock — even with a co-occurring frontend
    # issue, revision must be allowed to edit the handler.
    result = _revision_locked_artifacts([_f("handler"), _f("widget_js")])
    assert result == frozenset({"migration"})


def test_plan_finding_alone_locks_both_default() -> None:
    # Plan-level findings are informational — revision can't re-run the
    # architect from inside this loop. Falls through to the default.
    result = _revision_locked_artifacts([_f("plan")])
    assert result == frozenset({"handler", "migration"})


def test_plan_finding_with_handler_finding_locks_migration_only() -> None:
    # Co-occurring handler finding still drives the lock decision.
    result = _revision_locked_artifacts([_f("plan"), _f("handler")])
    assert result == frozenset({"migration"})


def test_empty_issues_locks_both() -> None:
    # No findings → conservative default (frontend-only revision shape).
    result = _revision_locked_artifacts([])
    assert result == frozenset({"handler", "migration"})


def test_finding_without_artifact_field_treated_as_no_op() -> None:
    # Defensive: a malformed entry without an artifact field is ignored,
    # falling through to the empty-issues default.
    result = _revision_locked_artifacts([{"question": "agent_rules[]", "issue": "x"}])
    assert result == frozenset({"handler", "migration"})
