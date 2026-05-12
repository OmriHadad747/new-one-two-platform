"""
Pydantic output schema for the Product Agent.

The product agent classifies a merchant prompt into a feature intent that
drives every downstream agent's archetype/capability gate. Wrong
classification poisons every downstream stage — wrong appCategory makes
the HLD agent emit the wrong archetype's contracts, and the e_*_agents
all get the wrong scaffolding.

Closed-set fields use `Literal[...]`; cross-field invariants use
`@model_validator(mode="after")`. The rules absorbed here mirror
PRODUCT_RULES.md rows 6, 8, 9, 10, 11 — the original four-bar audit
that survived in the retired procedural validator.

Validation policy
-----------------
- `extra="forbid"` — extra keys are hard errors. Catches hallucinated
  fields before they propagate.
- `frozen=True` — once parsed, the intent is immutable.
- Single entry point: `ProductIntent.model_validate_json(text)`.
"""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


TriggerType = Literal["webhook", "cron", "admin", "widget"]
AppCategory = Literal[
    "backend",
    "backend_admin",
    "storefront_backend",
    "storefront_backend_admin",
]


class ProductIntent(BaseModel):
    """Parsed feature intent — what the merchant asked for, classified."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    triggerTypes: List[TriggerType] = Field(min_length=1)
    """Entry points the feature reacts to. Closed set: webhook / cron /
    admin / widget. Empty is rejected — every feature needs at least one
    way to be triggered, otherwise nothing downstream has anything to
    anchor on."""

    resources: List[str] = Field(default_factory=list)
    """Free-form list of Shopify resources the feature touches (e.g.
    'orders', 'products'). Intentionally open-set; the HLD agent picks
    the canonical names."""

    desiredOutcome: str = Field(min_length=1)
    """One-sentence merchant- or customer-perspective description of what
    the feature does."""

    cronHint: Optional[str] = None
    """Brief natural-language schedule description, required iff `cron`
    is in triggerTypes. Examples: 'every 6 hours', 'daily at 2am'.
    Drives the HLD agent's cron-schedule choice."""

    appCategory: AppCategory
    """Which archetype the feature implements. Determines which executor
    agents run downstream (e_db / e_storefront / e_admin / e_backend).
    The relationship to triggerTypes is rule-enforced (see
    `_storefront_widget_biconditional` + `_admin_trigger_implies_admin_archetype`)."""

    qualityBrief: str = Field(min_length=1)
    """3–5 sentences describing what makes a GOOD version of this app.
    Surfaced to downstream agents so they can prioritise UX choices."""

    # ── Cross-field invariants ─────────────────────────────────────────

    @model_validator(mode="after")
    def _cron_hint_coupling(self) -> "ProductIntent":
        """PRODUCT_RULES.md row 9: cronHint is non-null IFF 'cron' is in
        triggerTypes. A cron feature with no hint can't produce a
        cronSchedule; a hint without 'cron' is silently ignored."""
        has_cron = "cron" in self.triggerTypes
        hint_present = bool(self.cronHint and self.cronHint.strip())
        if has_cron and not hint_present:
            raise ValueError(
                "cronHint is null/empty but 'cron' is in triggerTypes — "
                "provide a brief schedule (e.g. 'every 6 hours', "
                "'daily at 2am') so the architect can produce a cronSchedule."
            )
        if hint_present and not has_cron:
            raise ValueError(
                f"cronHint is set ({self.cronHint!r}) but 'cron' is not in "
                "triggerTypes — either add 'cron' to triggerTypes or set "
                "cronHint to null."
            )
        return self

    @model_validator(mode="after")
    def _storefront_widget_biconditional(self) -> "ProductIntent":
        """PRODUCT_RULES.md row 10: appCategory starts with 'storefront_'
        IFF 'widget' is in triggerTypes. Storefront archetype only makes
        sense with a widget the customer interacts with."""
        is_storefront = self.appCategory.startswith("storefront_")
        has_widget = "widget" in self.triggerTypes
        if is_storefront and not has_widget:
            raise ValueError(
                f"appCategory {self.appCategory!r} starts with 'storefront_' "
                "but 'widget' is not in triggerTypes. Storefront archetype "
                "is valid only when the feature has a widget the customer "
                "interacts with."
            )
        if has_widget and not is_storefront:
            raise ValueError(
                f"'widget' is in triggerTypes but appCategory "
                f"{self.appCategory!r} does not start with 'storefront_'. "
                "Switch appCategory to 'storefront_backend' or "
                "'storefront_backend_admin'."
            )
        return self

    @model_validator(mode="after")
    def _admin_trigger_implies_admin_archetype(self) -> "ProductIntent":
        """PRODUCT_RULES.md row 11 (one-way): 'admin' in triggerTypes ⇒
        appCategory ends with '_admin'. The reverse is NOT a hard rule —
        admin-in-archetype is broader than the admin trigger."""
        if "admin" in self.triggerTypes and not self.appCategory.endswith("_admin"):
            raise ValueError(
                f"'admin' is in triggerTypes but appCategory "
                f"{self.appCategory!r} does not end with '_admin'. Switch "
                "appCategory to 'backend_admin' or 'storefront_backend_admin'."
            )
        return self
