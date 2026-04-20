#!/usr/bin/env python3
"""
Interactive chat CLI — mirrors the platform's chat page experience.

Runs the multi-turn product agent clarification loop, then shows the
component picker (Backend / Widget / Admin UI), then runs the generation
pipeline phase by phase. Use --stop-after to halt at a specific phase.

USAGE
-----
  python chat_local.py                        # full pipeline
  python chat_local.py --stop-after arch      # product + architect only, prints plan
  python chat_local.py --stop-after codegen   # + codegen + static validation
  python chat_local.py --stop-after validator # + LLM validator + revision pass

OUTPUT
------
  Console: live per-agent progress lines with token counts
  File (stop-after=arch):     test_results/<ts>_<slug>_arch.json
  File (stop-after=codegen/validator or full): test_results/<ts>_<slug>.md
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import shutil
import sys
import textwrap
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

_HERE = Path(__file__).resolve().parent
_GENERATOR_ROOT = _HERE.parent
os.chdir(_GENERATOR_ROOT)
sys.path.insert(0, str(_GENERATOR_ROOT))
sys.path.insert(0, str(_HERE))  # allow importing cli/db_local

# Redirect all generator logs to file — keeps the terminal output clean
import logging as _log
(_HERE / "test_results").mkdir(exist_ok=True)
_log.basicConfig(
    handlers=[_log.FileHandler(_HERE / "test_results" / "generation.log")],
    level=_log.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    force=True,
)

from shopify_mcp.client import prefetch_for_run
from subagents.architect_agent import run_architect_agent, _ARCHITECT_USER_TEMPLATE
from subagents.base import CodegenContext
from subagents.explanation_agent import run_explanation_agent
from subagents.product_agent import run_product_agent_analyze
from subagents.revision_agent import run_revision_agent
from subagents.static_validation import validate_architect_plan
from subagents.validator_agent import run_validator_agent
from crews.feature_generator.crew import (
    run_codegen_parallel,
    validate_artifacts,
    _revision_locked_artifacts,
)

TEST_RESULTS_DIR = _HERE / "test_results"
_MAX_ARCH_ATTEMPTS = 2   # matches crew.py
_MAX_CODEGEN_RETRIES = 3  # matches crew.py _MAX_RETRIES

StopAfter = Literal["arch", "codegen", "validator", "full"]

# ── Display helpers ────────────────────────────────────────────────────────────

_W = 80
_RESET  = "\033[0m"
_BOLD   = "\033[1m"
_DIM    = "\033[2m"
_CYAN   = "\033[36m"
_GREEN  = "\033[32m"
_YELLOW = "\033[33m"
_RED    = "\033[31m"


def _hr(char: str = "─") -> None:
    print(_DIM + char * _W + _RESET)


def _bot(text: str) -> None:
    print(f"\n{_CYAN}{_BOLD}Ton{_RESET}  {text}\n")


def _info(text: str) -> None:
    print(f"  {_DIM}{text}{_RESET}")


def _agent_line(name: str, ok: bool, ms: Optional[int], notes: str = "") -> None:
    icon   = f"{_GREEN}✓{_RESET}" if ok else f"{_RED}✗{_RESET}"
    timing = f"{ms}ms" if ms is not None else "—"
    line   = f"  {name:<14} {icon}  {_DIM}{timing:<8}{_RESET}  {notes}".rstrip()
    print(f"\r{line:<{_W}}")


def _spinner(name: str) -> None:
    print(f"\r  {name:<14} {_DIM}…{_RESET}", end="", flush=True)


def _retry_line(name: str, notes: str) -> None:
    line = f"  {name:<14} {_YELLOW}↻{_RESET}  {'':8}  {_DIM}{notes[:60]}{_RESET}".rstrip()
    print(f"\r{line:<{_W}}")


def _ktok(n: int) -> str:
    """Format token count as e.g. '2.4k' or '850'."""
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def _tok_note(in_tok: int, out_tok: int, extra: str = "") -> str:
    """'in=2.4k out=0.8k' — append extra if provided."""
    base = f"in={_ktok(in_tok)} out={_ktok(out_tok)}"
    return f"{base}  {extra}" if extra else base


# ── Clarification loop ─────────────────────────────────────────────────────────


def _ask_user(prompt_text: str) -> str:
    try:
        return input(prompt_text).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)


def _clarify(history: List[Dict[str, str]]) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    """
    Drive the multi-turn product agent until it returns status='ready'.
    Accepts an existing history (so clarification can be resumed after a 'ready' response).
    Returns (intent, updated_history) — history includes the final assistant 'ready' turn.
    """
    while True:
        _info("thinking…")
        response = run_product_agent_analyze(history)
        status = response.get("status")

        if status == "ready":
            summary = response.get("summary", "")
            _bot(summary)
            history = history + [{"role": "assistant", "content": json.dumps(response)}]
            return response.get("intent") or {}, history

        if status == "needs_clarification":
            question    = response.get("question", "")
            suggestions = response.get("suggestions") or []
            _bot(question)
            if suggestions:
                for i, s in enumerate(suggestions, 1):
                    print(f"  {_DIM}[{i}]{_RESET} {s}")
                print()
                _info("Pick a number or type your own answer.")
        else:
            _bot("Could you rephrase your request?")
            suggestions = []

        user_input = _ask_user(f"\n{_BOLD}You{_RESET}  ")
        if not user_input:
            continue

        if suggestions and user_input.isdigit():
            idx = int(user_input) - 1
            if 0 <= idx < len(suggestions):
                user_input = suggestions[idx]
                _info(f"→ {user_input}")

        history = history + [
            {"role": "assistant", "content": json.dumps(response)},
            {"role": "user",      "content": user_input},
        ]


# ── Component picker ───────────────────────────────────────────────────────────
#
# Mirrors the ConfirmCard component in ChatMessages.tsx:
#   - Backend is always locked/on
#   - Widget and Admin UI can be toggled
#   - If merchant adds a component the AI didn't suggest, a description is required
#   - "Change request" returns None → caller loops back to clarification


def _pick_components(intent: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Terminal equivalent of the web ConfirmCard component picker.
    Returns updated intent dict, or None if user chose "Change request".
    """
    archetype      = intent.get("appCategory", "backend")
    ai_has_widget  = archetype in ("storefront_backend",       "storefront_backend_admin")
    ai_has_admin   = archetype in ("storefront_backend_admin", "backend_admin")

    has_widget  = ai_has_widget
    has_admin   = ai_has_admin
    widget_desc = ""
    admin_desc  = ""

    def _render() -> None:
        _hr()
        print(f"\n  {_BOLD}COMPONENTS{_RESET}\n")

        # Backend — always on, locked
        print(f"  {_GREEN}[✓]{_RESET} Backend             {_DIM}(always included){_RESET}")

        # Widget
        if has_widget:
            tag = f"{_DIM}AI suggested{_RESET}" if ai_has_widget else f"{_YELLOW}you added{_RESET}"
            print(f"  {_GREEN}[✓]{_RESET} Storefront Widget   {tag}")
            if has_widget and not ai_has_widget and widget_desc:
                print(f"      {_DIM}└ {widget_desc}{_RESET}")
        else:
            print(f"  {_DIM}[ ]{_RESET} Storefront Widget")

        # Admin UI
        if has_admin:
            tag = f"{_DIM}AI suggested{_RESET}" if ai_has_admin else f"{_YELLOW}you added{_RESET}"
            print(f"  {_GREEN}[✓]{_RESET} Admin UI            {tag}")
            if has_admin and not ai_has_admin and admin_desc:
                print(f"      {_DIM}└ {admin_desc}{_RESET}")
        else:
            print(f"  {_DIM}[ ]{_RESET} Admin UI")

        print()
        print(f"  {_DIM}Backend is always included. Toggle optional components.{_RESET}")
        print(
            f"  {_DIM}w{_RESET} = Widget   "
            f"{_DIM}a{_RESET} = Admin   "
            f"{_DIM}↵{_RESET} = Generate   "
            f"{_DIM}c{_RESET} = Change request"
        )
        print()

    while True:
        _render()
        cmd = _ask_user(f"{_BOLD}Choice{_RESET}  ").strip().lower()

        if cmd == "w":
            has_widget = not has_widget
            if not has_widget:
                widget_desc = ""

        elif cmd == "a":
            has_admin = not has_admin
            if not has_admin:
                admin_desc = ""

        elif cmd in ("c", "change", "change request"):
            return None

        elif cmd in ("", "g", "generate"):
            # Mandatory description when merchant adds a component the AI didn't suggest
            if has_widget and not ai_has_widget and not widget_desc:
                _bot("You added Storefront Widget — what should it display?")
                _info("e.g. show loyalty points balance on the product page")
                desc = _ask_user(f"\n{_BOLD}You{_RESET}  ")
                if not desc.strip():
                    _info("Description required to add the Widget.")
                    continue
                widget_desc = desc.strip()

            if has_admin and not ai_has_admin and not admin_desc:
                _bot("You added Admin UI — what should it manage?")
                _info("e.g. dashboard to configure reward tiers and view analytics")
                desc = _ask_user(f"\n{_BOLD}You{_RESET}  ")
                if not desc.strip():
                    _info("Description required to add the Admin UI.")
                    continue
                admin_desc = desc.strip()

            break

    # Resolve updated appCategory
    cat = (
        "storefront_backend_admin" if has_widget and has_admin else
        "storefront_backend"       if has_widget else
        "backend_admin"            if has_admin  else
        "backend"
    )
    updated: Dict[str, Any] = {**intent, "appCategory": cat}
    if has_widget and not ai_has_widget and widget_desc:
        updated["widgetDescription"] = widget_desc
    if has_admin and not ai_has_admin and admin_desc:
        updated["adminDescription"] = admin_desc
    return updated


