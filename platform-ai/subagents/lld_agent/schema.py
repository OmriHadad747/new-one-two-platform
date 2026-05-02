"""
Pydantic output schema for the LLD agent.

The LLD agent emits the COMPLETE implementation specification: physical
SQL schema, wire-level HTTP route shapes, Shopify integration plan
(webhook topics + cron expression), and per-capability ordered algorithm
recipes. Codegen agents downstream implement the spec verbatim.

Validation policy
-----------------
- `extra="forbid"` on every model: extra keys are hard errors. Catches
  hallucinated fields before they propagate to downstream stages.
- `frozen=True` on every model: plans are immutable once parsed.
- Single entry point: `LLDPlan.model_validate_json(text)`.
- Closed-set fields use `Literal[...]` and discriminated unions — typing
  alone enforces them, no validator code needed.
- Recipe step kinds use a `Literal` discriminator + `Annotated[Union[...],
  Field(discriminator="kind")]` so each step shape is checked against the
  right schema variant.
- Cross-field invariants live in `@model_validator` methods on the
  containing model.
"""

from __future__ import annotations

from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# ── Strict base ──────────────────────────────────────────────────────────────


class _StrictModel(BaseModel):
    """Shared model_config — every nested model inherits these flags."""

    model_config = ConfigDict(extra="forbid", frozen=True)


# ── Forbidden columns (validation rejects) ───────────────────────────────────

_FORBIDDEN_COLUMN_NAMES: frozenset[str] = frozenset(
    {
        # Tenant-isolation drift — schema-level isolation replaces per-row keys.
        "tenant_id",
        "shop_id",
        "shop_domain",
        "account_id",
        # Platform-owned email template fields (managed by app_email_configs).
        "email_subject",
        "email_body",
        "email_body_template",
        "email_cta_label",
        "email_cta_url",
        "email_from_name",
    }
)


# ── 1. shopifyIntegration ────────────────────────────────────────────────────


_WEBHOOK_TOPIC_RE = r"^[a-z][a-z_0-9]*/[a-z][a-z_0-9]*$"
_CRON_EXPR_RE = r"^\S+\s+\S+\s+\S+\s+\S+\s+\S+$"  # 5 whitespace-separated fields


