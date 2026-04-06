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
from typing import Dict, List, Optional, Tuple

import contract.publisher as _contract_publisher
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
from shopify_mcp.client import prefetch_for_run, refetch_for_operations
from subagents.product_agent import run_product_agent
from subagents.explanation_agent import run_explanation_agent
from subagents.base import CodegenContext, Generator
from subagents.architect_agent import run_architect_agent
from subagents.codespec_agent import run_codespec_agent
from subagents.revision_agent import run_revision_agent
from subagents.validator_agent import run_validator_agent
from subagents.registry import GENERATORS
from subagents.static_validation import (
    validate_architect_plan,
    validate_codespec_plan,
    validate_widget_handler_contract,
    validate_admin_handler_contract,
)

log = logging.getLogger(__name__)

_MAX_RETRIES = 3  # total codegen attempts (1 initial + 2 retries)
_MAX_PLAN_ATTEMPTS = (
    2  # attempts for both Architect and CodeSpec (1 initial + 1 retry each)
)


# ── Pipeline control ───────────────────────────────────────────────────────────


class _PipelineAbort(Exception):
    """Raised after a failure event is published to halt the pipeline cleanly."""


def _now_ms() -> int:
    return int(time.time() * 1000)


def _emit(request: GenerationRequest, agent: str, status: str, message: str) -> None:
    """Publish a ProgressEvent and log it."""
    try:
        _contract_publisher.publish_progress(
            ProgressEvent(
                jobId=request.jobId,
                agent=agent,
                status=status,  # type: ignore[arg-type]
                message=message,
                timestampMs=_now_ms(),
            )
        )
    except Exception:
        log.exception(
            "Failed to publish progress event agent=%s status=%s", agent, status
        )


def _fail_and_abort(
    request: GenerationRequest,
    agent: str,
    progress_msg: str,
    error: str,
    error_code: Optional[str] = None,
) -> None:
    """Publish a failure progress event + completion failure, then raise _PipelineAbort."""
    _emit(request, agent, "failed", progress_msg)
    payload: Dict = {"jobId": request.jobId, "status": "failed", "error": error}
    if error_code:
        payload["errorCode"] = error_code
    _contract_publisher.publish_completed(FeatureBundleMessage(**payload))
    raise _PipelineAbort


# ── Pipeline entry point ───────────────────────────────────────────────────────


def run_feature_generation(request: GenerationRequest) -> None:
    """
    Entry point — runs the full pipeline for a GenerationRequest.
    Publishes progress + completion events. Never raises (exceptions → failure event).
    """
    start_ms = _now_ms()
    agent_trace: List[AgentTraceEntry] = []

    try:
        intent = _phase_product(request, agent_trace)

        archetype = intent["appCategory"]
        is_storefront = archetype in ("storefront_backend", "storefront_backend_admin")
        is_admin_ui = archetype in ("storefront_backend_admin", "backend_admin")
        log.info(
            "job=%s archetype=%s is_storefront=%s is_admin_ui=%s",
            request.jobId,
            archetype,
            is_storefront,
            is_admin_ui,
        )

        architect_output, api_context = _phase_architect(request, intent, agent_trace)
        plan = _phase_codespec(
            request, intent, architect_output, api_context, agent_trace
        )

        prior_bundle = request.priorBundle or {}
        base_ctx = CodegenContext(
            intent=intent,
            plan=plan,
            platform_api_catalog=(plan.get("implementationSpec") or {}).get(
                "widgetApiCatalog"
            )
            or [],
            prior_handler_code=(
                (prior_bundle.get("handlerModule") or {}).get("code") or None
            ),
            prior_widget_code=(prior_bundle.get("widgetModule") or None),
            prior_migration_sql=(
                (prior_bundle.get("dbMigration") or {}).get("sql") or None
            ),
            prior_admin_ui_code=(prior_bundle.get("adminUiModule") or None),
        )

        artifacts = _phase_codegen(
            request, base_ctx, is_storefront, is_admin_ui, agent_trace
        )
        artifacts = _phase_llm_validation(
            request, base_ctx, artifacts, is_storefront, is_admin_ui, agent_trace
        )
        explanation = _phase_explanation(
            request, intent, plan, artifacts, is_storefront, agent_trace
        )

        _publish_success(
            request,
            plan,
            artifacts,
            is_storefront,
            is_admin_ui,
            explanation,
            agent_trace,
            start_ms,
        )

    except _PipelineAbort:
        pass  # failure event already published by _fail_and_abort

    except Exception as exc:
        log.exception("job=%s unhandled error in run_feature_generation", request.jobId)
        try:
            _contract_publisher.publish_completed(
                FeatureBundleMessage(
                    jobId=request.jobId,
                    status="failed",
                    error=str(exc),
                )
            )
        except Exception:
            log.exception("job=%s failed to publish failure event", request.jobId)