# ── Phase runners ──────────────────────────────────────────────────────────────


def _phase_architect(
    intent: Dict[str, Any], prompt: str
) -> Tuple[Dict[str, Any], str, str, int, int]:
    """
    Run product prefetch + architect with validation retry.
    Returns (plan, api_context, arch_prompt, total_in_tokens, total_out_tokens).
    """
    archetype = intent.get("appCategory", "")

    _spinner("Prefetch")
    t0 = time.monotonic()
    api_context = prefetch_for_run(intent.get("resources", []), intent.get("desiredOutcome", ""))
    ms = int((time.monotonic() - t0) * 1000)
    docs_chars   = len(api_context) if api_context else 0
    prefetch_notes = f"docs: {docs_chars} chars" if docs_chars else "docs: empty (MCP miss)"
    _agent_line("Prefetch", ok=True, ms=ms, notes=prefetch_notes)

    api_context_section = (
        f"\nShopify API context (webhook payload shapes, resource fields — use as ground truth):\n{api_context}\n"
        if api_context else ""
    )

    quality_brief = intent.get("qualityBrief", "")
    quality_brief_section = (
        f"\nQuality brief (use this to inform edgeCases and uxExpectations):\n{quality_brief}\n"
        if quality_brief else ""
    )

    comp_parts = []
    if intent.get("widgetDescription"):
        comp_parts.append(f"  Widget (merchant-added): {intent['widgetDescription']}")
    if intent.get("adminDescription"):
        comp_parts.append(f"  Admin panel (merchant-added): {intent['adminDescription']}")
    component_descriptions_section = (
        "\nMerchant-provided component descriptions (components added beyond the AI suggestion — "
        "incorporate these requirements into the contracts):\n"
        + "\n".join(comp_parts) + "\n"
        if comp_parts else ""
    )

    product_prompt = _ARCHITECT_USER_TEMPLATE.format(
        error_block="",
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
        archetype=archetype,
        quality_brief_section=quality_brief_section,
        component_descriptions_section=component_descriptions_section,
        api_context_section=api_context_section,
    )

    plan: Dict[str, Any] = {}
    errors: List[str] = []
    total_in = total_out = 0

    for attempt in range(1, _MAX_ARCH_ATTEMPTS + 1):
        _spinner("Architect")
        t0 = time.monotonic()
        plan, arch_in, arch_out = run_architect_agent(
            prompt=prompt,
            intent=intent,
            app_archetype=archetype,
            api_context=api_context,
            validation_errors=errors if attempt > 1 else None,
        )
        ms = int((time.monotonic() - t0) * 1000)
        total_in  += arch_in
        total_out += arch_out
        errors = validate_architect_plan(plan, app_archetype=archetype)

        if not errors:
            attempt_note = f"attempt {attempt}  " if attempt > 1 else ""
            _agent_line("Architect", ok=True, ms=ms,
                        notes=attempt_note + _tok_note(total_in, total_out))
            contracts = plan.get("appContracts") or {}
            if contracts.get("feasibility") == "blocked":
                blocked_reason = contracts.get(
                    "blockedReason",
                    "This app requires capabilities that aren't available on the platform yet.",
                )
                print(f"\n  {_RED}Platform limitation:{_RESET} {blocked_reason}")
                sys.exit(1)
            return plan, api_context, product_prompt, total_in, total_out

        _agent_line("Architect", ok=False, ms=ms,
                    notes=f"attempt {attempt} — {len(errors)} error(s)  " + _tok_note(arch_in, arch_out))
        if attempt < _MAX_ARCH_ATTEMPTS:
            _retry_line("Architect", notes="; ".join(errors[:2]))

    print(f"\n  {_RED}Architect failed after {_MAX_ARCH_ATTEMPTS} attempts:{_RESET}")
    for e in errors:
        print(f"    • {e}")
    sys.exit(1)


