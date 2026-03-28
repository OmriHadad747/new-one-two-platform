"""
FeatureGenerator crew — orchestrates all agents for a single generation request.

Pipeline:
  Agent 1  Intent       — parse merchant prompt into structured intent
  Agent 2  Planner      — merged Schema + Strategy: produces shopifyPlan + implementationSpec
           validate_plan — rule-based gate (webhook topics, cron syntax, atomic-claim check)
           (retry Planner once on validation failure before failing the job)
  Agent 3  CodeGen      — generators run in parallel (ThreadPoolExecutor)
  Agent 4  Validation   — static analysis per artifact, retry loop (max 3 attempts total)
  Agent 5  Explanation  — sequential, writes merchant-facing summary
  Publisher             — FeatureBundleMessage to generation.completed

Adding a new generator requires only creating a new Generator subclass and
registering it in subagents/registry.py. This file never changes for new generators.

Progress events are published to generation.progress at every stage transition.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

from contract.publisher import publish_completed, publish_progress
from contract.validators import (
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
)
from crews.feature_generator.agents import (
    load_schema_fragments,
    run_explanation_agent,
    run_intent_agent,
)
from subagents.base import CodegenContext, Generator
from subagents.planner_agent import run_planner_agent
from subagents.registry import GENERATORS
from subagents.validation import validate_plan

log = logging.getLogger(__name__)

_MAX_RETRIES = 3        # total codegen attempts (1 initial + 2 retries)
_MAX_PLAN_ATTEMPTS = 2  # total planner attempts (1 initial + 1 retry on plan validation failure)


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
    Entry point — runs the full pipeline for a GenerationRequest.
    Publishes progress + completion events. Never raises (exceptions → failure event).
    """
    start_ms = _now_ms()
    agent_trace: List[AgentTraceEntry] = []

    try:
        # ── Agent 1: Intent ──────────────────────────────────────────────────
        _emit(request, "intent", "running", "Understanding your request…")
        t0 = _now_ms()
        intent = run_intent_agent(request.prompt)
        agent_trace.append(
            AgentTraceEntry(agent="intent", latencyMs=_now_ms() - t0, inputTokens=0, outputTokens=0)
        )
        _emit(request, "intent", "completed", "Feature spec ready")
        log.info("job=%s intent=%s", request.jobId, intent)

        # ── Agent 2: Planner (+ validate_plan gate) ──────────────────────────
        _emit(request, "planner", "running", "Planning Shopify API surface and implementation…")
        t0 = _now_ms()

        schema_fragments = load_schema_fragments(intent.get("resources", []))
        plan: Optional[Dict] = None
        plan_errors: List[str] = []

        for plan_attempt in range(1, _MAX_PLAN_ATTEMPTS + 1):
            plan = run_planner_agent(
                prompt=request.prompt,
                intent=intent,
                app_archetype=request.appArchetype,
                schema_fragments=schema_fragments,
                validation_errors=plan_errors if plan_attempt > 1 else None,
            )
            plan_errors = validate_plan(plan, app_archetype=request.appArchetype)

            if not plan_errors:
                break

            log.warning(
                "job=%s plan validation attempt=%d errors=%s",
                request.jobId,
                plan_attempt,
                plan_errors,
            )

            if plan_attempt == _MAX_PLAN_ATTEMPTS:
                _emit(
                    request,
                    "planner",
                    "failed",
                    f"Plan validation failed: {plan_errors[0]}",
                )
                publish_completed(
                    FeatureBundleMessage(
                        jobId=request.jobId,
                        status="failed",
                        error=f"Planner produced invalid plan after {_MAX_PLAN_ATTEMPTS} attempts: {plan_errors}",
                    )
                )
                return

            _emit(
                request,
                "planner",
                "running",
                f"Fixing plan (attempt {plan_attempt + 1}/{_MAX_PLAN_ATTEMPTS})…",
            )

        agent_trace.append(
            AgentTraceEntry(agent="planner", latencyMs=_now_ms() - t0, inputTokens=0, outputTokens=0)
        )
        _emit(request, "planner", "completed", "Plan ready")
        log.info(
            "job=%s plan topics=%s cron=%s has_code_spec=%s",
            request.jobId,
            plan.get("shopifyPlan", {}).get("webhookTopics"),
            plan.get("shopifyPlan", {}).get("cronSchedule"),
            bool((plan.get("implementationSpec") or {}).get("codeSpec")),
        )

        # ── Agent 3: Parallel CodeGen + Agent 4: Validation (retry loop) ────
        _emit(request, "codegen", "running", "Generating feature code…")
        t0 = _now_ms()

        # widgetApiCatalog is decided by the planner based on what this specific
        # feature needs — not hardcoded by the platform.
        catalog_dicts = (plan.get("implementationSpec") or {}).get("widgetApiCatalog") or []
        archetype = intent.get("appArchetype") or request.appArchetype
        is_storefront = archetype == "storefront_ui"

        base_ctx = CodegenContext(
            intent=intent,
            plan=plan,
            platform_api_catalog=catalog_dicts,
        )

        artifacts: Dict[str, str] = {}
        error_map: Dict[str, List[str]] = {}

        for attempt in range(1, _MAX_RETRIES + 1):
            artifacts = _run_codegen_parallel(
                base_ctx,
                is_storefront=is_storefront,
                error_map=error_map,
                artifacts=artifacts,
            )

            if attempt == 1:
                agent_trace.append(
                    AgentTraceEntry(
                        agent="codegen",
                        latencyMs=_now_ms() - t0,
                        inputTokens=0,
                        outputTokens=0,
                    )
                )
                _emit(request, "codegen", "completed", "Code generation complete")
                _emit(request, "validation", "running", "Validating generated artifacts…")

            error_map = _validate_artifacts(artifacts, base_ctx, is_storefront)

            if not error_map:
                break

            log.warning(
                "job=%s validation attempt=%d failing_generators=%s errors=%s",
                request.jobId,
                attempt,
                list(error_map.keys()),
                {name: errs for name, errs in error_map.items()},
            )

            if attempt == _MAX_RETRIES:
                all_errors = [
                    f"{name}: {e}" for name, errs in error_map.items() for e in errs
                ]
                _emit(
                    request,
                    "validation",
                    "failed",
                    f"Validation failed: {all_errors[0]}",
                )
                publish_completed(
                    FeatureBundleMessage(
                        jobId=request.jobId,
                        status="failed",
                        error=f"Validation failed after {_MAX_RETRIES} attempts: {all_errors}",
                    )
                )
                return

            failing = ", ".join(error_map.keys())
            _emit(
                request,
                "validation",
                "running",
                f"Fixing {failing} (attempt {attempt + 1}/{_MAX_RETRIES})…",
            )

        _emit(request, "validation", "completed", "All artifacts validated")

        # ── Agent 5: Explanation ─────────────────────────────────────────────
        _emit(request, "explanation", "running", "Writing feature summary…")
        t0 = _now_ms()
        explanation_raw = run_explanation_agent(
            intent=intent,
            plan=plan,
            widget_js_code=artifacts.get("widget_js", "") if is_storefront else "",
            handler_code=artifacts.get("handler", ""),
            migration_sql=artifacts.get("migration", ""),
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

        # ── Build final bundle ────────────────────────────────────────────────
        technical = explanation_raw.get("technical", {})
        shopify_plan = plan.get("shopifyPlan", {})

        bundle = Bundle(
            widgetModule=artifacts.get("widget_js") if is_storefront else None,
            handlerModule=HandlerModule(
                code=artifacts.get("handler", ""),
                webhookTopics=shopify_plan.get("webhookTopics", []),
                cronSchedule=shopify_plan.get("cronSchedule"),
            ),
            dbMigration=DbMigration(sql=artifacts.get("migration", "")),
            explanation=FeatureExplanation(
                merchantFacing=explanation_raw.get("merchantFacing", ""),
                technical=TechnicalExplanation(
                    webhookTopics=technical.get("webhookTopics", []),
                    dbTables=technical.get("dbTables", []),
                    estimatedMonthlyExecutions=technical.get("estimatedMonthlyExecutions", 0),
                    estimatedMonthlyCost=technical.get("estimatedMonthlyCost", "$0"),
                ),
            ),
        )

        total_ms = _now_ms() - start_ms
        meta = GenerationMeta(
            totalInputTokens=0,
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


# ── Parallel CodeGen ───────────────────────────────────────────────────────────


def _run_codegen_parallel(
    base_ctx: CodegenContext,
    *,
    is_storefront: bool,
    error_map: Dict[str, List[str]],
    artifacts: Dict[str, str],
) -> Dict[str, str]:
    """
    Run generators in parallel via ThreadPoolExecutor.

    Only generators that either have errors (retry path) or have not yet produced
    an artifact (first run) are executed. Generators whose artifacts are clean are
    skipped — their existing output is preserved in the returned dict.

    Each generator receives its own CodegenContext with previous_errors populated
    from error_map so the retry prompt is generator-specific.
    """
    to_run: List[Generator] = []
    for name, gen in GENERATORS.items():
        if name == "widget_js" and not is_storefront:
            continue
        if name in error_map or name not in artifacts:
            to_run.append(gen)

    if not to_run:
        return artifacts

    with ThreadPoolExecutor(max_workers=len(to_run)) as pool:
        futures = {
            gen.name: pool.submit(
                gen.generate,
                CodegenContext(
                    intent=base_ctx.intent,
                    plan=base_ctx.plan,
                    platform_api_catalog=base_ctx.platform_api_catalog,
                    previous_errors=error_map.get(gen.name),
                ),
            )
            for gen in to_run
        }
        for name, future in futures.items():
            artifacts[name] = future.result()  # raises on sub-agent exception

    return artifacts


def _validate_artifacts(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
) -> Dict[str, List[str]]:
    """
    Run each generator's validate() on its artifact.

    Returns {generator_name: [errors]} for every generator that failed.
    An empty dict means all artifacts passed validation.
    """
    error_map: Dict[str, List[str]] = {}
    for name, gen in GENERATORS.items():
        if name == "widget_js" and not is_storefront:
            continue
        errs = gen.validate(artifacts.get(name, ""), ctx)
        if errs:
            error_map[name] = errs
    return error_map