# ── Phase functions ────────────────────────────────────────────────────────────


def _phase_product(
    request: GenerationRequest,
    agent_trace: List[AgentTraceEntry],
) -> Dict:
    """Agent 1: translate merchant prompt into a feature intent dict."""
    if request.preComputedIntent:
        _emit(request, "product", "completed", "Feature spec ready")
        log.info("job=%s intent pre-computed", request.jobId)
        return request.preComputedIntent

    _emit(request, "product", "running", "Understanding your request…")
    t0 = _now_ms()
    intent = run_product_agent(request.prompt)
    agent_trace.append(
        AgentTraceEntry(
            agent="product",
            latencyMs=_now_ms() - t0,
            inputTokens=0,
            outputTokens=0,
        )
    )
    _emit(request, "product", "completed", "Feature spec ready")
    log.info("job=%s intent=%s", request.jobId, intent)
    return intent


def _phase_architect(
    request: GenerationRequest,
    intent: Dict,
    agent_trace: List[AgentTraceEntry],
) -> Tuple[Dict, str]:
    """
    Agent 2: produce shopifyPlan + implementationSpec.

    Returns (architect_output, api_context) where api_context is the enriched
    MCP context for the CodeSpec agent — broad resource docs from the upfront
    prefetch, supplemented by precise operation-level schemas fetched after the
    architect locks its specific API calls.
    """
    _emit(request, "architect", "running", "Planning Shopify API surface…")
    t0 = _now_ms()

    archetype = intent.get("appCategory")
    api_context = prefetch_for_run(
        intent.get("resources", []), intent.get("desiredOutcome", "")
    )

    architect_output: Optional[Dict] = None
    arch_errors: List[str] = []

    for attempt in range(1, _MAX_PLAN_ATTEMPTS + 1):
        architect_output = run_architect_agent(
            prompt=request.prompt,
            intent=intent,
            app_archetype=archetype,
            api_context=api_context,
            validation_errors=arch_errors if attempt > 1 else None,
        )
        arch_errors = validate_architect_plan(architect_output, app_archetype=archetype)

        if not arch_errors:
            break

        log.warning(
            "job=%s architect validation attempt=%d errors=%s",
            request.jobId,
            attempt,
            arch_errors,
        )

        if attempt == _MAX_PLAN_ATTEMPTS:
            _fail_and_abort(
                request,
                "architect",
                f"Architect validation failed: {arch_errors[0]}",
                f"Architect produced invalid plan after {_MAX_PLAN_ATTEMPTS} attempts: {arch_errors}",
            )

        _emit(
            request,
            "architect",
            "running",
            f"Fixing architect plan (attempt {attempt + 1}/{_MAX_PLAN_ATTEMPTS})…",
        )

    # Feasibility gate — fail immediately when ctx cannot deliver the core value.
    impl_spec = architect_output.get("implementationSpec") or {}
    if impl_spec.get("feasibility") == "blocked":
        blocked_reason: str = impl_spec.get(
            "blockedReason",
            "This app requires capabilities that aren't available on the platform yet.",
        )
        _fail_and_abort(
            request,
            "architect",
            blocked_reason,
            blocked_reason,
            error_code="platform_limitation",
        )

    agent_trace.append(
        AgentTraceEntry(
            agent="architect",
            latencyMs=_now_ms() - t0,
            inputTokens=0,
            outputTokens=0,
        )
    )
    _emit(request, "architect", "completed", "Structural plan ready")
    log.info(
        "job=%s architect topics=%s cron=%s has_catalog=%s",
        request.jobId,
        (architect_output.get("shopifyPlan") or {}).get("webhookTopics"),
        (architect_output.get("shopifyPlan") or {}).get("cronSchedule"),
        bool(impl_spec.get("widgetApiCatalog")),
    )

    # Post-architect re-fetch: precise schemas for the specific operations the
    # architect locked. Supplements the broad resource-level docs from prefetch_for_run.
    architect_operations = (architect_output.get("shopifyPlan") or {}).get(
        "operations"
    ) or []
    if architect_operations:
        refined = refetch_for_operations(architect_operations)
        if refined:
            api_context = "\n\n".join(
                filter(
                    None,
                    [
                        api_context,
                        "── Post-architect precise schemas ──\n\n" + refined,
                    ],
                )
            )
            log.info(
                "job=%s post-architect context enriched (+%d chars)",
                request.jobId,
                len(refined),
            )

    return architect_output, api_context


