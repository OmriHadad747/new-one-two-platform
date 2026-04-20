"""
Pydantic models mirroring the JSON Schema definitions in /contract/*.schema.json
and the Zod schemas in platform-back.

Source of truth: /contract/*.schema.json
When the contract changes, update this file and the JSON Schema files.

Phase 2 shift (2026-04-20):
  Generator output is now a file bundle ({path, contents}[]) matching the
  platform-back deploy endpoint at POST /apps/:appId/deploy — instead of a
  single CommonJS blob + ctx.* runtime harness. Field names kept in place so
  the merchant-click-deploy flow (subscriber persists bundle, merchant clicks,
  deployer reads) can adopt the new shape without cascading renames.
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


class GeneratedFile(BaseModel):
    """
    One file in the deploy bundle.

    Mirrors GeneratedFileSchema in
    platform-back/apps/api/src/routes/deploy.ts — deploy will reject anything
    that doesn't fit these constraints, so generator static validation
    enforces them up front:
      - `path` is relative (no leading '/'), no '..' segments, ≤ 512 chars.
      - `contents` ≤ 1 MiB (platform-back caps hard at this size).
    """

    path: str
    contents: str


class HandlerModule(BaseModel):
    """
    Handler artifact: TypeScript files layered onto the platform-back handler
    template (src/routes/*.ts, optionally src/lib/*.ts) plus runtime metadata
    the deployer consumes separately.

    `files` contains ONLY generator-authored files — the template's hand-built
    files (server.ts, middleware/, lib/db.ts, lib/platform-call.ts, etc.) ship
    with every handler and MUST NOT appear here.
    """

    files: List[GeneratedFile]
    webhookTopics: List[str]
    cronSchedule: Optional[str] = None
    npmPackages: List[str] = []


class TechnicalExplanation(BaseModel):
    webhookTopics: List[str]
    dbTables: List[str]
    estimatedMonthlyExecutions: int
    estimatedMonthlyCost: str


class FeatureExplanation(BaseModel):
    merchantFacing: str
    technical: TechnicalExplanation


class EmailStarterContent(BaseModel):
    """AI-generated pre-fill used to seed app_email_configs on deploy."""

    subject: str
    heading: Optional[str] = None
    body: str
    ctaLabel: Optional[str] = None
    ctaUrl: Optional[str] = None


class Bundle(BaseModel):
    widgetModule: Optional[str] = None  # storefront ES module — Phase 4 rework
    adminUiModule: Optional[str] = None  # admin panel ES module — Phase 4 rework
    widgetTargetTemplates: Optional[List[str]] = (
        None  # theme template pages the widget targets, e.g. ["product", "cart"]
    )
    handlerModule: HandlerModule
    # dbMigration is a single .sql file under migrations/NNNN_*.sql — the
    # deployer's SQL validator only accepts a narrow allow-list of constructs
    # (CREATE TABLE/INDEX/POLICY, restricted ALTER TABLE, COMMENT ON,
    # cron.schedule/unschedule). See platform-back/packages/deployer/src/sql-validator.ts.
    dbMigration: GeneratedFile
    explanation: FeatureExplanation

    # ─── Email metadata (set when handler calls /services/email/send) ───────
    usesEmail: bool = False
    emailVariables: List[str] = Field(default_factory=list)
    emailTypeSuggestion: Optional[Literal["transactional", "marketing"]] = None
    emailStarterContent: Optional[EmailStarterContent] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "widgetModule": self.widgetModule,
            "adminUiModule": self.adminUiModule,
            "widgetTargetTemplates": self.widgetTargetTemplates,
            "handlerModule": self.handlerModule.model_dump(),
            "dbMigration": self.dbMigration.model_dump(),
            "explanation": self.explanation.model_dump(),
            "usesEmail": self.usesEmail,
            "emailVariables": self.emailVariables,
        }
        if self.emailTypeSuggestion is not None:
            d["emailTypeSuggestion"] = self.emailTypeSuggestion
        if self.emailStarterContent is not None:
            d["emailStarterContent"] = self.emailStarterContent.model_dump()
        return d


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
    # that the platform cannot deliver and has no viable mitigation. Show a
    # merchant-friendly message; do not suggest retrying (it won't help).
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
