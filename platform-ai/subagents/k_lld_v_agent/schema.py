"""
Pydantic output schema for the LLD validator agent.

Mirrors `b_hld_v_agent.schema` exactly — same severity ladder, same
4-field finding shape, same 5-item cap. Kept as its own type so the LLD
validator can evolve independently without coupling to HLD-validator
behaviour.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class LLDVFinding(_StrictModel):
    severity: Literal["critical", "important", "minor"]
    location: str = Field(min_length=1)
    issue: str = Field(min_length=1)
    fix: str = Field(min_length=1)


class LLDVOutput(_StrictModel):
    findings: list[LLDVFinding] = Field(max_length=5)