def _phase_codespec(
    request: GenerationRequest,
    intent: Dict,
    architect_output: Dict,
    api_context: str,
    agent_trace: List[AgentTraceEntry],
) -> Dict:
    """
    Agent 3: write step-by-step algorithms against the locked architect output.

    Returns the merged plan dict consumed by all codegen generators.
    """
    _emit(request, "codespec", "running", "Writing implementation algorithms…")
    t0 = _now_ms()

    codespec_output: Optional[Dict] = None
    cs_errors: List[str] = []

    for attempt in range(1, _MAX_PLAN_ATTEMPTS + 1):
        codespec_output = run_codespec_agent(
            prompt=request.prompt,
            intent=intent,
            architect_output=architect_output,
            api_context=api_context,
            validation_errors=cs_errors if attempt > 1 else None,
        )
        cs_errors = validate_codespec_plan(codespec_output, architect_output)

        if not cs_errors:
            break

        log.warning(
            "job=%s codespec validation attempt=%d errors=%s",
            request.jobId,
            attempt,
            cs_errors,
        )

        if attempt == _MAX_PLAN_ATTEMPTS:
            _fail_and_abort(
                request,
                "codespec",
                f"CodeSpec validation failed: {cs_errors[0]}",
                f"CodeSpec produced invalid spec after {_MAX_PLAN_ATTEMPTS} attempts: {cs_errors}",
            )

        _emit(
            request,
            "codespec",
            "running",
            f"Fixing code spec (attempt {attempt + 1}/{_MAX_PLAN_ATTEMPTS})…",
        )

    plan: Dict = {
        **architect_output,
        "implementationSpec": {
            **(architect_output.get("implementationSpec") or {}),
            "codeSpec": codespec_output.get("codeSpec") or {},
        },
    }

    agent_trace.append(
        AgentTraceEntry(
            agent="codespec",
            latencyMs=_now_ms() - t0,
            inputTokens=0,
            outputTokens=0,
        )
    )
    _emit(request, "codespec", "completed", "Implementation spec ready")
    impl = plan.get("implementationSpec") or {}
    log.info(
        "job=%s codespec webhook_steps=%d cron_steps=%d widget_steps=%d",
        request.jobId,
        len((impl.get("codeSpec") or {}).get("webhookPath") or []),
        len((impl.get("codeSpec") or {}).get("cronPath") or []),
        len((impl.get("codeSpec") or {}).get("widgetPath") or []),
    )

    return plan


