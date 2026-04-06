"""
Pydantic models mirroring the JSON Schema definitions in /contract/*.schema.json
and the Zod schemas in platform/packages/pubsub-client/src/schemas.ts.

Source of truth: /contract/*.schema.json
When the contract changes, update this file, schemas.ts, and the JSON Schema files.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


# ─── GenerationRequest ────────────────────────────────────────────────────────


class GenerationRequest(BaseModel):
    jobId: str
    tenantId: str
    appId: str
    prompt: str
    existingFeatures: List[str] = Field(default_factory=list)
    priorBundle: Optional[Dict[str, Any]] = None
    preComputedIntent: Optional[Dict[str, Any]] = None


# ─── ProgressEvent ────────────────────────────────────────────────────────────


class ProgressEvent(BaseModel):
    jobId: str
    agent: Literal[
        "product",
        "architect",
        "codespec",
        "handler",
        "migration",
        "widget_js",
        "admin_ui",
        "validation",
        "validator",
        "revision",
        "explanation",
    ]
    status: Literal["running", "completed", "failed", "retrying"]
    message: str
    timestampMs: int
    attempt: Optional[int] = None


# ─── FeatureBundleMessage ─────────────────────────────────────────────────────


class HandlerModule(BaseModel):
    code: str
    webhookTopics: List[str]
    cronSchedule: Optional[str] = None
    npmPackages: List[str] = []


class DbMigration(BaseModel):
    sql: str


class TechnicalExplanation(BaseModel):
    webhookTopics: List[str]
    dbTables: List[str]
    estimatedMonthlyExecutions: int
    estimatedMonthlyCost: str


class FeatureExplanation(BaseModel):
    merchantFacing: str
    technical: TechnicalExplanation


class Bundle(BaseModel):
    widgetModule: Optional[str] = (
        None  # storefront ES module (storefront_backend / storefront_backend_admin apps)
    )
    adminUiModule: Optional[str] = (
        None  # admin panel ES module (storefront_backend_admin apps)
    )
    handlerModule: HandlerModule
    dbMigration: DbMigration
    explanation: FeatureExplanation

    def to_dict(self) -> Dict[str, Any]:
        return {
            "widgetModule": self.widgetModule,
            "adminUiModule": self.adminUiModule,
            "handlerModule": self.handlerModule.model_dump(),
            "dbMigration": self.dbMigration.model_dump(),
            "explanation": self.explanation.model_dump(),
        }


class AgentTraceEntry(BaseModel):
    agent: str
    inputTokens: int
    outputTokens: int
    latencyMs: int


class GenerationMeta(BaseModel):
    totalInputTokens: int
    totalOutputTokens: int
    generationMs: int
    agentTrace: List[AgentTraceEntry]


class FeatureBundleMessage(BaseModel):
    jobId: str
    status: Literal["success", "failed"]
    error: Optional[str] = None
    # "platform_limitation" — architect detected the app requires a capability
    # that ctx cannot deliver and has no viable mitigation. Show a merchant-
    # friendly message; do not suggest retrying (it won't help).
    errorCode: Optional[Literal["platform_limitation"]] = None
    bundle: Optional[Bundle] = None
    meta: Optional[GenerationMeta] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"jobId": self.jobId, "status": self.status}
        if self.error:
            d["error"] = self.error
        if self.errorCode:
            d["errorCode"] = self.errorCode
        if self.bundle:
            d["bundle"] = self.bundle.to_dict()
        if self.meta:
            d["meta"] = self.meta.model_dump()
        return d
