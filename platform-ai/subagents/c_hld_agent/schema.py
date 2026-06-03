"""
Pydantic output schema for the HLD agent.

The HLD agent reasons in two phases:
  - Phase 1 (domain): a schema-agnostic data model, capabilities, triggers,
    and contracts — the "would this change if Shopify became Stripe?" layer.
  - Phase 2 (Shopify resolution): bind the domain plan to concrete Shopify
    using the catalog tools — the webhook topic + per-signalField payload
    bindings for each external event, and the resolved op (or ordered op
    sequence for multi-step protocols) for each shopify-* capability.

There is no downstream LLD agent; the coding agent implements directly
against this plan, so the Phase-2 bindings are the contract that keeps it
from guessing topics, ops, and payload field paths. DB columns and file
paths are still out of scope (the coding agent owns those).

Validation policy
-----------------
- `extra="forbid"` on every model: extra keys are hard errors. Catches
  hallucinated fields before they propagate to downstream stages.
- `frozen=True` on every model: plans are immutable once parsed. No
  accidental mutation between stages.
- Single entry point: `HLDPlan.model_validate_json(text)`.
- Closed-set fields use `Literal[...]` and discriminated unions — typing
  alone enforces them, no validator code needed.
- The validators below are deliberate enforcement of cross-field
  invariants and deny-listed values picked under the policy
  "cheap, safe, reliable, very low FP, high blast radius". The full
  catalog of candidate rules lives in `HLD_AGENT_RULES.md`; only rules
  earning a slot today are coded here.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# Semantic kind for column roles — scalar only (no collection types).
ColumnRole = Literal[
    "identifier",
    "reference",
    "timestamp",
    "money",
    "ratio",
    "status",
    "flag",
    "text",
    "count",
]

# Semantic kind for requestShape / responseShape values — extends ColumnRole
# with collection types that only make sense at the API boundary.
ShapeKind = Literal[
    "identifier",
    "reference",
    "timestamp",
    "money",
    "ratio",
    "status",
    "flag",
    "text",
    "count",
    "list",
    "object",
]

_VALID_SHAPE_KINDS: frozenset[str] = frozenset(get_args(ShapeKind))

# Forbidden column names.
# Email-template fields are platform-owned (the platform stores subject /
# body / CTA / from-name on its own — declaring them in app DDL collides
# with the platform's migration).
_PLATFORM_OWNED_COLUMNS: frozenset[str] = frozenset(
    {
        "email_subject",
        "email_body",
        "email_body_template",
        "email_cta_label",
        "email_cta_url",
        "email_from_name",
    }
)


# Surfaces implied by archetype — used by the externalContracts ↔ archetype
# correlation validator.
_ARCHETYPE_SURFACES: dict[str, frozenset[str]] = {
    "backend": frozenset(),
    "backend+admin": frozenset({"admin"}),
    "backend+storefront": frozenset({"widget"}),
    "backend+admin+storefront": frozenset({"widget", "admin"}),
}


class _StrictModel(BaseModel):
    """Shared model_config — every nested model inherits these flags."""

    model_config = ConfigDict(extra="forbid", frozen=True)


# ── Triggers (discriminated union by `kind`) ──────────────────────────


class PayloadBinding(_StrictModel):
    """Phase-2 resolution of one semantic signalField to where it actually
    comes from in the chosen Shopify webhook payload.

    `source`:
      - "payload"  — the value is a real field on the topic's payload;
                     `payloadPath` is the dot-path (e.g. "id",
                     "line_items[].variant_id"), verified via
                     `get_webhook_topic`.
      - "resolved" — the value is NOT on the payload and needs a follow-up
                     lookup; `resolution` states it in one phrase (e.g.
                     "resolve from inventory_item_id via the inventoryItem
                     GraphQL query"). This is what makes the
                     inventory_item_id → variant gap explicit at plan time.
    """

    signalField: str
    source: Literal["payload", "resolved"]
    payloadPath: Optional[str] = None
    resolution: Optional[str] = None

    @model_validator(mode="after")
    def _source_carries_its_detail(self) -> "PayloadBinding":
        if self.source == "payload" and not self.payloadPath:
            raise ValueError(
                f"payloadBinding for '{self.signalField}' has source "
                "'payload' but no payloadPath"
            )
        if self.source == "resolved" and not self.resolution:
            raise ValueError(
                f"payloadBinding for '{self.signalField}' has source "
                "'resolved' but no resolution phrase"
            )
        return self


class ExternalEventTrigger(_StrictModel):
    kind: Literal["external-event"]
    event: str
    signalFields: list[str]
    idempotency: str
    # ── Phase-2 Shopify bindings ──
    shopifyTopic: str
    payloadBindings: list[PayloadBinding]

    # Every signalField must have exactly the bindings it needs: each
    # signalField is bound, and no binding references a field the trigger
    # never declared. This is the structural half of "is this the right
    # topic" — a signalField that can't be bound to the chosen topic's
    # payload (and isn't a declared resolution hop) is a wrong-topic or
    # missing-hop signal.
    @model_validator(mode="after")
    def _bindings_cover_signal_fields(self) -> "ExternalEventTrigger":
        declared = set(self.signalFields)
        bound = {b.signalField for b in self.payloadBindings}
        missing = [s for s in self.signalFields if s not in bound]
        if missing:
            raise ValueError(
                f"signalFields {missing} have no payloadBinding for topic "
                f"'{self.shopifyTopic}'; bind each to a payload path or a "
                "declared resolution hop"
            )
        stray = sorted(b.signalField for b in self.payloadBindings if b.signalField not in declared)
        if stray:
            raise ValueError(
                f"payloadBindings {stray} reference fields not in "
                f"signalFields {sorted(declared)}"
            )
        return self


class ScheduleTrigger(_StrictModel):
    kind: Literal["schedule"]
    cadence: str
    jobPurpose: str
    perTickWork: str
    bulkFetchRule: bool


class InboundRequestTrigger(_StrictModel):
    kind: Literal["inbound-request"]


Trigger = Annotated[
    Union[ExternalEventTrigger, ScheduleTrigger, InboundRequestTrigger],
    Field(discriminator="kind"),
]


# ── Capabilities ──────────────────────────────────────────────────────


class ShopifyStep(_StrictModel):
    """One resolved Shopify operation in a capability. A single-op capability
    declares one step; a multi-step protocol declares an ordered list (e.g.
    step 1 `discountCodeBasicCreate` produces a code, step 2 applies that
    code to the cart). `produces`/`consumes` make the data flow between steps
    explicit so the coding agent threads real ids instead of fabricating
    them, and so the Shopify-effect validator can check the sequence was
    honored."""

    op: str
    produces: Optional[str] = None
    consumes: Optional[str] = None


class Capability(_StrictModel):
    id: str
    description: str
    kind: Literal["read", "write", "compute", "notify"]
    dataNeeds: list[str]
    integration: Optional[Literal["shopify-admin", "shopify-storefront", "email"]]
    # ── Phase-2 Shopify binding ──
    # Resolved op(s) for shopify-admin / shopify-storefront capabilities,
    # in execution order. Empty for compute / DB-only / email capabilities.
    shopifySteps: list[ShopifyStep] = Field(default_factory=list)
    returnsList: bool = False
    touchesMoney: bool = False
    usesConfig: bool = False
    usesWorkflow: bool = False

    # A shopify-* capability MUST resolve its op(s); a non-Shopify capability
    # must not carry any. This is what makes "declared effect not realized"
    # checkable downstream — the plan names the op the code must actually
    # call.
    @model_validator(mode="after")
    def _shopify_steps_match_integration(self) -> "Capability":
        is_shopify = self.integration in ("shopify-admin", "shopify-storefront")
        if is_shopify and not self.shopifySteps:
            raise ValueError(
                f"capability '{self.id}' has integration '{self.integration}' "
                "but no shopifySteps; resolve the Shopify op(s) it performs "
                "via list_shopify_ops / get_shopify_op"
            )
        if not is_shopify and self.shopifySteps:
            raise ValueError(
                f"capability '{self.id}' declares shopifySteps but integration "
                f"is '{self.integration}'; shopifySteps are only for "
                "shopify-admin / shopify-storefront capabilities"
            )
        return self


# ── Persistence ───────────────────────────────────────────────────────


class Column(_StrictModel):
    name: str
    role: ColumnRole
    nullable: bool
    purpose: Optional[str] = None

    # Rule #46 — deny-listed column names. Platform-owned email template
    # fields are managed by the platform's own migration; declaring them
    # in app DDL collides with platform state.
    @field_validator("name")
    @classmethod
    def _name_not_forbidden(cls, v: str) -> str:
        if v in _PLATFORM_OWNED_COLUMNS:
            raise ValueError(
                f"column name '{v}' is platform-owned (email template "
                "fields are managed by the platform; do not declare them "
                "in HLD)"
            )
        return v


class Table(_StrictModel):
    name: str
    purpose: str
    columns: list[Column]
    # Structured dedup key — the exact column list the downstream
    # uniqueConstraint must match. The integrity gate checks this
    # against `app.json.uniqueConstraint` (a deterministic check that
    # catches the "natural-language said calendar date, formal
    # constraint used timestamp" class of plan-vs-code contradiction).
    # Empty list means "no dedup key" — only valid for tables that
    # genuinely have no natural uniqueness (rare). Non-obvious column
    # choices (derived columns like `detected_date` that exist to make
    # daily dedup work) should be justified in the relevant column's
    # `purpose` field, not in prose at the table level. Generic.
    keyedByColumns: list[str] = Field(default_factory=list)
    # DEPRECATED: free-text restatement of keyedByColumns. Retained as
    # Optional so legacy plans (pre-keyedByColumns) still parse; new
    # plans should NOT set it — the structured `keyedByColumns` is the
    # single source of truth, and any rationale for non-obvious column
    # choices belongs on the column's own `purpose` field. Will be
    # removed once no in-flight plans reference it.
    keyedBy: Optional[str] = None
    statusField: Optional[str] = None
    queryPatterns: list[str] = Field(default_factory=list)

    # Rule #40 — when statusField is set, it must name an existing column
    # on this same table. Otherwise LLD will write to a non-existent
    # column and the migration / handler will drift.
    @model_validator(mode="after")
    def _status_field_resolves_to_column(self) -> "Table":
        if self.statusField is None:
            return self
        column_names = {c.name for c in self.columns}
        if self.statusField not in column_names:
            raise ValueError(
                f"statusField '{self.statusField}' on table "
                f"'{self.name}' does not match any column on this table; "
                f"columns are {sorted(column_names)}"
            )
        return self

    # keyedByColumns must (a) name only declared columns of this table,
    # and (b) be non-empty if keyedBy isn't a degenerate description.
    # Structural check; no app knowledge.
    @model_validator(mode="after")
    def _keyed_by_columns_resolve(self) -> "Table":
        if not self.keyedByColumns:
            return self
        column_names = {c.name for c in self.columns}
        stray = [k for k in self.keyedByColumns if k not in column_names]
        if stray:
            raise ValueError(
                f"keyedByColumns {stray} on table '{self.name}' do not "
                f"match any column; columns are {sorted(column_names)}"
            )
        return self


# ── State machine ─────────────────────────────────────────────────────


class Transition(_StrictModel):
    # `from` is a Python keyword; alias-mapped to the JSON wire field.
    from_: str = Field(alias="from")
    to: str
    trigger: str

    # Override base config to also accept the python attribute name in
    # tests / programmatic construction.
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class StateMachine(_StrictModel):
    states: list[str]
    initialState: str
    terminalStates: list[str]
    transitions: list[Transition]
    invariants: list[str]

    # Rules #50 + #53 — initialState and every transition's from/to must
    # resolve to a declared state. Catches the entire class of
    # "dangling state reference" bugs that would make the state machine
    # un-implementable.
    @model_validator(mode="after")
    def _state_references_resolve(self) -> "StateMachine":
        states = set(self.states)
        if self.initialState not in states:
            raise ValueError(
                f"initialState '{self.initialState}' is not in states "
                f"{sorted(states)}"
            )
        for i, t in enumerate(self.transitions):
            if t.from_ not in states:
                raise ValueError(
                    f"transitions[{i}].from '{t.from_}' is not in states "
                    f"{sorted(states)}"
                )
            if t.to not in states:
                raise ValueError(
                    f"transitions[{i}].to '{t.to}' is not in states "
                    f"{sorted(states)}"
                )
        return self


# ── External contracts ────────────────────────────────────────────────

# Accepted requestShape keys that signal pagination on a list-returning GET.
# Whitelisted by name (rather than role) because a cursor is "text" in the
# semantic-kind vocabulary, which is indistinguishable from any other free-
# form text input — naming is the only structural signal we have here.
_PAGINATION_CURSOR_KEYS: frozenset[str] = frozenset(
    {"cursor", "page", "page_cursor", "after", "before"}
)


class ExternalContract(_StrictModel):
    surface: Literal["widget", "admin"]
    path: str
    method: Literal["GET", "POST", "PUT", "DELETE"]
    purpose: str
    requestShape: dict[str, str]
    responseShape: dict[str, str]

    # Rule #62 — path must start with `/` and contain no `:param`
    # segments. Express-style path params silently mis-route requests in
    # production; require query/body params instead.
    @field_validator("path")
    @classmethod
    def _path_well_formed(cls, v: str) -> str:
        if not v.startswith("/"):
            raise ValueError(f"path '{v}' must start with '/'")
        if ":" in v:
            raise ValueError(
                f"path '{v}' contains ':' — Express-style :param routes "
                "are not allowed; use query / body params instead"
            )
        return v

    # Rule #65 — requestShape and responseShape values must be semantic
    # kinds, not TS types. Enforces the closed set including collection
    # types (list, object) that are valid at the API boundary but not
    # as column roles.
    @field_validator("requestShape", "responseShape")
    @classmethod
    def _shape_values_are_semantic_kinds(cls, v: dict[str, str]) -> dict[str, str]:
        for key, kind in v.items():
            if kind not in _VALID_SHAPE_KINDS:
                raise ValueError(
                    f"shape value '{kind}' for key '{key}' is not a valid "
                    f"semantic kind; allowed: {sorted(_VALID_SHAPE_KINDS)}"
                )
        return v

    # Rule X2 — any GET that returns a `list` must expose a pagination
    # cursor in the request so the LLD can generate a paginated query.
    # Pushed down from the validator's semantic-judgment layer: the old
    # validator kept rationalising "this list is naturally small" and
    # silently dropping the finding. A structural check has no such
    # judgment to apply and always fires when the shape is wrong.
    @model_validator(mode="after")
    def _list_get_must_paginate(self) -> "ExternalContract":
        if self.method != "GET":
            return self
        if not any(v == "list" for v in self.responseShape.values()):
            return self
        if not any(k in _PAGINATION_CURSOR_KEYS for k in self.requestShape):
            raise ValueError(
                f"GET {self.path} returns a 'list' in responseShape but "
                f"has no pagination cursor in requestShape. Add one of "
                f"{sorted(_PAGINATION_CURSOR_KEYS)} (typically 'cursor' "
                f"with kind 'text') so the endpoint is paginable at scale."
            )
        return self


# ── HLD plan (top-level) ──────────────────────────────────────────────


class HLDPlan(_StrictModel):
    """
    Top-level HLD plan. Single source of truth for the prompt's JSON
    schema and the parser's contract.
    """

    schema_version: Literal["1"] = "1"
    archetype: Literal[
        "backend", "backend+admin", "backend+storefront", "backend+admin+storefront"
    ]
    feasibility: Literal["feasible", "blocked"]
    blockedReason: Optional[str]
    complexity: Literal["low", "medium", "high"]
    dataFlow: str
    triggers: list[Trigger]
    capabilities: list[Capability]
    persistence: list[Table]
    stateMachine: Optional[StateMachine]
    externalContracts: list[ExternalContract]
    edgeCases: list[str]

    # Rule #20 — capability ids must be unique within a plan. Duplicate
    # ids silently break any downstream cross-reference.
    @model_validator(mode="after")
    def _capability_ids_unique(self) -> "HLDPlan":
        seen: set[str] = set()
        for cap in self.capabilities:
            if cap.id in seen:
                raise ValueError(
                    f"capability id '{cap.id}' appears more than once; "
                    "capability ids must be unique within a plan"
                )
            seen.add(cap.id)
        return self

    # Rules #42 + #43 — stateMachine and statusField are linked, but the
    # cardinality is many-to-one rather than one-to-one. An app may bind
    # the same state machine to multiple lifecycle-tracked tables; what
    # we enforce is the link itself:
    #   - stateMachine null  ⟹  no table may declare statusField
    #     (a status column with no governing state machine is just an
    #      enum, and "just an enum" doesn't go in statusField).
    #   - stateMachine set   ⟹  at least one table must declare statusField
    #     (otherwise the state machine is orphaned — declared transitions
    #      with no column to write them to).
    @model_validator(mode="after")
    def _state_machine_bound_to_status_field(self) -> "HLDPlan":
        tables_with_status = [t for t in self.persistence if t.statusField is not None]
        if self.stateMachine is None:
            if tables_with_status:
                names = [t.name for t in tables_with_status]
                raise ValueError(
                    f"tables {names} declare a statusField but stateMachine "
                    "is null; statusField is only valid when a state machine "
                    "governs the column"
                )
            return self
        if not tables_with_status:
            raise ValueError(
                "stateMachine is declared but no persistence table has a "
                "statusField; bind the state machine to at least one table"
            )
        return self

    # Rule #58 — externalContracts must be empty for backend archetypes,
    # and surfaces declared in contracts must be a subset of those
    # implied by the archetype. Without this, you can ship a "backend"
    # plan that silently exposes widget routes (or vice versa).
    @model_validator(mode="after")
    def _archetype_matches_external_contracts(self) -> "HLDPlan":
        allowed = _ARCHETYPE_SURFACES[self.archetype]
        if not allowed:
            if self.externalContracts:
                raise ValueError(
                    f"archetype '{self.archetype}' exposes no UI surface "
                    "and must not declare any externalContracts"
                )
            return self
        for i, c in enumerate(self.externalContracts):
            if c.surface not in allowed:
                raise ValueError(
                    f"externalContracts[{i}].surface '{c.surface}' is not "
                    f"valid for archetype '{self.archetype}' "
                    f"(allowed: {sorted(allowed)})"
                )
        return self
