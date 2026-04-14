#!/usr/bin/env python3
"""
Local generation runner — fast iteration without any infrastructure.

Runs the exact same production pipeline (run_feature_generation) by patching
contract.publisher in-process to intercept progress events and the final bundle.
No Pub/Sub, no GCP, no API server needed — just ANTHROPIC_API_KEY.

USAGE
-----
  python run_local.py "notify me when a product is back in stock"
  python run_local.py --file prompt.txt
  python run_local.py --dir test_prompts/
  python run_local.py --arch-only "notify me when a product is back in stock"
  python run_local.py --arch-only --file prompt.txt
  python run_local.py --arch-only --dir test_prompts/

OUTPUT
------
  Console: one clean line per agent with status + timing
  File:    test_results/<timestamp>_<slug>.md  (markdown with full artifacts)
  JSON:    results.json  (appended, machine-readable)

  --arch-only mode:
  File:    test_results/<timestamp>_<slug>_arch.json  (pretty-printed architect plan)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

_HERE = Path(__file__).resolve().parent
_GENERATOR_ROOT = _HERE.parent
os.chdir(_GENERATOR_ROOT)
sys.path.insert(0, str(_GENERATOR_ROOT))

import contract.publisher as _publisher
from contract.validators import FeatureBundleMessage, GenerationRequest, ProgressEvent
from crews.feature_generator.crew import run_feature_generation
from subagents.architect_agent import run_architect_agent
from subagents.product_agent import run_product_agent
from shopify_mcp.client import prefetch_for_run
from subagents.static_validation import validate_architect_plan

RESULTS_FILE = _HERE / "results.json"
TEST_RESULTS_DIR = _HERE / "test_results"

_W = 100

# Agent display labels — must cover every agent value in the ProgressEvent Literal.
_LABELS: Dict[str, str] = {
    "product": "Product",
    "architect": "Architect",
    "handler": "Handler",
    "migration": "Migration",
    "widget_js": "Widget JS",
    "admin_ui": "Admin UI",
    "validation": "Validation",
    "validator": "Validator",
    "revision": "Revision",
    "explanation": "Explanation",
}

# Report row order — agents that may or may not appear are added conditionally.
_PLAN_AGENTS = ["product", "architect"]
_CODEGEN_AGENTS = ["handler", "migration", "widget_js", "admin_ui"]
# Tail agents always present; validator+revision inserted only when they actually ran.
_TAIL_AGENTS = ["validation", "explanation"]


# ── Console output ────────────────────────────────────────────────────────────


def _hr(char: str = "━") -> None:
    print(char * _W)


def _agent_line(name: str, ok: bool, ms: Optional[int], notes: str = "") -> None:
    """Print a final result line for an agent, overwriting the current spinner."""
    icon = "✓" if ok else "✗"
    timing = f"{ms}ms" if ms is not None else "—"
    line = f"  {name:<12} {icon}  {timing:<8}  {notes}".rstrip()
    print(f"\r{line:<{_W}}")


def _spinner(name: str) -> None:
    """Print a 'running' placeholder that will be overwritten by _agent_line."""
    print(f"\r  {name:<12} …", end="", flush=True)


def _retry_line(name: str, notes: str) -> None:
    """Print a retry notice without consuming the agent's timing slot."""
    line = f"  {name:<12} ↻  {'':8}  {notes}".rstrip()
    print(f"\r{line:<{_W}}")


# ── results.json persistence ──────────────────────────────────────────────────


def _append_result(result: Dict[str, Any]) -> None:
    existing: List[Dict[str, Any]] = []
    if RESULTS_FILE.exists():
        try:
            data = json.loads(RESULTS_FILE.read_text())
            if isinstance(data, list):
                existing = data
            elif isinstance(data, dict):
                existing = [data]
        except (json.JSONDecodeError, ValueError):
            pass
    existing.append(result)
    RESULTS_FILE.write_text(json.dumps(existing, indent=2))


# ── Markdown report ───────────────────────────────────────────────────────────


def _slug(text: str, max_words: int = 6) -> str:
    words = re.sub(r"[^a-z0-9 ]", "", text.lower()).split()
    return "-".join(words[:max_words])


