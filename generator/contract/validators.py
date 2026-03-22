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

class PlatformApiEntry(BaseModel):
    method: Literal["GET", "POST", "PUT", "DELETE", "PATCH"]
    path: str


class GenerationRequest(BaseModel):
    jobId: str
    tenantId: str
    appId: str
    prompt: str
    appArchetype: Literal["storefront_ui", "backend_only"]
    platformApiCatalog: List[PlatformApiEntry]
    existingFeatures: List[str]
    priorBundle: Optional[Dict[str, Any]] = None


# ─── ProgressEvent ────────────────────────────────────────────────────────────

class ProgressEvent(BaseModel):
    jobId: str
    agent: Literal[
        "intent", "schema", "codegen", "widget_config",
        "handler", "migration", "validation", "explanation"
    ]
    status: Literal["running", "completed", "failed", "retrying"]
    message: str
    timestampMs: int
    attempt: Optional[int] = None


# ─── FeatureBundleMessage ─────────────────────────────────────────────────────

class WidgetConfigActions(BaseModel):
    on_submit: Optional[str] = None
    on_load: Optional[str] = None
    data_source: Optional[str] = None


class WidgetConfig(BaseModel):
    widget_type: str
    trigger_condition: Optional[Literal["out_of_stock", "always", "low_stock"]] = None
    ui: Dict[str, Any]
    actions: WidgetConfigActions


class HandlerModule(BaseModel):
    code: str
    webhookTopics: List[str]
    cronSchedule: Optional[str] = None


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
    widgetConfig: Optional[WidgetConfig] = None  # None for backend_only apps
    handlerModule: HandlerModule
    dbMigration: DbMigration
    explanation: FeatureExplanation

    def to_dict(self) -> Dict[str, Any]:
        return {
            "widgetConfig": self.widgetConfig.model_dump() if self.widgetConfig else None,
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
    bundle: Optional[Bundle] = None
    meta: Optional[GenerationMeta] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"jobId": self.jobId, "status": self.status}
        if self.error:
            d["error"] = self.error
        if self.bundle:
            d["bundle"] = self.bundle.to_dict()
        if self.meta:
            d["meta"] = self.meta.model_dump()
        return d
