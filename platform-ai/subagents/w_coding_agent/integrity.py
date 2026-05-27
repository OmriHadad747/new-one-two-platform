"""
Deterministic integrity gate for the coding agent's `done()` call.

`done()` is the quality gate: the loop accepts completion only when these
checks pass; otherwise the failures come back as feedback and the agent
keeps working. Everything here is STRUCTURAL and deterministic — no LLM, no
false positives. The Haiku micro-validators (semantic) run after these pass
(see validators.py); keeping them separate means a cheap, certain floor
under the expensive, judgment-based layer.

Checks run fail-fast, cheapest first:
  1. scaffold/app.json exists and parses.
  2. scaffold/src/types/contracts.ts exists (the spine).
  3. every shopifyIntegration.webhookTopics[] has a handler key in
     scaffold/src/routes/webhook-handlers.ts.
  4. every httpRoutes.{widget,admin}[] route path is registered in its
     router file.
  5. tsc clean — backend + UI passes.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Dict, List

if TYPE_CHECKING:
    from subagents.w_coding_agent.tools import RunnerContext


def check_structural(ctx: "RunnerContext") -> List[str]:
    """Deterministic graph checks over the scaffold. Returns failure
    messages (empty = pass). Never runs tsc."""
    scaffold = ctx.work_dir / "scaffold"
    failures: List[str] = []

    app_path = scaffold / "app.json"
    if not app_path.exists():
        return ["scaffold/app.json is missing — the spine metadata must exist"]
    try:
        app: Dict[str, Any] = json.loads(app_path.read_text())
    except json.JSONDecodeError as e:
        return [f"scaffold/app.json does not parse: {e}"]

    if not (scaffold / "src" / "types" / "contracts.ts").exists():
        failures.append(
            "scaffold/src/types/contracts.ts is missing — cross-file types "
            "must exist before handlers can import them"
        )

    # 3. Webhook topics ↔ handler keys.
    topics = (app.get("shopifyIntegration") or {}).get("webhookTopics") or []
    if topics:
        handlers_path = scaffold / "src" / "routes" / "webhook-handlers.ts"
        if not handlers_path.exists():
            failures.append(
                f"{len(topics)} webhookTopic(s) declared but "
                "scaffold/src/routes/webhook-handlers.ts is missing"
            )
        else:
            handlers_text = handlers_path.read_text()
            for topic in topics:
                # webhooks.md mandates quoted-string-literal keys, so the
                # topic must appear quoted in the webhookHandlers object.
                if f'"{topic}"' not in handlers_text:
                    failures.append(
                        f"webhookTopic '{topic}' has no handler key "
                        f'("{topic}": …) in webhook-handlers.ts'
                    )

    # 4. HTTP routes ↔ router registration.
    http_routes = app.get("httpRoutes") or {}
    for surface in ("widget", "admin"):
        routes = http_routes.get(surface) or []
        if not routes:
            continue
        route_file = scaffold / "src" / "routes" / f"{surface}.ts"
        if not route_file.exists():
            failures.append(
                f"{len(routes)} {surface} route(s) declared but "
                f"scaffold/src/routes/{surface}.ts is missing"
            )
            continue
        route_text = route_file.read_text()
        for route in routes:
            path = route.get("path")
            method = (route.get("method") or "").upper()
            if path and f'"{path}"' not in route_text and f"'{path}'" not in route_text:
                failures.append(
                    f"{surface} route '{method} {path}' is declared in "
                    f"app.json but not registered in {surface}.ts"
                )

    return failures


def run_done_gate(ctx: "RunnerContext") -> List[str]:
    """Full deterministic gate for done(): structural checks, then tsc
    (backend + UI). Returns blocking issues (empty = clean). Fail-fast —
    tsc only runs once the structure is sound."""
    structural = check_structural(ctx)
    if structural:
        return structural

    from subagents.w_coding_agent.tsc_runner import (
        run_tsc_on_scaffold,
        run_tsc_on_ui_scaffold,
    )

    tsc_errors = run_tsc_on_scaffold(ctx.repo_root, ctx.work_dir)
    tsc_errors = tsc_errors + run_tsc_on_ui_scaffold(ctx.repo_root, ctx.work_dir)
    if tsc_errors:
        return [
            "tsc must pass before done(); "
            f"{len(tsc_errors)} error(s) remain, e.g.:"
        ] + [
            f"  {e.get('file', '?')}:{e.get('line', 0)} {e.get('message', '')}"
            for e in tsc_errors[:10]
        ]

    return []
