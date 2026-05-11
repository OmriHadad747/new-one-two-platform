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


_TEMPLATE_OWNED_TABLES: frozenset[str] = frozenset(
    {
        "processed_webhooks",
        "cron_queue",
        "app_config",
    }
)


class Table(_StrictModel):
    name: str = Field(min_length=1)
    purpose: str
    columns: list[Column] = Field(min_length=1)
    uniqueConstraint: Optional[UniqueConstraint] = None
    indexes: list[str] = Field(default_factory=list)
    foreignKeys: list[ForeignKey] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _name_not_template_owned(cls, v: str) -> str:
        if v in _TEMPLATE_OWNED_TABLES:
            raise ValueError(
                f"table name '{v}' is template-owned (managed by the "
                "platform handler template); the LLD must not redeclare it"
            )
        return v

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
    """
    Two flavours, picked by `kind`:

      "observation" — change-detection on an EXTERNAL value (Shopify enum
                       field flipping over time). Column is NULLABLE with no
                       DEFAULT — null encodes "never observed". Recipes
                       MUST treat null→value as a non-transition when
                       `skipWhenUnknown=true`. This matches the canonical
                       HLD use of stateMachine.

      "workflow"    — internal lifecycle driven by THIS app's own writes
                       (e.g. job queue: pending→running→completed). Column
                       is NOT NULL DEFAULT '<initialState>'. Per HLD policy
                       the upstream agent should NOT emit a stateMachine for
                       workflow lifecycles (they're plain enum columns
                       bound via `statusField`); this kind exists so the
                       LLD can still represent a workflow when one
                       legitimately surfaces, without forcing a misleading
                       NULLABLE column.
    """

    kind: Literal["observation", "workflow"]
    table: str = Field(min_length=1)
    column: str = Field(min_length=1)
    states: list[str] = Field(min_length=1)
    initialState: str
    terminalStates: list[str] = Field(default_factory=list)
    unknownSentinel: Literal["null"] = "null"
    skipWhenUnknown: bool = False
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
    # "offset" / "cursor"  →  the route's primary purpose is to page through a
    #                         large collection; LLD generates paginate() / cursor
    #                         helpers and the validator enforces matching recipe
    #                         shape.
    # "inline"  →  the route returns a mixed response that happens to include a
    #              bounded embedded list (top-N rankings, fixed-size collection
    #              capped by config). The list is naturally bounded; no cursor
    #              or offset machinery is needed. Use this instead of None when
    #              the responseShape carries a `[]` value but the caller is not
    #              paginating.
    paginationKind: Optional[Literal["offset", "cursor", "inline"]] = None

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
    # When true, the codegen wraps each iteration in `try { ... } catch (err) { ... }`
    # so a single failing item does NOT abort the rest of the batch. The
    # caught error is bound to `errorBinding` (default: "iterationError")
    # for the caller's continue-handling logic. Use this for any for_each
    # whose body has a side-effect step (shopify_mutation, email_send,
    # email_send_batch, files_upload, fetch_external) — without it, one
    # throw kills the whole loop.
    continueOnError: bool = False
    errorBinding: Optional[str] = None
    # Optional bound name where successful-item ids accumulate; codegen
    # initialises it to []. Useful for partial-success reporting.
    successItemsBinding: Optional[str] = None
    # Optional bound name where failed-item descriptors accumulate; codegen
    # initialises it to []. Each entry is `{ item, error }`. Useful for
    # the recipe's failure-summary log / response.
    failedItemsBinding: Optional[str] = None


