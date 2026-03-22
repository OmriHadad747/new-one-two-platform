"""
FeatureGenerator crew — orchestrates all 5 agents for a single generation request.

Execution order:
  Agent 1  Intent       — sequential
  Agent 2  Schema       — sequential
  Agent 3  CodeGen      — 3 sub-agents in parallel (ThreadPoolExecutor)
  Agent 4  Validation   — sequential, retry loop (max 3 attempts total)
  Agent 5  Explanation  — sequential
  Publisher             — FeatureBundleMessage to generation.completed

Progress events are published to generation.progress at every stage transition.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from contract.publisher import publish_completed, publish_progress
from contract.validators import (
    WidgetConfig,
    Bundle,
    DbMigration,
    FeatureBundleMessage,
    FeatureExplanation,
    GenerationMeta,
    GenerationRequest,
    HandlerModule,
    ProgressEvent,
    TechnicalExplanation,
    AgentTraceEntry,
    WidgetConfigActions,
)
from crews.feature_generator.agents import (
    run_explanation_agent,
    run_intent_agent,
    run_schema_agent,
)
from subagents.widget_config_agent import run_widget_config_agent
from subagents.handler_agent import run_handler_agent
from subagents.migration_agent import run_migration_agent
from subagents.validation import validate_bundle

log = logging.getLogger(__name__)

_MAX_RETRIES = 3  # total attempts (1 initial + 2 retries)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _emit(
    request: GenerationRequest,
    agent: str,
    status: str,
    message: str,
) -> None:
    """Publish a ProgressEvent and log it."""
    try:
        event = ProgressEvent(
            jobId=request.jobId,
            agent=agent,
            status=status,  # type: ignore[arg-type]
            message=message,
            timestampMs=_now_ms(),
        )
        publish_progress(event)
    except Exception:
        log.exception(
            "Failed to publish progress event agent=%s status=%s", agent, status
        )


def run_feature_generation(request: GenerationRequest) -> None:
    """
    Entry point — runs the full 5-agent pipeline for a GenerationRequest.
    Publishes progress + completion events.  Never raises (exceptions → failure event).
    """
    start_ms = _now_ms()
    agent_trace: List[AgentTraceEntry] = []

    try:
        # ── Agent 1: Intent ──────────────────────────────────────────────────
        _emit(request, "intent", "running", "Understanding your request…")
        t0 = _now_ms()
        intent = run_intent_agent(request.prompt)
        agent_trace.append(
            AgentTraceEntry(
                agent="intent", latencyMs=_now_ms() - t0, inputTokens=0, outputTokens=0
            )
        )
        _emit(request, "intent", "completed", "Feature spec ready")
        log.info("job=%s intent=%s", request.jobId, intent)

        # ── Agent 2: Schema ──────────────────────────────────────────────────
        _emit(request, "schema", "running", "Mapping Shopify APIs…")
        t0 = _now_ms()
        api_plan = run_schema_agent(intent, request.platformApiCatalog)
        agent_trace.append(
            AgentTraceEntry(
                agent="schema", latencyMs=_now_ms() - t0, inputTokens=0, outputTokens=0
            )
        )
        _emit(request, "schema", "completed", "API plan complete")
        log.info(
            "job=%s api_plan topics=%s", request.jobId, api_plan.get("webhookTopics")
        )

        # ── Agent 3: Parallel CodeGen ────────────────────────────────────────
        _emit(request, "codegen", "running", "Generating feature code…")
        t0 = _now_ms()

        catalog_dicts = [e.model_dump() for e in request.platformApiCatalog]
        is_storefront = request.appArchetype == "storefront_ui"

        # Initial generation (no errors on first attempt)
        widget_config_raw, handler_code, migration_sql = _run_codegen_parallel(
            intent,
            api_plan,
            catalog_dicts,
            is_storefront=is_storefront,
            widget_config_errors=None,
            handler_errors=None,
            migration_errors=None,
        )

        agent_trace.append(
            AgentTraceEntry(
                agent="codegen", latencyMs=_now_ms() - t0, inputTokens=0, outputTokens=0
            )
        )
        _emit(request, "codegen", "completed", "Code generation complete")

        # ── Agent 4: Validation + retry loop ────────────────────────────────
        _emit(request, "validation", "running", "Validating generated artifacts…")
        api_plan_topics: List[str] = api_plan.get("webhookTopics", [])

        errors: List[str] = []
        for attempt in range(1, _MAX_RETRIES + 1):
            errors = validate_bundle(
                handler_code=handler_code,
                migration_sql=migration_sql,
                widget_config=widget_config_raw,
                platform_api_catalog=catalog_dicts,
                api_plan_topics=api_plan_topics,
            )
            if not errors:
                break

            log.warning(
                "job=%s validation attempt=%d errors=%s", request.jobId, attempt, errors
            )

            if attempt == _MAX_RETRIES:
                # Final attempt failed — publish failure
                _emit(
                    request, "validation", "failed", f"Validation failed: {errors[0]}"
                )
                publish_completed(
                    FeatureBundleMessage(
                        jobId=request.jobId,
                        status="failed",
                        error=f"Validation failed after {_MAX_RETRIES} attempts: {errors}",
                    )
                )
                return

            # Targeted retry: only re-run sub-agents with errors
            _emit(
                request,
                "validation",
                "running",
                f"Fixing validation errors (attempt {attempt + 1}/{_MAX_RETRIES})…",
            )
            widget_config_errors = [e for e in errors if e.startswith("widget_config:")]
            handler_errors = [e for e in errors if e.startswith("handler.js:")]
            migration_errors = [e for e in errors if e.startswith("migration:")]

            new_widget_config, new_handler, new_migration = _run_codegen_parallel(
                intent,
                api_plan,
                catalog_dicts,
                is_storefront=is_storefront,
                widget_config_errors=widget_config_errors or None,
                handler_errors=handler_errors or None,
                migration_errors=migration_errors or None,
                # Keep artifacts that had no errors
                existing_widget_config=(
                    widget_config_raw if not widget_config_errors else None
                ),
                existing_handler=handler_code if not handler_errors else None,
                existing_migration=migration_sql if not migration_errors else None,
            )
            if widget_config_errors:
                widget_config_raw = new_widget_config
            if handler_errors:
                handler_code = new_handler
            if migration_errors:
                migration_sql = new_migration

        _emit(request, "validation", "completed", "All artifacts validated")

        # ── Agent 5: Explanation ─────────────────────────────────────────────
        _emit(request, "explanation", "running", "Writing feature summary…")
        t0 = _now_ms()
        explanation_raw = run_explanation_agent(
            intent=intent,
            api_plan=api_plan,
            widget_config=widget_config_raw,
            handler_code=handler_code,
            migration_sql=migration_sql,
        )
        agent_trace.append(
            AgentTraceEntry(
                agent="explanation",
                latencyMs=_now_ms() - t0,
                inputTokens=0,
                outputTokens=0,
            )
        )
        _emit(request, "explanation", "completed", "Summary complete")

        # ── Build final bundle ───────────────────────────────────────────────
        technical = explanation_raw.get("technical", {})

        # Build WidgetConfig object for storefront_ui apps
        widget_config_obj: Optional[WidgetConfig] = None
        if is_storefront and widget_config_raw:
            actions_raw = widget_config_raw.get("actions", {})
            widget_config_obj = WidgetConfig(
                widget_type=widget_config_raw.get("widget_type", "notify_me"),
                trigger_condition=widget_config_raw.get("trigger_condition"),
                ui=widget_config_raw.get("ui", {}),
                actions=WidgetConfigActions(
                    on_submit=actions_raw.get("on_submit"),
                    on_load=actions_raw.get("on_load"),
                    data_source=actions_raw.get("data_source"),
                ),
            )

        bundle = Bundle(
            widgetConfig=widget_config_obj,
            handlerModule=HandlerModule(
                code=handler_code,
                webhookTopics=api_plan.get("webhookTopics", []),
                cronSchedule=api_plan.get("cronSchedule"),
            ),
            dbMigration=DbMigration(sql=migration_sql),
            explanation=FeatureExplanation(
                merchantFacing=explanation_raw.get("merchantFacing", ""),
                technical=TechnicalExplanation(
                    webhookTopics=technical.get("webhookTopics", []),
                    dbTables=technical.get("dbTables", []),
                    estimatedMonthlyExecutions=technical.get(
                        "estimatedMonthlyExecutions", 0
                    ),
                    estimatedMonthlyCost=technical.get("estimatedMonthlyCost", "$0"),
                ),
            ),
        )

        total_ms = _now_ms() - start_ms
        meta = GenerationMeta(
            totalInputTokens=0,  # TODO: aggregation deferred — models return per-call counts
            totalOutputTokens=0,
            generationMs=total_ms,
            agentTrace=agent_trace,
        )

        publish_completed(
            FeatureBundleMessage(
                jobId=request.jobId,
                status="success",
                bundle=bundle,
                meta=meta,
            )
        )
        log.info("job=%s completed in %dms", request.jobId, total_ms)

    except Exception as exc:
        log.exception("job=%s unhandled error in run_feature_generation", request.jobId)
        try:
            publish_completed(
                FeatureBundleMessage(
                    jobId=request.jobId,
                    status="failed",
                    error=str(exc),
                )
            )
        except Exception:
            log.exception("job=%s failed to publish failure event", request.jobId)


# ── Parallel CodeGen helper ────────────────────────────────────────────────────


def _run_codegen_parallel(
    intent: Dict[str, Any],
    api_plan: Dict[str, Any],
    catalog_dicts: List[Dict[str, str]],
    *,
    is_storefront: bool,
    widget_config_errors: Optional[List[str]],
    handler_errors: Optional[List[str]],
    migration_errors: Optional[List[str]],
    existing_widget_config: Optional[Dict[str, Any]] = None,
    existing_handler: Optional[str] = None,
    existing_migration: Optional[str] = None,
) -> tuple[Dict[str, Any], str, str]:
    """
    Run up to 3 sub-agents in parallel.
    widget_config sub-agent only runs for storefront_ui apps.
    If an artifact has no errors and an existing value is provided, skip re-running it.
    Returns (widget_config_raw, handler_code, migration_sql).
    """
    futures: dict = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        if is_storefront and (
            widget_config_errors is not None or existing_widget_config is None
        ):
            futures["widget_config"] = pool.submit(
                run_widget_config_agent,
                intent,
                api_plan,
                catalog_dicts,
                widget_config_errors,
            )
        if handler_errors is not None or existing_handler is None:
            futures["handler"] = pool.submit(
                run_handler_agent,
                intent,
                api_plan,
                handler_errors,
            )
        if migration_errors is not None or existing_migration is None:
            futures["migration"] = pool.submit(
                run_migration_agent,
                intent,
                api_plan,
                migration_errors,
            )

        results = {}
        for name, future in futures.items():
            results[name] = future.result()  # raises on sub-agent exception

    widget_config_raw = results.get("widget_config", existing_widget_config) or {}
    handler_code = results.get("handler", existing_handler) or ""
    migration_sql = results.get("migration", existing_migration) or ""

    return widget_config_raw, handler_code, migration_sql
