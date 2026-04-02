"""
FeatureGenerator crew — orchestrates all agents for a single generation request.

Pipeline:
  Agent 1  Product      — translate merchant prompt into product feature spec
  Agent 2  Architect    — structural decisions: webhooks, state machine, catalog, gaps
           validate_architect — rule-based gate (topics, cron syntax, catalog paths, sentinel)
           (retry Architect once on validation failure before failing the job)
  Agent 3  CodeSpec     — step-by-step algorithms written against locked architect output
           validate_codespec — rule-based gate (claim ordering, field names, loop safety)
           (retry CodeSpec once on validation failure before failing the job)
  Agent 4  CodeGen      — generators run in parallel (ThreadPoolExecutor)
  Agent 5  Validation   — static analysis per artifact + cross-artifact check, retry loop (max 3)
  Agent 6  Explanation  — sequential, writes merchant-facing summary
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
    fetch_api_context,
    run_explanation_agent,
    run_product_agent,
)
from subagents.base import CodegenContext, Generator
from subagents.architect_agent import run_architect_agent
from subagents.codespec_agent import run_codespec_agent
from subagents.registry import GENERATORS
from subagents.validation import validate_architect, validate_codespec, validate_cross_artifact

log = logging.getLogger(__name__)

_MAX_RETRIES = 3        # total codegen attempts (1 initial + 2 retries)
_MAX_PLAN_ATTEMPTS = 2  # attempts for both Architect and CodeSpec (1 initial + 1 retry each)


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
        # ── Agent 1: Product ─────────────────────────────────────────────────
        _emit(request, "product", "running", "Understanding your request…")
        t0 = _now_ms()
        intent = run_product_agent(request.prompt)
        agent_trace.append(
            AgentTraceEntry(agent="product", latencyMs=_now_ms() - t0, inputTokens=0, outputTokens=0)
        )
        _emit(request, "product", "completed", "Feature spec ready")
        log.info("job=%s intent=%s", request.jobId, intent)

        # ── Agent 2: Architect (+ validate_architect gate) ───────────────────
        _emit(request, "architect", "running", "Planning Shopify API surface…")
        t0 = _now_ms()

        api_context = fetch_api_context(
            intent.get("resources", []),
            intent_description=intent.get("desiredOutcome", ""),
        )
        architect_output: Optional[Dict] = None
        arch_errors: List[str] = []

        for arch_attempt in range(1, _MAX_PLAN_ATTEMPTS + 1):
            architect_output = run_architect_agent(
                prompt=request.prompt,
                intent=intent,
                app_archetype=request.appArchetype,
                api_context=api_context,
                validation_errors=arch_errors if arch_attempt > 1 else None,
            )
            arch_errors = validate_architect(architect_output, app_archetype=request.appArchetype)

            if not arch_errors:
                break

            log.warning(
                "job=%s architect validation attempt=%d errors=%s",
                request.jobId,
                arch_attempt,
                arch_errors,
            )

            if arch_attempt == _MAX_PLAN_ATTEMPTS:
                _emit(
                    request,
                    "architect",
                    "failed",
                    f"Architect validation failed: {arch_errors[0]}",
                )
                publish_completed(
                    FeatureBundleMessage(
                        jobId=request.jobId,
                        status="failed",
                        error=f"Architect produced invalid plan after {_MAX_PLAN_ATTEMPTS} attempts: {arch_errors}",
                    )
                )
                return

            _emit(
                request,
                "architect",
                "running",
                f"Fixing architect plan (attempt {arch_attempt + 1}/{_MAX_PLAN_ATTEMPTS})…",
            )

        agent_trace.append(
            AgentTraceEntry(agent="architect", latencyMs=_now_ms() - t0, inputTokens=0, outputTokens=0)
        )
        _emit(request, "architect", "completed", "Structural plan ready")
        log.info(
            "job=%s architect topics=%s cron=%s has_catalog=%s",
            request.jobId,
            (architect_output.get("shopifyPlan") or {}).get("webhookTopics"),
            (architect_output.get("shopifyPlan") or {}).get("cronSchedule"),
            bool((architect_output.get("implementationSpec") or {}).get("widgetApiCatalog")),
        )

        # ── Agent 3: CodeSpec (+ validate_codespec gate) ─────────────────────
        _emit(request, "codespec", "running", "Writing implementation algorithms…")
        t0 = _now_ms()

        codespec_output: Optional[Dict] = None
        cs_errors: List[str] = []

        for cs_attempt in range(1, _MAX_PLAN_ATTEMPTS + 1):
            codespec_output = run_codespec_agent(
                prompt=request.prompt,
                intent=intent,
                architect_output=architect_output,
                api_context=api_context,
                validation_errors=cs_errors if cs_attempt > 1 else None,
            )
            cs_errors = validate_codespec(codespec_output, architect_output)

            if not cs_errors:
                break

            log.warning(
                "job=%s codespec validation attempt=%d errors=%s",
                request.jobId,
                cs_attempt,
                cs_errors,
            )

            if cs_attempt == _MAX_PLAN_ATTEMPTS:
                _emit(
                    request,
                    "codespec",
                    "failed",
                    f"CodeSpec validation failed: {cs_errors[0]}",
                )
                publish_completed(
                    FeatureBundleMessage(
                        jobId=request.jobId,
                        status="failed",
                        error=f"CodeSpec produced invalid spec after {_MAX_PLAN_ATTEMPTS} attempts: {cs_errors}",
                    )
                )
                return

            _emit(
                request,
                "codespec",
                "running",
                f"Fixing code spec (attempt {cs_attempt + 1}/{_MAX_PLAN_ATTEMPTS})…",
            )

        # Merge into the complete plan dict — identical shape to what generators consume
        plan: Dict = {
            **architect_output,
            "implementationSpec": {
                **(architect_output.get("implementationSpec") or {}),
                "codeSpec": codespec_output.get("codeSpec") or {},
            },
        }

        agent_trace.append(
            AgentTraceEntry(agent="codespec", latencyMs=_now_ms() - t0, inputTokens=0, outputTokens=0)
        )
        _emit(request, "codespec", "completed", "Implementation spec ready")
        log.info(
            "job=%s codespec webhook_steps=%d cron_steps=%d widget_steps=%d",
            request.jobId,
            len((plan.get("implementationSpec") or {}).get("codeSpec", {}).get("webhookPath") or []),
            len((plan.get("implementationSpec") or {}).get("codeSpec", {}).get("cronPath") or []),
            len((plan.get("implementationSpec") or {}).get("codeSpec", {}).get("widgetPath") or []),
        )

        # ── Agent 4: Parallel CodeGen + Agent 5: Validation (retry loop) ────
        _emit(request, "codegen", "running", "Generating feature code…")
        t0 = _now_ms()

        # widgetApiCatalog is decided by the Architect agent based on what this
        # specific feature needs — not hardcoded by the platform.
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

        # ── Agent 6: Explanation ─────────────────────────────────────────────
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
    Run each generator's validate() on its artifact, then run cross-artifact checks.

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

    # Cross-artifact field-name check: only when both widget and handler passed
    # their individual validators (no point checking contract if either is broken)
    if (
        is_storefront
        and "widget_js" not in error_map
        and "handler" not in error_map
    ):
        cross_errors = validate_cross_artifact(
            artifacts.get("widget_js", ""),
            artifacts.get("handler", ""),
        )
        for gen_name, errs in cross_errors.items():
            if errs:
                error_map.setdefault(gen_name, []).extend(errs)

    return error_map