def _save_report(result: Dict[str, Any]) -> Path:
    TEST_RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    slug = _slug(result.get("prompt", "run"))
    path = TEST_RESULTS_DIR / f"{ts}_{slug}.md"

    artifacts = result.get("artifacts") or {}
    stages = result.get("stages") or {}

    # Determine which optional agents were active — prefer stages over artifacts
    # so the report is accurate even on failure (artifacts may be empty on fail).
    is_storefront = "widget_js" in stages or bool(artifacts.get("widget_js"))
    is_admin_ui = "admin_ui" in stages or bool(artifacts.get("admin_ui"))

    def ms_str(stage: str) -> str:
        entry = stages.get(stage)
        if not entry:
            return "—"
        return f"{entry['ms']}ms"

    def stage_icon(stage: str) -> str:
        entry = stages.get(stage)
        if not entry:
            return "—"
        return "✓" if entry.get("ok", True) else "✗"

    lines = [
        "# Feature Generator — Run Result",
        "",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ",
        f"**Status:** {'✅ SUCCESS' if result['status'] == 'success' else '❌ FAILED'}  ",
        f"**Total:** {result['total_ms']}ms  ",
        f"**Prompt:** {result['prompt']}",
        "",
        "## Pipeline",
        "",
        "| Agent       | Status | Time       |",
        "|-------------|--------|------------|",
    ]

    agent_rows = list(_PLAN_AGENTS)
    for a in _CODEGEN_AGENTS:
        if a == "widget_js" and not is_storefront:
            continue
        if a == "admin_ui" and not is_admin_ui:
            continue
        agent_rows.append(a)
    # Insert optional agents (validator, revision) before explanation only if they ran.
    for a in ["validator", "revision"]:
        if a in stages:
            agent_rows.append(a)
    agent_rows.extend(_TAIL_AGENTS)

    for agent in agent_rows:
        label = _LABELS.get(agent, agent)
        lines.append(f"| {label:<11} | {stage_icon(agent):<6} | {ms_str(agent):<10} |")

    if artifacts:
        lines += ["", "## Artifacts", ""]

        if artifacts.get("handler"):
            lines += [
                "### handler.js",
                "",
                "```javascript",
                artifacts["handler"],
                "```",
                "",
            ]

        if artifacts.get("migration"):
            lines += [
                "### migration.sql",
                "",
                "```sql",
                artifacts["migration"],
                "```",
                "",
            ]

        if artifacts.get("widget_js"):
            lines += [
                "### widget.js",
                "",
                "```javascript",
                artifacts["widget_js"],
                "```",
                "",
            ]

        if artifacts.get("admin_ui"):
            lines += [
                "### admin_ui.js",
                "",
                "```javascript",
                artifacts["admin_ui"],
                "```",
                "",
            ]

    explanation = result.get("explanation")
    if explanation:
        lines += ["", "## Explanation", "", str(explanation)]

    if result.get("error"):
        lines += ["", "## Error", "", "```", result["error"], "```"]

    path.write_text("\n".join(lines) + "\n")
    return path


# ── Arch-only runner ──────────────────────────────────────────────────────────


def _save_arch_report(
    prompt: str, intent: Dict[str, Any], plan: Dict[str, Any], errors: List[str]
) -> Path:
    TEST_RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    slug = _slug(prompt)
    path = TEST_RESULTS_DIR / f"{ts}_{slug}_arch.json"
    path.write_text(
        json.dumps(
            {
                "prompt": prompt,
                "intent": intent,
                "plan": plan,
                "validation_errors": errors,
            },
            indent=2,
        )
    )
    return path


