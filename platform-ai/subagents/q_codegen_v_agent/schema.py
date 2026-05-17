"""
Pydantic output schema for the codegen validator agent.

Mirrors `e_hld_v_agent.schema` and `k_lld_v_agent.schema`: a strict
`Finding` model + an `Output` wrapper with a hard cap on the list.

Findings target one of four codegen artifacts (`backend`, `db`,
`storefront`, `admin_ui`) — those are the agents the pipeline routes
the finding back to on retry. `plan` is accepted for findings that
flag an LLD-level problem (informational only; cannot be patched
because the LLD has already shipped to the codegen agents).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# Canonical artifact names — must match the codegen agents the pipeline
# will route findings back to.
CodegenVArtifact = Literal[
    "plan",
    "backend",
    "db",
    "storefront",
    "admin_ui",
]


class CodegenVFinding(_StrictModel):
    """One runtime-crash / data-corruption bug detected by the agent."""

    artifact: CodegenVArtifact
    location: str = Field(min_length=1)
    issue: str = Field(min_length=1)
    failure_mode: str = Field(min_length=1)
    # The prompt asks for HIGH only; MEDIUM is dropped downstream.
    confidence: Literal["high", "medium"] = "high"


class CodegenVOutput(_StrictModel):
    """Top-level JSON shape the LLM must emit."""

    # Cap at 8 — matches the documented hard cap in the system prompt.
    findings: list[CodegenVFinding] = Field(default_factory=list, max_length=8)
