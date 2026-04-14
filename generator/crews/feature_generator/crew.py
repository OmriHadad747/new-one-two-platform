"""
FeatureGenerator crew — orchestrates all agents for a single generation request.

Pipeline:
  Agent 1  Product      — translate merchant prompt into product feature spec
  Agent 2  Architect    — structural decisions + binding contracts
           validate_architect — rule-based gate (topics, cron syntax, catalog paths, sentinel,
                                dbContracts tenant_id, requestShape presence)
           (retry Architect once on validation failure before failing the job)
  Agent 3  CodeGen      — generators run in parallel (ThreadPoolExecutor)
           validate_artifacts — static analysis per artifact + cross-artifact check, retry loop (max 3)
  Agent 4  Validator    — optional LLM semantic alignment check (LLM_VALIDATION_ENABLED=true)
           triggers one revision pass via revision_agent if high-confidence issues found
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
from shopify_mcp.client import prefetch_for_run
from subagents.product_agent import run_product_agent
from subagents.explanation_agent import run_explanation_agent
from subagents.base import CodegenContext, Generator
from subagents.architect_agent import run_architect_agent
from subagents.revision_agent import run_revision_agent
from subagents.validator_agent import run_validator_agent
from subagents.registry import GENERATORS
from subagents.email_metadata import extract_email_metadata
from subagents.static_validation import (
    validate_architect_plan,
    validate_widget_handler_contract,
    validate_admin_handler_contract,
)

log = logging.getLogger(__name__)

_MAX_RETRIES = 3        # total codegen attempts (1 initial + 2 retries)
_MAX_ARCH_ATTEMPTS = 2  # architect: 1 initial + 1 retry

# Pipeline-level deadline. A healthy run finishes well inside 5 minutes; we give
# a generous 15-minute ceiling so that legitimate long runs (3 codegen attempts
# × 4 parallel generators + validator + revision) still succeed, but a stuck
# pipeline surfaces a failure event rather than leaking the subscriber thread.
# Individual LLM calls have their own timeout in adapter.py — this catches the
# aggregate.
_PIPELINE_DEADLINE_S = 900


# ── Pipeline control ───────────────────────────────────────────────────────────


class _PipelineAbort(Exception):
    """Raised after a failure event is published to halt the pipeline cleanly."""


def _now_ms() -> int:
    return int(time.time() * 1000)


def _check_deadline(request: "GenerationRequest", start_ms: int) -> None:
    """
    Fail fast if we've already exceeded the pipeline deadline.

    Called at phase boundaries — won't interrupt an in-flight LLM call, but
    prevents spending more time on a run that's already over budget. Combines
    with per-call timeouts in models/adapter.py to bound total duration.
    """
    elapsed_s = (_now_ms() - start_ms) / 1000
    if elapsed_s > _PIPELINE_DEADLINE_S:
        _fail_and_abort(
            request,
            "validation",
            f"Generation exceeded {_PIPELINE_DEADLINE_S}s deadline",
            f"Pipeline deadline exceeded after {elapsed_s:.0f}s "
            f"(budget: {_PIPELINE_DEADLINE_S}s).",
        )


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
        _check_deadline(request, start_ms)

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

        plan, api_context = _phase_architect(request, intent, agent_trace)
        _check_deadline(request, start_ms)

        prior_bundle = request.priorBundle or {}
        base_ctx = CodegenContext(
            intent=intent,
            plan=plan,
            platform_api_catalog=(plan.get("appContracts") or {}).get(
                "widgetApiCatalog"
            )
            or [],
            api_context=api_context,
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
        _check_deadline(request, start_ms)

        artifacts = _phase_validator(
            request, base_ctx, artifacts, is_storefront, is_admin_ui, agent_trace
        )
        _check_deadline(request, start_ms)

        explanation = _phase_explanation(
            request, intent, plan, artifacts, is_storefront, agent_trace
        )

        _publish_success(
            request,
            intent,
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
    intent, in_tok, out_tok = run_product_agent(request.prompt)
    agent_trace.append(
        AgentTraceEntry(
            agent="product",
            latencyMs=_now_ms() - t0,
            inputTokens=in_tok,
            outputTokens=out_tok,
        )
    )
    _emit(request, "product", "completed", "Feature spec ready")
    log.info("job=%s intent=%s tokens=(%d,%d)", request.jobId, intent, in_tok, out_tok)
    return intent


def _phase_architect(
    request: GenerationRequest,
    intent: Dict,
    agent_trace: List[AgentTraceEntry],
) -> Tuple[Dict, str]:
    """
    Agent 2: produce shopifyPlan + appContracts (typed contracts for all components).

    Returns (plan, api_context) where plan IS the architect output and api_context
    is the live MCP context passed directly to the Handler agent.
    """
    _emit(request, "architect", "running", "Planning Shopify API surface…")
    t0 = _now_ms()

    archetype = intent.get("appCategory")
    api_context = prefetch_for_run(
        intent.get("resources", []), intent.get("desiredOutcome", "")
    )

    plan: Optional[Dict] = None
    arch_errors: List[str] = []
    arch_in = 0
    arch_out = 0

    for attempt in range(1, _MAX_ARCH_ATTEMPTS + 1):
        plan, attempt_in, attempt_out = run_architect_agent(
            prompt=request.prompt,
            intent=intent,
            app_archetype=archetype,
            api_context=api_context,
            validation_errors=arch_errors if attempt > 1 else None,
        )
        arch_in += attempt_in
        arch_out += attempt_out
        arch_errors = validate_architect_plan(plan, app_archetype=archetype)

        if not arch_errors:
            break

        log.warning(
            "job=%s architect validation attempt=%d errors=%s",
            request.jobId,
            attempt,
            arch_errors,
        )

        if attempt == _MAX_ARCH_ATTEMPTS:
            _fail_and_abort(
                request,
                "architect",
                f"Architect validation failed: {arch_errors[0]}",
                f"Architect produced invalid plan after {_MAX_ARCH_ATTEMPTS} attempts: {arch_errors}",
            )

        _emit(
            request,
            "architect",
            "running",
            f"Fixing architect plan (attempt {attempt + 1}/{_MAX_ARCH_ATTEMPTS})…",
        )

    # Feasibility gate — fail immediately when ctx cannot deliver the core value.
    contracts = plan.get("appContracts") or {}
    if contracts.get("feasibility") == "blocked":
        blocked_reason: str = contracts.get(
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
            inputTokens=arch_in,
            outputTokens=arch_out,
        )
    )
    _emit(request, "architect", "completed", "Structural plan ready")
    log.info(
        "job=%s architect topics=%s cron=%s has_widget_catalog=%s has_admin_catalog=%s",
        request.jobId,
        (plan.get("shopifyPlan") or {}).get("webhookTopics"),
        (plan.get("shopifyPlan") or {}).get("cronSchedule"),
        bool(contracts.get("widgetApiCatalog")),
        bool(contracts.get("adminApiCatalog")),
    )

    return plan, api_context


def _phase_codegen(
    request: GenerationRequest,
    base_ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
    agent_trace: List[AgentTraceEntry],
) -> Dict[str, str]:
    """
    Agents 3 + 4: parallel code generation with a validation-and-retry loop.

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
    # per-agent token totals accumulated across all attempts (handler, migration,
    # widget_js, admin_ui, revision). Each value is (input_tokens, output_tokens).
    token_totals: Dict[str, Tuple[int, int]] = {}
    t0 = _now_ms()

    for attempt in range(1, _MAX_RETRIES + 1):
        if attempt > 1:
            # Flip only the generators that actually need re-running back to
            # "running". Generators whose previous output is being preserved
            # stay at whatever status they had (typically still "running" from
            # the initial emit above — they flip to "completed" once the whole
            # attempt passes validation).
            for name in error_map:
                _emit(
                    request,
                    name,
                    "retrying",  # type: ignore[arg-type]
                    f"Fixing issues (attempt {attempt}/{_MAX_RETRIES})…",
                )

        artifacts, attempt_tokens = _generate_artifacts(
            request,
            base_ctx,
            is_storefront,
            is_admin_ui,
            error_map,
            artifacts,
            attempt,
        )
        for name, (in_tok, out_tok) in attempt_tokens.items():
            prev_in, prev_out = token_totals.get(name, (0, 0))
            token_totals[name] = (prev_in + in_tok, prev_out + out_tok)

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

    # Only emit per-generator "completed" events AFTER validation passes —
    # emitting them before validation caused "Handler complete" → "Retrying"
    # flicker in the UI when validation forced a retry.
    codegen_latency = _now_ms() - t0
    for name, (in_tok, out_tok) in token_totals.items():
        agent_trace.append(
            AgentTraceEntry(
                agent=name,
                # Latency for the whole codegen phase is recorded once against
                # each participating generator; running times are parallel within
                # an attempt, so per-generator latency isn't meaningful here.
                latencyMs=codegen_latency,
                inputTokens=in_tok,
                outputTokens=out_tok,
            )
        )
    _emit(request, "handler", "completed", "Handler complete")
    _emit(request, "migration", "completed", "Migration complete")
    if is_storefront:
        _emit(request, "widget_js", "completed", "Widget complete")
    if is_admin_ui:
        _emit(request, "admin_ui", "completed", "Admin UI complete")
    _emit(request, "validation", "completed", "All artifacts validated")
    return artifacts


