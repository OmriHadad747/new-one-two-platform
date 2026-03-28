#!/usr/bin/env python3
"""
Local generation runner — fast iteration without any infrastructure.

Runs the full pipeline (intent → architect → codespec → codegen → validate →
explanation) and appends the result to generator/results.json.
No Pub/Sub, no GCP, no API server needed — just ANTHROPIC_API_KEY.

USAGE
-----
  # Run from anywhere — the script anchors itself to the generator/ directory
  python run_local.py "notify me when a product is back in stock"
  python run_local.py "back-in-stock signup widget"

  # Stop after a specific stage to inspect intermediate output
  python run_local.py "my prompt" --stop-after architect
  python run_local.py "my prompt" --stop-after codespec

  # Read a long prompt from a file
  python run_local.py --file prompt.txt

OUTPUT
------
  Each run appends one entry to generator/results.json:
    id            — ISO timestamp of the run
    prompt        — original prompt
    archetype     — storefront_ui | backend_only (decided by Intent agent)
    status        — "success" | "error"
    error         — error message if status is "error", else null
    total_ms      — wall-clock time for the full run
    stages        — per-stage timing { intent, architect, codespec, codegen, explanation }
    intent        — Intent agent output
    architect     — Architect agent output
    codespec      — CodeSpec agent output
    plan          — merged plan passed to generators
    artifacts     — { handler, migration, widget_js }
    explanation   — Explanation agent output

REQUIREMENTS
------------
  ANTHROPIC_API_KEY set in environment or in .env file in the generator/ directory.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

# Anchor to the generator/ directory so that:
#   1. Module imports (from models.adapter import ...) resolve correctly.
#   2. pydantic-settings finds .env via its env_file=".env" setting.
_HERE = Path(__file__).parent
os.chdir(_HERE)
sys.path.insert(0, str(_HERE))

from crews.feature_generator.agents import load_schema_fragments, run_explanation_agent, run_intent_agent
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


# ── Formatting helpers ────────────────────────────────────────────────────────

_W = 64


def _hr(char: str = "─") -> None:
    print(char * _W)


def _header(title: str) -> None:
    _hr("━")
    print(f"  {title}")
    _hr("━")


def _ok(label: str, ms: int) -> None:
    print(f"  ✓  {label:<38}  {ms:>5} ms")


def _fail(label: str, errors: List[str]) -> None:
    print(f"  ✗  {label}")
    for e in errors:
        print(f"       – {e}")


def _section(title: str) -> None:
    print()
    _hr()
    print(f"  {title}")
    _hr()


# ── results.json persistence ──────────────────────────────────────────────────

def _append_result(result: Dict[str, Any]) -> None:
    existing: List[Dict[str, Any]] = []
    if RESULTS_FILE.exists():
        try:
            data = json.loads(RESULTS_FILE.read_text())
            if isinstance(data, list):
                existing = data
            elif isinstance(data, dict):
                existing = [data]  # single legacy result — migrate to array
        except (json.JSONDecodeError, ValueError):
            pass  # corrupted file — start fresh
    existing.append(result)
    RESULTS_FILE.write_text(json.dumps(existing, indent=2))


# ── Stage runner ──────────────────────────────────────────────────────────────

class StageError(Exception):
    """Raised when a planning stage fails validation after all retries."""


def _run_with_retry(
    label: str,
    run_fn,
    validate_fn,
    run_args: tuple,
    max_attempts: int = 2,
) -> Any:
    errors: List[str] = []
    for attempt in range(1, max_attempts + 1):
        t0 = time.monotonic()
        output = run_fn(*run_args, validation_errors=errors if attempt > 1 else None)
        ms = int((time.monotonic() - t0) * 1000)

        errors = validate_fn(output)
        if not errors:
            _ok(f"{label} (attempt {attempt})", ms)
            return output

        _fail(f"{label} (attempt {attempt}/{max_attempts})", errors)

        if attempt == max_attempts:
            raise StageError(f"{label} failed after {max_attempts} attempts: {errors}")

        print("       → retrying with errors injected…")

    return None  # unreachable


def _run_codegen_parallel(
    plan: Dict,
    intent: Dict,
    platform_api_catalog: List[Dict],
    is_storefront: bool,
    error_map: Dict[str, List[str]],
    artifacts: Dict[str, str],
) -> Dict[str, str]:
    to_run = []
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
        cross_errors = validate_cross_artifact(
            artifacts.get("widget_js", ""),
            artifacts.get("handler", ""),
        )
        for gen_name, errs in cross_errors.items():
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

    _header("Feature Generator — local run")
    print(f"  Prompt : {prompt[:72]}")
    print()

    total_start = time.monotonic()

    try:
        # ── Intent ────────────────────────────────────────────────────────────
        _section("Agent 1 — Intent")
        t0 = time.monotonic()
        intent = run_intent_agent(prompt)
        ms = int((time.monotonic() - t0) * 1000)
        _ok("intent parsed", ms)
        result["stages"]["intent"] = {"ms": ms}
        result["intent"] = intent

        archetype: str = intent.get("appArchetype") or "backend_only"
        result["archetype"] = archetype
        print(f"  archetype={archetype}  trigger={intent.get('triggerType')}  "
              f"resources={intent.get('resources')}")

        if stop_after == "intent":
            return

        # ── Architect ─────────────────────────────────────────────────────────
        _section("Agent 2 — Architect")
        schema_fragments = load_schema_fragments(intent.get("resources", []))
        t0 = time.monotonic()
        architect_output = _run_with_retry(
            label="architect",
            run_fn=run_architect_agent,
            validate_fn=lambda out: validate_architect(out, app_archetype=archetype),
            run_args=(prompt, intent, archetype, schema_fragments),
        )
        result["stages"]["architect"] = {"ms": int((time.monotonic() - t0) * 1000)}
        result["architect"] = architect_output

        shopify = architect_output.get("shopifyPlan") or {}
        impl = architect_output.get("implementationSpec") or {}
        print(f"  topics={shopify.get('webhookTopics')}  cron={shopify.get('cronSchedule')}")
        print(f"  stateMachine={'yes' if impl.get('stateMachine') else 'no'}  "
              f"cronBatching={'yes' if (impl.get('cronBatching') or {}).get('required') else 'no'}  "
              f"catalog={[e['path'] for e in (impl.get('widgetApiCatalog') or [])]}")

        if stop_after == "architect":
            return

        # ── CodeSpec ──────────────────────────────────────────────────────────
        _section("Agent 3 — CodeSpec")
        t0 = time.monotonic()
        codespec_output = _run_with_retry(
            label="codespec",
            run_fn=run_codespec_agent,
            validate_fn=lambda out: validate_codespec(out, architect_output),
            run_args=(prompt, intent, architect_output),
        )
        result["stages"]["codespec"] = {"ms": int((time.monotonic() - t0) * 1000)}
        result["codespec"] = codespec_output

        cs = codespec_output.get("codeSpec") or {}
        print(f"  webhook_steps={len(cs.get('webhookPath') or [])}  "
              f"cron_steps={len(cs.get('cronPath') or [])}  "
              f"widget_steps={len(cs.get('widgetPath') or [])}  "
              f"functions={len(cs.get('functions') or [])}")

        plan: Dict = {
            **architect_output,
            "implementationSpec": {
                **(architect_output.get("implementationSpec") or {}),
                "codeSpec": codespec_output.get("codeSpec") or {},
            },
        }
        result["plan"] = plan

        if stop_after == "codespec":
            return

        # ── CodeGen + Validation ───────────────────────────────────────────────
        _section("Agent 4 — CodeGen  +  Agent 5 — Validation")

        catalog_dicts = (plan.get("implementationSpec") or {}).get("widgetApiCatalog") or []
        is_storefront = archetype == "storefront_ui"

        artifacts: Dict[str, str] = {}
        error_map: Dict[str, List[str]] = {}
        MAX_RETRIES = 3
        validation_attempts: List[Dict] = []

        for attempt in range(1, MAX_RETRIES + 1):
            t0 = time.monotonic()
            artifacts = _run_codegen_parallel(
                plan, intent, catalog_dicts, is_storefront, error_map, artifacts
            )
            gen_ms = int((time.monotonic() - t0) * 1000)

            t0 = time.monotonic()
            error_map = _validate_artifacts(artifacts, plan, intent, catalog_dicts, is_storefront)
            val_ms = int((time.monotonic() - t0) * 1000)

            validation_attempts.append({
                "attempt": attempt,
                "errors": {name: errs for name, errs in error_map.items()} if error_map else {},
            })

            if not error_map:
                _ok(f"codegen + validation (attempt {attempt})", gen_ms + val_ms)
                result["stages"]["codegen"] = {
                    "ms": gen_ms,
                    "attempts": attempt,
                    "validation_attempts": validation_attempts,
                }
                break

            _fail(f"validation (attempt {attempt}/{MAX_RETRIES})", [
                f"{name}: {e}" for name, errs in error_map.items() for e in errs
            ])

            if attempt == MAX_RETRIES:
                result["stages"]["codegen"] = {
                    "ms": gen_ms,
                    "attempts": attempt,
                    "validation_attempts": validation_attempts,
                }
                result["artifacts"] = {
                    "handler": artifacts.get("handler", ""),
                    "migration": artifacts.get("migration", ""),
                    "widget_js": artifacts.get("widget_js") if is_storefront else None,
                }
                raise StageError(f"validation failed after {MAX_RETRIES} attempts: {error_map}")

            print("       → retrying failing generators…")

        result["artifacts"] = {
            "handler": artifacts.get("handler", ""),
            "migration": artifacts.get("migration", ""),
            "widget_js": artifacts.get("widget_js") if is_storefront else None,
        }

        if stop_after == "codegen":
            return

        # ── Explanation ────────────────────────────────────────────────────────
        _section("Agent 6 — Explanation")
        t0 = time.monotonic()
        explanation = run_explanation_agent(
            intent=intent,
            plan=plan,
            widget_js_code=artifacts.get("widget_js", "") if is_storefront else "",
            handler_code=artifacts.get("handler", ""),
            migration_sql=artifacts.get("migration", ""),
        )
        ms = int((time.monotonic() - t0) * 1000)
        _ok("explanation written", ms)
        result["stages"]["explanation"] = {"ms": ms}
        result["explanation"] = explanation

        result["status"] = "success"

    except StageError as e:
        result["error"] = str(e)
        print(f"\n  FAILED: {e}")

    finally:
        result["total_ms"] = int((time.monotonic() - total_start) * 1000)
        _append_result(result)

        print()
        _hr("━")
        status = result["status"].upper()
        print(f"  {status}  —  {result['total_ms']} ms  —  appended to results.json")
        _hr("━")
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
    parser.add_argument(
        "prompt",
        nargs="?",
        help="Merchant feature request (quote it). Use --file for longer prompts.",
    )
    parser.add_argument(
        "--file", "-f",
        metavar="PATH",
        help="Read prompt from a text file instead of the command line.",
    )
    parser.add_argument(
        "--stop-after",
        choices=["intent", "architect", "codespec", "codegen"],
        metavar="STAGE",
        help="Stop after STAGE and still persist partial result. "
             "Choices: intent, architect, codespec, codegen",
    )

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