def run_arch_only(prompt: str) -> None:
    _hr()
    print("  Architect — plan review mode")
    print(f"  Prompt: {prompt}")
    _hr()
    print()

    total_start = time.monotonic()

    # Product agent
    _spinner(_LABELS["product"])
    t0 = time.monotonic()
    intent, _prod_in, _prod_out = run_product_agent(prompt)
    ms = int((time.monotonic() - t0) * 1000)
    _agent_line(_LABELS["product"], ok=True, ms=ms, notes=intent.get("appCategory", ""))

    # Prefetch API context
    api_context = prefetch_for_run(
        intent.get("resources", []), intent.get("desiredOutcome", "")
    )

    # Architect agent (with validation retry)
    archetype = intent.get("appCategory", "")
    plan: Dict[str, Any] = {}
    errors: List[str] = []
    _MAX_ARCH_ATTEMPTS = 3
    for attempt in range(1, _MAX_ARCH_ATTEMPTS + 1):
        _spinner(_LABELS["architect"])
        t0 = time.monotonic()
        plan, _arch_in, _arch_out = run_architect_agent(
            prompt=prompt,
            intent=intent,
            app_archetype=archetype,
            api_context=api_context,
            validation_errors=errors if attempt > 1 else None,
        )
        ms = int((time.monotonic() - t0) * 1000)
        errors = validate_architect_plan(plan, app_archetype=archetype)
        if not errors:
            _agent_line(
                _LABELS["architect"], ok=True, ms=ms, notes=f"attempt {attempt}"
            )
            break
        _agent_line(
            _LABELS["architect"],
            ok=False,
            ms=ms,
            notes=f"attempt {attempt} — {len(errors)} error(s)",
        )
        if attempt < _MAX_ARCH_ATTEMPTS:
            _retry_line(_LABELS["architect"], notes="; ".join(errors[:2]))

    total_ms = int((time.monotonic() - total_start) * 1000)

    # Pretty-print the plan to console
    print()
    _hr()
    print()
    print(json.dumps({"intent": intent, "plan": plan}, indent=2))
    print()
    _hr()

    # Save report
    report_path = _save_arch_report(prompt, intent, plan, errors)
    ok = not errors
    status = "SUCCESS" if ok else f"FAILED — {len(errors)} validation error(s)"
    print(f"  {status} — {total_ms / 1000:.1f}s — {report_path.relative_to(_HERE)}")
    _hr()
    print()

    if not ok:
        sys.exit(1)


def run_arch_only_dir(dir_path: Path) -> None:
    """Run arch-only on every *.txt file in dir_path."""
    files = sorted(dir_path.glob("*.txt"))
    if not files:
        print(f"No .txt files found in {dir_path}")
        sys.exit(1)

    print(f"Found {len(files)} prompt file(s) in {dir_path.name}/")
    print()

    failed: List[str] = []
    for i, f in enumerate(files, 1):
        prompt = f.read_text().strip()
        if not prompt:
            print(f"[{i}/{len(files)}] Skipping {f.name} — empty")
            continue
        print(f"[{i}/{len(files)}] {f.name}")
        try:
            run_arch_only(prompt=prompt)
        except SystemExit:
            failed.append(f.name)

    print()
    if failed:
        print(f"FAILED ({len(failed)}/{len(files)}): {', '.join(failed)}")
        sys.exit(1)
    else:
        print(f"All {len(files)} prompts completed successfully.")


# ── Main runner ───────────────────────────────────────────────────────────────


def run(prompt: str) -> None:
    job_id = str(uuid.uuid4())
    result: Dict[str, Any] = {
        "id": job_id,
        "prompt": prompt,
        "status": "error",
        "error": None,
        "total_ms": 0,
        "stages": {},
        "artifacts": {},
    }

    _hr()
    print("  Feature Generator")
    print(f"  Prompt: {prompt}")
    _hr()
    print()

    # Per-agent wall-clock start times. Keyed by agent name.
    # On retry: the "running" event resets the clock so timing reflects the retry only.
    _start_times: Dict[str, float] = {}
    _bundle_holder: List[FeatureBundleMessage] = []

    def _on_progress(event: ProgressEvent) -> None:
        label = _LABELS.get(event.agent, event.agent)

        if event.status == "running":
            # Reset clock on every "running" — includes retry starts.
            _start_times[event.agent] = time.monotonic()
            _spinner(label)

        elif event.status == "completed":
            t0 = _start_times.pop(event.agent, time.monotonic())
            ms = int((time.monotonic() - t0) * 1000)
            result["stages"][event.agent] = {"ms": ms, "ok": True}
            _agent_line(label, ok=True, ms=ms, notes=event.message)

        elif event.status == "failed":
            t0 = _start_times.pop(event.agent, time.monotonic())
            ms = int((time.monotonic() - t0) * 1000)
            result["stages"][event.agent] = {"ms": ms, "ok": False}
            _agent_line(label, ok=False, ms=ms, notes=event.message)

        elif event.status == "retrying":
            # Print a retry notice. Don't record a stage time — the next
            # "running" event will reset the clock for the retry attempt.
            _start_times.pop(event.agent, None)
            _retry_line(label, notes=event.message)

    def _on_completed(msg: FeatureBundleMessage) -> None:
        _bundle_holder.append(msg)

    # Patch contract.publisher in-process — crew.py calls through the module
    # reference (_contract_publisher.publish_*) so this patch lands correctly.
    _orig_progress = _publisher.publish_progress
    _orig_completed = _publisher.publish_completed
    _publisher.publish_progress = _on_progress  # type: ignore[assignment]
    _publisher.publish_completed = _on_completed  # type: ignore[assignment]

    total_start = time.monotonic()
    try:
        request = GenerationRequest(
            jobId=job_id,
            tenantId=str(uuid.uuid4()),
            appId=str(uuid.uuid4()),
            prompt=prompt,
        )
        run_feature_generation(request)
    finally:
        _publisher.publish_progress = _orig_progress
        _publisher.publish_completed = _orig_completed
        result["total_ms"] = int((time.monotonic() - total_start) * 1000)

    # Unpack the bundle into the result dict
    if _bundle_holder:
        msg = _bundle_holder[0]
        result["status"] = msg.status
        result["error"] = msg.error
        if msg.bundle:
            b = msg.bundle
            result["artifacts"] = {
                "handler": b.handlerModule.code,
                "migration": b.dbMigration.sql,
                "widget_js": b.widgetModule,
                "admin_ui": b.adminUiModule,
            }
            result["explanation"] = b.explanation.merchantFacing
    else:
        result["error"] = "No completion event received from run_feature_generation"

    _append_result(result)
    report_path = _save_report(result)

    print()
    _hr()
    status = "SUCCESS" if result["status"] == "success" else "FAILED"
    total_s = result["total_ms"] / 1000
    print(f"  {status} — {total_s:.1f}s — {report_path.relative_to(_HERE)}")
    _hr()
    print()

    if result["status"] != "success":
        sys.exit(1)


