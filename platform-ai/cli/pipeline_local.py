"""
LLM pipeline phases for the local generator CLI.

Owns the actual generation flow — architect, codegen + static validation,
LLM validator + revision — plus the failure-persistence helpers tied to
those phases (`_save_codegen_failure_local`, `_save_revision_failure_local`,
`_save_revision_trace`) and the on-disk artifact writer (`_save_generated_files`).

`chat_local.py` orchestrates: argparse, chat / clarification, component
picking, run-dir + resume state management, output writing (md / arch.json),
DB bundle assembly, and the `main()` driver. It calls into the phase
functions here.

Why the deferred imports inside each phase
------------------------------------------
The phases need a handful of UI primitives (spinner / agent_line / colors)
and the resume-state writer (`_save_state`) that live in `chat_local.py`.
Importing them at module level would cause a circular import (chat_local
imports phases from this module). Late-binding inside each phase function
breaks the cycle: by the time a phase actually runs, chat_local is fully
loaded.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import re
import shutil
import sys
import textwrap
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from models.adapter import input_log
from subagents.hld_agent.agent import HLDValidationError, run_hld_agent
from subagents.base import CodegenContext
from subagents.explanation_agent import run_explanation_agent
from subagents.revision_agent import run_revision_agent
from subagents.validators import run_llm_validators
from crews.feature_generator.crew import (
    run_codegen_parallel,
    validate_artifacts,
    _revision_locked_artifacts,
)
from utils.file_bundle import parse_file_bundle, ParseError

_log = logging.getLogger(__name__)
_HERE = Path(__file__).resolve().parent

_MAX_CODEGEN_RETRIES = 3  # matches crew.py _MAX_RETRIES
_REVISION_TRACES_SUBDIR = "revision_traces"


# ── Artifact + failure persistence ────────────────────────────────────────────


def _save_generated_files(
    run_dir: Path,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    plan: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Write generated artifacts as individual files within run_dir.

    For widget.js / admin_ui.js, prepend the same `window.__PLATFORM_CATALOG__`
    manifest the platform-back bundle-storage saver uses on deploy, so the
    locally-saved file is byte-identical to the served bundle. Without the
    prelude, locally-tested code would behave differently from deployed code
    (the SDK would default to all-POST). When `plan` is omitted (legacy
    callers), fall back to no prelude — the SDK will treat absent manifest
    as all-POST, matching the pre-method-aware-SDK behaviour.
    """
    handler_raw = artifacts.get("handler", "")
    if handler_raw:
        try:
            for f in parse_file_bundle(handler_raw):
                dest = run_dir / f["path"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(f["contents"])
        except ParseError:
            (run_dir / "handler_bundle.ts").write_text(handler_raw)

    migration = artifacts.get("migration", "")
    if migration:
        migrations_dir = run_dir / "migrations"
        migrations_dir.mkdir(exist_ok=True)
        (migrations_dir / "generated.sql").write_text(migration)

    contracts = ((plan or {}).get("appContracts") or {}) if plan else {}

    def _prelude(catalog_rows: List[Dict[str, Any]]) -> str:
        slim = [
            {"path": r["path"], "method": (r.get("method") or "POST").upper()}
            for r in catalog_rows or []
            if isinstance(r, dict) and isinstance(r.get("path"), str)
        ]
        # Mirror the platform-back bundle-storage saver's `</script>`
        # escape so locally-saved bundles are byte-identical to the
        # deployed bundle. Defense in depth — bundles are loaded via
        # `<script src=...>` not inlined, but the dev/prod parity matters.
        # Capture-group preserves the matched case (`</SCRIPT` →
        # `<\/SCRIPT`). Mirrors the TypeScript regex shape so the locally-
        # saved bundle is byte-identical to the platform-back one.
        encoded = re.sub(
            r"</(script)", r"<\\/\1", json.dumps(slim), flags=re.IGNORECASE
        )
        return f"window.__PLATFORM_CATALOG__ = {encoded};\n"

    if is_storefront and artifacts.get("widget_js"):
        prelude = _prelude(contracts.get("widgetApiCatalog") or []) if plan else ""
        (run_dir / "widget.js").write_text(prelude + artifacts["widget_js"])

    if is_admin_ui and artifacts.get("admin_ui"):
        prelude = _prelude(contracts.get("adminApiCatalog") or []) if plan else ""
        (run_dir / "admin_ui.js").write_text(prelude + artifacts["admin_ui"])


def _save_revision_failure_local(
    run_dir: Path,
    bad_artifacts: Dict[str, str],
    errors: Dict[str, List[str]],
) -> Path:
    failure_dir = run_dir / "revision_failures"
    failure_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = failure_dir / f"{ts}_revision_failure.json"
    payload = {"timestamp": ts, "errors": errors, "artifacts": bad_artifacts}
    path.write_text(json.dumps(payload, indent=2))
    return path


def _save_codegen_failure_local(
    run_dir: Path,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    retry_log: List[Dict],
    final_errors: Dict[str, List[str]],
    token_totals: Dict[str, Tuple[int, int]],
    plan: Optional[Dict[str, Any]] = None,
) -> Path:
    """
    Persist the LAST-attempt artifacts and the full retry trail when codegen
    static validation fails after `_MAX_CODEGEN_RETRIES` attempts.

    Without this, the failed-attempt code lives only in memory and is lost
    when the process exits — leaving the merchant with errors but nothing
    to inspect. The dumped files use the SAME layout as a successful run
    (handler split via `===FILE:===` markers, migration in migrations/,
    single-file widget/admin at the run-dir root) so the same inspection
    workflow applies to a failed run. `plan` is forwarded so the saved
    widget.js / admin_ui.js get the same `__PLATFORM_CATALOG__` prelude
    the deployed bundles get.

    Returns the path to the validation_failure.json summary so the caller
    can print it to the merchant.
    """
    # Dump artifacts as proper files — same shape as a successful run.
    # Wrap in try/except so a disk-full / permission error during failure-
    # handling doesn't replace the merchant's "validation failed" output
    # with a Python traceback. We still want the partial state if some
    # writes succeeded.
    try:
        _save_generated_files(run_dir, artifacts, is_storefront, is_admin_ui, plan)
    except OSError as exc:
        _log.warning(
            "could not persist failed-attempt artifacts to %s: %s", run_dir, exc
        )

    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = run_dir / "validation_failure.json"
    payload = {
        "timestamp": ts,
        "phase": "codegen",
        "max_retries": _MAX_CODEGEN_RETRIES,
        "final_errors": final_errors,
        "retry_log": retry_log,
        "token_totals": {k: {"in": v[0], "out": v[1]} for k, v in token_totals.items()},
        "artifact_keys": sorted(artifacts.keys()),
    }
    try:
        path.write_text(json.dumps(payload, indent=2))
    except OSError as exc:
        _log.warning("could not write %s: %s", path, exc)
    return path


def _save_revision_trace(
    run_dir: Path, run_ts: str, slug: str, trace: Dict[str, Any]
) -> Path:
    trace_dir = run_dir / _REVISION_TRACES_SUBDIR
    trace_dir.mkdir(parents=True, exist_ok=True)
    path = trace_dir / f"{run_ts}_{slug}.json"
    path.write_text(json.dumps(trace, indent=2))
    return path


# ── Phase runners ─────────────────────────────────────────────────────────────


def _phase_hld(
    intent: Dict[str, Any], prompt: str, run_dir: Path
) -> Tuple[Dict[str, Any], str, int, int]:
    """
    Run the HLD agent. The legacy architect lives in
    `subagents/architect_agent.py` for reference — this phase now produces
    an HLD plan (schema-agnostic, integration-agnostic). Pydantic-driven
    validation lives inside the agent; no outer retry loop is needed.

    Returns (plan_dict, product_prompt, total_in_tokens, total_out_tokens).
    """
    from cli.chat_local import (
        _DIM,
        _RED,
        _RESET,
        _agent_line,
        _retry_line,
        _spinner,
        _tok_note,
    )

    # Capture the user-side prompt for logging / report inclusion. The
    # agent re-formats this internally; we just record what the operator
    # would have seen.
    product_prompt = (
        f"Merchant request: {prompt}\n\n"
        f"Product-agent intent:\n{json.dumps(intent, indent=2)}"
    )

    def _on_attempt_failed(attempt: int, errors: List[str]) -> None:
        """Surface validator rejections live, instead of letting the
        spinner sit silent for ~30s while the agent retries."""
        first = errors[0] if errors else "validation failed"
        more = f" (+{len(errors) - 1} more)" if len(errors) > 1 else ""
        _agent_line(
            "HLD",
            ok=False,
            ms=None,
            notes=f"attempt {attempt} rejected: {first}{more}",
        )
        for e in errors:
            print(f"    {_DIM}• {e}{_RESET}")
        _retry_line("HLD", notes=f"retry attempt {attempt + 1}")
        _spinner("HLD")

    _spinner("HLD")
    t0 = time.monotonic()
    try:
        with input_log("hld", run_dir):
            plan, hld_in, hld_out = run_hld_agent(
                prompt=prompt,
                intent=intent,
                on_attempt_failed=_on_attempt_failed,
            )
    except HLDValidationError as err:
        ms = int((time.monotonic() - t0) * 1000)
        _agent_line(
            "HLD",
            ok=False,
            ms=ms,
            notes=f"failed after {err.attempts} attempt(s)  "
            + _tok_note(err.in_tokens, err.out_tokens),
        )
        print(f"\n  {_RED}HLD failed after {err.attempts} attempts:{_RESET}")
        for e in err.errors:
            print(f"    • {e}")
        sys.exit(1)

    ms = int((time.monotonic() - t0) * 1000)
    _agent_line(
        "HLD",
        ok=True,
        ms=ms,
        notes=_tok_note(hld_in, hld_out),
    )

    if plan.get("feasibility") == "blocked":
        blocked_reason = plan.get(
            "blockedReason",
            "This app requires capabilities that aren't available on the platform yet.",
        )
        print(f"\n  {_RED}Platform limitation:{_RESET} {blocked_reason}")
        sys.exit(1)

    return plan, product_prompt, hld_in, hld_out


def _phase_codegen(
    base_ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
    run_dir: Path,
    *,
    prior_artifacts: Optional[Dict[str, str]] = None,
    prior_error_map: Optional[Dict[str, List[str]]] = None,
    prior_retry_log: Optional[List[Dict]] = None,
    prior_token_totals: Optional[Dict[str, Tuple[int, int]]] = None,
) -> Tuple[Dict[str, str], List[Dict], Dict[str, Tuple[int, int]]]:
    """
    Run parallel codegen with static validation retries.

    Returns (artifacts, retry_log, token_totals) where:
      retry_log    — list of {attempt, errors} dicts for every failed round
      token_totals — {agent_name: (total_in, total_out)} accumulated across all attempts

    Resume path: when `prior_artifacts` / `prior_error_map` are passed, the
    first iteration starts from that state instead of the empty dicts. The
    crew's `_plan_codegen_batch` already short-circuits any generator whose
    artifact is present and has no errors, so passing the saved bundle from
    a previous run is the entire mechanism for "skip handler/widget/admin if
    they already passed". `prior_retry_log` and `prior_token_totals` carry
    the audit trail forward so a resumed run's report.md / per-agent token
    summary reflects the cumulative cost, not just this resumed segment.
    """
    from cli.chat_local import (
        _DIM,
        _RED,
        _RESET,
        _agent_line,
        _finish_slot,
        _retry_line,
        _save_state,
        _spinner,
        _spinner_group,
        _stop_spinner_group,
        _tok_note,
    )

    artifacts: Dict[str, str] = dict(prior_artifacts or {})
    error_map: Dict[str, List[str]] = {
        k: list(v) for k, v in (prior_error_map or {}).items()
    }
    cumulative_errors: Dict[str, List[str]] = {}
    retry_log: List[Dict] = list(prior_retry_log or [])
    token_totals: Dict[str, Tuple[int, int]] = dict(prior_token_totals or {})

    _CODEGEN_LABELS = {
        "handler": "Handler",
        "migration": "Migration",
        "widget_js": "Widget JS",
        "admin_ui": "Admin UI",
    }

    # Resume case: when prior_artifacts arrives with an error_map (codegen
    # was halted mid-pipeline), the first attempt should display only the
    # failed/missing generators in the spinner — same as a normal retry —
    # rather than spinning rows for handler/migration/widget/admin and
    # never advancing the ones that won't run. The crew already filters
    # correctly via _plan_codegen_batch; this is purely the label list.
    _is_resumed_first = prior_artifacts and (
        prior_error_map
        or any(
            n not in artifacts
            for n in (
                ["handler", "migration"]
                + (["widget_js"] if is_storefront else [])
                + (["admin_ui"] if is_admin_ui else [])
            )
        )
    )

    for attempt in range(1, _MAX_CODEGEN_RETRIES + 1):
        if attempt > 1 or _is_resumed_first:
            generators_this_round = list(error_map.keys()) or [
                n
                for n in (
                    ["handler", "migration"]
                    + (["widget_js"] if is_storefront else [])
                    + (["admin_ui"] if is_admin_ui else [])
                )
                if n not in artifacts
            ]
        else:
            generators_this_round = (
                ["handler", "migration"]
                + (["widget_js"] if is_storefront else [])
                + (["admin_ui"] if is_admin_ui else [])
            )
        # After the first iteration we don't want this resume-mode label
        # filter to keep firing — clear it so subsequent retries follow
        # the normal `attempt > 1 → error_map.keys()` path.
        _is_resumed_first = False

        labels = [_CODEGEN_LABELS.get(n, n) for n in generators_this_round]
        # Start one animated row per parallel generator so the merchant sees
        # all three racing, not just the last _spinner call.
        _spinner_group(labels)

        # Map crew-side internal names → CLI labels for the callback.
        label_of = {n: _CODEGEN_LABELS.get(n, n) for n in generators_this_round}

        # Callbacks fire on worker threads the instant each generator
        # finishes — the group's redraw loop picks up the slot transition
        # on its next tick.
        def _on_done(
            name: str,
            ms_agent: int,
            in_tok: int,
            out_tok: int,
            _attempt: int = attempt,
        ) -> None:
            retry_sfx = f"  retry {_attempt}" if _attempt > 1 else ""
            tok_str = (
                _tok_note(in_tok, out_tok, extra=retry_sfx)
                if (in_tok or out_tok)
                else retry_sfx.strip()
            )
            _agent_line(label_of.get(name, name), ok=True, ms=ms_agent, notes=tok_str)

        # The agent name "codegen" here is a placeholder — workers in
        # run_codegen_parallel re-enter input_log() with codegen_<gen> per
        # generator, so individual prompts land in inputs/codegen_handler/,
        # inputs/codegen_migration/, etc., not under a shared dir.
        with input_log("codegen", run_dir):
            artifacts, attempt_tokens = run_codegen_parallel(
                base_ctx,
                is_storefront=is_storefront,
                is_admin_ui=is_admin_ui,
                error_map=error_map,
                cumulative_errors=cumulative_errors,
                artifacts=artifacts,
                on_done=_on_done,
            )

        # Accumulate token totals across retries
        for name, (in_t, out_t) in attempt_tokens.items():
            prev_in, prev_out = token_totals.get(name, (0, 0))
            token_totals[name] = (prev_in + in_t, prev_out + out_t)

        _spinner("Validation")
        t0 = time.monotonic()
        error_map = validate_artifacts(artifacts, base_ctx, is_storefront, is_admin_ui)
        ms_val = int((time.monotonic() - t0) * 1000)

        if not error_map:
            _agent_line("Validation", ok=True, ms=ms_val, notes="all artifacts pass")
            _save_state(
                run_dir,
                checkpoint="codegen",
                halt_reason=None,
                artifacts=artifacts,
                retry_log=retry_log,
                codegen_token_totals={k: list(v) for k, v in token_totals.items()},
                codegen_error_map=None,
                handler_email_metadata=base_ctx.handler_email_metadata,
                handler_raw_response=base_ctx.handler_raw_response,
            )
            return artifacts, retry_log, token_totals

        for name, errs in error_map.items():
            existing = cumulative_errors.setdefault(name, [])
            for err in errs:
                if err not in existing:
                    existing.append(err)

        retry_log.append(
            {
                "attempt": attempt,
                "errors": {gen: list(errs) for gen, errs in error_map.items()},
            }
        )

        failed_summary = ", ".join(error_map.keys())
        _agent_line(
            "Validation",
            ok=False,
            ms=ms_val,
            notes=f"{len(error_map)} artifact(s) failed: {failed_summary}",
        )
        for gen_name, errs in error_map.items():
            for e in errs:
                print(f"    {_DIM}• {gen_name}: {e}{_RESET}")

        if attempt < _MAX_CODEGEN_RETRIES:
            _retry_line("Validation", notes=f"fixing {failed_summary}")

    # All retries exhausted. Persist whatever the last attempt produced —
    # the artifacts live only in this stack frame and would otherwise be
    # lost when sys.exit(1) runs, leaving the merchant with errors but
    # nothing to inspect. Dump in the same shape as a successful run so
    # the same workflow (open files in IDE, diff against prior run, etc.)
    # works for failures too.
    failure_path = _save_codegen_failure_local(
        run_dir,
        artifacts,
        is_storefront,
        is_admin_ui,
        retry_log,
        error_map,
        token_totals,
        plan=base_ctx.plan,
    )

    # Persist partial state so the run is resumable. checkpoint stays at
    # "arch" (the last phase that fully succeeded); halt_reason flags this
    # as a codegen failure so --resume re-runs codegen and the crew's
    # batch planner re-runs only the failed/missing generators.
    _save_state(
        run_dir,
        checkpoint="arch",
        halt_reason="codegen_failed",
        artifacts=artifacts,
        retry_log=retry_log,
        codegen_token_totals={k: list(v) for k, v in token_totals.items()},
        codegen_error_map={k: list(v) for k, v in error_map.items()},
        handler_email_metadata=base_ctx.handler_email_metadata,
        handler_raw_response=base_ctx.handler_raw_response,
    )

    all_errors = [f"{n}: {e}" for n, errs in error_map.items() for e in errs]
    print(
        f"\n  {_RED}Codegen validation failed after {_MAX_CODEGEN_RETRIES} attempts:{_RESET}"
    )
    for e in all_errors[:5]:
        print(f"    • {e}")
    print(
        f"\n  {_DIM}Final-attempt artifacts saved to: "
        f"{run_dir.relative_to(_HERE)}/{_RESET}"
    )
    print(f"  {_DIM}Validation summary: {failure_path.relative_to(_HERE)}{_RESET}")
    print(
        f"  {_DIM}Resume with:  python chat_local.py --resume "
        f"{run_dir.name}{_RESET}"
    )
    sys.exit(1)


def _phase_validator(
    base_ctx: CodegenContext,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    run_dir: Path,
    run_ts: str,
    run_slug: str,
    *,
    resumed_validator: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, str], int, int, Optional[Dict[str, Any]]]:
    """
    Run LLM validator + optional revision pass.

    The revision agent fixes only widget_js / admin_ui (handler and migration are
    locked as read-only context). Revision output is statically validated; if both
    attempts fail the run exits with an error and saves the bad artifacts.

    Returns (artifacts, total_in_tokens, total_out_tokens, trace). `trace` is None
    when no revision was attempted (validator skipped or passed on first pass); a
    dict otherwise, always persisted to test_results/revision_traces/ keyed by
    run_ts + slug so the report .md can link to it.

    Resume path: when `resumed_validator` is passed, the LLM validator call is
    skipped entirely — we trust the saved issues from the previous run and go
    straight to revision. This is the cost-saver: validator tokens already paid,
    don't pay them again. Required keys: `issues`, `in_tokens`, `out_tokens`,
    `duration_ms`. Token counts are reported back so the run summary still shows
    the original cost; they are NOT re-added to `total_in/out` here because the
    caller credits them separately for resumed runs.
    """
    from config import get_settings

    from cli.chat_local import (
        _DIM,
        _RED,
        _RESET,
        _agent_line,
        _info,
        _save_state,
        _spinner,
        _tok_note,
    )

    if resumed_validator is not None:
        # Skip the validator LLM call — reuse saved issues. Falls through to
        # the revision branch below using `issues` from saved state.
        issues = resumed_validator.get("issues") or []
        val_in = int(resumed_validator.get("in_tokens", 0))
        val_out = int(resumed_validator.get("out_tokens", 0))
        ms = int(resumed_validator.get("duration_ms", 0))
        _info(
            f"Validator: reusing {len(issues)} saved issue(s) from prior run "
            f"(no LLM call)"
        )
    elif not get_settings().llm_validation_enabled:
        _info("Validator skipped (LLM_VALIDATION_ENABLED not set)")
        _save_state(
            run_dir,
            checkpoint="validator",
            halt_reason=None,
            validator_issues=[],
            validator_tokens={"in": 0, "out": 0, "duration_ms": 0},
            pre_revision_artifacts=dict(artifacts),
        )
        return artifacts, 0, 0, None
    else:
        _spinner("Validator")
        t0 = time.monotonic()
        with input_log("validator", run_dir):
            issues, val_in, val_out, per_validator = run_llm_validators(
                artifacts, base_ctx, is_storefront, is_admin_ui
            )
        ms = int((time.monotonic() - t0) * 1000)
        # Surface per-validator latency / errors so a silent fail-open is
        # visible in the local CLI run, not just the production logs. Only
        # available when we actually invoked the validator — resumed runs
        # skip this since the per-validator breakdown wasn't persisted.
        for name, result in per_validator.items():
            suffix = f" error={result.error}" if result.error else ""
            _info(
                f"  ↳ {name}: {result.latency_ms}ms "
                f"in={result.input_tokens} out={result.output_tokens} "
                f"findings={len(result.findings)}{suffix}"
            )

    if not issues:
        _agent_line(
            "Validator",
            ok=True,
            ms=ms,
            notes=_tok_note(val_in, val_out, extra="semantic check passed"),
        )
        _save_state(
            run_dir,
            checkpoint="validator",
            halt_reason=None,
            validator_issues=[],
            validator_tokens={"in": val_in, "out": val_out, "duration_ms": ms},
            pre_revision_artifacts=dict(artifacts),
        )
        return artifacts, val_in, val_out, None

    issue_summary = ", ".join(i["question"] for i in issues)
    _agent_line(
        "Validator",
        ok=True,
        ms=ms,
        notes=_tok_note(
            val_in, val_out, extra=f"{len(issues)} issue(s): {issue_summary}"
        ),
    )
    # Print each issue fully, wrapped at terminal width with indented
    # continuation lines. The previous [:80] cap silently truncated
    # issue messages mid-sentence, hiding the actual diagnosis.
    term_w = max(60, shutil.get_terminal_size((100, 20)).columns)
    initial_indent = "    • "
    subsequent_indent = "      "
    for iss in issues:
        header = f"{iss.get('question', '?')}: {iss.get('issue', '')}"
        wrapped = textwrap.fill(
            header,
            width=term_w,
            initial_indent=initial_indent,
            subsequent_indent=subsequent_indent,
            break_long_words=False,
            break_on_hyphens=False,
        )
        print(f"{_DIM}{wrapped}{_RESET}")

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

    # Accumulate a trace that gets persisted no matter which branch we exit on.
    trace: Dict[str, Any] = {
        "run_ts": run_ts,
        "slug": run_slug,
        "validator": {
            "duration_ms": ms,
            "in_tokens": val_in,
            "out_tokens": val_out,
            "issues": issues,
        },
        "locked_artifacts": sorted(_LOCKED),
        "pre_artifacts": dict(artifacts),
        "attempts": [],
        "final_outcome": None,
    }

    # Persist the validator findings + pre-revision artifacts up front. If
    # the process is killed mid-revision (or revision punts), --resume picks
    # this up and re-runs only revision against the saved issues, NOT the
    # validator — that's the point of trusting saved issues.
    _save_state(
        run_dir,
        validator_issues=issues,
        validator_tokens={"in": val_in, "out": val_out, "duration_ms": ms},
        pre_revision_artifacts=dict(artifacts),
    )

    def _finalize(
        outcome: str, *, final_artifacts: Optional[Dict[str, str]] = None
    ) -> None:
        trace["final_outcome"] = outcome
        _save_revision_trace(run_dir, run_ts, run_slug, trace)
        # halt_reason is set only for outcomes the user can resume from.
        # 'resolved' / 'resolved_on_retry' are clean successes — checkpoint
        # advances to 'revision' and resume goes straight to explanation.
        if outcome in ("resolved", "resolved_on_retry"):
            cp, halt = "revision", None
        elif outcome == "kept_originals":
            cp, halt = "validator", "kept_originals"
        else:  # "failed"
            cp, halt = "validator", "revision_failed"
        patch: Dict[str, Any] = {
            "checkpoint": cp,
            "halt_reason": halt,
            "revision_outcome": outcome,
        }
        if final_artifacts is not None:
            patch["artifacts"] = final_artifacts
        _save_state(run_dir, **patch)

    _spinner("Revision")
    t0 = time.monotonic()
    with input_log("revision", run_dir):
        revised, rev_in, rev_out = run_revision_agent(
            revision_ctx,
            is_storefront=is_storefront,
            is_admin_ui=is_admin_ui,
            validation_issues=issues,
            locked_artifacts=_LOCKED,
        )
    ms = int((time.monotonic() - t0) * 1000)

    total_in = val_in + rev_in
    total_out = val_out + rev_out

    frontend_revised = {k: v for k, v in revised.items() if k not in _LOCKED}
    trace["attempts"].append(
        {
            "attempt": 1,
            "duration_ms": ms,
            "in_tokens": rev_in,
            "out_tokens": rev_out,
            "returned_artifacts": sorted(frontend_revised.keys()),
            "post": frontend_revised,
            "static_errors": {},
            "outcome": None,
        }
    )

    if not frontend_revised:
        _agent_line(
            "Revision",
            ok=False,
            ms=ms,
            notes=_tok_note(
                rev_in,
                rev_out,
                extra="no frontend artifacts returned — keeping originals",
            ),
        )
        trace["attempts"][-1]["outcome"] = "no_output"
        _finalize("kept_originals", final_artifacts=dict(artifacts))
        return artifacts, total_in, total_out, trace

    # Statically validate the revised frontend artifacts before accepting them.
    merged = {**artifacts, **frontend_revised}
    all_errors = validate_artifacts(merged, revision_ctx, is_storefront, is_admin_ui)
    static_errors: Dict[str, List[str]] = {
        k: v for k, v in all_errors.items() if k in frontend_revised
    }

    if not static_errors:
        _agent_line(
            "Revision",
            ok=True,
            ms=ms,
            notes=_tok_note(rev_in, rev_out, extra="semantic issues resolved"),
        )
        trace["attempts"][-1]["outcome"] = "accepted"
        _finalize("resolved", final_artifacts=dict(merged))
        return merged, total_in, total_out, trace

    # First revision failed static validation — retry once with errors fed back.
    trace["attempts"][-1]["static_errors"] = static_errors
    trace["attempts"][-1]["outcome"] = "retrying"
    _agent_line(
        "Revision",
        ok=False,
        ms=ms,
        notes=_tok_note(
            rev_in,
            rev_out,
            extra=f"static validation failed ({len(static_errors)} artifact(s)) — retrying",
        ),
    )
    for gen_name, errs in static_errors.items():
        for e in errs:
            print(f"    {_DIM}• [{gen_name}] {e[:80]}{_RESET}")

    _spinner("Revision (static retry)")
    t0 = time.monotonic()
    # Reusing agent="revision" — _dump_inputs counts existing attempt_* dirs
    # so this lands in inputs/revision/attempt_2/ alongside attempt_1/.
    with input_log("revision", run_dir):
        revised2, rev2_in, rev2_out = run_revision_agent(
            revision_ctx,
            is_storefront=is_storefront,
            is_admin_ui=is_admin_ui,
            validation_issues=issues,
            locked_artifacts=_LOCKED,
            static_errors=static_errors,
        )
    ms2 = int((time.monotonic() - t0) * 1000)

    total_in += rev2_in
    total_out += rev2_out

    frontend_revised2 = {k: v for k, v in revised2.items() if k not in _LOCKED}
    merged2 = {**artifacts, **frontend_revised2}
    all_errors2 = validate_artifacts(merged2, revision_ctx, is_storefront, is_admin_ui)
    static_errors2: Dict[str, List[str]] = {
        k: v for k, v in all_errors2.items() if k in frontend_revised2
    }

    trace["attempts"].append(
        {
            "attempt": 2,
            "duration_ms": ms2,
            "in_tokens": rev2_in,
            "out_tokens": rev2_out,
            "returned_artifacts": sorted(frontend_revised2.keys()),
            "post": frontend_revised2,
            "static_errors": static_errors2,
            "outcome": None,
        }
    )

    if not static_errors2:
        _agent_line(
            "Revision",
            ok=True,
            ms=ms2,
            notes=_tok_note(
                rev2_in, rev2_out, extra="semantic issues resolved (static retry)"
            ),
        )
        trace["attempts"][-1]["outcome"] = "accepted"
        _finalize("resolved_on_retry", final_artifacts=dict(merged2))
        return merged2, total_in, total_out, trace

    # Both revision attempts produced structurally invalid code — fail the run.
    trace["attempts"][-1]["outcome"] = "failed"
    # Don't pass final_artifacts here — we want the next --resume to start
    # from the pre-revision artifacts (saved separately as
    # `pre_revision_artifacts`), NOT the broken merged2 bundle. Re-running
    # revision against the broken output would compound the damage.
    _finalize("failed")
    bad = {**frontend_revised, **frontend_revised2}
    path = _save_revision_failure_local(run_dir, bad, static_errors2)
    # Also dump the final merged bundle as proper files at the run-dir root
    # — same shape as a successful run, so the merchant can open the broken
    # widget.js / admin_ui.js in their editor instead of fishing them out
    # of a JSON blob.
    _save_generated_files(
        run_dir, merged2, is_storefront, is_admin_ui, plan=revision_ctx.plan
    )
    _agent_line(
        "Revision",
        ok=False,
        ms=ms2,
        notes=_tok_note(
            rev2_in, rev2_out, extra="static validation failed after 2 attempts"
        ),
    )
    print(
        f"\n  {_RED}Revision agent produced structurally invalid code after 2 attempts.{_RESET}"
    )
    for gen_name, errs in static_errors2.items():
        for e in errs:
            print(f"    • [{gen_name}] {e}")
    print(f"  {_DIM}Failure summary: {path.relative_to(_HERE)}{_RESET}")
    print(
        f"  {_DIM}Final-attempt artifacts saved to: "
        f"{run_dir.relative_to(_HERE)}/{_RESET}"
    )
    print(
        f"  {_DIM}Resume with:  python chat_local.py --resume "
        f"{run_dir.name}{_RESET}"
    )
    sys.exit(1)


def _phase_explanation(
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    artifacts: Dict[str, str],
    is_storefront: bool,
    run_dir: Path,
) -> Tuple[Dict[str, Any], int, int]:
    """
    Run the explanation agent and return (explanation_dict, in_tokens, out_tokens).

    Pure pipeline phase — no resume / state handling. The orchestrator decides
    whether to call this (currently always called once codegen + validator
    succeed; not gated by `--stop-after`).
    """
    from cli.chat_local import _agent_line, _spinner, _tok_note

    _spinner("Explanation")
    t0 = time.monotonic()
    with input_log("explanation", run_dir):
        explanation, exp_in, exp_out = run_explanation_agent(
            intent=intent,
            plan=plan,
            widget_js_code=artifacts.get("widget_js", "") if is_storefront else "",
            migration_sql=artifacts.get("migration", ""),
        )
    ms = int((time.monotonic() - t0) * 1000)
    _agent_line("Explanation", ok=True, ms=ms, notes=_tok_note(exp_in, exp_out))
    return explanation, exp_in, exp_out