class TryCatchStep(_StepBase):
    """
    Try/catch primitive — gives the LLD a way to express failure paths
    that previously could only be hinted at in prose. Codegen translates
    to `try { <try> } catch (err) { <catch> }`. The `errorBinding` (default
    "caughtError") names the JS error so catch-body steps can reference
    `errorBinding.message` in compute / sql_update bindings (e.g. to
    persist a failure_reason).

    Required for any side-effect that has a meaningful failure path
    (e.g. flipping a workflow row to 'failed' on a Shopify call throw).
    """

    kind: Literal["try_catch"]
    try_: list["RecipeStep"] = Field(alias="try", min_length=1)
    catch: list["RecipeStep"] = Field(min_length=1)
    errorBinding: str = "caughtError"

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class EnqueueStep(_StepBase):
    """
    Push a row onto the tenant's `cron_queue` so a cron recipe can pick
    it up asynchronously. The HTTP-route pattern is:

        sql_insert (record the request)        ← bindResultTo: "newRow"
        enqueue   (push job, dedupKey=$newRow[0].id)
        response  (status=202, return the new record id)

    The cron recipe handles the long work (bulk-fetch, per-item Shopify
    mutation, etc.) without an HTTP timeout window.

    `jobName` MUST match a `triggeredBy: "cron:<jobName>"` recipe — the
    cross-validator on `LLDPlan` enforces this so enqueue calls can never
    target a non-existent job.

    `dedupKey` (optional) collapses concurrent enqueues of the same logical
    job. While a prior row with the same (jobName, dedupKey) is still
    pending or processing, a second enqueue is a silent no-op. Use the
    just-inserted parent record's id to make the route idempotent under
    client retry / double-click. The cross-validator
    `_enqueue_after_sql_insert_requires_dedup_key` REQUIRES a dedupKey
    whenever this recipe contains a sql_insert with `bindResultTo` before
    the enqueue (otherwise a retried POST would create N parallel pending
    jobs for the same logical request).
    """

    kind: Literal["enqueue"]
    jobName: str = Field(min_length=1)
    payload: dict[str, str] = Field(default_factory=dict)  # key → "$bind" or constant
    dedupKey: Optional[str] = None  # "$bindName" referencing an upstream id


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
        TryCatchStep,
        EnqueueStep,
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
TryCatchStep.model_rebuild()


# ── 5. capabilityRecipes — recipe + triggeredBy validation ───────────────────


_TRIGGERED_BY_RE = (
    r"^("
    r"webhook:[a-z][a-z_0-9]*/[a-z][a-z_0-9]*"
    r"|cron:[a-zA-Z_][a-zA-Z0-9_]*"
    r"|widget:(GET|POST|PUT|DELETE):/.+"
    r"|admin:(GET|POST|PUT|DELETE):/.+"
    r")$"
)


