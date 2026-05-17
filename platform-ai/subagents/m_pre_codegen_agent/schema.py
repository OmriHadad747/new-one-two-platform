"""
Pydantic output schema for the pre-codegen alignment agent.

The agent emits short, structured alignment notes. Each note pins down a
single cross-surface ambiguity (a numeric field whose unit isn't stated on
the wire, a sibling-currency pairing the LLD only implies, a pagination
convention used in some routes and not others) and translates it into one
imperative line per downstream codegen agent.

Capped at 10 notes — more is noise and inflates downstream prompts. If a
plan has more than 10 real ambiguities the answer is to fix the LLD, not
to grow the alignment list.

Closed vocabularies (`target_agents`, `concern`) are the whole point: they
make per-agent slicing trivial and let humans audit the output without
parsing prose.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# Downstream codegen agents that may receive an alignment note.
AlignmentTarget = Literal["db", "backend", "storefront", "admin_ui"]


# Closed set of cross-surface concerns. Add new entries only when a real
# bug class surfaces in production — keeping the list small forces notes
# to map onto known fix patterns instead of free-form prose.
AlignmentConcern = Literal[
    "unit",          # numeric field's unit (bps / ratio / minor_units / ms / …)
    "format",        # string field's format (iso-8601 / iso-4217 / uuid / gid / …)
    "nullability",   # absent-vs-explicit-null semantics on a field
    "pagination",    # offset / cursor / inline convention
    "id_shape",      # raw external id vs gid vs internal uuid
    "protocol",      # cross-route invariant (validate-then-act, idempotency keys, …)
]


class AlignmentNote(_StrictModel):
    """
    One alignment note. The combination of `target_agents` + `concern` +
    `surfaces` makes the note searchable and deduplicatable; the
    `instruction` is the line that gets injected into each target's
    system / user prompt.
    """

    target_agents: list[AlignmentTarget] = Field(min_length=1)
    concern: AlignmentConcern
    # Exact LLD paths the note touches (in dot/bracket form), e.g.
    # "httpRoutes.<surface>[<i>].requestShape.<field>",
    # "database.tables[<i>].columns[<j>]",
    # "capabilityRecipes.<recipe-id>.steps[<i>]".
    # One entry per surface.
    surfaces: list[str] = Field(min_length=1)
    # One short imperative line. The agent is told to write it as if it
    # were a system-prompt rule for the target agent — concrete enough
    # that the codegen LLM can act on it without re-reasoning. The cap
    # is generous (≈200 words) so the agent can describe a multi-surface
    # protocol — the practical ceiling is the LLM's output-token budget,
    # not this field length. A pathological 800-char instruction is the
    # exact case where bumping the cap further would be worse than
    # rewriting the prompt.
    instruction: str = Field(min_length=1, max_length=800)
    # One short sentence saying why the alignment matters (which bug it
    # prevents). Used in logs and human audits; not injected into the
    # downstream prompt to avoid bloat. Rationales are inherently short
    # — empirically 150–200 chars — so 400 is a safe ceiling.
    rationale: str = Field(min_length=1, max_length=400)


class PreCodegenOutput(_StrictModel):
    notes: list[AlignmentNote] = Field(max_length=10)