class ShopifyIntegration(_StrictModel):
    """Top-level Shopify integration plan derived from HLD triggers + ops-picks."""

    webhookTopics: list[str] = Field(default_factory=list)
    cronSchedule: Optional[str] = None
    bulkFetchRequired: bool = False

    @field_validator("webhookTopics")
    @classmethod
    def _topics_lowercase_rest(cls, v: list[str]) -> list[str]:
        # Topic strings must be lowercase REST format (e.g. orders/create).
        # Catches the common GraphQL-enum-format slip (ORDERS_CREATE).
        import re

        for t in v:
            if not re.match(_WEBHOOK_TOPIC_RE, t):
                raise ValueError(
                    f"webhookTopic '{t}' is not lowercase REST format "
                    "(expected 'resource/action', e.g. 'orders/create')"
                )
        return v

    @field_validator("cronSchedule")
    @classmethod
    def _cron_well_formed(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        import re

        if not re.match(_CRON_EXPR_RE, v):
            raise ValueError(
                f"cronSchedule '{v}' is not a 5-field cron expression "
                "(e.g. '*/15 * * * *')"
            )
        return v


# ── 2. database ──────────────────────────────────────────────────────────────


SqlType = Literal[
    "UUID",
    "BIGINT",
    "TEXT",
    "TIMESTAMPTZ",
    "BOOLEAN",
    "JSONB",
    "INTEGER",
]


class Column(_StrictModel):
    name: str = Field(min_length=1)
    sqlType: SqlType
    constraints: str  # raw SQL fragment (NOT NULL DEFAULT ..., REFERENCES ...)
    enum: Optional[list[str]] = None
    purpose: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _name_not_forbidden(cls, v: str) -> str:
        if v in _FORBIDDEN_COLUMN_NAMES:
            raise ValueError(
                f"column name '{v}' is forbidden "
                "(tenant isolation is schema-level OR field is platform-owned)"
            )
        return v

    @model_validator(mode="after")
    def _enum_default_member(self) -> "Column":
        # If column has an enum and a DEFAULT, the default literal must be in
        # the enum list — otherwise the CHECK constraint fails on first INSERT.
        if not self.enum:
            return self
        import re

        m = re.search(r"DEFAULT\s+'([^']+)'", self.constraints)
        if m and m.group(1) not in self.enum:
            raise ValueError(
                f"column '{self.name}' DEFAULT '{m.group(1)}' is not in "
                f"enum {self.enum}"
            )
        return self


class UniqueConstraint(_StrictModel):
    columns: list[str] = Field(min_length=1)


class ForeignKey(_StrictModel):
    column: str = Field(min_length=1)
    references: str = Field(min_length=1)  # "other_table(id)" form
    onDelete: Literal["CASCADE", "SET NULL", "RESTRICT"]


class Table(_StrictModel):
    name: str = Field(min_length=1)
    purpose: str
    singleton: bool = False
    columns: list[Column] = Field(min_length=1)
    uniqueConstraint: Optional[UniqueConstraint] = None
    indexes: list[str] = Field(default_factory=list)
    foreignKeys: list[ForeignKey] = Field(default_factory=list)

    @model_validator(mode="after")
    def _singleton_shape(self) -> "Table":
        # Singleton tables: no `id` column, no uniqueConstraint (the
        # generator emits the singleton BOOLEAN PK by construction).
        if not self.singleton:
            return self
        if any(c.name == "id" for c in self.columns):
            raise ValueError(
                f"singleton table '{self.name}' must NOT declare an `id` "
                "column — the migration generator emits "
                "`singleton BOOLEAN PRIMARY KEY` by construction"
            )
        if self.uniqueConstraint is not None:
            raise ValueError(
                f"singleton table '{self.name}' must NOT declare a "
                "uniqueConstraint — the singleton PK enforces uniqueness"
            )
        return self

    @model_validator(mode="after")
    def _fk_columns_exist(self) -> "Table":
        names = {c.name for c in self.columns}
        for fk in self.foreignKeys:
            if fk.column not in names:
                raise ValueError(
                    f"foreignKey on table '{self.name}' references column "
                    f"'{fk.column}' which is not declared on this table"
                )
        return self


class Database(_StrictModel):
    tables: list[Table] = Field(default_factory=list)

    @model_validator(mode="after")
    def _table_names_unique(self) -> "Database":
        seen: set[str] = set()
        for t in self.tables:
            if t.name in seen:
                raise ValueError(
                    f"table '{t.name}' is declared more than once in database.tables"
                )
            seen.add(t.name)
        return self


# ── 3. stateMachine ──────────────────────────────────────────────────────────


class StateTransition(_StrictModel):
    # `from` is a Python keyword; aliased to the JSON wire field.
    from_: str = Field(alias="from")
    to: str
    trigger: str
    action: str

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class StateMachine(_StrictModel):
    table: str = Field(min_length=1)
    column: str = Field(min_length=1)
    states: list[str] = Field(min_length=1)
    initialState: str
    terminalStates: list[str] = Field(default_factory=list)
    unknownSentinel: Literal["null"] = "null"
    skipWhenUnknown: bool
    transitions: list[StateTransition] = Field(min_length=1)

    @model_validator(mode="after")
    def _state_references_resolve(self) -> "StateMachine":
        states = set(self.states)
        if self.initialState not in states:
            raise ValueError(
                f"initialState '{self.initialState}' is not in states {sorted(states)}"
            )
        for term in self.terminalStates:
            if term not in states:
                raise ValueError(
                    f"terminalState '{term}' is not in states {sorted(states)}"
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


# ── 4. httpRoutes ────────────────────────────────────────────────────────────


class HttpRoute(_StrictModel):
    path: str = Field(min_length=1)
    method: Literal["GET", "POST", "PUT", "DELETE"]
    purpose: str
    requestShape: dict[str, str] = Field(default_factory=dict)
    responseShape: dict[str, str] = Field(default_factory=dict)
    paginationKind: Optional[Literal["offset", "cursor"]] = None

    @field_validator("path")
    @classmethod
    def _path_well_formed(cls, v: str) -> str:
        if not v.startswith("/"):
            raise ValueError(f"path '{v}' must start with '/'")
        if ":" in v:
            raise ValueError(
                f"path '{v}' contains ':' — Express-style :param routes are not "
                "allowed; use query / body params instead"
            )
        return v


class HttpRoutes(_StrictModel):
    widget: list[HttpRoute] = Field(default_factory=list)
    admin: list[HttpRoute] = Field(default_factory=list)

    @model_validator(mode="after")
    def _paths_unique_within_surface(self) -> "HttpRoutes":
        for surface_name, routes in (("widget", self.widget), ("admin", self.admin)):
            seen: set[tuple[str, str]] = set()
            for r in routes:
                key = (r.method, r.path)
                if key in seen:
                    raise ValueError(
                        f"httpRoutes.{surface_name} declares "
                        f"({r.method} {r.path}) more than once"
                    )
                seen.add(key)
        return self


# ── 5. capabilityRecipes — recipe inputs + step kinds ────────────────────────


InputSource = Literal[
    "webhook.payload",
    "request.body",
    "request.query",
    "cron.payload",
    "platform.context",
    "constant",
]


class RecipeInput(_StrictModel):
    name: str = Field(min_length=1)
    source: InputSource
    fieldPath: str  # dot-path or key name; literal JSON for `constant`
    type: str  # TS-ish type string
    nullable: bool


class Binding(_StrictModel):
    """A bind from a SQL/GraphQL placeholder to a recipe-input or earlier step."""

    name: str = Field(min_length=1)
    source: str = Field(min_length=1)


# ── Step kinds (discriminated union) ──────────────────────────────────────────
#
# Every step carries a `kind` Literal + `purpose`, and may carry
# `bindResultTo`. Kind-specific fields live on each subclass.
#
# Mutually-recursive step containers (`decision`, `for_each`,
# `sql_transaction`) refer to `RecipeStep`, which is defined as
# `Annotated[Union[...]]` after all subclasses below; Pydantic resolves the
# forward reference via `model_rebuild()` at the end of this section.


class _StepBase(_StrictModel):
    kind: str  # overridden by Literal in each subclass
    purpose: str
    bindResultTo: Optional[str] = None


PaginationStrategy = Literal["single", "graphqlPaginate", "bulkQuery"]


class ShopifyQueryStep(_StepBase):
    kind: Literal["shopify_query"]
    op: str = Field(min_length=1)
    query: str = Field(min_length=1)  # full GraphQL string, verbatim
    variables: dict[str, str] = Field(default_factory=dict)  # {paramName: "$bind"}
    paginationStrategy: PaginationStrategy
    connectionPath: Optional[str] = None
    elementBinding: Optional[str] = None

    @model_validator(mode="after")
    def _paginated_requires_connection(self) -> "ShopifyQueryStep":
        if self.paginationStrategy in ("graphqlPaginate", "bulkQuery"):
            if not self.connectionPath:
                raise ValueError(
                    f"shopify_query step '{self.purpose}' uses "
                    f"paginationStrategy='{self.paginationStrategy}' but "
                    "connectionPath is not set"
                )
        return self


class ShopifyMutationStep(_StepBase):
    kind: Literal["shopify_mutation"]
    op: str = Field(min_length=1)
    mutation: str = Field(min_length=1)
    variables: dict[str, str] = Field(default_factory=dict)
    userErrorsCheck: Literal[True] = True  # always required


class SqlSelectStep(_StepBase):
    kind: Literal["sql_select"]
    template: str = Field(min_length=1)
    bindings: list[Binding] = Field(default_factory=list)


class SqlClaimStep(_StepBase):
    kind: Literal["sql_claim"]
    template: str = Field(min_length=1)
    bindings: list[Binding] = Field(default_factory=list)
    zeroRowAction: Literal["skip", "throw"]

    @model_validator(mode="after")
    def _claim_template_shape(self) -> "SqlClaimStep":
        # An atomic claim is UPDATE ... RETURNING. Catch the common slip of
        # writing a SELECT or an INSERT in a sql_claim step.
        upper = self.template.upper().lstrip()
        if not upper.startswith("UPDATE"):
            raise ValueError(
                f"sql_claim step '{self.purpose}' template must start with "
                "UPDATE; use sql_select / sql_insert / sql_upsert for other shapes"
            )
        if "RETURNING" not in upper:
            raise ValueError(
                f"sql_claim step '{self.purpose}' template must include "
                "RETURNING so the handler can detect zero-row claims"
            )
        return self


class SqlInsertStep(_StepBase):
    kind: Literal["sql_insert"]
    template: str = Field(min_length=1)
    bindings: list[Binding] = Field(default_factory=list)


class SqlUpdateStep(_StepBase):
    kind: Literal["sql_update"]
    template: str = Field(min_length=1)
    bindings: list[Binding] = Field(default_factory=list)


class SqlUpsertStep(_StepBase):
    kind: Literal["sql_upsert"]
    template: str = Field(min_length=1)
    bindings: list[Binding] = Field(default_factory=list)


class SqlTransactionStep(_StepBase):
    kind: Literal["sql_transaction"]
    steps: list["RecipeStep"] = Field(min_length=1)


class ComputeStep(_StepBase):
    kind: Literal["compute"]
    expression: str = Field(min_length=1)


class DecisionStep(_StepBase):
    kind: Literal["decision"]
    condition: str = Field(min_length=1)
    ifTrue: list["RecipeStep"] = Field(default_factory=list)
    ifFalse: list["RecipeStep"] = Field(default_factory=list)


class ForEachStep(_StepBase):
    kind: Literal["for_each"]
    source: str = Field(min_length=1)  # bound name of collection
    iterationBinding: str = Field(min_length=1)
    steps: list["RecipeStep"] = Field(min_length=1)


class EmailSendStep(_StepBase):
    kind: Literal["email_send"]
    to: str = Field(min_length=1)  # bound name carrying recipient
    dataKeys: list[str] = Field(default_factory=list)
    onQuotaExceeded: Literal["log_and_skip", "abort_recipe"]
    onSoftFailure: Literal["log_and_skip", "abort_recipe"] = "log_and_skip"


class EmailSendBatchStep(_StepBase):
    kind: Literal["email_send_batch"]
    itemsBinding: str = Field(min_length=1)
    onQuotaExceeded: Literal["log_and_skip", "abort_recipe"]


class FilesUploadStep(_StepBase):
    kind: Literal["files_upload"]
    size: Literal["small", "large"]
    contentBinding: str = Field(min_length=1)
    metadataBinding: str = Field(min_length=1)


class FetchExternalStep(_StepBase):
    kind: Literal["fetch_external"]
    url: str = Field(min_length=1)
    method: Literal["GET", "POST", "PUT", "DELETE"]
    headers: dict[str, str] = Field(default_factory=dict)
    body: Optional[str] = None  # bound name | null
    timeoutMs: int = Field(gt=0, le=5000)

    @field_validator("url")
    @classmethod
    def _no_shopify_or_platform(cls, v: str) -> str:
        # fetch_external is for THIRD-PARTY APIs only. Shopify uses the
        # shopify.* helpers; platform-back uses platform.* — never fetch().
        lower = v.lower()
        if "myshopify.com" in lower or "shopify.dev" in lower or "shopify.com" in lower:
            raise ValueError(
                f"fetch_external url '{v}' targets Shopify — use shopify_query "
                "/ shopify_mutation instead"
            )
        if "/services/" in lower:
            raise ValueError(
                f"fetch_external url '{v}' targets platform-back /services/ — "
                "use the platform.* SDK helpers instead"
            )
        return v


class LogStep(_StepBase):
    kind: Literal["log"]
    level: Literal["info", "warn", "error"]
    fields: dict[str, str] = Field(default_factory=dict)
    message: str = Field(min_length=1)


class ResponseStep(_StepBase):
    kind: Literal["response"]
    status: int = Field(ge=100, le=599)
    body: Optional[dict[str, str]] = None  # field → "$bind" or constant


class ReturnStep(_StepBase):
    kind: Literal["return"]


# Discriminated union — Pydantic picks the right shape by the `kind` literal.
RecipeStep = Annotated[
    Union[
        ShopifyQueryStep,
        ShopifyMutationStep,
        SqlSelectStep,
        SqlClaimStep,
        SqlInsertStep,
        SqlUpdateStep,
        SqlUpsertStep,
        SqlTransactionStep,
        ComputeStep,
        DecisionStep,
        ForEachStep,
        EmailSendStep,
        EmailSendBatchStep,
        FilesUploadStep,
        FetchExternalStep,
        LogStep,
        ResponseStep,
        ReturnStep,
    ],
    Field(discriminator="kind"),
]

# Resolve forward references on the recursive containers.
SqlTransactionStep.model_rebuild()
DecisionStep.model_rebuild()
ForEachStep.model_rebuild()


# ── 5. capabilityRecipes — recipe + triggeredBy validation ───────────────────


_TRIGGERED_BY_RE = r"^(webhook:[a-z][a-z_0-9]*/[a-z][a-z_0-9]*|cron:[a-zA-Z_][a-zA-Z0-9_]*|widget:/.+|admin:/.+)$"


class CapabilityRecipe(_StrictModel):
    triggeredBy: str
    description: str
    inputs: list[RecipeInput] = Field(default_factory=list)
    steps: list[RecipeStep] = Field(min_length=1)
    postconditions: list[str] = Field(default_factory=list)
    edgeCases: list[str] = Field(default_factory=list)

    @field_validator("triggeredBy")
    @classmethod
    def _triggered_by_well_formed(cls, v: str) -> str:
        import re

        if not re.match(_TRIGGERED_BY_RE, v):
            raise ValueError(
                f"triggeredBy '{v}' must be one of: "
                "'webhook:<topic>', 'cron:<jobName>', 'widget:<path>', "
                "'admin:<path>'"
            )
        return v

    @model_validator(mode="after")
    def _input_names_unique(self) -> "CapabilityRecipe":
        seen: set[str] = set()
        for inp in self.inputs:
            if inp.name in seen:
                raise ValueError(
                    f"recipe input '{inp.name}' is declared more than once"
                )
            seen.add(inp.name)
        return self

    @model_validator(mode="after")
    def _terminal_response_only_for_http(self) -> "CapabilityRecipe":
        # `response` may appear inside decision branches, but it only makes
        # sense in widget/admin recipes — webhook/cron handlers use the
        # template's response writer.
        is_http = self.triggeredBy.startswith(("widget:", "admin:"))
        has_response = _contains_response(self.steps)
        if has_response and not is_http:
            raise ValueError(
                f"recipe triggeredBy='{self.triggeredBy}' contains a `response` "
                "step; response is only valid in widget:/admin: recipes "
                "(webhook/cron handlers do not write responses)"
            )
        if is_http and not has_response:
            raise ValueError(
                f"recipe triggeredBy='{self.triggeredBy}' is an HTTP route "
                "but has no `response` step on any branch"
            )
        return self


def _contains_response(steps: list) -> bool:
    """True if any step (including nested decision/for_each/transaction) is a response."""
    for s in steps:
        if isinstance(s, ResponseStep):
            return True
        if isinstance(s, DecisionStep):
            if _contains_response(list(s.ifTrue)) or _contains_response(list(s.ifFalse)):
                return True
        elif isinstance(s, ForEachStep):
            if _contains_response(list(s.steps)):
                return True
        elif isinstance(s, SqlTransactionStep):
            if _contains_response(list(s.steps)):
                return True
    return False


# ── 8. emailSpec ─────────────────────────────────────────────────────────────


class EmailStarterContent(_StrictModel):
    subject: str = Field(min_length=1)
    body: str = Field(min_length=1)


class EmailSpec(_StrictModel):
    type: Literal["transactional", "marketing"]
    purpose: str
    dataKeys: list[str] = Field(default_factory=list)
    starterContent: EmailStarterContent


# ── 7. platformGaps ──────────────────────────────────────────────────────────


class PlatformGap(_StrictModel):
    gap: str
    mitigation: str
    uxImplication: Optional[str] = None


# ── 9. uxExpectations ────────────────────────────────────────────────────────


class UxExpectations(_StrictModel):
    storefront: Optional[str] = None
    admin: Optional[str] = None


# ── 6. widgetTargetTemplates ─────────────────────────────────────────────────

WidgetTemplate = Literal[
    "product", "collection", "index", "cart", "page", "blog", "article", "search"
]


# ── Top-level LLDPlan ────────────────────────────────────────────────────────


class LLDPlan(_StrictModel):
    """Top-level LLD plan. Single source of truth for the prompt's JSON schema."""

    schema_version: Literal["1"] = "1"

    shopifyIntegration: ShopifyIntegration
    database: Database
    stateMachine: Optional[StateMachine] = None
    httpRoutes: HttpRoutes
    capabilityRecipes: Dict[str, CapabilityRecipe]
    widgetTargetTemplates: Optional[list[WidgetTemplate]] = None
    platformGaps: list[PlatformGap] = Field(default_factory=list)
    emailSpec: Optional[EmailSpec] = None
    uxExpectations: UxExpectations
    edgeCases: list[str] = Field(default_factory=list)

    # ── Cross-section invariants ────────────────────────────────────────────

    @model_validator(mode="after")
    def _state_machine_table_and_column_resolve(self) -> "LLDPlan":
        """stateMachine.table must exist in database.tables; .column on that table."""
        if self.stateMachine is None:
            return self
        sm = self.stateMachine
        table = next((t for t in self.database.tables if t.name == sm.table), None)
        if table is None:
            raise ValueError(
                f"stateMachine.table '{sm.table}' is not declared in database.tables"
            )
        column = next((c for c in table.columns if c.name == sm.column), None)
        if column is None:
            raise ValueError(
                f"stateMachine.column '{sm.column}' is not declared on table "
                f"'{sm.table}'"
            )
        # The column's enum must list every state (the unknown sentinel is
        # encoded as NULL on the column, not as a string in the enum).
        if column.enum is None:
            raise ValueError(
                f"stateMachine.column '{sm.column}' on table '{sm.table}' must "
                "declare an enum listing every state"
            )
        missing = [s for s in sm.states if s not in column.enum]
        if missing:
            raise ValueError(
                f"stateMachine.column '{sm.column}' enum is missing states "
                f"{missing}"
            )
        # The column must be nullable (constraints contains NULL but not
        # NOT NULL) so null can encode "never observed".
        upper = column.constraints.upper()
        if "NOT NULL" in upper:
            raise ValueError(
                f"stateMachine.column '{sm.column}' on table '{sm.table}' must "
                "be NULLABLE (no NOT NULL) so null encodes 'never observed'"
            )
        return self

    @model_validator(mode="after")
    def _every_route_has_recipe(self) -> "LLDPlan":
        """Every httpRoutes.widget/admin entry must have a backing recipe."""
        triggers = {r.triggeredBy for r in self.capabilityRecipes.values()}
        for route in self.httpRoutes.widget:
            key = f"widget:{route.path}"
            if key not in triggers:
                raise ValueError(
                    f"httpRoutes.widget '{route.path}' has no backing recipe "
                    f"(expected a capabilityRecipes entry with triggeredBy='{key}')"
                )
        for route in self.httpRoutes.admin:
            key = f"admin:{route.path}"
            if key not in triggers:
                raise ValueError(
                    f"httpRoutes.admin '{route.path}' has no backing recipe "
                    f"(expected a capabilityRecipes entry with triggeredBy='{key}')"
                )
        return self

    @model_validator(mode="after")
    def _every_webhook_topic_has_recipe(self) -> "LLDPlan":
        """Every shopifyIntegration.webhookTopics entry must have a recipe."""
        triggers = {r.triggeredBy for r in self.capabilityRecipes.values()}
        for topic in self.shopifyIntegration.webhookTopics:
            key = f"webhook:{topic}"
            if key not in triggers:
                raise ValueError(
                    f"shopifyIntegration.webhookTopics declares '{topic}' but "
                    f"no capabilityRecipes entry has triggeredBy='{key}'"
                )
        return self

    @model_validator(mode="after")
    def _cron_recipes_match_schedule(self) -> "LLDPlan":
        """A cronSchedule requires at least one cron:* recipe; absent cronSchedule forbids any."""
        triggers = {r.triggeredBy for r in self.capabilityRecipes.values()}
        cron_recipes = [t for t in triggers if t.startswith("cron:")]
        if self.shopifyIntegration.cronSchedule is None and cron_recipes:
            raise ValueError(
                "capabilityRecipes contains cron:* recipe(s) "
                f"{sorted(cron_recipes)} but shopifyIntegration.cronSchedule is null"
            )
        if self.shopifyIntegration.cronSchedule is not None and not cron_recipes:
            raise ValueError(
                "shopifyIntegration.cronSchedule is set but no capabilityRecipes "
                "entry has triggeredBy='cron:<jobName>'"
            )
        return self

    @model_validator(mode="after")
    def _email_spec_iff_email_steps(self) -> "LLDPlan":
        """emailSpec must be set iff any recipe has email_send/email_send_batch steps."""
        has_email_step = any(
            _contains_email(list(r.steps)) for r in self.capabilityRecipes.values()
        )
        if has_email_step and self.emailSpec is None:
            raise ValueError(
                "capabilityRecipes contain email_send/email_send_batch steps "
                "but emailSpec is null"
            )
        if not has_email_step and self.emailSpec is not None:
            raise ValueError(
                "emailSpec is set but no recipe has an email_send/email_send_batch step"
            )
        return self

    @model_validator(mode="after")
    def _email_step_data_keys_subset_of_spec(self) -> "LLDPlan":
        """Every email_send.dataKeys must be a subset of emailSpec.dataKeys."""
        if self.emailSpec is None:
            return self
        spec_keys = set(self.emailSpec.dataKeys)
        for rid, recipe in self.capabilityRecipes.items():
            for step_keys in _collect_email_data_keys(list(recipe.steps)):
                missing = [k for k in step_keys if k not in spec_keys]
                if missing:
                    raise ValueError(
                        f"recipe '{rid}' email step references dataKeys {missing} "
                        "which are not declared in emailSpec.dataKeys"
                    )
        return self


def _contains_email(steps: list) -> bool:
    for s in steps:
        if isinstance(s, (EmailSendStep, EmailSendBatchStep)):
            return True
        if isinstance(s, DecisionStep):
            if _contains_email(list(s.ifTrue)) or _contains_email(list(s.ifFalse)):
                return True
        elif isinstance(s, ForEachStep):
            if _contains_email(list(s.steps)):
                return True
        elif isinstance(s, SqlTransactionStep):
            if _contains_email(list(s.steps)):
                return True
    return False


def _collect_email_data_keys(steps: list) -> list[list[str]]:
    """Return a list of dataKeys lists, one per email_send step encountered."""
    out: list[list[str]] = []
    for s in steps:
        if isinstance(s, EmailSendStep):
            out.append(list(s.dataKeys))
        elif isinstance(s, DecisionStep):
            out.extend(_collect_email_data_keys(list(s.ifTrue)))
            out.extend(_collect_email_data_keys(list(s.ifFalse)))
        elif isinstance(s, ForEachStep):
            out.extend(_collect_email_data_keys(list(s.steps)))
        elif isinstance(s, SqlTransactionStep):
            out.extend(_collect_email_data_keys(list(s.steps)))
    return out