def run_dir(dir_path: Path) -> None:
    """Run every *.txt file in dir_path as a separate prompt, one by one."""
    files = sorted(dir_path.glob("*.txt"))
    if not files:
        print(f"No .txt files found in {dir_path}")
        sys.exit(1)

    print(f"Found {len(files)} prompt file(s) in {dir_path.name}/")
    print()

    failed: List[str] = []
    for i, f in enumerate(files, 1):
        prompt = f.read_text().strip()
        if not prompt:
            print(f"[{i}/{len(files)}] Skipping {f.name} — empty")
            continue
        print(f"[{i}/{len(files)}] {f.name}")
        try:
            run(prompt=prompt)
        except SystemExit as exc:
            # run() calls sys.exit(1) on failure — catch so the loop continues
            failed.append(f.name)

    print()
    if failed:
        print(f"FAILED ({len(failed)}/{len(files)}): {', '.join(failed)}")
        sys.exit(1)
    else:
        print(f"All {len(files)} prompts completed successfully.")


# ── CLI ───────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the feature generator pipeline locally.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "prompt", nargs="?", help="Merchant feature request (quote it)."
    )
    parser.add_argument(
        "--file", "-f", metavar="PATH", help="Read prompt from a text file."
    )
    parser.add_argument(
        "--dir",
        "-d",
        metavar="DIR",
        help="Run all *.txt files in DIR as prompts, one by one.",
    )
    parser.add_argument(
        "--arch-only",
        action="store_true",
        help="Run only product + architect agents and print the plan. Skips code generation.",
    )

    args = parser.parse_args()

    if args.arch_only:
        if args.dir:
            run_arch_only_dir(Path(args.dir))
        elif args.file:
            prompt = Path(args.file).read_text().strip()
            if not prompt:
                parser.error("Prompt file is empty.")
            run_arch_only(prompt=prompt)
        elif args.prompt:
            prompt = args.prompt.strip()
            if not prompt:
                parser.error("Prompt is empty.")
            run_arch_only(prompt=prompt)
        else:
            parser.error("Provide a prompt, --file PATH, or --dir DIR.")
    elif args.dir:
        run_dir(Path(args.dir))
    elif args.file:
        prompt = Path(args.file).read_text().strip()
        if not prompt:
            parser.error("Prompt file is empty.")
        run(prompt=prompt)
    elif args.prompt:
        prompt = args.prompt.strip()
        if not prompt:
            parser.error("Prompt is empty.")
        run(prompt=prompt)
    else:
        parser.error("Provide a prompt, --file PATH, or --dir DIR.")


if __name__ == "__main__":
    main()
