#!/usr/bin/env python3
"""
Interactive chat CLI — mirrors the platform's chat page experience.

Runs the multi-turn product agent clarification loop, then runs the generation
pipeline phase by phase. Use --stop-after to halt at a specific phase.

USAGE
-----
  python chat_local.py                        # full pipeline
  python chat_local.py --stop-after arch      # product + architect only, prints plan
  python chat_local.py --stop-after codegen   # + codegen + static validation
  python chat_local.py --stop-after validator # + LLM validator + revision pass

OUTPUT
------
  Console: live per-agent progress lines
  File (stop-after=arch):     test_results/<ts>_<slug>_arch.json
  File (stop-after=codegen/validator or full): test_results/<ts>_<slug>.md
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

_HERE = Path(__file__).parent
os.chdir(_HERE)
sys.path.insert(0, str(_HERE))

from shopify_mcp.client import prefetch_for_run
from subagents.architect_agent import run_architect_agent, _ARCHITECT_USER_TEMPLATE
from subagents.base import CodegenContext
from subagents.explanation_agent import run_explanation_agent
from subagents.product_agent import run_product_agent_analyze
from subagents.revision_agent import run_revision_agent
from subagents.static_validation import validate_architect_plan
from subagents.validator_agent import run_validator_agent
from crews.feature_generator.crew import run_codegen_parallel, validate_artifacts

TEST_RESULTS_DIR = _HERE / "test_results"
_MAX_ARCH_ATTEMPTS = 2   # matches crew.py
_MAX_CODEGEN_RETRIES = 3  # matches crew.py _MAX_RETRIES

StopAfter = Literal["arch", "codegen", "validator", "full"]

# ── Display helpers ────────────────────────────────────────────────────────────

_W = 80
_RESET = "\033[0m"
_BOLD = "\033[1m"
_DIM = "\033[2m"
_CYAN = "\033[36m"
_GREEN = "\033[32m"
_YELLOW = "\033[33m"
_RED = "\033[31m"


def _hr(char: str = "─") -> None:
    print(_DIM + char * _W + _RESET)


def _bot(text: str) -> None:
    print(f"\n{_CYAN}{_BOLD}Ton{_RESET}  {text}\n")


def _info(text: str) -> None:
    print(f"  {_DIM}{text}{_RESET}")


def _agent_line(name: str, ok: bool, ms: Optional[int], notes: str = "") -> None:
    icon = f"{_GREEN}✓{_RESET}" if ok else f"{_RED}✗{_RESET}"
    timing = f"{ms}ms" if ms is not None else "—"
    line = f"  {name:<14} {icon}  {_DIM}{timing:<8}{_RESET}  {notes}".rstrip()
    print(f"\r{line:<{_W}}")


def _spinner(name: str) -> None:
    print(f"\r  {name:<14} {_DIM}…{_RESET}", end="", flush=True)


def _retry_line(name: str, notes: str) -> None:
    line = f"  {name:<14} {_YELLOW}↻{_RESET}  {'':8}  {_DIM}{notes[:60]}{_RESET}".rstrip()
    print(f"\r{line:<{_W}}")


# ── Clarification loop ─────────────────────────────────────────────────────────


def _ask_user(prompt_text: str) -> str:
    try:
        return input(prompt_text).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)


def _clarify(history: List[Dict[str, str]]) -> tuple[Dict[str, Any], List[Dict[str, str]]]:
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
            # Append the ready turn so history stays complete if we need to resume
            history = history + [{"role": "assistant", "content": json.dumps(response)}]
            return response.get("intent") or {}, history

        if status == "needs_clarification":
            question = response.get("question", "")
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
            {"role": "user", "content": user_input},
        ]


# ── Phase runners ──────────────────────────────────────────────────────────────


def _phase_architect(intent: Dict[str, Any], prompt: str) -> tuple[Dict[str, Any], str, str]:
    """Run product prefetch + architect with validation retry. Returns (plan, api_context, arch_prompt)."""
    archetype = intent.get("appCategory", "")

    _spinner("Prefetch")
    t0 = time.monotonic()
    api_context = prefetch_for_run(intent.get("resources", []), intent.get("desiredOutcome", ""))
    ms = int((time.monotonic() - t0) * 1000)
    _agent_line("Prefetch", ok=True, ms=ms, notes="webhook topics loaded")

    # Assemble the product→architect user prompt once (same logic as run_architect_agent)
    api_context_section = (
        f"\nShopify API context (webhook payload shapes, resource fields — use as ground truth):\n{api_context}\n"
        if api_context else ""
    )
    product_prompt = _ARCHITECT_USER_TEMPLATE.format(
        error_block="",
        prompt=prompt,
        intent_json=json.dumps(intent, indent=2),
        archetype=archetype,
        api_context_section=api_context_section,
    )

    plan: Dict[str, Any] = {}
    errors: List[str] = []

    for attempt in range(1, _MAX_ARCH_ATTEMPTS + 1):
        _spinner("Architect")
        t0 = time.monotonic()
        plan = run_architect_agent(
            prompt=prompt,
            intent=intent,
            app_archetype=archetype,
            api_context=api_context,
            validation_errors=errors if attempt > 1 else None,
        )
        ms = int((time.monotonic() - t0) * 1000)
        errors = validate_architect_plan(plan, app_archetype=archetype)

        if not errors:
            _agent_line("Architect", ok=True, ms=ms, notes=f"attempt {attempt}")
            # Feasibility gate — same as crew.py _phase_architect
            contracts = plan.get("appContracts") or {}
            if contracts.get("feasibility") == "blocked":
                blocked_reason = contracts.get(
                    "blockedReason",
                    "This app requires capabilities that aren't available on the platform yet.",
                )
                print(f"\n  {_RED}Platform limitation:{_RESET} {blocked_reason}")
                sys.exit(1)
            return plan, api_context, product_prompt

        _agent_line("Architect", ok=False, ms=ms, notes=f"attempt {attempt} — {len(errors)} error(s)")
        if attempt < _MAX_ARCH_ATTEMPTS:
            _retry_line("Architect", notes="; ".join(errors[:2]))

    # All attempts exhausted
    print(f"\n  {_RED}Architect failed after {_MAX_ARCH_ATTEMPTS} attempts:{_RESET}")
    for e in errors:
        print(f"    • {e}")
    sys.exit(1)


def _phase_codegen(
    base_ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> Dict[str, str]:
    """Run parallel codegen with static validation retries. Returns artifacts dict."""
    artifacts: Dict[str, str] = {}
    error_map: Dict[str, List[str]] = {}

    _CODEGEN_LABELS = {
        "handler": "Handler",
        "migration": "Migration",
        "widget_js": "Widget JS",
        "admin_ui": "Admin UI",
    }

    for attempt in range(1, _MAX_CODEGEN_RETRIES + 1):
        retry_note = f"attempt {attempt}/{_MAX_CODEGEN_RETRIES}" if attempt > 1 else ""

        # On first attempt show all; on retry show only failing generators (matches crew.py)
        generators_this_round = (
            list(error_map.keys()) if attempt > 1 else
            ["handler", "migration"]
            + (["widget_js"] if is_storefront else [])
            + (["admin_ui"] if is_admin_ui else [])
        )
        for name in generators_this_round:
            if attempt > 1:
                _retry_line(_CODEGEN_LABELS.get(name, name), notes=retry_note)
            _spinner(_CODEGEN_LABELS.get(name, name))

        t0 = time.monotonic()
        artifacts = run_codegen_parallel(
            base_ctx,
            is_storefront=is_storefront,
            is_admin_ui=is_admin_ui,
            error_map=error_map,
            artifacts=artifacts,
        )
        ms = int((time.monotonic() - t0) * 1000)

        # Print completion lines only for generators that ran this round
        for name in generators_this_round:
            _agent_line(_CODEGEN_LABELS.get(name, name), ok=True, ms=ms if name == generators_this_round[0] else None, notes="")

        # Static validation
        _spinner("Validation")
        t0 = time.monotonic()
        error_map = validate_artifacts(artifacts, base_ctx, is_storefront, is_admin_ui)
        ms = int((time.monotonic() - t0) * 1000)

        if not error_map:
            _agent_line("Validation", ok=True, ms=ms, notes="all artifacts pass")
            return artifacts

        _agent_line("Validation", ok=False, ms=ms, notes=f"{len(error_map)} artifact(s) failed")
        if attempt < _MAX_CODEGEN_RETRIES:
            _retry_line("Validation", notes=", ".join(error_map.keys()))

    # All retries exhausted
    all_errors = [f"{n}: {e}" for n, errs in error_map.items() for e in errs]
    print(f"\n  {_RED}Codegen validation failed after {_MAX_CODEGEN_RETRIES} attempts:{_RESET}")
    for e in all_errors[:5]:
        print(f"    • {e}")
    sys.exit(1)


def _phase_validator(
    base_ctx: CodegenContext,
    artifacts: Dict[str, str],
    is_storefront: bool,
    is_admin_ui: bool,
) -> Dict[str, str]:
    """
    Run LLM validator + optional revision pass. Returns (possibly revised) artifacts.
    Gated by LLM_VALIDATION_ENABLED — same as crew.py _phase_validator.
    """
    from config import get_settings
    if not get_settings().llm_validation_enabled:
        _info("Validator skipped (LLM_VALIDATION_ENABLED not set)")
        return artifacts

    _spinner("Validator")
    t0 = time.monotonic()
    issues = run_validator_agent(artifacts, base_ctx, is_storefront, is_admin_ui)
    ms = int((time.monotonic() - t0) * 1000)

    if not issues:
        _agent_line("Validator", ok=True, ms=ms, notes="semantic check passed")
        return artifacts

    issue_summary = ", ".join(i["question"] for i in issues)
    _agent_line("Validator", ok=True, ms=ms, notes=f"{len(issues)} issue(s): {issue_summary}")

    _spinner("Revision")
    t0 = time.monotonic()
    revised = run_revision_agent(
        base_ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        validation_issues=issues,
    )
    ms = int((time.monotonic() - t0) * 1000)

    if revised.get("handler") and revised.get("migration"):
        _agent_line("Revision", ok=True, ms=ms, notes="semantic issues resolved")
        return {**artifacts, **revised}

    _agent_line("Revision", ok=False, ms=ms, notes="incomplete — keeping originals")
    return artifacts


# ── Output helpers ─────────────────────────────────────────────────────────────


def _slug(text: str, max_words: int = 6) -> str:
    words = re.sub(r"[^a-z0-9 ]", "", text.lower()).split()
    return "-".join(words[:max_words])


def _save_arch_json(prompt: str, intent: Dict, plan: Dict, errors: List[str], product_prompt: str = "") -> Path:
    TEST_RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = TEST_RESULTS_DIR / f"{ts}_{_slug(prompt)}_arch.json"
    payload: Dict[str, Any] = {"prompt": prompt, "intent": intent, "plan": plan, "validation_errors": errors}
    if product_prompt:
        payload["product_prompt"] = product_prompt
    path.write_text(json.dumps(payload, indent=2))
    return path


def _save_artifacts_md(
    prompt: str,
    artifacts: Dict[str, str],
    stop_label: str,
    is_storefront: bool,
    is_admin_ui: bool,
) -> Path:
    TEST_RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = TEST_RESULTS_DIR / f"{ts}_{_slug(prompt)}_{stop_label}.md"

    lines = [
        f"# Chat Local — {stop_label.capitalize()} Output",
        "",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ",
        f"**Prompt:** {prompt}",
        "",
        "## Artifacts",
        "",
    ]
    if artifacts.get("handler"):
        lines += ["### handler.js", "", "```javascript", artifacts["handler"], "```", ""]
    if artifacts.get("migration"):
        lines += ["### migration.sql", "", "```sql", artifacts["migration"], "```", ""]
    if is_storefront and artifacts.get("widget_js"):
        lines += ["### widget.js", "", "```javascript", artifacts["widget_js"], "```", ""]
    if is_admin_ui and artifacts.get("admin_ui"):
        lines += ["### admin_ui.js", "", "```javascript", artifacts["admin_ui"], "```", ""]

    path.write_text("\n".join(lines) + "\n")
    return path


def _print_arch(intent: Dict, plan: Dict) -> None:
    print()
    _hr("━")
    print(json.dumps({"intent": intent, "plan": plan}, indent=2))
    _hr("━")


def _print_artifacts(artifacts: Dict[str, str]) -> None:
    """Print a short summary of generated artifacts to console."""
    print()
    _hr()
    for key, code in artifacts.items():
        if code:
            lines = code.strip().splitlines()
            print(f"\n  {_BOLD}{key}{_RESET}  ({len(lines)} lines)")
            # Show first 5 lines as a preview
            for line in lines[:5]:
                print(f"    {_DIM}{line}{_RESET}")
            if len(lines) > 5:
                print(f"    {_DIM}… ({len(lines) - 5} more lines){_RESET}")
    _hr()


# ── Main ───────────────────────────────────────────────────────────────────────


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
    args = parser.parse_args()
    stop_after: StopAfter = args.stop_after or "full"

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
    _info(f"Press Enter to generate  |  type more to refine  |  'n' to cancel")
    while True:
        user_input = _ask_user(f"\n{_BOLD}You{_RESET}  ")
        if not user_input or user_input.lower() in ("y", "yes"):
            break
        if user_input.lower() in ("n", "no"):
            print("\nAborted.")
            return
        # User added more — continue clarification from current history
        history = history + [{"role": "user", "content": user_input}]
        intent, history = _clarify(history)
        prompt = intent.get("desiredOutcome") or first_message
        _info(f"Press Enter to generate  |  type more to refine  |  'n' to cancel")

    print()
    _hr()
    print(f"  {_BOLD}Running pipeline…{_RESET}")
    _hr()
    print()

    archetype = intent.get("appCategory", "")
    is_storefront = archetype in ("storefront_backend", "storefront_backend_admin")
    is_admin_ui = archetype in ("storefront_backend_admin", "backend_admin")

    total_start = time.monotonic()

    # ── Phase: Architect ───────────────────────────────────────────────────────
    plan, api_context, product_prompt = _phase_architect(intent, prompt)

    if stop_after == "arch":
        total_ms = int((time.monotonic() - total_start) * 1000)
        report = _save_arch_json(prompt, intent, plan, [], product_prompt)
        print(f"  done — {total_ms / 1000:.1f}s — {report.relative_to(_HERE)}")
        _hr("━")
        return

    # ── Phase: CodeGen + Static Validation ────────────────────────────────────
    base_ctx = CodegenContext(
        intent=intent,
        plan=plan,
        platform_api_catalog=(plan.get("appContracts") or {}).get("widgetApiCatalog") or [],
        api_context=api_context,
    )
    artifacts = _phase_codegen(base_ctx, is_storefront, is_admin_ui)

    if stop_after == "codegen":
        total_ms = int((time.monotonic() - total_start) * 1000)
        _print_artifacts(artifacts)
        report = _save_artifacts_md(prompt, artifacts, "codegen", is_storefront, is_admin_ui)
        print(f"  done — {total_ms / 1000:.1f}s — {report.relative_to(_HERE)}")
        _hr("━")
        return

    # ── Phase: LLM Validator + Revision ───────────────────────────────────────
    artifacts = _phase_validator(base_ctx, artifacts, is_storefront, is_admin_ui)

    if stop_after == "validator":
        total_ms = int((time.monotonic() - total_start) * 1000)
        _print_artifacts(artifacts)
        report = _save_artifacts_md(prompt, artifacts, "validator", is_storefront, is_admin_ui)
        print(f"  done — {total_ms / 1000:.1f}s — {report.relative_to(_HERE)}")
        _hr("━")
        return

    # ── Phase: Explanation ────────────────────────────────────────────────────
    _spinner("Explanation")
    t0 = time.monotonic()
    explanation = run_explanation_agent(
        intent=intent,
        plan=plan,
        widget_js_code=artifacts.get("widget_js", "") if is_storefront else "",
        handler_code=artifacts.get("handler", ""),
        migration_sql=artifacts.get("migration", ""),
    )
    ms = int((time.monotonic() - t0) * 1000)
    _agent_line("Explanation", ok=True, ms=ms, notes="")

    total_ms = int((time.monotonic() - total_start) * 1000)

    # Save full report
    TEST_RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    report = TEST_RESULTS_DIR / f"{ts}_{_slug(prompt)}.md"
    lines = [
        "# Chat Local — Full Pipeline",
        "",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ",
        f"**Status:** ✅ SUCCESS  ",
        f"**Total:** {total_ms}ms  ",
        f"**Prompt:** {prompt}",
        "",
        "## Artifacts",
        "",
    ]
    if artifacts.get("handler"):
        lines += ["### handler.js", "", "```javascript", artifacts["handler"], "```", ""]
    if artifacts.get("migration"):
        lines += ["### migration.sql", "", "```sql", artifacts["migration"], "```", ""]
    if is_storefront and artifacts.get("widget_js"):
        lines += ["### widget.js", "", "```javascript", artifacts["widget_js"], "```", ""]
    if is_admin_ui and artifacts.get("admin_ui"):
        lines += ["### admin_ui.js", "", "```javascript", artifacts["admin_ui"], "```", ""]
    merchant_facing = explanation.get("merchantFacing", "")
    if merchant_facing:
        lines += ["", "## Explanation", "", merchant_facing]
    report.write_text("\n".join(lines) + "\n")

    _hr("━")
    print(f"  {_GREEN}SUCCESS{_RESET} — {total_ms / 1000:.1f}s — {report.relative_to(_HERE)}")
    _hr("━")
    print()

    if merchant_facing:
        _bot(merchant_facing)


if __name__ == "__main__":
    main()