def _phase_codegen(
    base_ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> Tuple[Dict[str, str], List[Dict], Dict[str, Tuple[int, int]]]:
    """
    Run parallel codegen with static validation retries.

    Returns (artifacts, retry_log, token_totals) where:
      retry_log    — list of {attempt, errors} dicts for every failed round
      token_totals — {agent_name: (total_in, total_out)} accumulated across all attempts
    """
    artifacts: Dict[str, str] = {}
    error_map: Dict[str, List[str]] = {}
    cumulative_errors: Dict[str, List[str]] = {}
    retry_log: List[Dict] = []
    token_totals: Dict[str, Tuple[int, int]] = {}

    _CODEGEN_LABELS = {
        "handler":   "Handler",
        "migration": "Migration",
        "widget_js": "Widget JS",
        "admin_ui":  "Admin UI",
    }

    for attempt in range(1, _MAX_CODEGEN_RETRIES + 1):
        generators_this_round = (
            list(error_map.keys()) if attempt > 1 else
            ["handler", "migration"]
            + (["widget_js"] if is_storefront else [])
            + (["admin_ui"]  if is_admin_ui   else [])
        )

        for name in generators_this_round:
            label = _CODEGEN_LABELS.get(name, name)
            if attempt > 1:
                top_err = (error_map.get(name) or ["unknown error"])[0]
                _retry_line(label, notes=top_err[:60])
            _spinner(label)

        t0 = time.monotonic()
        artifacts, attempt_tokens = run_codegen_parallel(
            base_ctx,
            is_storefront=is_storefront,
            is_admin_ui=is_admin_ui,
            error_map=error_map,
            cumulative_errors=cumulative_errors,
            artifacts=artifacts,
        )
        ms = int((time.monotonic() - t0) * 1000)

        # Accumulate token totals across retries
        for name, (in_t, out_t) in attempt_tokens.items():
            prev_in, prev_out = token_totals.get(name, (0, 0))
            token_totals[name] = (prev_in + in_t, prev_out + out_t)

        # Print a completed line for each generator that ran this round
        for i, name in enumerate(generators_this_round):
            label  = _CODEGEN_LABELS.get(name, name)
            in_t, out_t = attempt_tokens.get(name, (0, 0))
            retry_sfx   = f"  retry {attempt}" if attempt > 1 else ""
            tok_str     = _tok_note(in_t, out_t, extra=retry_sfx) if (in_t or out_t) else retry_sfx.strip()
            _agent_line(label, ok=True, ms=ms if i == 0 else None, notes=tok_str)

        _spinner("Validation")
        t0 = time.monotonic()
        error_map = validate_artifacts(artifacts, base_ctx, is_storefront, is_admin_ui)
        ms_val = int((time.monotonic() - t0) * 1000)

        if not error_map:
            _agent_line("Validation", ok=True, ms=ms_val, notes="all artifacts pass")
            return artifacts, retry_log, token_totals

        for name, errs in error_map.items():
            existing = cumulative_errors.setdefault(name, [])
            for err in errs:
                if err not in existing:
                    existing.append(err)

        retry_log.append({
            "attempt": attempt,
            "errors":  {gen: list(errs) for gen, errs in error_map.items()},
        })

        failed_summary = ", ".join(error_map.keys())
        _agent_line("Validation", ok=False, ms=ms_val,
                    notes=f"{len(error_map)} artifact(s) failed: {failed_summary}")
        for gen_name, errs in error_map.items():
            for e in errs:
                print(f"    {_DIM}• {gen_name}: {e}{_RESET}")

        if attempt < _MAX_CODEGEN_RETRIES:
            _retry_line("Validation", notes=f"fixing {failed_summary}")

    all_errors = [f"{n}: {e}" for n, errs in error_map.items() for e in errs]
    print(f"\n  {_RED}Codegen validation failed after {_MAX_CODEGEN_RETRIES} attempts:{_RESET}")
    for e in all_errors[:5]:
        print(f"    • {e}")
    sys.exit(1)


def _save_revision_failure_local(
    bad_artifacts: Dict[str, str],
    errors: Dict[str, List[str]],
) -> Path:
    """Save bad revision artifacts to test_results/revision_failures/ for analysis."""
    failure_dir = TEST_RESULTS_DIR / "revision_failures"
    failure_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = failure_dir / f"{ts}_revision_failure.json"
    payload = {"timestamp": ts, "errors": errors, "artifacts": bad_artifacts}
    path.write_text(json.dumps(payload, indent=2))
    return path


_REVISION_TRACES_SUBDIR = "revision_traces"


def _save_revision_trace(run_ts: str, slug: str, trace: Dict[str, Any]) -> Path:
    """Persist a validator+revision trace. Shares run_ts+slug with the report .md
    so traces and reports are trivially cross-referenceable on disk."""
    trace_dir = TEST_RESULTS_DIR / _REVISION_TRACES_SUBDIR
    trace_dir.mkdir(parents=True, exist_ok=True)
    path = trace_dir / f"{run_ts}_{slug}.json"
    path.write_text(json.dumps(trace, indent=2))
    return path


def _phase_validator(
    base_ctx: CodegenContext,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
    run_ts: str,
    run_slug: str,
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
    """
    from config import get_settings
    if not get_settings().llm_validation_enabled:
        _info("Validator skipped (LLM_VALIDATION_ENABLED not set)")
        return artifacts, 0, 0, None

    _spinner("Validator")
    t0 = time.monotonic()
    issues, val_in, val_out = run_validator_agent(
        artifacts, base_ctx, is_storefront, is_admin_ui
    )
    ms = int((time.monotonic() - t0) * 1000)

    if not issues:
        _agent_line("Validator", ok=True, ms=ms,
                    notes=_tok_note(val_in, val_out, extra="semantic check passed"))
        return artifacts, val_in, val_out, None

    issue_summary = ", ".join(i["question"] for i in issues)
    _agent_line("Validator", ok=True, ms=ms,
                notes=_tok_note(val_in, val_out, extra=f"{len(issues)} issue(s): {issue_summary}"))
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

    def _finalize(outcome: str) -> None:
        trace["final_outcome"] = outcome
        _save_revision_trace(run_ts, run_slug, trace)

    _spinner("Revision")
    t0 = time.monotonic()
    revised, rev_in, rev_out = run_revision_agent(
        revision_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        validation_issues=issues,
        locked_artifacts=_LOCKED,
    )
    ms = int((time.monotonic() - t0) * 1000)

    total_in  = val_in  + rev_in
    total_out = val_out + rev_out

    frontend_revised = {k: v for k, v in revised.items() if k not in _LOCKED}
    trace["attempts"].append({
        "attempt": 1,
        "duration_ms": ms,
        "in_tokens": rev_in,
        "out_tokens": rev_out,
        "returned_artifacts": sorted(frontend_revised.keys()),
        "post": frontend_revised,
        "static_errors": {},
        "outcome": None,
    })

    if not frontend_revised:
        _agent_line("Revision", ok=False, ms=ms,
                    notes=_tok_note(rev_in, rev_out, extra="no frontend artifacts returned — keeping originals"))
        trace["attempts"][-1]["outcome"] = "no_output"
        _finalize("kept_originals")
        return artifacts, total_in, total_out, trace

    # Statically validate the revised frontend artifacts before accepting them.
    merged = {**artifacts, **frontend_revised}
    all_errors = validate_artifacts(merged, revision_ctx, is_storefront, is_admin_ui)
    static_errors: Dict[str, List[str]] = {
        k: v for k, v in all_errors.items() if k in frontend_revised
    }

    if not static_errors:
        _agent_line("Revision", ok=True, ms=ms,
                    notes=_tok_note(rev_in, rev_out, extra="semantic issues resolved"))
        trace["attempts"][-1]["outcome"] = "accepted"
        _finalize("resolved")
        return merged, total_in, total_out, trace

    # First revision failed static validation — retry once with errors fed back.
    trace["attempts"][-1]["static_errors"] = static_errors
    trace["attempts"][-1]["outcome"] = "retrying"
    _agent_line("Revision", ok=False, ms=ms,
                notes=_tok_note(rev_in, rev_out,
                                extra=f"static validation failed ({len(static_errors)} artifact(s)) — retrying"))
    for gen_name, errs in static_errors.items():
        for e in errs:
            print(f"    {_DIM}• [{gen_name}] {e[:80]}{_RESET}")

    _spinner("Revision (static retry)")
    t0 = time.monotonic()
    revised2, rev2_in, rev2_out = run_revision_agent(
        revision_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        validation_issues=issues,
        locked_artifacts=_LOCKED,
        static_errors=static_errors,
    )
    ms2 = int((time.monotonic() - t0) * 1000)

    total_in  += rev2_in
    total_out += rev2_out

    frontend_revised2 = {k: v for k, v in revised2.items() if k not in _LOCKED}
    merged2 = {**artifacts, **frontend_revised2}
    all_errors2 = validate_artifacts(merged2, revision_ctx, is_storefront, is_admin_ui)
    static_errors2: Dict[str, List[str]] = {
        k: v for k, v in all_errors2.items() if k in frontend_revised2
    }

    trace["attempts"].append({
        "attempt": 2,
        "duration_ms": ms2,
        "in_tokens": rev2_in,
        "out_tokens": rev2_out,
        "returned_artifacts": sorted(frontend_revised2.keys()),
        "post": frontend_revised2,
        "static_errors": static_errors2,
        "outcome": None,
    })

    if not static_errors2:
        _agent_line("Revision", ok=True, ms=ms2,
                    notes=_tok_note(rev2_in, rev2_out, extra="semantic issues resolved (static retry)"))
        trace["attempts"][-1]["outcome"] = "accepted"
        _finalize("resolved_on_retry")
        return merged2, total_in, total_out, trace

    # Both revision attempts produced structurally invalid code — fail the run.
    trace["attempts"][-1]["outcome"] = "failed"
    _finalize("failed")
    bad = {**frontend_revised, **frontend_revised2}
    path = _save_revision_failure_local(bad, static_errors2)
    _agent_line("Revision", ok=False, ms=ms2,
                notes=_tok_note(rev2_in, rev2_out, extra="static validation failed after 2 attempts"))
    print(f"\n  {_RED}Revision agent produced structurally invalid code after 2 attempts.{_RESET}")
    for gen_name, errs in static_errors2.items():
        for e in errs:
            print(f"    • [{gen_name}] {e}")
    print(f"  Saved for analysis: {path}")
    sys.exit(1)


# ── Output helpers ─────────────────────────────────────────────────────────────


def _slug(text: str, max_words: int = 6) -> str:
    words = re.sub(r"[^a-z0-9 ]", "", text.lower()).split()
    return "-".join(words[:max_words])


def _save_arch_json(prompt: str, intent: Dict, plan: Dict, errors: List[str], product_prompt: str = "") -> Path:
    TEST_RESULTS_DIR.mkdir(exist_ok=True)
    ts   = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = TEST_RESULTS_DIR / f"{ts}_{_slug(prompt)}_arch.json"
    payload: Dict[str, Any] = {"prompt": prompt, "intent": intent, "plan": plan, "validation_errors": errors}
    if product_prompt:
        payload["product_prompt"] = product_prompt
    path.write_text(json.dumps(payload, indent=2))
    return path


def _validator_revision_md_lines(trace: Dict[str, Any]) -> List[str]:
    """Render a concise '## Validator + Revision' section from a trace dict.
    Includes a relative-path link back to the full trace JSON on disk."""
    issues = trace.get("validator", {}).get("issues") or []
    attempts = trace.get("attempts") or []
    final = trace.get("final_outcome") or "?"
    lines = ["## Validator + Revision", ""]
    lines.append(f"**Final outcome:** `{final}`  ")
    lines.append(f"**Validator issues:** {len(issues)}  ")
    lines.append(f"**Revision attempts:** {len(attempts)}")
    lines.append("")
    if issues:
        lines.append("**Issues raised by validator:**")
        lines.append("")
        for iss in issues:
            q = iss.get("question", "?")
            msg = str(iss.get("issue", "")).strip()
            lines.append(f"- *{q}*: {msg}")
        lines.append("")
    for att in attempts:
        lines.append(
            f"- Attempt {att.get('attempt')}: "
            f"{att.get('duration_ms', 0)}ms · "
            f"in={att.get('in_tokens', 0)} out={att.get('out_tokens', 0)} · "
            f"returned={att.get('returned_artifacts') or []} · "
            f"outcome=`{att.get('outcome')}`"
        )
        se = att.get("static_errors") or {}
        for gen, errs in se.items():
            for e in errs:
                lines.append(f"    - [{gen}] {e}")
    trace_rel = f"{_REVISION_TRACES_SUBDIR}/{trace['run_ts']}_{trace['slug']}.json"
    lines.append("")
    lines.append(f"**Full trace:** [{trace_rel}]({trace_rel})")
    lines.append("")
    return lines


def _save_artifacts_md(
    prompt: str,
    artifacts: Dict[str, str],
    stop_label: str,
    is_storefront: bool,
    is_admin_ui: bool,
    retry_log: Optional[List[Dict]] = None,
    intent: Optional[Dict] = None,
    plan: Optional[Dict] = None,
    run_ts: Optional[str] = None,
    validator_trace: Optional[Dict[str, Any]] = None,
    handler_email_metadata: Optional[Dict[str, Any]] = None,
) -> Path:
    TEST_RESULTS_DIR.mkdir(exist_ok=True)
    ts   = run_ts or datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = TEST_RESULTS_DIR / f"{ts}_{_slug(prompt)}_{stop_label}.md"

    lines = [
        f"# Chat Local — {stop_label.capitalize()} Output",
        "",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ",
        f"**Prompt:** {prompt}",
        "",
    ]

    if intent:
        lines += ["## Intent (Product Agent)", "", "```json", json.dumps(intent, indent=2), "```", ""]
    if plan:
        lines += ["## Architect Plan",         "", "```json", json.dumps(plan,   indent=2), "```", ""]

    if retry_log:
        resolved = stop_label != "codegen" or not retry_log or all(
            entry["attempt"] < _MAX_CODEGEN_RETRIES for entry in retry_log
        )
        heading = "## Validation Retries" + (" (all resolved)" if resolved else " (UNRESOLVED — max retries hit)")
        lines += [heading, ""]
        for entry in retry_log:
            lines.append(f"### Attempt {entry['attempt']}")
            for gen_name, errs in entry["errors"].items():
                for e in errs:
                    lines.append(f"- **{gen_name}**: {e}")
            lines.append("")

    if validator_trace:
        lines += _validator_revision_md_lines(validator_trace)

    lines += ["## Artifacts", ""]
    if artifacts.get("handler"):
        lines += ["### handler.js",    "", "```javascript", artifacts["handler"],    "```", ""]
    if handler_email_metadata is not None:
        lines += _email_metadata_md_lines(handler_email_metadata)
    if artifacts.get("migration"):
        lines += ["### migration.sql", "", "```sql",        artifacts["migration"],  "```", ""]
    if is_storefront and artifacts.get("widget_js"):
        lines += ["### widget.js",     "", "```javascript", artifacts["widget_js"],  "```", ""]
    if is_admin_ui and artifacts.get("admin_ui"):
        lines += ["### admin_ui.js",   "", "```javascript", artifacts["admin_ui"],   "```", ""]

    path.write_text("\n".join(lines) + "\n")
    return path


def _email_metadata_md_lines(meta: Dict[str, Any]) -> List[str]:
    """
    Render the handler's email-metadata sidecar for the test-results report.

    Makes sidecar presence, declared variables, and starter content inspectable
    at a glance — matches the contract in templates/capabilities/handler.py
    ("Email metadata sidecar"). Empty/None metadata produces nothing.
    """
    if not meta:
        return []
    return [
        "### handler email metadata (sidecar)",
        "",
        "```json",
        json.dumps(meta, indent=2),
        "```",
        "",
    ]


def _print_arch(intent: Dict, plan: Dict) -> None:
    print()
    _hr("━")
    print(json.dumps({"intent": intent, "plan": plan}, indent=2))
    _hr("━")


def _print_artifacts(artifacts: Dict[str, str]) -> None:
    print()
    _hr()
    for key, code in artifacts.items():
        if code:
            lines = len(code.strip().splitlines())
            print(f"  {_BOLD}{key}{_RESET}  ({lines} lines)")
    _hr()


def _print_token_summary(token_map: Dict[str, Tuple[int, int]]) -> None:
    """Print a per-agent token breakdown and grand total."""
    if not token_map:
        return
    total_in  = sum(v[0] for v in token_map.values())
    total_out = sum(v[1] for v in token_map.values())
    parts = "  ".join(
        f"{_DIM}{name}({_ktok(in_t)}+{_ktok(out_t)}){_RESET}"
        for name, (in_t, out_t) in token_map.items()
        if in_t or out_t
    )
    print(
        f"\n  {_DIM}Tokens{_RESET}  "
        f"in={_ktok(total_in)}  out={_ktok(total_out)}  "
        f"total={_ktok(total_in + total_out)}"
    )
    if parts:
        print(f"  {_DIM}Agents{_RESET}  {parts}")


# ── Main ───────────────────────────────────────────────────────────────────────


def _build_bundle(
    artifacts: Dict[str, Any],
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    explanation: Dict[str, Any],
    is_storefront: bool,
    is_admin_ui: bool,
    handler_email_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Assemble the FeatureBundle dict from generation outputs.
    Mirrors _publish_success in crew.py so the DB bundle is identical to what
    the production generator publishes via Pub/Sub.

    Email metadata flow matches crew.py — see _publish_success for the full
    rationale. usesEmail / emailTypeSuggestion come from the architect plan;
    emailVariables / emailStarterContent come from the handler's structured
    sidecar (captured by HandlerGenerator.generate() onto base_ctx).
    """
    handler_code = artifacts.get("handler", "")
    shopify_plan = plan.get("shopifyPlan", {})
    technical    = explanation.get("technical", {})
    app_contracts = plan.get("appContracts") or {}

    # Parse npmPackages from the handler's module.exports
    def _parse_npm(code: str) -> List[str]:
        m = re.search(r"npmPackages\s*:\s*\[([^\]]*)\]", code)
        if not m:
            return []
        return re.findall(r"""['"]([^'"]+)['"]""", m.group(1))

    uses_email = "email" in (app_contracts.get("handlerCapabilities") or [])
    email_spec = app_contracts.get("emailSpec") or {}
    sidecar = handler_email_metadata or {}
    raw_variables = sidecar.get("variables")
    email_variables: List[str] = [
        v for v in (raw_variables or []) if isinstance(v, str)
    ]
    starter_raw = sidecar.get("starterContent")
    starter = (
        starter_raw
        if isinstance(starter_raw, dict)
        and starter_raw.get("subject")
        and starter_raw.get("body")
        else None
    )

    return {
        "widgetModule":          artifacts.get("widget_js") if is_storefront else None,
        "adminUiModule":         artifacts.get("admin_ui")  if is_admin_ui   else None,
        "widgetTargetTemplates": (app_contracts.get("widgetTargetTemplates") or None) if is_storefront else None,
        "handlerModule": {
            # Phase 2 bridge: one-file wrapper around the legacy CommonJS blob.
            # Step 5 replaces this with real multi-file output from handler_agent.
            "files": [
                {"path": "src/routes/generated.ts", "contents": handler_code},
            ],
            "webhookTopics": shopify_plan.get("webhookTopics", []),
            "cronSchedule":  shopify_plan.get("cronSchedule"),
            "npmPackages":   _parse_npm(handler_code),
        },
        "dbMigration": {
            "path": "migrations/generated.sql",
            "contents": artifacts.get("migration", ""),
        },
        "explanation": {
            "merchantFacing": explanation.get("merchantFacing", ""),
            "technical": {
                "webhookTopics":                technical.get("webhookTopics", []),
                "dbTables":                     technical.get("dbTables", []),
                "estimatedMonthlyExecutions":   technical.get("estimatedMonthlyExecutions", 0),
                "estimatedMonthlyCost":         technical.get("estimatedMonthlyCost", "$0"),
            },
        },
        "usesEmail":           uses_email,
        "emailVariables":      email_variables,
        "emailTypeSuggestion": email_spec.get("type"),
        "emailStarterContent": starter,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Interactive chat CLI with optional pipeline stop points.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--stop-after",
        choices=["arch", "codegen", "validator"],
        default=None,
        help=(
            "Stop after a specific phase: "
            "'arch' = product + architect only, "
            "'codegen' = + codegen + static validation, "
            "'validator' = + LLM validator + revision. "
            "Omit to run the full pipeline."
        ),
    )
    parser.add_argument(
        "--no-db",
        action="store_true",
        default=False,
        help="Skip writing the bundle to the local postgres DB.",
    )
    args = parser.parse_args()
    stop_after: StopAfter = args.stop_after or "full"
    save_to_db = not args.no_db and stop_after == "full"

    _hr("━")
    print(f"\n{_BOLD}  Ton — Shopify App Builder{_RESET}")
    mode_note = f"  stop after: {stop_after}" if stop_after != "full" else "  full pipeline"
    print(f"  {_DIM}{mode_note}  |  Ctrl+C to exit{_RESET}\n")
    _hr("━")

    # ── Step 1: Chat until intent is ready ─────────────────────────────────────
    first_message = _ask_user(f"\n{_BOLD}You{_RESET}  ")
    if not first_message:
        print("Nothing entered — exiting.")
        return

    history: List[Dict[str, str]] = [{"role": "user", "content": first_message}]
    intent, history = _clarify(history)
    prompt = intent.get("desiredOutcome") or first_message

    # ── Step 2: Confirm or keep refining ───────────────────────────────────────
    _info("Press Enter to continue to components  |  type more to refine  |  'n' to cancel")
    while True:
        user_input = _ask_user(f"\n{_BOLD}You{_RESET}  ")
        if not user_input or user_input.lower() in ("y", "yes"):
            break
        if user_input.lower() in ("n", "no"):
            print("\nAborted.")
            return
        history = history + [{"role": "user", "content": user_input}]
        intent, history = _clarify(history)
        prompt = intent.get("desiredOutcome") or first_message
        _info("Press Enter to continue to components  |  type more to refine  |  'n' to cancel")

    # ── Step 3: Component picker (mirrors ConfirmCard) ─────────────────────────
    while True:
        updated_intent = _pick_components(intent)
        if updated_intent is not None:
            intent = updated_intent
            break
        # "Change request" — resume clarification from current history
        _bot("Sure, what would you like to change?")
        user_input = _ask_user(f"\n{_BOLD}You{_RESET}  ")
        if not user_input:
            continue
        history = history + [{"role": "user", "content": user_input}]
        intent, history = _clarify(history)
        prompt = intent.get("desiredOutcome") or first_message

    # ── DB: create app + session before pipeline starts ───────────────────────
    app_name = (intent.get("desiredOutcome") or prompt)[:60]
    app_id = job_id = session_id = slug = None
    if save_to_db:
        try:
            import uuid
            import db_local
            app_id, slug = db_local.create_app(app_name)
            job_id = str(uuid.uuid4())
            session_id = db_local.create_session(app_id, prompt, job_id)
            _info(f"DB: created app '{slug}'")
        except Exception as exc:
            _info(f"DB setup failed — continuing without DB: {exc}")
            save_to_db = False

    print()
    _hr()
    print(f"  {_BOLD}Running pipeline…{_RESET}")
    _hr()
    print()

    archetype    = intent.get("appCategory", "")
    is_storefront = archetype in ("storefront_backend",       "storefront_backend_admin")
    is_admin_ui   = archetype in ("storefront_backend_admin", "backend_admin")

    total_start = time.monotonic()
    run_ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    run_slug = _slug(prompt)
    all_tokens: Dict[str, Tuple[int, int]] = {}

    def _fail_db(reason: str) -> None:
        """Mark the DB session+app as failed before exiting."""
        if save_to_db and app_id and job_id:
            try:
                db_local.mark_session_failed(job_id, app_id, reason)
            except Exception:
                pass

    # ── Phase: Architect ───────────────────────────────────────────────────────
    try:
        plan, api_context, product_prompt, arch_in, arch_out = _phase_architect(intent, prompt)
    except SystemExit:
        _fail_db("Architect phase failed")
        raise
    all_tokens["architect"] = (arch_in, arch_out)

    if stop_after == "arch":
        total_ms = int((time.monotonic() - total_start) * 1000)
        _print_token_summary(all_tokens)
        report = _save_arch_json(prompt, intent, plan, [], product_prompt)
        print(f"\n  done — {total_ms / 1000:.1f}s — {report.relative_to(_HERE)}")
        _hr("━")
        return

    # ── Phase: CodeGen + Static Validation ────────────────────────────────────
    base_ctx = CodegenContext(
        intent=intent,
        plan=plan,
        platform_api_catalog=(plan.get("appContracts") or {}).get("widgetApiCatalog") or [],
        api_context=api_context,
    )
    try:
        artifacts, retry_log, codegen_tokens = _phase_codegen(base_ctx, is_storefront, is_admin_ui)
    except SystemExit:
        _fail_db("Codegen validation failed after max retries")
        raise
    all_tokens.update(codegen_tokens)

    if stop_after == "codegen":
        total_ms = int((time.monotonic() - total_start) * 1000)
        _print_artifacts(artifacts)
        _print_token_summary(all_tokens)
        report = _save_artifacts_md(prompt, artifacts, "codegen", is_storefront, is_admin_ui,
                                    retry_log or None, intent=intent, plan=plan,
                                    run_ts=run_ts,
                                    handler_email_metadata=base_ctx.handler_email_metadata)
        print(f"\n  done — {total_ms / 1000:.1f}s — {report.relative_to(_HERE)}")
        _hr("━")
        return

    # ── Phase: LLM Validator + Revision ───────────────────────────────────────
    artifacts, val_in, val_out, validator_trace = _phase_validator(
        base_ctx, artifacts, is_storefront, is_admin_ui, run_ts, run_slug,
    )
    if val_in or val_out:
        all_tokens["validator"] = (val_in, val_out)

    if stop_after == "validator":
        total_ms = int((time.monotonic() - total_start) * 1000)
        _print_artifacts(artifacts)
        _print_token_summary(all_tokens)
        report = _save_artifacts_md(prompt, artifacts, "validator", is_storefront, is_admin_ui,
                                    retry_log or None, intent=intent, plan=plan,
                                    run_ts=run_ts, validator_trace=validator_trace,
                                    handler_email_metadata=base_ctx.handler_email_metadata)
        print(f"\n  done — {total_ms / 1000:.1f}s — {report.relative_to(_HERE)}")
        _hr("━")
        return

    # ── Phase: Explanation ────────────────────────────────────────────────────
    _spinner("Explanation")
    t0 = time.monotonic()
    explanation, exp_in, exp_out = run_explanation_agent(
        intent=intent,
        plan=plan,
        widget_js_code=artifacts.get("widget_js", "") if is_storefront else "",
        migration_sql=artifacts.get("migration", ""),
    )
    ms = int((time.monotonic() - t0) * 1000)
    _agent_line("Explanation", ok=True, ms=ms, notes=_tok_note(exp_in, exp_out))
    all_tokens["explanation"] = (exp_in, exp_out)

    # ── DB: store bundle ──────────────────────────────────────────────────────
    if save_to_db and app_id and job_id:
        try:
            bundle = _build_bundle(
                artifacts, intent, plan, explanation, is_storefront, is_admin_ui,
                handler_email_metadata=base_ctx.handler_email_metadata,
            )
            db_local.store_bundle(job_id, app_id, bundle)
        except Exception as exc:
            _log.info("DB bundle save failed: %s", exc, exc_info=True)
            _info(f"DB bundle save failed: {exc}")

    total_ms = int((time.monotonic() - total_start) * 1000)

    # ── Save full report ───────────────────────────────────────────────────────
    TEST_RESULTS_DIR.mkdir(exist_ok=True)
    report = TEST_RESULTS_DIR / f"{run_ts}_{run_slug}.md"

    total_in  = sum(v[0] for v in all_tokens.values())
    total_out = sum(v[1] for v in all_tokens.values())

    lines = [
        "# Chat Local — Full Pipeline",
        "",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ",
        f"**Status:** ✅ SUCCESS  ",
        f"**Total:** {total_ms}ms  ",
        f"**Tokens:** in={total_in} out={total_out} total={total_in + total_out}  ",
        f"**Prompt:** {prompt}",
        "",
        "## Intent (Product Agent)",
        "",
        "```json",
        json.dumps(intent, indent=2),
        "```",
        "",
        "## Architect Plan",
        "",
        "```json",
        json.dumps(plan, indent=2),
        "```",
        "",
    ]
    if retry_log:
        lines += ["## Validation Retries (resolved)", ""]
        for entry in retry_log:
            lines.append(f"### Attempt {entry['attempt']}")
            for gen_name, errs in entry["errors"].items():
                for e in errs:
                    lines.append(f"- **{gen_name}**: {e}")
            lines.append("")
    if validator_trace:
        lines += _validator_revision_md_lines(validator_trace)
    lines += ["## Artifacts", ""]
    if artifacts.get("handler"):
        lines += ["### handler.js",    "", "```javascript", artifacts["handler"],   "```", ""]
    if base_ctx.handler_email_metadata is not None:
        lines += _email_metadata_md_lines(base_ctx.handler_email_metadata)
    if artifacts.get("migration"):
        lines += ["### migration.sql", "", "```sql",        artifacts["migration"], "```", ""]
    if is_storefront and artifacts.get("widget_js"):
        lines += ["### widget.js",     "", "```javascript", artifacts["widget_js"], "```", ""]
    if is_admin_ui and artifacts.get("admin_ui"):
        lines += ["### admin_ui.js",   "", "```javascript", artifacts["admin_ui"],  "```", ""]
    merchant_facing = explanation.get("merchantFacing", "")
    if merchant_facing:
        lines += ["", "## Explanation", "", merchant_facing]
    report.write_text("\n".join(lines) + "\n")

    # ── Final summary ──────────────────────────────────────────────────────────
    _hr("━")
    print(f"  {_GREEN}SUCCESS{_RESET} — {total_ms / 1000:.1f}s — {report.relative_to(_HERE)}")

    # Artifact line counts
    artifact_parts = []
    for key, label in [("handler", "handler.js"), ("migration", "migration.sql"),
                       ("widget_js", "widget.js"), ("admin_ui", "admin_ui.js")]:
        code = artifacts.get(key, "")
        if code:
            artifact_parts.append(f"{label} ({len(code.strip().splitlines())} lines)")
    if artifact_parts:
        print(f"  {_DIM}Files{_RESET}   " + "  ".join(artifact_parts))
    if save_to_db and slug:
        print(f"  {_DIM}App{_RESET}     http://localhost:3000  →  {app_name}")

    _print_token_summary(all_tokens)
    _hr("━")
    print()

    if merchant_facing:
        _bot(merchant_facing)


if __name__ == "__main__":
    main()