def _parse_http_triggered_by(tb: str) -> Optional[tuple[str, str, str]]:
    """
    Parse a widget/admin triggeredBy into (surface, method, path).
    Returns None for non-http triggers (webhook/cron).
    Caller is responsible for ensuring the string passed
    `_triggered_by_well_formed`.
    """
    if not (tb.startswith("widget:") or tb.startswith("admin:")):
        return None
    surface, _, rest = tb.partition(":")
    method, _, path = rest.partition(":")
    return surface, method, path


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
                "'webhook:<topic>', 'cron:<jobName>', "
                "'widget:<METHOD>:<path>', 'admin:<METHOD>:<path>' "
                "(METHOD ∈ GET|POST|PUT|DELETE; route binding requires "
                "the method so GET/POST on the same path can coexist)"
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
    """True if any step (including nested decision/for_each/transaction/try_catch) is a response."""
    for s in steps:
        if isinstance(s, ResponseStep):
            return True
        if isinstance(s, DecisionStep):
            if _contains_response(list(s.ifTrue)) or _contains_response(
                list(s.ifFalse)
            ):
                return True
        elif isinstance(s, ForEachStep):
            if _contains_response(list(s.steps)):
                return True
        elif isinstance(s, SqlTransactionStep):
            if _contains_response(list(s.steps)):
                return True
        elif isinstance(s, TryCatchStep):
            if _contains_response(list(s.try_)) or _contains_response(list(s.catch)):
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
    widgetShapes: List[str] = Field(default_factory=list)

    @field_validator("widgetShapes")
    @classmethod
    def _check_widget_shapes(cls, v: List[str]) -> List[str]:
        """Reject any shape name not present in the storefront agent's
        registry. The registry is the single source of truth — adding a
        new shape there makes it valid here automatically."""
        from subagents.e_storefront_agent.widget_shapes import is_known_shape

        bad = [name for name in v if not is_known_shape(name)]
        if bad:
            raise ValueError(
                f"unknown widgetShapes: {sorted(set(bad))}. "
                "Allowed values come from "
                "subagents.e_storefront_agent.widget_shapes.WIDGET_SHAPES."
            )
        return v


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
        # Nullability + DEFAULT requirements differ by state-machine kind.
        upper = column.constraints.upper()
        import re as _re

        if sm.kind == "observation":
            # Observation: column tracks an external value; null encodes
            # "never observed". Must be NULLABLE with no DEFAULT.
            if "NOT NULL" in upper:
                raise ValueError(
                    f"stateMachine kind='observation' on '{sm.table}.{sm.column}' "
                    "requires the column to be NULLABLE (no NOT NULL) so null "
                    "encodes 'never observed'"
                )
            if "DEFAULT" in upper:
                raise ValueError(
                    f"stateMachine kind='observation' on '{sm.table}.{sm.column}' "
                    "must NOT declare a DEFAULT — a default coerces the first "
                    "INSERT past the unknown state and the recipe's "
                    "null-as-never-observed check never fires"
                )
        else:
            # Workflow: column carries the lifecycle state of an internal row;
            # initialState is set at INSERT. Must be NOT NULL with
            # DEFAULT='<initialState>'.
            if "NOT NULL" not in upper:
                raise ValueError(
                    f"stateMachine kind='workflow' on '{sm.table}.{sm.column}' "
                    "requires the column to be NOT NULL (every row carries a state)"
                )
            m = _re.search(r"DEFAULT\s+'([^']+)'", column.constraints)
            if not m:
                raise ValueError(
                    f"stateMachine kind='workflow' on '{sm.table}.{sm.column}' "
                    f"requires a DEFAULT '{sm.initialState}' clause so newly "
                    "inserted rows start in the initial state"
                )
            if m.group(1) != sm.initialState:
                raise ValueError(
                    f"stateMachine kind='workflow' on '{sm.table}.{sm.column}': "
                    f"column DEFAULT '{m.group(1)}' does not match "
                    f"initialState '{sm.initialState}'"
                )
        return self

    @model_validator(mode="after")
    def _every_route_has_recipe(self) -> "LLDPlan":
        """Every httpRoutes.widget/admin entry must have a backing recipe.
        Bound by the (surface, method, path) tuple so GET/POST at the same
        path each get their own recipe."""
        triggers = {r.triggeredBy for r in self.capabilityRecipes.values()}
        for route in self.httpRoutes.widget:
            key = f"widget:{route.method}:{route.path}"
            if key not in triggers:
                raise ValueError(
                    f"httpRoutes.widget '{route.method} {route.path}' has no "
                    f"backing recipe (expected a capabilityRecipes entry with "
                    f"triggeredBy='{key}')"
                )
        for route in self.httpRoutes.admin:
            key = f"admin:{route.method}:{route.path}"
            if key not in triggers:
                raise ValueError(
                    f"httpRoutes.admin '{route.method} {route.path}' has no "
                    f"backing recipe (expected a capabilityRecipes entry with "
                    f"triggeredBy='{key}')"
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
    def _cron_recipes_match_schedule_or_enqueue(self) -> "LLDPlan":
        """
        Every cron:<jobName> recipe must be triggered by something — either
        the periodic `cronSchedule`, or at least one `enqueue` step in another
        recipe targeting that jobName. A cron recipe with neither is
        unreachable.

        Conversely: if `cronSchedule` is set, at least one cron:* recipe must
        exist for the scheduler to dispatch to.
        """
        triggers = {r.triggeredBy for r in self.capabilityRecipes.values()}
        cron_recipes = [t for t in triggers if t.startswith("cron:")]
        cron_job_names = {t[len("cron:") :] for t in cron_recipes}

        # Schedule set but no cron recipe → orphan schedule.
        if self.shopifyIntegration.cronSchedule is not None and not cron_recipes:
            raise ValueError(
                "shopifyIntegration.cronSchedule is set but no capabilityRecipes "
                "entry has triggeredBy='cron:<jobName>'"
            )

        # Each cron recipe must be reachable: scheduled or enqueued from
        # somewhere. Skipped when cronSchedule is set (every cron job is
        # then potentially scheduled — we don't try to map schedule to a
        # specific job here; that's an LLM-level concern).
        if self.shopifyIntegration.cronSchedule is None and cron_recipes:
            enqueue_targets = _collect_enqueue_targets(self.capabilityRecipes)
            unreachable = sorted(cron_job_names - enqueue_targets)
            if unreachable:
                raise ValueError(
                    f"cron:<jobName> recipe(s) {unreachable} are unreachable: "
                    "shopifyIntegration.cronSchedule is null AND no other "
                    "recipe has an `enqueue` step targeting them"
                )
        return self

    @model_validator(mode="after")
    def _enqueue_targets_exist(self) -> "LLDPlan":
        """Every `enqueue.jobName` must match a cron:<jobName> recipe."""
        cron_job_names = {
            r.triggeredBy[len("cron:") :]
            for r in self.capabilityRecipes.values()
            if r.triggeredBy.startswith("cron:")
        }
        for rid, recipe in self.capabilityRecipes.items():
            for step in _collect_enqueue_steps(list(recipe.steps)):
                if step.jobName not in cron_job_names:
                    raise ValueError(
                        f"recipe '{rid}' enqueue step targets jobName "
                        f"'{step.jobName}' but no capabilityRecipes entry has "
                        f"triggeredBy='cron:{step.jobName}'"
                    )
        return self

    @model_validator(mode="after")
    def _enqueue_after_sql_insert_requires_dedup_key(self) -> "LLDPlan":
        """
        Idempotency on retry: when a recipe inserts a row AND THEN enqueues
        a job, the enqueue MUST carry a `dedupKey`. Otherwise a client
        retry (double-click on "Run now", network blip on the POST) will
        create N parallel pending jobs for the same logical request.

        The rule fires when, in the same step list (or branch / loop body /
        try arm), an `enqueue` is preceded by at least one `sql_insert`
        with a `bindResultTo` that the enqueue could reasonably reference.
        We don't require the dedupKey to actually equal the inserted id —
        the model picks an appropriate id; we only require SOMETHING.

        Webhook handlers + cron recipes can still enqueue without a
        dedupKey when no upstream insert is present (e.g. a webhook that
        just kicks off a fresh job per delivery).
        """
        for rid, recipe in self.capabilityRecipes.items():
            errors = _check_enqueue_dedup(list(recipe.steps), inserted=False)
            if errors:
                # Surface the first violation; the rest will surface on the
                # next attempt if the model fixes only the first.
                raise ValueError(
                    f"recipe '{rid}' enqueue step is preceded by a "
                    "sql_insert with bindResultTo but has no dedupKey — "
                    "set dedupKey to '$<insertedRow>[0].id' (or another "
                    "stable identifier) so a retried request collapses "
                    "into a single pending job. Without it, double-clicks "
                    "and client retries create duplicate parallel jobs."
                )
        return self

    @model_validator(mode="after")
    def _http_response_subset_of_route_shape(self) -> "LLDPlan":
        """
        For each HTTP recipe, every reachable `response` step with status in
        [200, 300) must have a body whose top-level keys are a SUBSET of the
        route's responseShape keys. Catches silent contract drift between
        httpRoutes and capabilityRecipes (typo'd field names, fields the
        widget/admin caller would never see).

        Subset (not equality) so the recipe may legitimately omit optional
        fields. Error responses (4xx/5xx) are exempt — those typically carry
        a `{ error: "..." }` shape that doesn't match the success shape.
        """
        # Build (surface, method, path) -> shape-keys index. Method is
        # required to disambiguate GET/POST at the same path.
        route_shapes: dict[tuple[str, str, str], set[str]] = {}
        for r in self.httpRoutes.widget:
            route_shapes[("widget", r.method, r.path)] = set(r.responseShape.keys())
        for r in self.httpRoutes.admin:
            route_shapes[("admin", r.method, r.path)] = set(r.responseShape.keys())

        for rid, recipe in self.capabilityRecipes.items():
            parsed = _parse_http_triggered_by(recipe.triggeredBy)
            if parsed is None:
                continue
            surface, method, path = parsed
            shape_keys = route_shapes.get((surface, method, path))
            if shape_keys is None:
                continue  # route-coverage validator already catches this
            for resp in _collect_response_steps(list(recipe.steps)):
                if resp.body is None:
                    continue
                if not (200 <= resp.status < 300):
                    continue
                body_keys = set(resp.body.keys())
                extra = body_keys - shape_keys
                if extra:
                    raise ValueError(
                        f"recipe '{rid}' response (status={resp.status}) "
                        f"body has keys {sorted(extra)} not declared in "
                        f"httpRoutes.{surface} '{method} {path}' responseShape "
                        f"(declared keys: {sorted(shape_keys)})"
                    )
        return self

    @model_validator(mode="after")
    def _for_each_side_effect_requires_continue_on_error(self) -> "LLDPlan":
        """
        A `for_each` whose body contains a side-effect step (shopify_mutation,
        email_send, email_send_batch, files_upload, fetch_external) MUST
        either set `continueOnError: true` OR wrap the side effect in a
        `try_catch`. Otherwise one item's failure aborts the whole batch
        with no recovery.
        """
        for rid, recipe in self.capabilityRecipes.items():
            for fe in _collect_for_each_steps(list(recipe.steps)):
                body = list(fe.steps)
                # If the for_each itself opts in via continueOnError, OK.
                if fe.continueOnError:
                    continue
                # If every side-effect step in the body is wrapped in a
                # try_catch, OK.
                if not _has_unguarded_side_effect(body):
                    continue
                raise ValueError(
                    f"recipe '{rid}' for_each '{fe.purpose}' contains a "
                    "side-effect step (shopify_mutation / email_send / "
                    "email_send_batch / files_upload / fetch_external) but "
                    "neither sets `continueOnError: true` nor wraps the "
                    "side effect in a `try_catch`. One item's failure would "
                    "abort the whole batch with no recovery."
                )
        return self

    @model_validator(mode="after")
    def _workflow_state_machine_has_sweeper(self) -> "LLDPlan":
        """
        For stateMachine.kind="workflow", at least one cron recipe MUST
        invoke `workflow.sweepStale` against the workflow table.
        Without it, rows that crash mid-execution stay in 'running'
        forever — silent state corruption.

        Detection: scan every cron-triggered recipe's compute steps for
        an expression matching `workflow\\.sweepStale\\(['"]<table>['"]`.
        Tolerant of whitespace and either quote style.
        """
        sm = self.stateMachine
        if sm is None or sm.kind != "workflow":
            return self

        import re

        sweep_re = re.compile(
            r"workflow\s*\.\s*sweepStale\s*\(\s*['\"]" + re.escape(sm.table) + r"['\"]"
        )

        for recipe in self.capabilityRecipes.values():
            if not recipe.triggeredBy.startswith("cron:"):
                continue
            for step in _collect_compute_calls(list(recipe.steps)):
                if sweep_re.search(step):
                    return self

        raise ValueError(
            f"stateMachine.kind='workflow' on '{sm.table}' requires a "
            f"cron recipe with a compute step calling "
            f"`workflow.sweepStale('{sm.table}')` — without it, rows that "
            "crash mid-execution stay 'running' forever. Add a "
            "triggeredBy='cron:sweep_<table>' recipe with a single "
            "compute step running the sweeper (cadence: every 10 min)."
        )

    @model_validator(mode="after")
    def _state_machine_failure_path_implemented(self) -> "LLDPlan":
        """
        If `stateMachine.kind="observation"` declares a transition into a
        failure state (target name contains 'fail', 'cancel', 'error',
        or 'reject'), at least one recipe driving the lifecycle MUST
        contain an `sql_update` whose template flips the column to that
        state. Putting failure semantics only in `platformGaps` prose
        silently leaves orphan rows in the prior state forever.

        Skipped for `kind="workflow"` — those rows transition through
        the platform `workflow` helper, whose `attempt`/`fail` paths
        guarantee the failure write structurally.
        """
        sm = self.stateMachine
        if sm is None:
            return self
        if sm.kind != "observation":
            return self
        failure_states = {
            t.to
            for t in sm.transitions
            if any(tag in t.to.lower() for tag in ("fail", "cancel", "error", "reject"))
        }
        if not failure_states:
            return self
        for fs in failure_states:
            if not _any_recipe_writes_status(
                self.capabilityRecipes, sm.column, fs
            ):
                raise ValueError(
                    f"stateMachine declares a transition to failure state "
                    f"'{fs}' on '{sm.table}.{sm.column}' but no recipe has "
                    f"an sql_update template setting {sm.column}='{fs}'. "
                    "Wrap the failure-prone steps in a try_catch and emit the "
                    "sql_update inside the catch branch."
                )
        return self

    @model_validator(mode="after")
    def _list_response_requires_pagination_kind(self) -> "LLDPlan":
        """
        Any HTTP route whose responseShape contains a list value
        (TS-ish "[]" suffix) MUST declare paginationKind. Catches the
        "I returned a bare array" pattern where pagination was forgotten.
        """
        for surface_name, routes in (
            ("widget", self.httpRoutes.widget),
            ("admin", self.httpRoutes.admin),
        ):
            for route in routes:
                has_list = any(v.rstrip().endswith("[]") for v in route.responseShape.values())
                if has_list and route.paginationKind is None:
                    raise ValueError(
                        f"httpRoutes.{surface_name} '{route.path}' responseShape "
                        "contains a list value but paginationKind is null; set "
                        "paginationKind to 'offset' or 'cursor' for paginated "
                        "collections, or 'inline' for bounded embedded lists "
                        "(top-N rankings, config-capped collections returned "
                        "alongside other fields)"
                    )
        return self

    @model_validator(mode="after")
    def _offset_pagination_no_count_query(self) -> "LLDPlan":
        """
        When a route has paginationKind='offset', its backing recipe must NOT
        contain a sql_select with COUNT(*). The paginate() helper handles
        counting; a manual COUNT query is redundant and contradicts the
        paginate helper contract injected for paginated routes.
        """
        offset_triggers: set[str] = set()
        for r in self.httpRoutes.widget:
            if r.paginationKind == "offset":
                offset_triggers.add(f"widget:{r.method}:{r.path}")
        for r in self.httpRoutes.admin:
            if r.paginationKind == "offset":
                offset_triggers.add(f"admin:{r.method}:{r.path}")

        if not offset_triggers:
            return self

        for rid, recipe in self.capabilityRecipes.items():
            if recipe.triggeredBy not in offset_triggers:
                continue
            for step in _collect_sql_select_steps(list(recipe.steps)):
                if "COUNT(*)" in step.template.upper():
                    raise ValueError(
                        f"recipe '{rid}' (paginationKind='offset') contains a "
                        "sql_select with COUNT(*) — remove it; the paginate() "
                        "helper from ../lib/paginate.js handles counting automatically"
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


def _collect_compute_calls(steps: list) -> list[str]:
    """All ComputeStep expressions in `steps`, recursing into containers."""
    out: list[str] = []
    for s in steps:
        if isinstance(s, ComputeStep):
            out.append(s.expression)
        elif isinstance(s, DecisionStep):
            out.extend(_collect_compute_calls(list(s.ifTrue)))
            out.extend(_collect_compute_calls(list(s.ifFalse)))
        elif isinstance(s, ForEachStep):
            out.extend(_collect_compute_calls(list(s.steps)))
        elif isinstance(s, SqlTransactionStep):
            out.extend(_collect_compute_calls(list(s.steps)))
        elif isinstance(s, TryCatchStep):
            out.extend(_collect_compute_calls(list(s.try_)))
            out.extend(_collect_compute_calls(list(s.catch)))
    return out


def _collect_sql_select_steps(steps: list) -> list["SqlSelectStep"]:
    """All SqlSelectStep instances in `steps`, recursing into containers."""
    out: list[SqlSelectStep] = []
    for s in steps:
        if isinstance(s, SqlSelectStep):
            out.append(s)
        elif isinstance(s, DecisionStep):
            out.extend(_collect_sql_select_steps(list(s.ifTrue)))
            out.extend(_collect_sql_select_steps(list(s.ifFalse)))
        elif isinstance(s, ForEachStep):
            out.extend(_collect_sql_select_steps(list(s.steps)))
        elif isinstance(s, SqlTransactionStep):
            out.extend(_collect_sql_select_steps(list(s.steps)))
        elif isinstance(s, TryCatchStep):
            out.extend(_collect_sql_select_steps(list(s.try_)))
            out.extend(_collect_sql_select_steps(list(s.catch)))
    return out


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
        elif isinstance(s, TryCatchStep):
            if _contains_email(list(s.try_)) or _contains_email(list(s.catch)):
                return True
    return False


def _collect_email_data_keys(steps: list) -> list[list[str]]:
    """Return a list of dataKeys lists, one per email_send step encountered.

    Recurses into every nested step container (decision/for_each/transaction/
    try_catch). Used by the emailSpec.dataKeys cross-validator.
    """
    out: list[list[str]] = []
    for s in steps:
        if isinstance(s, EmailSendStep):
            out.append(list(s.dataKeys))
        elif isinstance(s, DecisionStep):
            out.extend(_collect_email_data_keys(list(s.ifTrue)))
            out.extend(_collect_email_data_keys(list(s.ifFalse)))
        elif isinstance(s, ForEachStep):
            out.extend(_collect_email_data_keys(list(s.steps)))
        elif isinstance(s, TryCatchStep):
            out.extend(_collect_email_data_keys(list(s.try_)))
            out.extend(_collect_email_data_keys(list(s.catch)))
        elif isinstance(s, SqlTransactionStep):
            out.extend(_collect_email_data_keys(list(s.steps)))
    return out


# ── Walkers used by the new LLDPlan cross-validators ────────────────────────


_SIDE_EFFECT_KINDS = (
    ShopifyMutationStep,
    EmailSendStep,
    EmailSendBatchStep,
    FilesUploadStep,
    FetchExternalStep,
)


def _collect_enqueue_steps(steps: list) -> list["EnqueueStep"]:
    """All EnqueueStep instances in `steps`, recursing into containers."""
    out: list[EnqueueStep] = []
    for s in steps:
        if isinstance(s, EnqueueStep):
            out.append(s)
        elif isinstance(s, DecisionStep):
            out.extend(_collect_enqueue_steps(list(s.ifTrue)))
            out.extend(_collect_enqueue_steps(list(s.ifFalse)))
        elif isinstance(s, ForEachStep):
            out.extend(_collect_enqueue_steps(list(s.steps)))
        elif isinstance(s, SqlTransactionStep):
            out.extend(_collect_enqueue_steps(list(s.steps)))
        elif isinstance(s, TryCatchStep):
            out.extend(_collect_enqueue_steps(list(s.try_)))
            out.extend(_collect_enqueue_steps(list(s.catch)))
    return out


def _collect_enqueue_targets(recipes: Dict[str, "CapabilityRecipe"]) -> set[str]:
    """Flatten every recipe's enqueue.jobName values into one set."""
    targets: set[str] = set()
    for r in recipes.values():
        for step in _collect_enqueue_steps(list(r.steps)):
            targets.add(step.jobName)
    return targets


def _collect_response_steps(steps: list) -> list["ResponseStep"]:
    out: list[ResponseStep] = []
    for s in steps:
        if isinstance(s, ResponseStep):
            out.append(s)
        elif isinstance(s, DecisionStep):
            out.extend(_collect_response_steps(list(s.ifTrue)))
            out.extend(_collect_response_steps(list(s.ifFalse)))
        elif isinstance(s, ForEachStep):
            out.extend(_collect_response_steps(list(s.steps)))
        elif isinstance(s, SqlTransactionStep):
            out.extend(_collect_response_steps(list(s.steps)))
        elif isinstance(s, TryCatchStep):
            out.extend(_collect_response_steps(list(s.try_)))
            out.extend(_collect_response_steps(list(s.catch)))
    return out


def _collect_for_each_steps(steps: list) -> list["ForEachStep"]:
    out: list[ForEachStep] = []
    for s in steps:
        if isinstance(s, ForEachStep):
            out.append(s)
            out.extend(_collect_for_each_steps(list(s.steps)))
        elif isinstance(s, DecisionStep):
            out.extend(_collect_for_each_steps(list(s.ifTrue)))
            out.extend(_collect_for_each_steps(list(s.ifFalse)))
        elif isinstance(s, SqlTransactionStep):
            out.extend(_collect_for_each_steps(list(s.steps)))
        elif isinstance(s, TryCatchStep):
            out.extend(_collect_for_each_steps(list(s.try_)))
            out.extend(_collect_for_each_steps(list(s.catch)))
    return out


def _has_unguarded_side_effect(steps: list) -> bool:
    """
    True when any side-effect step appears in `steps` (or in nested
    decision / for_each / sql_transaction containers) WITHOUT being inside
    a try_catch's `try_` arm. A try_catch arm fully shields the body from
    aborting the enclosing for_each, so we treat anything inside `try_` as
    guarded.
    """
    for s in steps:
        if isinstance(s, _SIDE_EFFECT_KINDS):
            return True
        if isinstance(s, TryCatchStep):
            # try_ body is guarded; catch body is the recovery path. Don't
            # recurse into try_ (its side effects don't propagate up). Do
            # recurse into catch — a side effect there IS unguarded.
            if _has_unguarded_side_effect(list(s.catch)):
                return True
        elif isinstance(s, DecisionStep):
            if _has_unguarded_side_effect(list(s.ifTrue)) or _has_unguarded_side_effect(
                list(s.ifFalse)
            ):
                return True
        elif isinstance(s, ForEachStep):
            # Nested for_each: its own continueOnError / try_catch is checked
            # by the outer validator; we still propagate "has side effect" up.
            if _has_unguarded_side_effect(list(s.steps)):
                return True
        elif isinstance(s, SqlTransactionStep):
            if _has_unguarded_side_effect(list(s.steps)):
                return True
    return False


def _any_recipe_writes_status(
    recipes: Dict[str, "CapabilityRecipe"], column: str, value: str
) -> bool:
    """
    True if any sql_update / sql_claim template in any recipe (recursing
    into nested containers) writes `<column>='<value>'`. Tolerant of
    surrounding whitespace and double-quoted column names.
    """
    import re as _re

    # Match: <col>=<value> or <col> = '<value>', allowing quotes around col.
    pattern = _re.compile(
        rf"""\b{_re.escape(column)}\b\s*=\s*'{_re.escape(value)}'""",
        _re.IGNORECASE,
    )

    def _scan(steps: list) -> bool:
        for s in steps:
            if isinstance(s, (SqlUpdateStep, SqlClaimStep, SqlUpsertStep)):
                if pattern.search(s.template):
                    return True
            if isinstance(s, DecisionStep):
                if _scan(list(s.ifTrue)) or _scan(list(s.ifFalse)):
                    return True
            elif isinstance(s, ForEachStep):
                if _scan(list(s.steps)):
                    return True
            elif isinstance(s, SqlTransactionStep):
                if _scan(list(s.steps)):
                    return True
            elif isinstance(s, TryCatchStep):
                if _scan(list(s.try_)) or _scan(list(s.catch)):
                    return True
        return False

    return any(_scan(list(r.steps)) for r in recipes.values())


def _check_enqueue_dedup(steps: list, inserted: bool) -> bool:
    """
    Walk `steps` in order. Track whether a sql_insert with bindResultTo has
    been seen at this scope (or inherited from an enclosing scope via
    `inserted`). Return True if we encounter an `enqueue` step without
    `dedupKey` while `inserted` is True.

    Recurses into containers, propagating the `inserted` flag DOWN
    (something inserted at the outer scope is still in scope inside the
    branch). Branch-local inserts only count for that branch.
    """
    saw_insert = inserted
    for s in steps:
        if isinstance(s, SqlInsertStep):
            if s.bindResultTo:
                saw_insert = True
            continue
        if isinstance(s, EnqueueStep):
            if saw_insert and not s.dedupKey:
                return True
            continue
        if isinstance(s, DecisionStep):
            if _check_enqueue_dedup(list(s.ifTrue), saw_insert):
                return True
            if _check_enqueue_dedup(list(s.ifFalse), saw_insert):
                return True
            continue
        if isinstance(s, ForEachStep):
            if _check_enqueue_dedup(list(s.steps), saw_insert):
                return True
            continue
        if isinstance(s, SqlTransactionStep):
            if _check_enqueue_dedup(list(s.steps), saw_insert):
                return True
            continue
        if isinstance(s, TryCatchStep):
            if _check_enqueue_dedup(list(s.try_), saw_insert):
                return True
            if _check_enqueue_dedup(list(s.catch), saw_insert):
                return True
            continue
    return False