def _generate_artifacts(
    request: GenerationRequest,
    base_ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
    error_map: Dict[str, List[str]],
    artifacts: Dict[str, str],
    attempt: int,
) -> Tuple[Dict[str, str], Dict[str, Tuple[int, int]]]:
    """
    Produce artifacts for one codegen attempt.

    Attempt 1 on a revision run uses the holistic revision agent (single LLM call,
    reasons across all artifacts simultaneously). All other attempts use the standard
    parallel individual generators.

    Returns (artifacts, per_agent_tokens) where per_agent_tokens maps agent name
    (handler / migration / widget_js / admin_ui / revision) to (in_tokens, out_tokens).
    """
    is_revision_first_attempt = attempt == 1 and base_ctx.prior_handler_code is not None

    if is_revision_first_attempt:
        _emit(request, "revision", "running", "Applying merchant changes…")
        revision, in_tok, out_tok = run_revision_agent(
            base_ctx, is_storefront=is_storefront, is_admin_ui=is_admin_ui
        )
        if revision.get("handler") and revision.get("migration"):
            log.info("revision_agent produced all artifacts")
            _emit(request, "revision", "completed", "Revision complete")
            return revision, {"revision": (in_tok, out_tok)}
        log.warning(
            "revision_agent returned incomplete output — falling back to parallel codegen"
        )
        _emit(request, "revision", "completed", "Revision incomplete — regenerating")
        # Fall through to parallel codegen; fold the revision tokens into the
        # result so they aren't lost.
        parallel_artifacts, parallel_tokens = run_codegen_parallel(
            base_ctx,
            is_storefront=is_storefront,
            is_admin_ui=is_admin_ui,
            error_map=error_map,
            artifacts=artifacts,
        )
        parallel_tokens["revision"] = (
            parallel_tokens.get("revision", (0, 0))[0] + in_tok,
            parallel_tokens.get("revision", (0, 0))[1] + out_tok,
        )
        return parallel_artifacts, parallel_tokens

    return run_codegen_parallel(
        base_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        error_map=error_map,
        artifacts=artifacts,
    )