def _phase_codegen(
    request: GenerationRequest,
    base_ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
    agent_trace: List[AgentTraceEntry],
) -> Dict[str, str]:
    """
    Agents 4 + 5: parallel code generation with a validation-and-retry loop.

    On revision runs (priorBundle present) the first attempt uses the holistic
    revision agent. Subsequent retry attempts always use individual generators.
    """
    _emit(request, "handler", "running", "Generating backend handler…")
    _emit(request, "migration", "running", "Writing DB migration…")
    if is_storefront:
        _emit(request, "widget_js", "running", "Generating storefront widget…")
    if is_admin_ui:
        _emit(request, "admin_ui", "running", "Generating admin panel…")

    artifacts: Dict[str, str] = {}
    error_map: Dict[str, List[str]] = {}
    t0 = _now_ms()

    for attempt in range(1, _MAX_RETRIES + 1):
        if attempt > 1:
            for name in error_map:
                _emit(
                    request,
                    name,
                    "running",  # type: ignore[arg-type]
                    f"Retrying (attempt {attempt}/{_MAX_RETRIES})…",
                )

        artifacts = _generate_artifacts(
            base_ctx,
            is_storefront,
            is_admin_ui,
            error_map,
            artifacts,
            attempt,
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
            _emit(request, "handler", "completed", "Handler complete")
            _emit(request, "migration", "completed", "Migration complete")
            if is_storefront:
                _emit(request, "widget_js", "completed", "Widget complete")
            if is_admin_ui:
                _emit(request, "admin_ui", "completed", "Admin UI complete")
        else:
            for name in list(error_map.keys()):
                _emit(request, name, "completed", f"Retry {attempt} complete")  # type: ignore[arg-type]

        _emit(request, "validation", "running", "Validating generated artifacts…")
        error_map = validate_artifacts(artifacts, base_ctx, is_storefront, is_admin_ui)

        if not error_map:
            break

        log.warning(
            "job=%s validation attempt=%d failing=%s errors=%s",
            request.jobId,
            attempt,
            list(error_map.keys()),
            {name: errs for name, errs in error_map.items()},
        )

        if attempt == _MAX_RETRIES:
            all_errors = [f"{n}: {e}" for n, errs in error_map.items() for e in errs]
            _fail_and_abort(
                request,
                "validation",
                f"Validation failed: {all_errors[0]}",
                f"Validation failed after {_MAX_RETRIES} attempts: {all_errors}",
            )

        _emit(
            request,
            "validation",
            "retrying",
            f"Fixing {', '.join(error_map.keys())} (attempt {attempt + 1}/{_MAX_RETRIES})…",
        )

    _emit(request, "validation", "completed", "All artifacts validated")
    return artifacts


def _generate_artifacts(
    base_ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
    error_map: Dict[str, List[str]],
    artifacts: Dict[str, str],
    attempt: int,
) -> Dict[str, str]:
    """
    Produce artifacts for one codegen attempt.

    Attempt 1 on a revision run uses the holistic revision agent (single LLM call,
    reasons across all artifacts simultaneously). All other attempts use the standard
    parallel individual generators.
    """
    is_revision_first_attempt = attempt == 1 and base_ctx.prior_handler_code is not None

    if is_revision_first_attempt:
        revision = run_revision_agent(
            base_ctx, is_storefront=is_storefront, is_admin_ui=is_admin_ui
        )
        if revision.get("handler") and revision.get("migration"):
            log.info("revision_agent produced all artifacts")
            return revision
        log.warning(
            "revision_agent returned incomplete output — falling back to parallel codegen"
        )

    return run_codegen_parallel(
        base_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        error_map=error_map,
        artifacts=artifacts,
    )


def _phase_llm_validation(
    request: GenerationRequest,
    base_ctx: CodegenContext,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    agent_trace: List[AgentTraceEntry],
) -> Dict[str, str]:
    """
    Optional Agent 5b: LLM semantic alignment check (LLM_VALIDATION_ENABLED=true).

    Runs 5 targeted questions against the generated artifacts. Only HIGH-confidence
    issues trigger one revision pass. Returns the (possibly revised) artifacts.
    Fail-open: any error returns the original artifacts unchanged.
    """
    from config import get_settings

    if not get_settings().llm_validation_enabled:
        return artifacts

    _emit(request, "validator", "running", "Checking semantic alignment…")
    t0 = _now_ms()
    issues = run_validator_agent(artifacts, base_ctx, is_storefront, is_admin_ui)
    agent_trace.append(
        AgentTraceEntry(
            agent="validator",
            latencyMs=_now_ms() - t0,
            inputTokens=0,
            outputTokens=0,
        )
    )

    if not issues:
        _emit(request, "validator", "completed", "Semantic check passed")
        return artifacts

    issue_summary = "; ".join(f"{i['question']}: {i['issue']}" for i in issues)
    log.info(
        "job=%s validator_agent: %d high-confidence issue(s): %s",
        request.jobId,
        len(issues),
        issue_summary,
    )
    _emit(
        request,
        "validator",
        "retrying",
        f"Fixing {len(issues)} semantic issue(s)…",
    )

    revised = run_revision_agent(
        base_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        validation_issues=issues,
    )
    if revised.get("handler") and revised.get("migration"):
        _emit(request, "validator", "completed", "Semantic issues resolved")
        return {**artifacts, **revised}

    log.warning(
        "job=%s validator_agent: revision returned incomplete output — keeping originals",
        request.jobId,
    )
    _emit(request, "validator", "completed", "Semantic check complete")
    return artifacts


def _phase_explanation(
    request: GenerationRequest,
    intent: Dict,
    plan: Dict,
    artifacts: Dict[str, str],
    is_storefront: bool,
    agent_trace: List[AgentTraceEntry],
) -> Dict:
    """Agent 6: write the merchant-facing feature summary."""
    _emit(request, "explanation", "running", "Writing feature summary…")
    t0 = _now_ms()
    explanation = run_explanation_agent(
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
    return explanation


def _publish_success(
    request: GenerationRequest,
    plan: Dict,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    explanation: Dict,
    agent_trace: List[AgentTraceEntry],
    start_ms: int,
) -> None:
    """Build the final Bundle and publish a success completion event."""
    import re

    handler_code = artifacts.get("handler", "")
    shopify_plan = plan.get("shopifyPlan", {})
    technical = explanation.get("technical", {})

    def _parse_npm_packages(code: str) -> list:
        match = re.search(r"npmPackages\s*:\s*\[([^\]]*)\]", code)
        if not match:
            return []
        return re.findall(r"""['"]([^'"]+)['"]""", match.group(1))

    bundle = Bundle(
        widgetModule=artifacts.get("widget_js") if is_storefront else None,
        adminUiModule=artifacts.get("admin_ui") if is_admin_ui else None,
        handlerModule=HandlerModule(
            code=handler_code,
            webhookTopics=shopify_plan.get("webhookTopics", []),
            cronSchedule=shopify_plan.get("cronSchedule"),
            npmPackages=_parse_npm_packages(handler_code),
        ),
        dbMigration=DbMigration(sql=artifacts.get("migration", "")),
        explanation=FeatureExplanation(
            merchantFacing=explanation.get("merchantFacing", ""),
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
    _contract_publisher.publish_completed(
        FeatureBundleMessage(
            jobId=request.jobId,
            status="success",
            bundle=bundle,
            meta=GenerationMeta(
                totalInputTokens=0,
                totalOutputTokens=0,
                generationMs=total_ms,
                agentTrace=agent_trace,
            ),
        )
    )
    log.info("job=%s completed in %dms", request.jobId, total_ms)


# ── Parallel CodeGen ───────────────────────────────────────────────────────────


def run_codegen_parallel(
    base_ctx: CodegenContext,
    *,
    is_storefront: bool,
    is_admin_ui: bool,
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
        if name == "admin_ui" and not is_admin_ui:
            continue
        if name in error_map or name not in artifacts:
            to_run.append(gen)

    # Coupled retries: any generator that shares a field contract with the handler
    # must be retried alongside it. If the handler regenerates for ANY reason it may
    # silently change ctx.widgetBody / ctx.adminBody destructuring, breaking the
    # contract with the other side. Coupling ensures both sides re-align together.
    #
    # Pairs enforced:
    #   handler ↔ widget_js   (storefront_backend, storefront_backend_admin)
    #   handler ↔ admin_ui    (backend_admin, storefront_backend_admin)
    if artifacts:  # non-empty = this is a retry, not the first run
        to_run_names = {gen.name for gen in to_run}
        coupled_pairs: List[tuple] = []
        if is_storefront:
            coupled_pairs.append(
                (
                    "handler",
                    "widget_js",
                    "Re-generating to stay in sync with the handler. "
                    "Ensure every host.call() field name exactly matches the codeSpec widgetPath steps.",
                )
            )
        if is_admin_ui:
            coupled_pairs.append(
                (
                    "handler",
                    "admin_ui",
                    "Re-generating to stay in sync with the handler. "
                    "Ensure every bridge.call() field name exactly matches the codeSpec adminPath steps.",
                )
            )
        for a, b, hint in coupled_pairs:
            pair = {a, b}
            if pair & to_run_names:  # at least one of the pair is already running
                for name in pair - to_run_names:
                    if name in GENERATORS and name in artifacts:
                        error_map.setdefault(name, [hint])
                        to_run.append(GENERATORS[name])
                        to_run_names.add(name)

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
                    prior_handler_code=base_ctx.prior_handler_code,
                    prior_widget_code=base_ctx.prior_widget_code,
                    prior_migration_sql=base_ctx.prior_migration_sql,
                    prior_admin_ui_code=base_ctx.prior_admin_ui_code,
                ),
            )
            for gen in to_run
        }
        for name, future in futures.items():
            artifacts[name] = future.result()  # raises on sub-agent exception

    return artifacts


# ── Validation ─────────────────────────────────────────────────────────────────


def validate_artifacts(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
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
        if name == "admin_ui" and not is_admin_ui:
            continue
        errs = gen.validate(artifacts.get(name, ""), ctx)
        if errs:
            error_map[name] = errs

    # Cross-artifact field-name check: always run for storefront apps.
    # Skipping this when handler has individual errors (e.g. missing npmPackages)
    # causes the mismatch to go undetected — the next retry only re-runs the handler,
    # which may silently change field names again and re-introduce the mismatch.
    if is_storefront:
        for gen_name, errs in validate_widget_handler_contract(
            artifacts.get("widget_js", ""),
            artifacts.get("handler", ""),
        ).items():
            if errs:
                error_map.setdefault(gen_name, []).extend(errs)

    # Admin UI ↔ handler cross-artifact check.
    if is_admin_ui:
        for gen_name, errs in validate_admin_handler_contract(
            artifacts.get("admin_ui", ""),
            artifacts.get("handler", ""),
        ).items():
            if errs:
                error_map.setdefault(gen_name, []).extend(errs)

    return error_map
