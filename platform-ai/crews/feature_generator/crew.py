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

import dataclasses
import datetime
import json
import logging
import pathlib
import time
from datetime import timezone
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

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
from subagents.a_product_agent.agent import (
    ProductIntentValidationError,
    run_product_agent,
)
from subagents.u_explenation_agent.explanation_agent import run_explanation_agent
from subagents.base import CodegenContext
from subagents.s_revision_agent.revision_agent import run_revision_agent
from subagents.q_codegen_v_agent.agent import (
    group_findings_by_artifact,
    run_codegen_validator,
)
from subagents.registry import GENERATORS
# Codegen primitives live in subagents/o_codegen_agent/orchestration.py — the
# canonical toolkit shared by every codegen consumer (this crew, the CLI's
# pipeline_local, and any future driver). Keep crew.py focused on the
# production-API shell: progress events, contract publishing, deadline.
from subagents.o_codegen_agent.orchestration import (
    _MAX_RETRIES,
    run_codegen_parallel,
    validate_artifacts,
)

log = logging.getLogger(__name__)

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

        # Legacy architect retired during the legacy-architect cleanup;
        # downstream agents (handler / revision / explanation) still read
        # ctx.plan and will be migrated in the next refactor wave. Pass
        # an empty plan dict so .get() lookups remain safe.
        plan: Dict = {}

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
        prior_db_sql = (
            prior_migration.get("contents") or prior_migration.get("sql") or None
        )
        base_ctx = CodegenContext(
            intent=intent,
            plan=plan,
            platform_api_catalog=(plan.get("appContracts") or {}).get(
                "widgetApiCatalog"
            )
            or [],
            prior_backend_code=prior_handler,
            prior_storefront_code=(prior_bundle.get("widgetModule") or None),
            prior_db_sql=prior_db_sql,
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
            backend_email_metadata=base_ctx.backend_email_metadata,
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
    try:
        intent, in_tok, out_tok = run_product_agent(request.prompt)
    except ProductIntentValidationError as err:
        # The agent already retried `_MAX_ATTEMPTS` times against
        # ProductIntent's pydantic schema (closed-set fields + cross-field
        # invariants from PRODUCT_RULES.md). Treat persistent failure as a
        # hard pipeline abort — downstream agents would receive a
        # malformed intent and silently mis-classify the app.
        log.warning(
            "job=%s product intent rejected after %d attempts: %s",
            request.jobId,
            err.attempts,
            err.errors,
        )
        agent_trace.append(
            AgentTraceEntry(
                agent="product",
                latencyMs=_now_ms() - t0,
                inputTokens=err.in_tokens,
                outputTokens=err.out_tokens,
            )
        )
        _fail_and_abort(
            request,
            "product",
            f"Feature spec failed validation: {err.errors[0] if err.errors else 'unknown error'}",
            f"Product intent validation failed: {'; '.join(err.errors)}",
            error_code="PRODUCT_INTENT_INVALID",
        )
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
    _emit(request, "backend", "running", "Generating backend handler…")
    _emit(request, "db", "running", "Writing DB migration…")
    if is_storefront:
        _emit(request, "storefront", "running", "Generating storefront widget…")
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
    # per-agent token totals accumulated across all attempts (backend, db,
    # storefront, admin_ui, revision). Each value is (input_tokens, output_tokens).
    token_totals: Dict[str, Tuple[int, int]] = {}
    t0 = _now_ms()

    # Per-attempt ctx. After each failed attempt we replace
    # `prior_<x>_code` for the retrying agents (backend, storefront,
    # admin_ui) with that attempt's output so the next attempt patches
    # its own previous bundle instead of regenerating from scratch.
    # DB is skipped — its validator interprets a non-empty
    # `prior_db_sql` as a real revision run (CREATE TABLE → ALTER TABLE
    # check), which would falsely flag the retry path.
    attempt_ctx = base_ctx

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
            attempt_ctx,
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

        # Propagate side-band outputs written by run_codegen_parallel onto
        # the attempt_ctx back to base_ctx — base_ctx is the canonical
        # home callers downstream (e.g. _publish_success) read from.
        if attempt_ctx is not base_ctx:
            if attempt_ctx.backend_email_metadata is not None:
                base_ctx.backend_email_metadata = attempt_ctx.backend_email_metadata
            if attempt_ctx.backend_raw_response is not None:
                base_ctx.backend_raw_response = attempt_ctx.backend_raw_response

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

        # Set `prior_<x>_code` for the retrying agents to THIS attempt's
        # output so the next attempt patches its own previous bundle (not
        # the stale pre-retry artifact). DB stays untouched — see comment
        # at the top of this function.
        attempt_ctx = dataclasses.replace(
            attempt_ctx,
            prior_backend_code=(
                artifacts.get("backend")
                if "backend" in error_map and artifacts.get("backend")
                else attempt_ctx.prior_backend_code
            ),
            prior_storefront_code=(
                artifacts.get("storefront")
                if "storefront" in error_map and artifacts.get("storefront")
                else attempt_ctx.prior_storefront_code
            ),
            prior_admin_ui_code=(
                artifacts.get("admin_ui")
                if "admin_ui" in error_map and artifacts.get("admin_ui")
                else attempt_ctx.prior_admin_ui_code
            ),
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
    _emit(request, "backend", "completed", "Handler complete")
    _emit(request, "db", "completed", "Migration complete")
    if is_storefront:
        _emit(request, "storefront", "completed", "Widget complete")
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
        (db → backend → {storefront, admin_ui} in parallel). UI generators
        see the real handler code they're calling instead of only the catalog,
        which closes the whack-a-mole loop where contract drift between handler
        and UI caused alternating failure modes across attempts.

    error_map: current attempt's errors — drives which generators re-run and the
      coupled-retry heuristic.
    cumulative_errors: union of every unique error string this generator has produced
      across all attempts — fed to the model as previous_errors so retry 3 sees
      attempt 1's errors, not just attempt 2's (prevents whack-a-mole regressions).

    Returns (artifacts, per_agent_tokens) where per_agent_tokens maps agent name
    (backend / db / storefront / admin_ui / revision) to (in_tokens, out_tokens).
    """
    is_revision_first_attempt = attempt == 1 and base_ctx.prior_backend_code is not None

    if is_revision_first_attempt:
        _emit(request, "revision", "running", "Applying merchant changes…")
        revision, in_tok, out_tok = run_revision_agent(
            base_ctx, is_storefront=is_storefront, is_admin_ui=is_admin_ui
        )
        if revision.get("backend") and revision.get("db"):
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
    Optional Agent 4b: codegen validator (LLM_VALIDATION_ENABLED=true).

    Runs `subagents.q_codegen_v_agent` against the emitted artifacts and
    routes findings BACK to the codegen agent that produced the broken
    artifact — same retry path the static validator already uses
    (`run_codegen_parallel` with `error_map` + `prior_<x>_code` on the
    ctx). No separate revision agent in this flow; each codegen agent
    patches its own file using its own prompt + cached examples.

    Plan-level findings (`artifact == "plan"`) are logged as warnings
    and dropped — there's no codegen agent to re-run the architect.

    Failure mode: if the per-agent retry produces output that still
    fails static validation, log + ship originals (kept_originals).
    The codegen-time retry loop already does N attempts before this
    runs, so a post-validator regression is rare and "ship working
    code" beats "fail the job because the fix attempt drifted".
    """
    from config import get_settings

    if not get_settings().llm_validation_enabled:
        return artifacts

    _emit(request, "validator", "running", "Hunting runtime-crashing bugs…")
    t0 = _now_ms()
    findings, val_in, val_out, _cache_r, _cache_c = run_codegen_validator(
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
    log.info(
        "job=%s codegen_v: latency=%dms in_tok=%d out_tok=%d findings=%d",
        request.jobId,
        _now_ms() - t0,
        val_in,
        val_out,
        len(findings),
    )

    if not findings:
        _emit(request, "validator", "completed", "No runtime bugs found")
        return artifacts

    # Plan-level findings can't be acted on in this loop — no codegen
    # agent re-runs the architect. Log loudly + drop them.
    plan_findings = [f for f in findings if f.get("artifact") == "plan"]
    for pf in plan_findings:
        log.warning(
            "job=%s plan-level finding (not auto-fixable, re-run architect): "
            "[%s] %s",
            request.jobId,
            pf.get("location", "?"),
            pf.get("issue", ""),
        )

    error_map = group_findings_by_artifact(findings)
    if not error_map:
        _emit(
            request,
            "validator",
            "completed",
            f"{len(plan_findings)} plan-level finding(s) — codegen retry skipped",
        )
        return artifacts

    for f in findings:
        if f.get("artifact") != "plan":
            log.info(
                "job=%s codegen_v[%s] %s — %s",
                request.jobId,
                f.get("artifact", "?"),
                f.get("location", "?"),
                f.get("issue", ""),
            )

    affected = sorted(error_map.keys())
    _emit(
        request,
        "validator",
        "completed",
        f"{len(findings)} finding(s) — retrying: {', '.join(affected)}",
    )

    # Stamp `prior_<x>_code` ONLY for artifacts that are actually being
    # retried. Setting `prior_db_sql` for an unchanged db.sql makes the
    # DB static validator treat it as a "revision run" (CREATE TABLE →
    # ALTER TABLE check), falsely failing the post-retry validation.
    retry_ctx = dataclasses.replace(
        base_ctx,
        prior_backend_code=(
            artifacts.get("backend") if "backend" in error_map else base_ctx.prior_backend_code
        ),
        prior_db_sql=(
            artifacts.get("db") if "db" in error_map else base_ctx.prior_db_sql
        ),
        prior_storefront_code=(
            artifacts.get("storefront") if "storefront" in error_map else base_ctx.prior_storefront_code
        ),
        prior_admin_ui_code=(
            artifacts.get("admin_ui") if "admin_ui" in error_map else base_ctx.prior_admin_ui_code
        ),
    )

    _emit(
        request,
        "revision",
        "running",
        f"Codegen retry on {', '.join(affected)}…",
    )
    retry_t0 = _now_ms()
    # `prior_findings_map` mirrors `error_map` so codegen_v findings ride
    # along as DO NOT REVERT guardrails on every attempt. Dedup against
    # the current round's NEW ERRORS happens inside `run_codegen_parallel`,
    # so attempt 1 still shows them once (as NEW ERRORS).
    revised_artifacts, retry_tokens = run_codegen_parallel(
        retry_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        error_map=error_map,
        cumulative_errors=dict(error_map),
        artifacts=dict(artifacts),
        prior_findings_map=dict(error_map),
    )
    retry_ms = _now_ms() - retry_t0

    for name, tokens in retry_tokens.items():
        in_tok, out_tok = tokens[0], tokens[1]
        agent_trace.append(
            AgentTraceEntry(
                agent=name,
                latencyMs=retry_ms,
                inputTokens=in_tok,
                outputTokens=out_tok,
            )
        )

    # Re-validate post-retry. If new static errors appeared, ship the
    # originals (better than shipping broken code).
    post_errors = validate_artifacts(
        revised_artifacts, retry_ctx, is_storefront, is_admin_ui
    )
    if not post_errors:
        _emit(request, "revision", "completed", "Findings fixed via codegen retry")
        return revised_artifacts

    log.warning(
        "job=%s codegen retry left static errors — keeping originals. errors=%s",
        request.jobId,
        post_errors,
    )
    _emit(
        request,
        "revision",
        "completed",
        "Codegen retry left static errors — keeping originals",
    )
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
        storefront_code=artifacts.get("storefront", "") if is_storefront else "",
        db_sql=artifacts.get("db", ""),
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
    backend_email_metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Build the final Bundle and publish a success completion event.

    Email metadata flow:
      - usesEmail is derived from plan.appContracts.handlerCapabilities
        (architect declares "email" when the gnerated app requries emailing).
      - emailTypeSuggestion comes from plan.appContracts.emailSpec.type
        (architect's committed transactional/marketing decision).
      - emailVariables and emailStarterContent come from the handler's
        structured ```email-metadata``` sidecar, surfaced on ctx by
        BackendGenerator.generate() and threaded here via the
        backend_email_metadata argument.

    On revision runs where the holistic revision agent runs without
    falling through to parallel codegen, backend_email_metadata will be
    None. In that case the platform preserves the existing
    app_email_configs row (merchant edits are not overwritten). See
    MEMORY notifications-center tech debt for the drift-surfacing plan.
    """
    # Handler output is a ===FILE:===/===END=== marker bundle; parse into
    # {path, contents} entries. Fall back to a single pseudo-file when the
    # model returned no markers (legacy shape or protocol violation — the
    # static validator catches the latter and triggers a retry).
    from utils.file_bundle import parse_file_bundle, ParseError

    handler_raw = artifacts.get("backend", "")
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

    db_sql = artifacts.get("db", "")
    shopify_plan = plan.get("shopifyPlan", {})
    technical = explanation.get("technical", {})
    app_contracts = plan.get("appContracts") or {}

    uses_email = "email" in (app_contracts.get("handlerCapabilities") or [])
    email_spec = app_contracts.get("emailSpec") or {}
    sidecar = backend_email_metadata or {}
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
        widgetModule=artifacts.get("storefront") if is_storefront else None,
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
            contents=db_sql,
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
