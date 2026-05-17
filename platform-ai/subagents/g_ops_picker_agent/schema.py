"""
Pydantic output schema for the ops-picker agent (LLD stage 1).

The ops-picker takes an HLD plan + the full Admin/Storefront GraphQL indexes
+ the webhook topic catalog and emits two mappings:

  - capability id → list of Shopify GraphQL operation names
  - external-event trigger → Shopify webhook topic literal

Anything that needs to know SQL types, indexes, route shapes, or transition
WHERE/SET clauses belongs to LLD stage 2, not here.

Validation policy
-----------------
- `extra="forbid"` and `frozen=True` on every model — same discipline as
  `HLDPlan`. Hallucinated fields are hard errors; the parsed picks are
  immutable downstream.
- Op names and webhook topics MUST come verbatim from catalogs the agent
  was prompted with. Catalog membership is checked at run-time by the
  agent runner (which has the catalogs in hand) — the schema enforces
  the structural shape only.
- Cross-field rules (one block per Shopify-touching capability, one
  block per external-event trigger) are enforced via `@model_validator`
  but only at the level the schema can see in isolation. The runner
  layers HLD-cross-reference checks on top.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _StrictModel(BaseModel):
    """Shared model_config — every nested model inherits these flags."""

    model_config = ConfigDict(extra="forbid", frozen=True)


# ── Capability picks ──────────────────────────────────────────────────


class OpPick(_StrictModel):
    """
    One picked Shopify GraphQL operation, scoped to the capability that
    needs it. `note` is one phrase describing what part of the
    capability the op satisfies — stage 2 uses it to bind the op to the
    right point in the data flow.

    Per-op catalog detail (signature, return-type SDL, input types,
    examples) does NOT live here. The model picks just the op name; the
    runner enriches the dump from `operations_detail.json` before passing
    the picks to the LLD agent. Keeping the LLM-emitted shape minimal
    avoids re-derivation of catalog data the runner already has.
    """

    name: str = Field(min_length=1)
    surface: Literal["admin", "storefront"]
    note: str


class CapabilityPick(_StrictModel):
    """
    Per-capability picks. `capability_id` MUST match an HLD capability
    whose `integration` is `shopify-admin` or `shopify-storefront` —
    cross-checked by the runner against the HLD plan.
    """

    capability_id: str = Field(min_length=1)
    ops: list[OpPick] = Field(min_length=1)

    # Within a single capability, the same op name should not be picked
    # twice. Catches the common waste-pick of selecting both `cart` and
    # `cartByToken` when one identifier already resolves the row.
    @model_validator(mode="after")
    def _op_names_unique(self) -> "CapabilityPick":
        seen: set[str] = set()
        for op in self.ops:
            if op.name in seen:
                raise ValueError(
                    f"capability '{self.capability_id}' picks op '{op.name}' "
                    "more than once; pick the smallest non-overlapping set"
                )
            seen.add(op.name)
        return self


# ── Webhook topic picks ───────────────────────────────────────────────


class WebhookPick(_StrictModel):
    """
    One external-event trigger → webhook topic mapping. The runner pairs
    `webhooks[i]` to the i-th HLD external-event trigger by list
    position, not by string-matching `trigger_event` against
    `trigger.event` — paraphrasing the trigger's domain sentence is
    therefore non-fatal. `trigger_event` is an audit label only; the
    model is asked to emit `webhooks` in the same order as the HLD
    triggers list.
    """

    trigger_event: str
    topic: str = Field(min_length=1)
    note: str


# ── Unsatisfied capabilities ──────────────────────────────────────────


class UnsatisfiedCapability(_StrictModel):
    """
    Recorded when no listed op satisfies a Shopify-integration
    capability. Stage 2 turns each entry into a `platformGaps[]` item
    rather than synthesizing an op to cover the gap.
    """

    capability_id: str = Field(min_length=1)
    reason: str


# ── Top-level ─────────────────────────────────────────────────────────


class OpsPicks(_StrictModel):
    """
    Stage-1 output. The runner layers HLD-cross-reference checks on top
    (every `shopify-admin`/`shopify-storefront` capability appears in
    `capabilities` or `unsatisfied`; every `external-event` trigger
    appears in `webhooks`; op names + topics are members of their
    catalogs).
    """

    schema_version: Literal["1"] = "1"
    capabilities: list[CapabilityPick]
    webhooks: list[WebhookPick]
    unsatisfied: list[UnsatisfiedCapability] = Field(default_factory=list)

    # A capability id may appear in `capabilities` OR `unsatisfied`,
    # never both. Both means the picker hedged — force a decision.
    @model_validator(mode="after")
    def _capability_ids_disjoint(self) -> "OpsPicks":
        picked = {c.capability_id for c in self.capabilities}
        unsat = {u.capability_id for u in self.unsatisfied}
        overlap = picked & unsat
        if overlap:
            raise ValueError(
                f"capability id(s) {sorted(overlap)} appear in both "
                "`capabilities` and `unsatisfied`; each capability is "
                "either satisfied by ops or not — pick one"
            )
        # Capability ids in `capabilities` must themselves be unique.
        if len(picked) != len(self.capabilities):
            seen: set[str] = set()
            for c in self.capabilities:
                if c.capability_id in seen:
                    raise ValueError(
                        f"capability '{c.capability_id}' appears more than "
                        "once in `capabilities`; emit one block per "
                        "capability"
                    )
                seen.add(c.capability_id)
        if len(unsat) != len(self.unsatisfied):
            seen2: set[str] = set()
            for u in self.unsatisfied:
                if u.capability_id in seen2:
                    raise ValueError(
                        f"capability '{u.capability_id}' appears more than "
                        "once in `unsatisfied`"
                    )
                seen2.add(u.capability_id)
        return self
