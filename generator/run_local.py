#!/usr/bin/env python3
"""
Local generation runner — fast iteration without any infrastructure.

Runs the full pipeline (product → architect → codespec → codegen → validate →
explanation) and appends the result to generator/results.json.
No Pub/Sub, no GCP, no API server needed — just ANTHROPIC_API_KEY.

USAGE
-----
  python run_local.py "notify me when a product is back in stock"
  python run_local.py --file prompt.txt
  python run_local.py "my prompt" --stop-after product

OUTPUT
------
  Console: one clean line per agent with status + timing + key info.
  File:    test_results/<timestamp>_<slug>.md  (markdown with full artifacts)
  JSON:    results.json  (appended, machine-readable)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

_HERE = Path(__file__).parent
os.chdir(_HERE)
sys.path.insert(0, str(_HERE))

from crews.feature_generator.agents import fetch_api_context, run_explanation_agent, run_product_agent
from subagents.architect_agent import run_architect_agent
from subagents.codespec_agent import run_codespec_agent
from subagents.base import CodegenContext
from subagents.registry import GENERATORS
from subagents.validation import (
    validate_architect,
    validate_codespec,
    validate_cross_artifact,
)

RESULTS_FILE = _HERE / "results.json"
TEST_RESULTS_DIR = _HERE / "test_results"

_W = 56


# ── Console output ────────────────────────────────────────────────────────────

def _hr(char: str = "━") -> None:
    print(char * _W)


def _agent_line(name: str, ok: bool, ms: int, notes: str = "") -> None:
    """Overwrite the spinner line with the final agent result."""
    icon = "✓" if ok else "✗"
    timing = f"{ms}ms"
    line = f"  {name:<12} {icon}  {timing:<8}  {notes}".rstrip()
    print(f"\r{line:<{_W}}")


def _spinner(name: str) -> None:
    """Print a 'running' placeholder that will be overwritten."""
    print(f"\r  {name:<12} …", end="", flush=True)


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

    stages = result.get("stages", {})
    artifacts = result.get("artifacts") or {}
    intent = result.get("intent") or {}
    architect = result.get("architect") or {}
    codespec = result.get("codespec") or {}
    is_storefront = result.get("archetype") == "storefront_ui"

    def ms_str(stage: str) -> str:
        return f"{stages[stage]['ms']}ms" if stage in stages else "—"

    # Build summary table rows
    shopify = architect.get("shopifyPlan") or {}
    impl = architect.get("implementationSpec") or {}
    cs = (codespec.get("codeSpec") or {})
    codegen_stage = stages.get("codegen") or {}
    val_attempts = codegen_stage.get("validation_attempts") or []
    val_errors = val_attempts[-1].get("errors") if val_attempts else {}

    def artifact_status(name: str) -> str:
        if not is_storefront and name == "widget_js":
            return "n/a"
        return "✓" if artifacts.get(name) else "✗"

    lines = [
        f"# Feature Generator — Run Result",
        f"",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ",
        f"**Status:** {'✅ SUCCESS' if result['status'] == 'success' else '❌ FAILED'}  ",
        f"**Total:** {result['total_ms']}ms  ",
        f"**Prompt:** {result['prompt']}",
        f"",
        f"## Pipeline",
        f"",
        f"| Agent       | Status | Time       | Notes |",
        f"|-------------|--------|------------|-------|",
    ]

    def intent_notes() -> str:
        return f"archetype={intent.get('appArchetype','?')}  trigger={intent.get('triggerType','?')}"

    def architect_notes() -> str:
        topics = shopify.get("webhookTopics") or []
        cron = shopify.get("cronSchedule") or "—"
        complexity = impl.get("complexity", "?")
        return f"complexity={complexity}  topics={topics}  cron={cron}  stateMachine={'yes' if impl.get('stateMachine') else 'no'}"

    def codespec_notes() -> str:
        return (
            f"webhook={len(cs.get('webhookPath') or [])} steps  "
            f"cron={len(cs.get('cronPath') or [])} steps  "
            f"widget={len(cs.get('widgetPath') or [])} steps  "
            f"functions={len(cs.get('functions') or [])}"
        )

    def codegen_notes() -> str:
        attempts = codegen_stage.get("attempts", "?")
        parts = [f"attempt {attempts}"]
        parts.append(f"handler {artifact_status('handler')}")
        parts.append(f"migration {artifact_status('migration')}")
        if is_storefront:
            parts.append(f"widget_js {artifact_status('widget_js')}")
        if val_errors:
            parts.append(f"errors: {list(val_errors.keys())}")
        return "  ".join(parts)

    agent_rows = [
        ("Product",     "product"     in stages, ms_str("product"),     intent_notes()),
        ("Architect",   "architect"   in stages, ms_str("architect"),   architect_notes()),
        ("CodeSpec",    "codespec"    in stages, ms_str("codespec"),    codespec_notes()),
        ("CodeGen",     "codegen"     in stages, ms_str("codegen"),     codegen_notes()),
        ("Explanation", "explanation" in stages, ms_str("explanation"), ""),
    ]

    for name, ok, t, notes in agent_rows:
        icon = "✓" if ok else "—"
        lines.append(f"| {name:<11} | {icon:<6} | {t:<10} | {notes} |")

    # Product detail
    if intent:
        lines += [
            f"",
            f"## Product Spec",
            f"",
            f"```json",
            json.dumps(intent, indent=2),
            f"```",
        ]

    # Architect detail
    if architect:
        lines += [
            f"",
            f"## Architect Plan",
            f"",
            f"```json",
            json.dumps(architect, indent=2),
            f"```",
        ]

    # CodeSpec detail
    if codespec:
        lines += [
            f"",
            f"## CodeSpec",
            f"",
            f"```json",
            json.dumps(codespec, indent=2),
            f"```",
        ]

    # Artifacts
    if artifacts:
        lines += [f"", f"## Artifacts", f""]

        if artifacts.get("handler"):
            lines += [f"### handler.js", f"", f"```javascript", artifacts["handler"], f"```", f""]

        if artifacts.get("migration"):
            lines += [f"### migration.sql", f"", f"```sql", artifacts["migration"], f"```", f""]

        if is_storefront and artifacts.get("widget_js"):
            lines += [f"### widget.js", f"", f"```javascript", artifacts["widget_js"], f"```", f""]

    # Explanation
    explanation = result.get("explanation")
    if explanation:
        lines += [f"", f"## Explanation", f"", str(explanation)]

    # Error
    if result.get("error"):
        lines += [f"", f"## Error", f"", f"```", result["error"], f"```"]

    path.write_text("\n".join(lines) + "\n")
    return path


# ── Stage runner ──────────────────────────────────────────────────────────────

class StageError(Exception):
    pass


def _run_with_retry(
    label: str,
    run_fn,
    validate_fn,
    run_args: tuple,
    max_attempts: int = 2,
) -> Any:
    errors: List[str] = []
    for attempt in range(1, max_attempts + 1):
        _spinner(label)
        t0 = time.monotonic()
        output = run_fn(*run_args, validation_errors=errors if attempt > 1 else None)
        ms = int((time.monotonic() - t0) * 1000)

        errors = validate_fn(output)
        if not errors:
            return output, ms

        retry_note = f"attempt {attempt}/{max_attempts} — {errors[0][:40]}"
        _agent_line(label, ok=False, ms=ms, notes=retry_note)

        if attempt == max_attempts:
            raise StageError(f"{label} failed after {max_attempts} attempts: {errors}")

    return None, 0  # unreachable


def _run_codegen_parallel(
    plan: Dict,
    intent: Dict,
    platform_api_catalog: List[Dict],
    is_storefront: bool,
    error_map: Dict[str, List[str]],
    artifacts: Dict[str, str],
) -> Dict[str, str]:
    to_run = [
        gen for name, gen in GENERATORS.items()
        if not (name == "widget_js" and not is_storefront)
        and (name in error_map or name not in artifacts)
    ]
    if not to_run:
        return artifacts
    with ThreadPoolExecutor(max_workers=len(to_run)) as pool:
        futures = {
            gen.name: pool.submit(
                gen.generate,
                CodegenContext(
                    intent=intent,
                    plan=plan,
                    platform_api_catalog=platform_api_catalog,
                    previous_errors=error_map.get(gen.name),
                ),
            )
            for gen in to_run
        }
        for name, future in futures.items():
            artifacts[name] = future.result()
    return artifacts


def _validate_artifacts(
    artifacts: Dict[str, str],
    plan: Dict,
    intent: Dict,
    platform_api_catalog: List[Dict],
    is_storefront: bool,
) -> Dict[str, List[str]]:
    ctx = CodegenContext(intent=intent, plan=plan, platform_api_catalog=platform_api_catalog)
    error_map: Dict[str, List[str]] = {}
    for name, gen in GENERATORS.items():
        if name == "widget_js" and not is_storefront:
            continue
        errs = gen.validate(artifacts.get(name, ""), ctx)
        if errs:
            error_map[name] = errs
    if is_storefront and "widget_js" not in error_map and "handler" not in error_map:
        for gen_name, errs in validate_cross_artifact(
            artifacts.get("widget_js", ""), artifacts.get("handler", "")
        ).items():
            if errs:
                error_map.setdefault(gen_name, []).extend(errs)
    return error_map


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run(prompt: str, stop_after: Optional[str]) -> None:
    run_id = datetime.now().isoformat()
    result: Dict[str, Any] = {
        "id": run_id,
        "prompt": prompt,
        "status": "error",
        "error": None,
        "total_ms": 0,
        "stages": {},
    }

    _hr()
    print(f"  Feature Generator")
    print(f"  Prompt: {prompt}")
    _hr()
    print()

    total_start = time.monotonic()

    try:
        # ── Product ───────────────────────────────────────────────────────────
        _spinner("Product")
        t0 = time.monotonic()
        intent = run_product_agent(prompt)
        ms = int((time.monotonic() - t0) * 1000)
        result["stages"]["product"] = {"ms": ms}
        result["intent"] = intent

        archetype: str = intent.get("appArchetype") or "backend_only"
        result["archetype"] = archetype
        _agent_line("Product", ok=True, ms=ms,
                    notes=f"archetype={archetype}  trigger={intent.get('triggerType')}")

        if stop_after == "product":
            return

        # ── Architect ─────────────────────────────────────────────────────────
        api_context = fetch_api_context(
            intent.get("resources", []),
            intent_description=intent.get("desiredOutcome", ""),
        )
        architect_output, arch_ms = _run_with_retry(
            label="Architect",
            run_fn=run_architect_agent,
            validate_fn=lambda out: validate_architect(out, app_archetype=archetype),
            run_args=(prompt, intent, archetype, api_context),
        )
        result["stages"]["architect"] = {"ms": arch_ms}
        result["architect"] = architect_output

        shopify = architect_output.get("shopifyPlan") or {}
        impl = architect_output.get("implementationSpec") or {}
        _agent_line("Architect", ok=True, ms=arch_ms,
                    notes=f"complexity={impl.get('complexity', '?')}  "
                          f"topics={shopify.get('webhookTopics')}  "
                          f"cron={shopify.get('cronSchedule') or '—'}  "
                          f"stateMachine={'yes' if impl.get('stateMachine') else 'no'}")

        if stop_after == "architect":
            return

        # ── CodeSpec ──────────────────────────────────────────────────────────
        codespec_output, cs_ms = _run_with_retry(
            label="CodeSpec",
            run_fn=run_codespec_agent,
            validate_fn=lambda out: validate_codespec(out, architect_output),
            run_args=(prompt, intent, architect_output, api_context),
        )
        result["stages"]["codespec"] = {"ms": cs_ms}
        result["codespec"] = codespec_output

        cs = codespec_output.get("codeSpec") or {}
        _agent_line("CodeSpec", ok=True, ms=cs_ms,
                    notes=f"webhook={len(cs.get('webhookPath') or [])} steps  "
                          f"cron={len(cs.get('cronPath') or [])} steps  "
                          f"widget={len(cs.get('widgetPath') or [])} steps  "
                          f"functions={len(cs.get('functions') or [])}")

        plan: Dict = {
            **architect_output,
            "implementationSpec": {
                **(architect_output.get("implementationSpec") or {}),
                "codeSpec": cs,
            },
        }
        result["plan"] = plan

        if stop_after == "codespec":
            return

        # ── CodeGen + Validation ───────────────────────────────────────────────
        catalog_dicts = (plan.get("implementationSpec") or {}).get("widgetApiCatalog") or []
        is_storefront = archetype == "storefront_ui"

        artifacts: Dict[str, str] = {}
        error_map: Dict[str, List[str]] = {}
        MAX_RETRIES = 3
        validation_attempts: List[Dict] = []

        for attempt in range(1, MAX_RETRIES + 1):
            _spinner("CodeGen")
            t0 = time.monotonic()
            artifacts = _run_codegen_parallel(plan, intent, catalog_dicts, is_storefront, error_map, artifacts)
            gen_ms = int((time.monotonic() - t0) * 1000)

            error_map = _validate_artifacts(artifacts, plan, intent, catalog_dicts, is_storefront)

            validation_attempts.append({
                "attempt": attempt,
                "errors": dict(error_map) if error_map else {},
            })

            if not error_map:
                artifact_notes = "  ".join(
                    f"{n} ✓" for n in (["handler", "migration"] + (["widget_js"] if is_storefront else []))
                    if artifacts.get(n)
                )
                _agent_line("CodeGen", ok=True, ms=gen_ms,
                            notes=f"attempt {attempt}  {artifact_notes}")
                result["stages"]["codegen"] = {"ms": gen_ms, "attempts": attempt,
                                               "validation_attempts": validation_attempts}
                break

            error_summary = "  ".join(f"{n}:{errs[0][:30]}" for n, errs in error_map.items())
            _agent_line("CodeGen", ok=False, ms=gen_ms,
                        notes=f"attempt {attempt}/{MAX_RETRIES}  {error_summary}")

            if attempt == MAX_RETRIES:
                result["stages"]["codegen"] = {"ms": gen_ms, "attempts": attempt,
                                               "validation_attempts": validation_attempts}
                result["artifacts"] = {
                    "handler": artifacts.get("handler", ""),
                    "migration": artifacts.get("migration", ""),
                    "widget_js": artifacts.get("widget_js") if is_storefront else None,
                }
                raise StageError(f"validation failed after {MAX_RETRIES} attempts: {error_map}")

        result["artifacts"] = {
            "handler": artifacts.get("handler", ""),
            "migration": artifacts.get("migration", ""),
            "widget_js": artifacts.get("widget_js") if is_storefront else None,
        }

        if stop_after == "codegen":
            return

        # ── Explanation ────────────────────────────────────────────────────────
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
        _agent_line("Explanation", ok=True, ms=ms)
        result["stages"]["explanation"] = {"ms": ms}
        result["explanation"] = explanation

        result["status"] = "success"

    except StageError as e:
        result["error"] = str(e)
        print(f"\n  FAILED: {e}")

    finally:
        result["total_ms"] = int((time.monotonic() - total_start) * 1000)
        _append_result(result)
        report_path = _save_report(result)

        print()
        _hr()
        status = "SUCCESS" if result["status"] == "success" else "FAILED"
        total_s = result["total_ms"] / 1000
        print(f"  {status} — {total_s:.1f}s — {report_path.relative_to(_HERE)}")
        _hr()
        print()

        if result["status"] == "error":
            sys.exit(1)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the feature generator pipeline locally.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("prompt", nargs="?",
                        help="Merchant feature request (quote it).")
    parser.add_argument("--file", "-f", metavar="PATH",
                        help="Read prompt from a text file.")
    parser.add_argument("--stop-after",
                        choices=["product", "architect", "codespec", "codegen"],
                        metavar="STAGE",
                        help="Stop after STAGE. Choices: product, architect, codespec, codegen")

    args = parser.parse_args()

    if args.file:
        prompt = Path(args.file).read_text().strip()
    elif args.prompt:
        prompt = args.prompt.strip()
    else:
        parser.error("Provide a prompt as a positional argument or via --file.")
        return

    if not prompt:
        parser.error("Prompt is empty.")

    run(prompt=prompt, stop_after=args.stop_after)


if __name__ == "__main__":
    main()
