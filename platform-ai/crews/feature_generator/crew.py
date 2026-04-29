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

import contextvars
import dataclasses
import datetime
import json
import logging
import pathlib
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import timezone
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Tuple

import contract.publisher as _contract_publisher
from contract.validators import (
    Bundle,
    EmailStarterContent,
    FeatureBundleMessage,
    FeatureExplanation,
    GeneratedFile,
    GenerationMeta,
    GenerationRequest,
    HandlerModule,
    ProgressEvent,
    TechnicalExplanation,
    AgentTraceEntry,
)
from models.adapter import current_input_log_run_dir, input_log
from subagents.product_agent import run_product_agent
from subagents.explanation_agent import run_explanation_agent
from subagents.base import CodegenContext, Generator
from subagents.architect_agent import run_architect_agent
from subagents.revision_agent import run_revision_agent
from subagents.validators import run_llm_validators
from subagents.registry import GENERATORS
from llm_validations.arch_plan import validate_architect_plan
from llm_validations.product_intent import validate_product_intent
from llm_validations.cross_admin_handler import validate_admin_handler_contract
from llm_validations.cross_widget_handler import validate_widget_handler_contract

log = logging.getLogger(__name__)

_MAX_RETRIES = 3  # total codegen attempts (1 initial + 2 retries)
_MAX_ARCH_ATTEMPTS = 2  # architect: 1 initial + 1 retry

# Findings whose `artifact == "migration"` mean the migration itself is broken
# (missing tables/columns) — unlock both so the revision agent fixes both
# together. (The legacy validator used Q-key categories for this; the new
# Finding shape carries a single `artifact` field that already encodes intent.)
_MIGRATION_BROKEN_ARTIFACTS: FrozenSet[str] = frozenset({"migration"})

# Artifact names that indicate a handler-side problem on a correct migration —
# lock migration, fix the handler. `migration` is NOT in this set because a
# migration finding is handled first by `_MIGRATION_BROKEN_ARTIFACTS` (which
# unlocks both); including it here would be dead. Widget/admin-only findings
# fall through to the default (lock both backends, fix the frontend). Plan-
# level findings are informational today: revision can't re-run the architect,
# so they fall through too.
_BACKEND_OPEN_ARTIFACTS: FrozenSet[str] = frozenset({"handler"})

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


