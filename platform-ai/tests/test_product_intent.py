"""
Tests for validate_product_intent — the static gate on the product agent's
parsed intent dict.

Coverage matches PRODUCT_RULES.md rows 6, 8, 9, 10, 11. Rows 2 and 7 are
intentionally `no (paranoid)` per the four-bar audit and are not enforced
in the validator, so no fixtures here for those.
"""

from __future__ import annotations

from llm_validations.product_intent import validate_product_intent


# ── Helpers ────────────────────────────────────────────────────────────────────


def _valid() -> dict:
    """A minimal-but-valid intent that should produce zero errors."""
    return {
        "triggerTypes": ["webhook"],
        "resources": ["orders"],
        "desiredOutcome": "Auto-tag orders shipped to expedited carriers.",
        "cronHint": None,
        "appCategory": "backend",
        "qualityBrief": "Tag orders idempotently; handle webhook retries; log decisions.",
    }


# ── Row 6: triggerTypes closed-set + non-empty ─────────────────────────────────


def test_valid_intent_passes() -> None:
    assert validate_product_intent(_valid()) == []


def test_empty_trigger_types_rejected() -> None:
    intent = _valid()
    intent["triggerTypes"] = []
    errors = validate_product_intent(intent)
    assert any("triggerTypes" in e and "non-empty" in e for e in errors), errors


def test_invalid_trigger_value_rejected() -> None:
    intent = _valid()
    intent["triggerTypes"] = ["schedule", "webhook"]
    errors = validate_product_intent(intent)
    assert any("'schedule'" in e for e in errors), errors


def test_all_valid_triggers_accepted() -> None:
    intent = _valid()
    intent["triggerTypes"] = ["webhook", "cron", "admin", "widget"]
    intent["cronHint"] = "every 6 hours"
    intent["appCategory"] = "storefront_backend_admin"
    assert validate_product_intent(intent) == []


# ── Row 8: appCategory enum ────────────────────────────────────────────────────


def test_invalid_app_category_rejected() -> None:
    intent = _valid()
    intent["appCategory"] = "ecommerce"
    errors = validate_product_intent(intent)
    assert any("appCategory" in e and "ecommerce" in e for e in errors), errors


# ── Row 9: cronHint coupled to "cron" trigger ─────────────────────────────────


def test_cron_trigger_without_cron_hint_rejected() -> None:
    intent = _valid()
    intent["triggerTypes"] = ["cron"]
    intent["cronHint"] = None
    intent["appCategory"] = "backend_admin"
    errors = validate_product_intent(intent)
    assert any("cronHint" in e and "null" in e for e in errors), errors


def test_cron_hint_without_cron_trigger_rejected() -> None:
    intent = _valid()
    intent["triggerTypes"] = ["webhook"]
    intent["cronHint"] = "every 6 hours"
    errors = validate_product_intent(intent)
    assert any("cronHint" in e and ("ignore" in e.lower() or "not in" in e) for e in errors), errors


def test_empty_cron_hint_with_cron_trigger_rejected() -> None:
    intent = _valid()
    intent["triggerTypes"] = ["cron"]
    intent["cronHint"] = "   "
    intent["appCategory"] = "backend_admin"
    errors = validate_product_intent(intent)
    assert any("cronHint" in e for e in errors), errors


# ── Row 10: storefront archetype ↔ widget trigger (biconditional) ─────────────


def test_storefront_archetype_without_widget_rejected() -> None:
    intent = _valid()
    intent["appCategory"] = "storefront_backend"
    # triggerTypes still ["webhook"] — no widget
    errors = validate_product_intent(intent)
    assert any("storefront_" in e and "widget" in e for e in errors), errors


def test_widget_trigger_without_storefront_archetype_rejected() -> None:
    intent = _valid()
    intent["triggerTypes"] = ["widget"]
    intent["appCategory"] = "backend"
    errors = validate_product_intent(intent)
    assert any("widget" in e and "storefront_" in e for e in errors), errors


# ── Row 11: admin trigger ⇒ admin archetype (one-way only) ────────────────────


def test_admin_trigger_without_admin_archetype_rejected() -> None:
    intent = _valid()
    intent["triggerTypes"] = ["admin"]
    intent["appCategory"] = "backend"
    errors = validate_product_intent(intent)
    assert any("admin" in e and "_admin" in e for e in errors), errors


def test_admin_archetype_without_admin_trigger_accepted() -> None:
    """
    The reverse direction is NOT a hard rule — admin in the archetype is
    broader than the admin trigger (records to review, configurable settings,
    scheduled cron all justify admin without 'admin' being a trigger).
    """
    intent = _valid()
    intent["triggerTypes"] = ["webhook"]
    intent["appCategory"] = "backend_admin"
    assert validate_product_intent(intent) == []
