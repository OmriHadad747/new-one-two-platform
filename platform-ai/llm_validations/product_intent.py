"""
Product-intent validation — runs after the product agent and before the
architect agent.

Public entry point: validate_product_intent.

Catches the catastrophic-by-cascade failure modes where wrong classification
poisons every downstream agent's prompt — wrong appCategory → architect emits
the wrong archetype's contracts → handler/widget/admin all get wrong scaffolding.

The full audit + classification rationale lives in `PRODUCT_RULES.md` at the
project root. Five rules survive the strict four-bar policy:
  6, 8, 9, 10, 11. Required-key-presence (row 2) and `resources` closed-set
(row 7) are intentionally NOT enforced — see `PRODUCT_RULES.md` for why.
"""

from __future__ import annotations

from typing import Any, Dict, List


_VALID_TRIGGER_TYPES = frozenset({"webhook", "cron", "admin", "widget"})

_VALID_APP_CATEGORIES = frozenset(
    {"backend", "backend_admin", "storefront_backend", "storefront_backend_admin"}
)


def validate_product_intent(intent: Dict[str, Any]) -> List[str]:
    """
    Gate on the Product Agent's parsed intent dict. Returns error strings;
    empty list = valid.

    Checks (PRODUCT_RULES.md row references):
      6.  triggerTypes is a non-empty list of values from the closed set
          {webhook, cron, admin, widget}.
      8.  appCategory is one of {backend, backend_admin, storefront_backend,
          storefront_backend_admin}.
      9.  cronHint is non-null iff "cron" is in triggerTypes; when present,
          a non-empty string.
      10. appCategory.startswith("storefront_") iff "widget" is in triggerTypes
          (biconditional — both halves are hard rules per the prompt).
      11. "admin" in triggerTypes ⇒ appCategory.endswith("_admin")
          (one-way only — admin in the archetype is broader than the admin
          trigger; see PRODUCT_RULES.md row 11 for why).

    Skips required-key presence (row 2) and `resources` closed-set (row 7) —
    see PRODUCT_RULES.md for the four-bar audit rationale.
    """
    errors: List[str] = []

    # Row 6: triggerTypes is a non-empty list within the closed set.
    trigger_types = intent.get("triggerTypes")
    if not isinstance(trigger_types, list) or not trigger_types:
        errors.append(
            "triggerTypes must be a non-empty array — every product intent has "
            "at least one trigger (webhook / cron / admin / widget). An empty "
            "trigger list leaves the architect with nothing to anchor on, so "
            "the feature ships with no entry points."
        )
        # Defensive default for the cross-field checks below — treat as empty.
        trigger_types = []
    else:
        invalid_triggers = [
            t for t in trigger_types if t not in _VALID_TRIGGER_TYPES
        ]
        if invalid_triggers:
            errors.append(
                f"triggerTypes contains invalid value(s) {invalid_triggers!r} — "
                f"valid values: {sorted(_VALID_TRIGGER_TYPES)}. The architect "
                "and codegen agents only recognize this closed set; any other "
                "value silently no-ops downstream."
            )

    trigger_set = {t for t in trigger_types if isinstance(t, str)}

    # Row 8: appCategory enum.
    app_category = intent.get("appCategory")
    if app_category not in _VALID_APP_CATEGORIES:
        errors.append(
            f"appCategory {app_category!r} is invalid — must be one of "
            f"{sorted(_VALID_APP_CATEGORIES)}. This drives every downstream "
            "codegen agent's archetype gate; an invalid value causes silent "
            "skipping (no widget code, no admin code, etc.)."
        )

    # Row 9: cronHint coupling.
    cron_hint = intent.get("cronHint")
    has_cron_trigger = "cron" in trigger_set
    if has_cron_trigger and (
        cron_hint is None or not (isinstance(cron_hint, str) and cron_hint.strip())
    ):
        errors.append(
            "cronHint is null/empty but 'cron' is in triggerTypes — a cron "
            "feature with no schedule hint cannot produce a cronSchedule, so "
            "the cron job will never run. Provide a brief natural-language "
            "schedule (e.g. 'every 6 hours', 'daily at 2am')."
        )
    elif not has_cron_trigger and cron_hint is not None:
        errors.append(
            f"cronHint is set ({cron_hint!r}) but 'cron' is not in "
            "triggerTypes — the architect will ignore the hint and the "
            "feature ships with no cron schedule. Either add 'cron' to "
            "triggerTypes or set cronHint to null."
        )

    # Row 10: storefront archetype iff widget trigger (biconditional).
    if isinstance(app_category, str):
        is_storefront_archetype = app_category.startswith("storefront_")
        has_widget_trigger = "widget" in trigger_set
        if is_storefront_archetype and not has_widget_trigger:
            errors.append(
                f"appCategory {app_category!r} starts with 'storefront_' but "
                "'widget' is not in triggerTypes. Storefront archetype is "
                "valid only when the feature has a widget the customer "
                "interacts with — sending emails or SMS does NOT count as "
                "storefront interaction."
            )
        elif not is_storefront_archetype and has_widget_trigger:
            errors.append(
                f"'widget' is in triggerTypes but appCategory {app_category!r} "
                "does not start with 'storefront_'. A widget trigger requires "
                "a storefront archetype — switch appCategory to "
                "'storefront_backend' or 'storefront_backend_admin'."
            )

    # Row 11: admin trigger ⇒ admin archetype (one-way).
    # The reverse (admin archetype ⇒ admin trigger) is NOT a hard rule —
    # admin in the archetype is broader than the admin trigger (records to
    # review, configurable settings, scheduled cron jobs all justify admin
    # without 'admin' being a trigger). See PRODUCT_RULES.md row 11.
    if "admin" in trigger_set and isinstance(app_category, str):
        if not app_category.endswith("_admin"):
            errors.append(
                f"'admin' is in triggerTypes but appCategory {app_category!r} "
                "does not end with '_admin'. An admin trigger requires an "
                "admin archetype — switch appCategory to 'backend_admin' or "
                "'storefront_backend_admin'."
            )

    return errors
