"""
Pydantic output schema for the HLD validator agent.

The validator emits at most 3 findings, ranked by severity. When there are
no critical issues it escalates to the highest available lower severity so
the caller always gets actionable signal.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class HLDVFinding(_StrictModel):
    severity: Literal["critical", "important", "minor"]
    location: str = Field(min_length=1)
    issue: str = Field(min_length=1)
    fix: str = Field(min_length=1)


class HLDVOutput(_StrictModel):
    findings: list[HLDVFinding] = Field(max_length=3)