def _phase_validator(
    request: GenerationRequest,
    base_ctx: CodegenContext,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    agent_trace: List[AgentTraceEntry],
) -> Dict[str, str]:
    """
    Optional Agent 4b: LLM semantic alignment check (LLM_VALIDATION_ENABLED=true).

    Runs 6 targeted questions against the generated artifacts. Only HIGH-confidence
    issues trigger one revision pass. Returns the (possibly revised) artifacts.
    Fail-open: any error returns the original artifacts unchanged.
    """
    from config import get_settings

    if not get_settings().llm_validation_enabled:
        return artifacts

    _emit(request, "validator", "running", "Checking semantic alignment…")
    t0 = _now_ms()
    issues, val_in, val_out = run_validator_agent(
        artifacts, base_ctx, is_storefront, is_admin_ui
    )
    agent_trace.append(
        AgentTraceEntry(
            agent="validator",
            latencyMs=_now_ms() - t0,
            inputTokens=val_in,
            outputTokens=val_out,
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
        "completed",
        f"{len(issues)} semantic issue(s) found — revising…",
    )

    _emit(request, "revision", "running", f"Fixing {len(issues)} semantic issue(s)…")
    rev_t0 = _now_ms()
    revised, rev_in, rev_out = run_revision_agent(
        base_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        validation_issues=issues,
    )
    agent_trace.append(
        AgentTraceEntry(
            agent="revision",
            latencyMs=_now_ms() - rev_t0,
            inputTokens=rev_in,
            outputTokens=rev_out,
        )
    )
    if revised.get("handler") and revised.get("migration"):
        _emit(request, "revision", "completed", "Semantic issues resolved")
        return {**artifacts, **revised}

    log.warning(
        "job=%s validator_agent: revision returned incomplete output — keeping originals",
        request.jobId,
    )
    _emit(request, "revision", "completed", "Revision incomplete — keeping originals")
    return artifacts


def _phase_explanation(
    request: GenerationRequest,
    intent: Dict,
    plan: Dict,
    artifacts: Dict[str, str],
    is_storefront: bool,
    agent_trace: List[AgentTraceEntry],
) -> Dict:
    """Agent 5: write the merchant-facing feature summary."""
    _emit(request, "explanation", "running", "Writing feature summary…")
    t0 = _now_ms()
    explanation, exp_in, exp_out = run_explanation_agent(
        intent=intent,
        plan=plan,
        widget_js_code=artifacts.get("widget_js", "") if is_storefront else "",
        migration_sql=artifacts.get("migration", ""),
    )
    agent_trace.append(
        AgentTraceEntry(
            agent="explanation",
            latencyMs=_now_ms() - t0,
            inputTokens=exp_in,
            outputTokens=exp_out,
        )
    )
    _emit(request, "explanation", "completed", "Summary complete")
    return explanation


def _publish_success(
    request: GenerationRequest,
    intent: Dict,
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

    app_contracts = plan.get("appContracts") or {}

    # Email metadata: regex-scan the handler for ctx.email.send() + extract
    # variables and build starter content. Drives the Email tab + deploy
    # blocking on the platform side.
    email_meta = extract_email_metadata(handler_code, intent or {}, plan or {})

    bundle = Bundle(
        widgetModule=artifacts.get("widget_js") if is_storefront else None,
        adminUiModule=artifacts.get("admin_ui") if is_admin_ui else None,
        widgetTargetTemplates=(
            app_contracts.get("widgetTargetTemplates") or None
        ) if is_storefront else None,
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
        usesEmail=bool(email_meta.get("usesEmail")),
        emailVariables=email_meta.get("emailVariables", []) or [],
        emailTypeSuggestion=email_meta.get("emailTypeSuggestion"),
        emailStarterContent=email_meta.get("emailStarterContent"),
    )

    total_ms = _now_ms() - start_ms
    total_in = sum(e.inputTokens for e in agent_trace)
    total_out = sum(e.outputTokens for e in agent_trace)
    _contract_publisher.publish_completed(
        FeatureBundleMessage(
            jobId=request.jobId,
            status="success",
            bundle=bundle,
            meta=GenerationMeta(
                totalInputTokens=total_in,
                totalOutputTokens=total_out,
                generationMs=total_ms,
                agentTrace=agent_trace,
            ),
        )
    )
    log.info(
        "job=%s completed in %dms tokens=(in=%d, out=%d)",
        request.jobId,
        total_ms,
        total_in,
        total_out,
    )


# ── Parallel CodeGen ───────────────────────────────────────────────────────────


def run_codegen_parallel(
    base_ctx: CodegenContext,
    *,
    is_storefront: bool,
    is_admin_ui: bool,
    error_map: Dict[str, List[str]],
    artifacts: Dict[str, str],
) -> Tuple[Dict[str, str], Dict[str, Tuple[int, int]]]:
    """
    Run generators in parallel via ThreadPoolExecutor.

    Only generators that either have errors (retry path) or have not yet produced
    an artifact (first run) are executed. Generators whose artifacts are clean are
    skipped — their existing output is preserved in the returned dict.

    Each generator receives its own CodegenContext with previous_errors populated
    from error_map so the retry prompt is generator-specific.

    Returns (artifacts, per_agent_tokens) — tokens dict only contains keys for
    generators that actually ran on this invocation.
    """
    to_run: List[Generator] = []
    for name, gen in GENERATORS.items():
        if name == "widget_js" and not is_storefront:
            continue
        if name == "admin_ui" and not is_admin_ui:
            continue
        if name in error_map or name not in artifacts:
            to_run.append(gen)

    # Coupled retries: if the handler is regenerating AND its errors indicate a
    # field-contract break, widget_js / admin_ui must be regenerated alongside
    # so both sides realign. We used to couple unconditionally, but a handler
    # retry caused by an unrelated issue (missing npmPackages, forbidden
    # setInterval, etc.) doesn't touch ctx.widgetBody/adminBody — re-running
    # the widget/admin UI in that case burned Sonnet tokens with no benefit.
    #
    # Pairs enforced:
    #   handler ↔ widget_js   (storefront_backend, storefront_backend_admin)
    #   handler ↔ admin_ui    (backend_admin, storefront_backend_admin)
    _CONTRACT_ERROR_MARKERS = (
        "widget route",
        "admin route",
        "widget sends",
        "admin UI sends",
        "ctx.widgetBody",
        "ctx.adminBody",
        "destructures",
        "requestShape",
        "responseShape",
        "field name",
    )
    if artifacts:  # non-empty = this is a retry, not the first run
        handler_errs = error_map.get("handler", [])
        handler_contract_broken = any(
            any(marker in err for marker in _CONTRACT_ERROR_MARKERS)
            for err in handler_errs
        )
        to_run_names = {gen.name for gen in to_run}
        coupled_pairs: List[tuple] = []
        if is_storefront:
            coupled_pairs.append(
                (
                    "handler",
                    "widget_js",
                    "Re-generating to stay in sync with the handler. "
                    "Ensure every host.call() field name exactly matches the widgetApiCatalog requestShape.",
                )
            )
        if is_admin_ui:
            coupled_pairs.append(
                (
                    "handler",
                    "admin_ui",
                    "Re-generating to stay in sync with the handler. "
                    "Ensure every bridge.call() field name exactly matches the adminApiCatalog requestShape.",
                )
            )
        for a, b, hint in coupled_pairs:
            pair = {a, b}
            if not (pair & to_run_names):
                continue  # neither side is running — nothing to couple
            # When the partner side is ALREADY in to_run (its own validator
            # flagged a mismatch), include it — that's its own error path.
            # Otherwise only pull it in if the handler's issues are contract-shaped.
            partner_already_running = bool(pair - {a} & to_run_names) and bool(
                pair - {b} & to_run_names
            )
            should_couple = partner_already_running or handler_contract_broken
            if not should_couple:
                log.info(
                    "codegen: skipping coupled retry of %s — handler errors are not contract-related",
                    ", ".join(sorted(pair - to_run_names)),
                )
                continue
            for name in pair - to_run_names:
                if name in GENERATORS and name in artifacts:
                    error_map.setdefault(name, [hint])
                    to_run.append(GENERATORS[name])
                    to_run_names.add(name)

    if not to_run:
        return artifacts, {}

    per_agent_tokens: Dict[str, Tuple[int, int]] = {}
    with ThreadPoolExecutor(max_workers=len(to_run)) as pool:
        futures = {
            gen.name: pool.submit(
                gen.generate,
                CodegenContext(
                    intent=base_ctx.intent,
                    plan=base_ctx.plan,
                    platform_api_catalog=base_ctx.platform_api_catalog,
                    api_context=base_ctx.api_context,
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
            # Generator.generate() now returns (artifact, in_tokens, out_tokens)
            artifact, in_tok, out_tok = future.result()  # raises on sub-agent exception
            artifacts[name] = artifact
            per_agent_tokens[name] = (in_tok, out_tok)

    return artifacts, per_agent_tokens


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
