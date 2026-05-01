"""
Pydantic output schema for the HLD agent.

The HLD agent emits a schema-agnostic, integration-agnostic plan. Anything
that mentions a specific Shopify op, GraphQL field path, file path, or DB
column belongs in the LLD plan, not here.

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

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# Forbidden column names.
# Email-template fields are platform-owned (the platform stores subject /
# body / CTA / from-name on its own — declaring them in app DDL collides
# with the platform's migration). `tenant_id` is implicit at runtime
# (search_path is pinned per tenant) — declaring it breaks multi-tenancy.
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
_IMPLICIT_COLUMNS: frozenset[str] = frozenset({"tenant_id"})


# Surfaces implied by archetype — used by the externalContracts ↔ archetype
# correlation validator.
_ARCHETYPE_SURFACES: dict[str, frozenset[str]] = {
    "storefront": frozenset({"widget"}),
    "admin": frozenset({"admin"}),
    "storefront+admin": frozenset({"widget", "admin"}),
    "backend": frozenset(),
}


class _StrictModel(BaseModel):
    """Shared model_config — every nested model inherits these flags."""

    model_config = ConfigDict(extra="forbid", frozen=True)


# ── Triggers (discriminated union by `kind`) ──────────────────────────


class ExternalEventTrigger(_StrictModel):
    kind: Literal["external-event"]
    event: str
    signalFields: list[str]
    idempotency: str


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


class Capability(_StrictModel):
    id: str
    description: str
    kind: Literal["read", "write", "compute", "notify"]
    dataNeeds: list[str]
    integration: Optional[Literal["shopify-admin", "shopify-storefront", "email"]]


# ── Persistence ───────────────────────────────────────────────────────


class Column(_StrictModel):
    name: str
    role: Literal[
        "identifier",
        "reference",
        "timestamp",
        "money",
        "status",
        "flag",
        "text",
        "count",
    ]
    nullable: bool

    # Rules #46 + #47 — deny-listed column names. Platform-owned email
    # template fields and implicit-tenant `tenant_id` must never appear in
    # an HLD plan.
    @field_validator("name")
    @classmethod
    def _name_not_forbidden(cls, v: str) -> str:
        if v in _PLATFORM_OWNED_COLUMNS:
            raise ValueError(
                f"column name '{v}' is platform-owned (email template "
                "fields are managed by the platform; do not declare them "
                "in HLD)"
            )
        if v in _IMPLICIT_COLUMNS:
            raise ValueError(
                f"column name '{v}' is implicit — multi-tenancy is "
                "handled by the runtime; do not declare a tenant_id column"
            )
        return v


class Table(_StrictModel):
    name: str
    purpose: str
    columns: list[Column]
    keyedBy: str
    statusField: Optional[str] = None

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


# ── HLD plan (top-level) ──────────────────────────────────────────────


class HLDPlan(_StrictModel):
    """
    Top-level HLD plan. Single source of truth for the prompt's JSON
    schema and the parser's contract.
    """

    schema_version: Literal["1"] = "1"
    archetype: Literal["storefront", "admin", "storefront+admin", "backend"]
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

    # Rules #42 + #43 — stateMachine and statusField are bound 1:1.
    # If stateMachine is null, no table may declare a statusField.
    # If stateMachine is non-null, exactly one table must declare a
    # statusField. Either side broken means the state machine has no
    # column to apply transitions to (or has more than one).
    @model_validator(mode="after")
    def _state_machine_bound_to_status_field(self) -> "HLDPlan":
        tables_with_status = [t for t in self.persistence if t.statusField is not None]
        if self.stateMachine is None:
            if tables_with_status:
                names = [t.name for t in tables_with_status]
                raise ValueError(
                    f"tables {names} declare a statusField but stateMachine "
                    "is null; statusField is only valid when stateMachine "
                    "is declared"
                )
            return self
        if len(tables_with_status) == 0:
            raise ValueError(
                "stateMachine is declared but no persistence table has a "
                "statusField; bind the state machine to exactly one table"
            )
        if len(tables_with_status) > 1:
            names = [t.name for t in tables_with_status]
            raise ValueError(
                f"stateMachine is declared but multiple tables {names} "
                "have a statusField; bind to exactly one"
            )
        return self

    # Rule #58 — externalContracts must be empty for backend archetypes,
    # and surfaces declared in contracts must be a subset of those
    # implied by the archetype. Without this, you can ship a "backend"
    # plan that silently exposes widget routes (or vice versa).
    @model_validator(mode="after")
    def _archetype_matches_external_contracts(self) -> "HLDPlan":
        allowed = _ARCHETYPE_SURFACES[self.archetype]
        if self.archetype == "backend":
            if self.externalContracts:
                raise ValueError(
                    "archetype 'backend' must not declare any externalContracts"
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