def _check_deadline(request: "GenerationRequest", start_ms: int, phase: str) -> None:
    """
    Fail fast if we've already exceeded the pipeline deadline.

    Called at phase boundaries — won't interrupt an in-flight LLM call, but
    prevents spending more time on a run that's already over budget. Combines
    with per-call timeouts in models/adapter.py to bound total duration.

    `phase` is the name of the phase that just completed (e.g. "product",
    "architect") and is used as the agent label on the failure event.
    """
    elapsed_s = (_now_ms() - start_ms) / 1000
    if elapsed_s > _PIPELINE_DEADLINE_S:
        _fail_and_abort(
            request,
            phase,
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
    payload: Dict = {
        "jobId": request.jobId,
        "tenantId": request.tenantId,
        "appId": request.appId,
        "status": "failed",
        "error": error,
    }
    if error_code:
        payload["errorCode"] = error_code
    _contract_publisher.publish_completed(FeatureBundleMessage(**payload))
    raise _PipelineAbort


def _save_revision_failure(
    job_id: str,
    bad_artifacts: Dict[str, str],
    errors: Dict[str, List[str]],
) -> str:
    """Persist bad revision artifacts to /tmp for post-mortem analysis. Returns file path."""
    failure_dir = pathlib.Path("/tmp/revision_validation_failures")
    failure_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    path = failure_dir / f"{ts}_{job_id}.json"
    payload = {
        "job_id": job_id,
        "timestamp": ts,
        "errors": errors,
        "artifacts": bad_artifacts,
    }
    try:
        path.write_text(json.dumps(payload, indent=2))
        return str(path)
    except OSError as exc:
        log.warning("Could not save revision failure artifacts: %s", exc)
        return "(save failed)"


def _revision_locked_artifacts(issues: List[Dict]) -> FrozenSet[str]:
    """
    Determine which artifacts the revision agent must treat as read-only based on
    which LLM-validator findings fired. The findings come from the unified
    Finding shape produced by subagents.validators (every finding carries an
    `artifact` field).

    Locking policy (single field, no Q-key categories):
    - artifact == "migration": migration itself is broken (missing table /
      missing column) — unlock both so the revision can add the missing
      schema AND adjust the handler in one pass.
    - artifact == "handler": backend problem — lock migration (it's the
      schema ground truth), fix the handler.
    - artifact in {"widget_js", "admin_ui"}: frontend misalignment — handler
      and migration are the contract; fix the frontend, keep them locked.

    Plan-level findings never reach this function — `_phase_validator`
    filters them before invoking revision (revision can't re-run the
    architect, so plan issues short-circuit the loop with a warning log
    rather than wasting a revision pass on the wrong artifact).

    Invariant: this function is only called after handler and migration have already
    passed static validation in the codegen loop. If that invariant ever breaks, the
    lock could paper over a real backend bug — revisit if backend static validation
    is weakened or bypassed.
    """
    artifacts = {i.get("artifact") for i in issues if i.get("artifact")}

    if artifacts & _MIGRATION_BROKEN_ARTIFACTS:
        # Migration itself is incomplete — unlock both so the revision fixes both.
        return frozenset()

    if artifacts & _BACKEND_OPEN_ARTIFACTS:
        # Handler misaligns with a correct migration — lock migration, fix handler.
        return frozenset({"migration"})

    # Frontend-only misalignment — handler is ground truth, fix widget/admin_ui.
    return frozenset({"handler", "migration"})


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
        _check_deadline(request, start_ms, "product")

        archetype = intent["appCategory"]
        is_storefront = archetype in (
            "storefront_backend",
            "storefront_backend_admin",
        )
        is_admin_ui = archetype in (
            "storefront_backend_admin",
            "backend_admin",
        )
        log.info(
            "job=%s archetype=%s is_storefront=%s is_admin_ui=%s",
            request.jobId,
            archetype,
            is_storefront,
            is_admin_ui,
        )

        plan = _phase_architect(request, intent, agent_trace)
        _check_deadline(request, start_ms, "architect")

        prior_bundle = request.priorBundle or {}
        prior_handler_module = prior_bundle.get("handlerModule") or {}
        # New shape: handlerModule.files = [{path, contents}, ...].
        # Legacy shape: handlerModule.code = "<single CommonJS blob>".
        # _format_prior_handler in handler_agent.py accepts both.
        prior_handler = (
            prior_handler_module.get("files")
            or prior_handler_module.get("code")
            or None
        )
        # New shape: dbMigration = {path, contents}.  Legacy: {sql}.
        prior_migration = prior_bundle.get("dbMigration") or {}
        prior_migration_sql = (
            prior_migration.get("contents") or prior_migration.get("sql") or None
        )
        base_ctx = CodegenContext(
            intent=intent,
            plan=plan,
            platform_api_catalog=(plan.get("appContracts") or {}).get(
                "widgetApiCatalog"
            )
            or [],
            prior_handler_code=prior_handler,
            prior_widget_code=(prior_bundle.get("widgetModule") or None),
            prior_migration_sql=prior_migration_sql,
            prior_admin_ui_code=(prior_bundle.get("adminUiModule") or None),
        )

        artifacts = _phase_codegen(
            request, base_ctx, is_storefront, is_admin_ui, agent_trace
        )
        _check_deadline(request, start_ms, "codegen")

        artifacts = _phase_validator(
            request, base_ctx, artifacts, is_storefront, is_admin_ui, agent_trace
        )
        _check_deadline(request, start_ms, "validator")

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
            handler_email_metadata=base_ctx.handler_email_metadata,
        )

    except _PipelineAbort:
        pass  # failure event already published by _fail_and_abort

    except Exception as exc:
        log.exception("job=%s unhandled error in run_feature_generation", request.jobId)
        try:
            _contract_publisher.publish_completed(
                FeatureBundleMessage(
                    jobId=request.jobId,
                    tenantId=request.tenantId,
                    appId=request.appId,
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

    # Static gate on the intent dict — five closed-set / cross-field checks
    # that catch the catastrophic-by-cascade failure modes (wrong appCategory,
    # invalid trigger, mismatched archetype↔trigger pairing). Mirrors how
    # validate_architect_plan runs on the architect output. See PRODUCT_RULES.md.
    intent_errors = validate_product_intent(intent)
    if intent_errors:
        joined = "; ".join(intent_errors)
        log.warning(
            "job=%s product intent rejected by validate_product_intent: %s",
            request.jobId,
            joined,
        )
        _fail_and_abort(
            request,
            "product",
            f"Feature spec failed validation: {intent_errors[0]}",
            f"Product intent validation failed: {joined}",
            error_code="PRODUCT_INTENT_INVALID",
        )

    _emit(request, "product", "completed", "Feature spec ready")
    log.info("job=%s intent=%s tokens=(%d,%d)", request.jobId, intent, in_tok, out_tok)
    return intent


def _phase_architect(
    request: GenerationRequest,
    intent: Dict,
    agent_trace: List[AgentTraceEntry],
) -> Dict:
    """
    Agent 2: produce shopifyPlan + appContracts (typed contracts for all components).

    Returns the architect plan dict.
    """
    _emit(request, "architect", "running", "Planning Shopify API surface…")
    t0 = _now_ms()

    archetype = intent.get("appCategory")

    plan: Optional[Dict] = None
    arch_errors: List[str] = []
    arch_in = 0
    arch_out = 0

    for attempt in range(1, _MAX_ARCH_ATTEMPTS + 1):
        plan, attempt_in, attempt_out = run_architect_agent(
            prompt=request.prompt,
            intent=intent,
            app_archetype=archetype,
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

    return plan


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
    # Cumulative errors across all retry attempts, keyed by generator name.
    # A fresh validate_artifacts() on each attempt only returns the CURRENT
    # attempt's errors; passing that alone to the model caused whack-a-mole —
    # attempt 2 fixes A → introduces B → attempt 3 fixes B → reintroduces A,
    # because the model never saw both constraints at the same time. The
    # cumulative view is the union of every unique error string a generator has
    # produced across all attempts so far, so by attempt N the model has the
    # full picture of every rule it has violated.
    cumulative_errors: Dict[str, List[str]] = {}
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
            cumulative_errors,
            artifacts,
            attempt,
        )
        for name, (in_tok, out_tok) in attempt_tokens.items():
            prev_in, prev_out = token_totals.get(name, (0, 0))
            token_totals[name] = (prev_in + in_tok, prev_out + out_tok)

        _emit(request, "validation", "running", "Validating generated artifacts…")
        error_map = validate_artifacts(artifacts, base_ctx, is_storefront, is_admin_ui)

        # Merge this attempt's errors into the cumulative view (dedup per generator).
        # The cumulative view is what gets shown to the model on the NEXT attempt.
        for name, errs in error_map.items():
            existing = cumulative_errors.setdefault(name, [])
            for err in errs:
                if err not in existing:
                    existing.append(err)

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
    cumulative_errors: Dict[str, List[str]],
    artifacts: Dict[str, str],
    attempt: int,
) -> Tuple[Dict[str, str], Dict[str, Tuple[int, int]]]:
    """
    Produce artifacts for one codegen attempt.

    Dispatch order:
      - Revision run + attempt 1: holistic revision agent first, parallel
        fallthrough if revision returns incomplete output.
      - Attempt 1 (any other case): parallel codegen (fastest; no peer code
        exists yet anyway).
      - Attempt > 1: sequential codegen with peer-artifact injection
        (migration → handler → {widget_js, admin_ui} in parallel). UI generators
        see the real handler code they're calling instead of only the catalog,
        which closes the whack-a-mole loop where contract drift between handler
        and UI caused alternating failure modes across attempts.

    error_map: current attempt's errors — drives which generators re-run and the
      coupled-retry heuristic.
    cumulative_errors: union of every unique error string this generator has produced
      across all attempts — fed to the model as previous_errors so retry 3 sees
      attempt 1's errors, not just attempt 2's (prevents whack-a-mole regressions).

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
            cumulative_errors=cumulative_errors,
            artifacts=artifacts,
        )
        parallel_tokens["revision"] = (
            parallel_tokens.get("revision", (0, 0))[0] + in_tok,
            parallel_tokens.get("revision", (0, 0))[1] + out_tok,
        )
        return parallel_artifacts, parallel_tokens

    log.info(
        "job=%s codegen attempt=%d mode=parallel failing=%s",
        request.jobId,
        attempt,
        sorted(error_map.keys()) if attempt > 1 else [],
    )
    return run_codegen_parallel(
        base_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        error_map=error_map,
        cumulative_errors=cumulative_errors,
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
    Optional Agent 4b: LLM semantic validators (LLM_VALIDATION_ENABLED=true).

    Runs the three parallel validators in subagents/validators (agent_rules,
    bug_finder, quality_brief_coverage) against the generated artifacts.
    Only HIGH-confidence findings trigger a revision pass.

    Locking strategy (see _revision_locked_artifacts) — driven solely by each
    finding's `artifact` field:
      artifact == "migration"      → unlock both (migration itself is broken).
      artifact == "handler"        → lock migration, fix handler.
      artifact in {widget_js,
                   admin_ui}       → lock both backends, fix the frontend.
      artifact == "plan"           → can't be fixed in this loop (revision
                                      doesn't re-run the architect). Logged
                                      as WARN and dropped before revision;
                                      if every finding is plan-level the
                                      run short-circuits and returns the
                                      original artifacts so the operator
                                      can re-run the architect.

    After each revision attempt the output is statically validated. If both attempts
    produce structurally invalid code the job is failed (not silently swapped back).
    Trade-off: a double revision failure is rare and always indicates a structural bug
    (React code, import statements, etc.) — silently shipping that is worse than failing.
    """
    from config import get_settings

    if not get_settings().llm_validation_enabled:
        return artifacts

    _emit(request, "validator", "running", "Checking semantic alignment…")
    t0 = _now_ms()
    issues, val_in, val_out, per_validator = run_llm_validators(
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
    # Per-validator visibility: log latency / tokens / error per slot so a
    # silent fail-open (e.g. provider outage on one validator) shows up in
    # job logs even when the other slots succeeded with no findings.
    for name, result in per_validator.items():
        log.info(
            "job=%s validator=%s latency=%dms in_tok=%d out_tok=%d findings=%d%s",
            request.jobId,
            name,
            result.latency_ms,
            result.input_tokens,
            result.output_tokens,
            len(result.findings),
            f" error={result.error}" if result.error else "",
        )

    if not issues:
        _emit(request, "validator", "completed", "Semantic check passed")
        return artifacts

    # Plan-level findings can't be fixed inside the codegen loop — the
    # revision agent edits handler / migration / widget / admin, never the
    # architect output. Surface them loudly as warnings (so they show up in
    # job logs) and drop them from the actionable set passed to revision.
    # If every finding was plan-level, skip revision entirely: there is
    # nothing the loop can act on, and forcing revision to run against
    # arbitrary frontend code (the prior `_revision_locked_artifacts`
    # default) would just churn unrelated artifacts.
    plan_issues = [i for i in issues if i.get("artifact") == "plan"]
    actionable_issues = [i for i in issues if i.get("artifact") != "plan"]
    for plan_issue in plan_issues:
        log.warning(
            "job=%s plan-level finding (not auto-fixable, re-run architect): "
            "%s — %s",
            request.jobId,
            plan_issue.get("question", "?"),
            plan_issue.get("issue", ""),
        )
    if not actionable_issues:
        _emit(
            request,
            "validator",
            "completed",
            f"{len(plan_issues)} plan-level issue(s) — revision skipped "
            "(re-run architect to fix)",
        )
        return artifacts
    issues = actionable_issues

    issue_summary = "; ".join(f"{i['question']}: {i['issue']}" for i in issues)
    log.info(
        "job=%s llm_validators: %d high-confidence issue(s): %s",
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

    # Build context from the fresh codegen output so the revision agent works from
    # the actual code it needs to fix, not from a (possibly absent) prior bundle.
    revision_ctx = dataclasses.replace(
        base_ctx,
        prior_handler_code=artifacts.get("handler") or base_ctx.prior_handler_code,
        prior_migration_sql=artifacts.get("migration") or base_ctx.prior_migration_sql,
        prior_widget_code=artifacts.get("widget_js") or base_ctx.prior_widget_code,
        prior_admin_ui_code=artifacts.get("admin_ui") or base_ctx.prior_admin_ui_code,
    )
    _LOCKED = _revision_locked_artifacts(issues)
    log.info(
        "job=%s revision locking: questions=%s locked=%s unlocked=%s",
        request.jobId,
        sorted(i["question"] for i in issues),
        sorted(_LOCKED),
        sorted({"handler", "migration", "widget_js", "admin_ui"} - _LOCKED),
    )

    _emit(request, "revision", "running", f"Fixing {len(issues)} semantic issue(s)…")
    rev_t0 = _now_ms()
    revised, rev_in, rev_out = run_revision_agent(
        revision_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        validation_issues=issues,
        locked_artifacts=_LOCKED,
    )
    agent_trace.append(
        AgentTraceEntry(
            agent="revision",
            latencyMs=_now_ms() - rev_t0,
            inputTokens=rev_in,
            outputTokens=rev_out,
        )
    )

    # Only accept frontend artifacts — handler/migration are locked.
    frontend_revised = {k: v for k, v in revised.items() if k not in _LOCKED}
    if not frontend_revised:
        log.warning(
            "job=%s revision_agent: returned no frontend artifacts — keeping originals",
            request.jobId,
        )
        _emit(
            request, "revision", "completed", "Revision incomplete — keeping originals"
        )
        return artifacts

    # Statically validate the revised frontend artifacts before accepting them.
    merged = {**artifacts, **frontend_revised}
    all_errors = validate_artifacts(merged, revision_ctx, is_storefront, is_admin_ui)
    static_errors: Dict[str, List[str]] = {
        k: v for k, v in all_errors.items() if k in frontend_revised
    }

    if not static_errors:
        _emit(request, "revision", "completed", "Semantic issues resolved")
        return merged

    # First revision failed static validation — retry once with the errors fed back.
    log.warning(
        "job=%s revision_agent: static validation failed on attempt 1 — retrying. errors=%s",
        request.jobId,
        {k: v for k, v in static_errors.items()},
    )
    rev2_t0 = _now_ms()
    revised2, rev2_in, rev2_out = run_revision_agent(
        revision_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        validation_issues=issues,
        locked_artifacts=_LOCKED,
        static_errors=static_errors,
    )
    agent_trace.append(
        AgentTraceEntry(
            agent="revision",
            latencyMs=_now_ms() - rev2_t0,
            inputTokens=rev2_in,
            outputTokens=rev2_out,
        )
    )

    frontend_revised2 = {k: v for k, v in revised2.items() if k not in _LOCKED}
    merged2 = {**artifacts, **frontend_revised2}
    all_errors2 = validate_artifacts(merged2, revision_ctx, is_storefront, is_admin_ui)
    static_errors2: Dict[str, List[str]] = {
        k: v for k, v in all_errors2.items() if k in frontend_revised2
    }

    if not static_errors2:
        _emit(
            request, "revision", "completed", "Semantic issues resolved (static retry)"
        )
        return merged2

    # Both revision attempts produced statically invalid code — fail the job.
    bad = {**frontend_revised, **frontend_revised2}
    failure_path = _save_revision_failure(request.jobId, bad, static_errors2)
    error_detail = "; ".join(
        f"{k}: {', '.join(errs)}" for k, errs in static_errors2.items()
    )
    log.error(
        "job=%s revision_agent: static validation failed after 2 attempts — failing job. "
        "saved=%s errors=%s",
        request.jobId,
        failure_path,
        error_detail,
    )
    _fail_and_abort(
        request,
        "revision",
        "Revision produced structurally invalid code — generation failed",
        f"Revision agent emitted invalid artifacts after 2 attempts: {error_detail}",
        error_code="REVISION_STATIC_VALIDATION_FAILED",
    )


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
    handler_email_metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Build the final Bundle and publish a success completion event.

    Email metadata flow:
      - usesEmail is derived from plan.appContracts.handlerCapabilities
        (architect declares "email" when the gnerated app requries emailing).
      - emailTypeSuggestion comes from plan.appContracts.emailSpec.type
        (architect's committed transactional/marketing decision).
      - emailVariables and emailStarterContent come from the handler's
        structured ```email-metadata``` sidecar, surfaced on ctx by
        HandlerGenerator.generate() and threaded here via the
        handler_email_metadata argument.

    On revision runs where the holistic revision agent runs without
    falling through to parallel codegen, handler_email_metadata will be
    None. In that case the platform preserves the existing
    app_email_configs row (merchant edits are not overwritten). See
    MEMORY notifications-center tech debt for the drift-surfacing plan.
    """
    # Handler output is a ===FILE:===/===END=== marker bundle; parse into
    # {path, contents} entries. Fall back to a single pseudo-file when the
    # model returned no markers (legacy shape or protocol violation — the
    # static validator catches the latter and triggers a retry).
    from utils.file_bundle import parse_file_bundle, ParseError

    handler_raw = artifacts.get("handler", "")
    try:
        parsed_files = parse_file_bundle(handler_raw) if handler_raw else []
    except ParseError as err:
        log.warning(
            "handler bundle malformed (%s) — falling back to single-file wrap",
            err,
        )
        parsed_files = []
    if parsed_files:
        handler_files = [
            GeneratedFile(path=f["path"], contents=f["contents"]) for f in parsed_files
        ]
    else:
        # Either the model produced no markers or parsing failed — wrap the
        # raw text so the Bundle still constructs. The static validator will
        # fail this on the retry loop and produce a better next attempt.
        handler_files = [
            GeneratedFile(path="src/routes/handler.ts", contents=handler_raw)
        ]

    migration_sql = artifacts.get("migration", "")
    shopify_plan = plan.get("shopifyPlan", {})
    technical = explanation.get("technical", {})
    app_contracts = plan.get("appContracts") or {}

    uses_email = "email" in (app_contracts.get("handlerCapabilities") or [])
    email_spec = app_contracts.get("emailSpec") or {}
    sidecar = handler_email_metadata or {}
    raw_variables = sidecar.get("variables")
    email_variables: List[str] = [
        v for v in (raw_variables or []) if isinstance(v, str)
    ]
    starter_raw = sidecar.get("starterContent")
    email_starter = (
        EmailStarterContent(**starter_raw)
        if isinstance(starter_raw, dict)
        and starter_raw.get("subject")
        and starter_raw.get("body")
        else None
    )

    # Slim catalog manifests for the served bundle prelude. Defaults to POST
    # for any catalog row that omits `method` (most existing plans before
    # this change emit GET/POST explicitly per ARCH_RULES row 19/29; the
    # default keeps wire-compat with the prior always-POST SDK behaviour).
    # Invalid rows are dropped with a warning so the post-publish bundle
    # never carries garbage; arch_plan.py is the upstream gate that should
    # fail the architect attempt before we reach this point — drops here
    # mean that gate slipped and we want it visible in logs.
    def _slim_catalog(
        rows: List[Dict[str, Any]], catalog_name: str
    ) -> List[Dict[str, str]]:
        out: List[Dict[str, str]] = []
        for row in rows or []:
            path = row.get("path")
            method_raw = row.get("method") or "POST"
            method = method_raw.upper() if isinstance(method_raw, str) else ""
            if not isinstance(path, str) or not path:
                log.warning(
                    "%s row dropped from slim manifest: missing/empty path "
                    "(row=%r). arch_plan.py should have rejected this — "
                    "investigate the architect output.",
                    catalog_name,
                    row,
                )
                continue
            if method not in ("GET", "POST"):
                log.warning(
                    "%s row dropped from slim manifest: path=%r method=%r "
                    "is not GET or POST. arch_plan.py should have rejected "
                    "this — investigate the architect output.",
                    catalog_name,
                    path,
                    method_raw,
                )
                continue
            out.append({"path": path, "method": method})
        return out

    widget_catalog = (
        _slim_catalog(app_contracts.get("widgetApiCatalog") or [], "widgetApiCatalog")
        if is_storefront
        else []
    )
    admin_catalog = (
        _slim_catalog(app_contracts.get("adminApiCatalog") or [], "adminApiCatalog")
        if is_admin_ui
        else []
    )

    bundle = Bundle(
        widgetModule=artifacts.get("widget_js") if is_storefront else None,
        adminUiModule=artifacts.get("admin_ui") if is_admin_ui else None,
        widgetTargetTemplates=(
            (app_contracts.get("widgetTargetTemplates") or None)
            if is_storefront
            else None
        ),
        widgetCatalog=widget_catalog,
        adminCatalog=admin_catalog,
        handlerModule=HandlerModule(
            files=handler_files,
            webhookTopics=shopify_plan.get("webhookTopics", []),
            cronSchedule=shopify_plan.get("cronSchedule"),
        ),
        dbMigration=GeneratedFile(
            path="migrations/generated.sql",
            contents=migration_sql,
        ),
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
        usesEmail=uses_email,
        emailVariables=email_variables,
        emailTypeSuggestion=email_spec.get("type"),
        emailStarterContent=email_starter,
    )

    total_ms = _now_ms() - start_ms
    total_in = sum(e.inputTokens for e in agent_trace)
    total_out = sum(e.outputTokens for e in agent_trace)
    _contract_publisher.publish_completed(
        FeatureBundleMessage(
            jobId=request.jobId,
            tenantId=request.tenantId,
            appId=request.appId,
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


def _plan_codegen_batch(
    *,
    is_storefront: bool,
    is_admin_ui: bool,
    error_map: Dict[str, List[str]],
    artifacts: Dict[str, str],
) -> List[Generator]:
    """
    Decide which generators to (re)run this attempt and apply the coupled-retry
    heuristic. Mutates error_map in place to add coupled-retry hints.

    Returns the Generator list to invoke. Shared by parallel (first attempt)
    and sequential (retry) paths so both use the same coupled-retry logic.

    Coupled retries: if the handler is regenerating AND its errors indicate a
    field-contract break, widget_js / admin_ui must be regenerated alongside
    so both sides realign. A handler retry caused by an unrelated issue
    (missing npmPackages, forbidden setInterval, etc.) does not touch
    ctx.widgetBody / ctx.adminBody — re-running the widget/admin UI in that
    case would burn Sonnet tokens with no benefit.

    Pairs enforced:
      handler ↔ widget_js   (storefront_backend, storefront_backend_admin)
      handler ↔ admin_ui    (backend_admin, storefront_backend_admin)
    """
    to_run: List[Generator] = []
    for name, gen in GENERATORS.items():
        if name == "widget_js" and not is_storefront:
            continue
        if name == "admin_ui" and not is_admin_ui:
            continue
        if name in error_map or name not in artifacts:
            to_run.append(gen)

    if not artifacts:
        return to_run  # first run — no coupling possible

    handler_errs = error_map.get("handler", [])
    handler_contract_broken = any(
        any(marker in err for marker in _CONTRACT_ERROR_MARKERS) for err in handler_errs
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
        if not handler_contract_broken:
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

    return to_run


def _build_prev_errors(
    name: str,
    cumulative_errors: Dict[str, List[str]],
    error_map: Dict[str, List[str]],
) -> Optional[List[str]]:
    """
    Build the previous_errors list passed to a generator on retry.

    Union of cumulative_errors (every unique error seen across all attempts)
    and the current attempt's error_map (which also carries any coupled-retry
    hints injected by _plan_codegen_batch). Deduped, ordered:
    cumulative first, then any new items from error_map.
    """
    merged: List[str] = []
    seen: set[str] = set()
    for err in (cumulative_errors.get(name) or []) + (error_map.get(name) or []):
        if err not in seen:
            merged.append(err)
            seen.add(err)
    return merged or None


def _build_codegen_context(
    base_ctx: CodegenContext,
    *,
    previous_errors: Optional[List[str]],
) -> CodegenContext:
    """Build the per-generator CodegenContext for one invocation."""
    return CodegenContext(
        intent=base_ctx.intent,
        plan=base_ctx.plan,
        platform_api_catalog=base_ctx.platform_api_catalog,
        previous_errors=previous_errors,
        prior_handler_code=base_ctx.prior_handler_code,
        prior_widget_code=base_ctx.prior_widget_code,
        prior_migration_sql=base_ctx.prior_migration_sql,
        prior_admin_ui_code=base_ctx.prior_admin_ui_code,
    )


def run_codegen_parallel(
    base_ctx: CodegenContext,
    *,
    is_storefront: bool,
    is_admin_ui: bool,
    error_map: Dict[str, List[str]],
    cumulative_errors: Dict[str, List[str]],
    artifacts: Dict[str, str],
    on_start: Optional[Callable[[str], None]] = None,
    on_done: Optional[Callable[[str, int, int, int], None]] = None,
) -> Tuple[Dict[str, str], Dict[str, Tuple[int, int]]]:
    """
    Run generators in parallel via ThreadPoolExecutor. Used for the first codegen
    attempt where no peer code exists yet — running concurrently is strictly
    faster since the generators cannot inform each other on the first pass.

    Only generators that either have errors (retry path) or have not yet produced
    an artifact (first run) are executed. Generators whose artifacts are clean are
    skipped — their existing output is preserved in the returned dict.

    error_map drives which generators re-run and the coupled-retry heuristic.
    cumulative_errors is the union of every unique error a generator has produced
    across all prior attempts — it's what gets passed to the model as
    previous_errors so later retries have the full history, not just the
    most recent failures.

    Returns (artifacts, per_agent_tokens) — tokens dict only contains keys for
    generators that actually ran on this invocation.
    """
    to_run = _plan_codegen_batch(
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        error_map=error_map,
        artifacts=artifacts,
    )
    if not to_run:
        return artifacts, {}

    per_agent_tokens: Dict[str, Tuple[int, int]] = {}
    # Capture each generator's ctx so we can read side-band outputs
    # (currently just HandlerGenerator's handler_email_metadata) after the
    # future resolves. The per-call ctx is distinct from base_ctx — base_ctx
    # lives for the whole pipeline; these are one-shot per generator call.
    ctx_by_gen: Dict[str, CodegenContext] = {
        gen.name: _build_codegen_context(
            base_ctx,
            previous_errors=_build_prev_errors(gen.name, cumulative_errors, error_map),
        )
        for gen in to_run
    }

    # Wrap each generator call to emit start/done callbacks with wall-clock
    # timing. Callbacks run on whichever thread finished — safe for the CLI's
    # multi-line spinner (Python print is atomic at the line level and the
    # spinner coordinates via a module-level dict it reads, not prints from).
    #
    # If an input_log() block is active in the parent (chat_local.py), we
    # re-enter it with a generator-specific agent name so each generator's
    # prompt lands in inputs/codegen_<gen>/attempt_N/ rather than colliding
    # under one shared dir. The pool boundary is crossed via copy_context()
    # at submit time below — without it, ContextVar state set on the main
    # thread is invisible to the workers.
    def _wrapped(gen_name: str, ctx: CodegenContext):
        if on_start is not None:
            on_start(gen_name)
        started = time.monotonic()
        parent_run_dir = current_input_log_run_dir()
        if parent_run_dir is not None:
            with input_log(f"codegen_{gen_name}", parent_run_dir):
                artifact, in_tok, out_tok = _registry_by_name[gen_name].generate(ctx)
        else:
            artifact, in_tok, out_tok = _registry_by_name[gen_name].generate(ctx)
        if on_done is not None:
            ms = int((time.monotonic() - started) * 1000)
            on_done(gen_name, ms, in_tok, out_tok)
        return gen_name, artifact, in_tok, out_tok

    _registry_by_name = {gen.name: gen for gen in to_run}

    # Each submission gets its own context copy — Context.run() is single-use
    # per Context, so a fresh copy_context() per submit is required to avoid
    # 'cannot enter context: already entered' when workers run concurrently.
    with ThreadPoolExecutor(max_workers=len(to_run)) as pool:
        futures = [
            pool.submit(
                contextvars.copy_context().run,
                _wrapped,
                gen.name,
                ctx_by_gen[gen.name],
            )
            for gen in to_run
        ]
        # Use as_completed so on_done fires in actual completion order; the
        # returned dicts still key by name, so callers that only care about
        # the final result are unaffected by ordering.
        for future in as_completed(futures):
            name, artifact, in_tok, out_tok = future.result()
            artifacts[name] = artifact
            per_agent_tokens[name] = (in_tok, out_tok)

    # Propagate HandlerGenerator's side-band email metadata onto base_ctx so
    # downstream phases (_publish_success → Bundle construction) can read it
    # without threading extra return values through every pipeline layer.
    handler_ctx = ctx_by_gen.get("handler")
    if handler_ctx is not None and handler_ctx.handler_email_metadata is not None:
        base_ctx.handler_email_metadata = handler_ctx.handler_email_metadata
    if handler_ctx is not None and handler_ctx.handler_raw_response is not None:
        base_ctx.handler_raw_response = handler_ctx.handler_raw_response

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
    # Pass the architect's catalog so the validator can branch on
    # per-path method (GET routes' fields land in req.query; POST routes'
    # fields land in req.body — the host.call SDK encodes accordingly).
    plan_contracts = (ctx.plan or {}).get("appContracts") or {}
    if is_storefront:
        for gen_name, errs in validate_widget_handler_contract(
            artifacts.get("widget_js", ""),
            artifacts.get("handler", ""),
            plan_contracts.get("widgetApiCatalog") or [],
        ).items():
            if errs:
                error_map.setdefault(gen_name, []).extend(errs)

    # Admin UI ↔ handler cross-artifact check.
    if is_admin_ui:
        for gen_name, errs in validate_admin_handler_contract(
            artifacts.get("admin_ui", ""),
            artifacts.get("handler", ""),
            plan_contracts.get("adminApiCatalog") or [],
        ).items():
            if errs:
                error_map.setdefault(gen_name, []).extend(errs)

    # GraphQL schema gate — extract every shopify.{graphql,graphqlPaginate,
    # bulkQuery,storefront}(`...`) query string and validate it against the
    # committed Shopify GraphQL catalog. Catches typo'd field names, wrong
    # arg types, missing required args, and deprecated field usage that the
    # regex layer can't see. Runs only when the regex/contract checks pass —
    # broken bundles produce noisy parse errors with no extra signal.
    if "handler" not in error_map:
        from llm_validations.handler_graphql import validate_handler_graphql

        graphql_errors = validate_handler_graphql(artifacts.get("handler", ""))
        if graphql_errors:
            error_map["handler"] = graphql_errors

    # tsc --noEmit gate. Run only when the cheap regex/contract checks
    # already pass for the handler — if the bundle has obvious bugs, tsc's
    # downstream errors won't add signal and just burn time. When the gate
    # finds problems, set the handler bucket (handler was clean up to this
    # point, so there are no prior entries to merge) so the retry loop
    # regenerates the handler with tsc messages as feedback.
    if "handler" not in error_map:
        from llm_validations.handler_typecheck import validate_handler_typecheck

        tsc_errors = validate_handler_typecheck(artifacts.get("handler", ""))
        if tsc_errors:
            error_map["handler"] = tsc_errors

    return error_map
