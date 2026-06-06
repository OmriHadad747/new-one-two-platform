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

    # Plan-vs-code checks on the persistence spec. Both checks are
    # GENERIC — they iterate the plan's own declarations and compare to
    # the app.json values; no app knowledge anywhere.
    failures.extend(_check_persistence_plan_vs_app(ctx, app))

    # Helper-reuse checks: when the plan declares a need a ready template
    # helper exists for, the generated source MUST import that helper rather
    # than re-implement it. GENERIC — iterates the plan's own flags.
    failures.extend(_check_helper_reuse(ctx))

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


def _check_persistence_plan_vs_app(
    ctx: "RunnerContext", app: Dict[str, Any]
) -> List[str]:
    """Two generic persistence checks, both structural:

      (A) keyedByColumns ↔ uniqueConstraint match.
          If the HLD declares `keyedByColumns` on a table, the
          generated `app.json` for the same table must declare a
          `uniqueConstraint` with exactly the same column set. Catches
          plans where the natural-language keyedBy text and the formal
          constraint diverged (e.g. "calendar date" vs raw timestamp).

      (B) nullable-in-uniqueConstraint trap.
          A `uniqueConstraint` that includes a NULL-allowing column
          will not deduplicate NULL rows under Postgres' default
          semantics. Flag unless the table opts in to
          `nullsNotDistinct: true`. Catches the silent-duplicate-rows
          class of bug.

    Both rules are app-agnostic. The plan supplies what was declared;
    these check the joint with the code.
    """
    plan = getattr(ctx, "plan", None) or {}
    tables_plan: Dict[str, Dict[str, Any]] = {
        t.get("name", ""): t for t in (plan.get("persistence") or [])
    }
    tables_app = ((app.get("database") or {}).get("tables")) or []
    failures: List[str] = []

    for tbl in tables_app:
        tname = tbl.get("name")
        if not tname:
            continue
        unique = tbl.get("uniqueConstraint") or []
        nulls_not_distinct = bool(tbl.get("nullsNotDistinct", False))

        # (A) keyedByColumns mismatch
        plan_tbl = tables_plan.get(tname) or {}
        keyed = plan_tbl.get("keyedByColumns") or []
        if keyed:
            if sorted(keyed) != sorted(unique):
                failures.append(
                    f"persistence: table '{tname}' has uniqueConstraint "
                    f"{unique} in app.json but plan.keyedByColumns is "
                    f"{keyed} — they must reference the same column set. "
                    f"Either update app.json to match the plan, or escalate "
                    f"the plan change."
                )

        # (B) nullable column inside a uniqueConstraint
        if unique and not nulls_not_distinct:
            cols_by_name: Dict[str, Dict[str, Any]] = {
                c.get("name", ""): c for c in (tbl.get("columns") or [])
            }
            for col_name in unique:
                col = cols_by_name.get(col_name) or {}
                constraints = (col.get("constraints") or "").upper()
                # "NULL" alone (not "NOT NULL") means nullable
                is_nullable = "NULL" in constraints and "NOT NULL" not in constraints
                if is_nullable:
                    failures.append(
                        f"persistence: table '{tname}' uniqueConstraint "
                        f"includes nullable column '{col_name}' but does "
                        f"not declare `nullsNotDistinct: true`. Postgres "
                        f"treats NULLs as distinct in unique indexes, so "
                        f"the constraint will not deduplicate NULL rows — "
                        f"either add `\"nullsNotDistinct\": true` to the "
                        f"table, drop the nullable column from "
                        f"uniqueConstraint, or make the column NOT NULL."
                    )

    return failures


def _check_helper_reuse(ctx: "RunnerContext") -> List[str]:
    """Plan-flag → helper-import presence. The template ships finished helpers
    under `src/lib/`; when the plan declares a need one of them covers, the
    generated source must IMPORT it instead of hand-rolling the same logic
    (the recurring reinvention bug: hand-rolled LIMIT/OFFSET, raw settings
    SELECTs, inline `Math.round(parseFloat(x)*100)`, hand-rolled claim loops).

    GENERIC and zero-false-positive: each check fires only off a flag the
    plan ITSELF set (`touchesMoney`/`usesConfig`/`usesWorkflow`/`returnsList`
    on a capability, or a declared `stateMachine`). If the plan declared the
    need, the binding helper is mandatory — so a missing import is a real
    miss, never a guess. This is a structural presence check (it asserts the
    helper is imported somewhere in the generated source); the "don't
    hand-roll the same thing" negative stays advisory (prompt + the
    micro-validators).
    """
    plan = getattr(ctx, "plan", None) or {}
    caps = plan.get("capabilities") or []
    scaffold = ctx.work_dir / "scaffold"

    # Concatenate the generated source the agent authored (never the template
    # lib, which the agent doesn't emit). Cheap — scaffolds are small.
    src_root = scaffold / "src"
    files = list(src_root.rglob("*.ts")) if src_root.is_dir() else []
    for extra in ("admin/ui.ts", "widget/widget.ts"):
        p = scaffold / extra
        if p.is_file():
            files.append(p)
    if not files:
        return []
    blob = "\n".join(p.read_text() for p in files)

    # (helper module name, is-needed?, one-line directive) — driven by plan flags.
    needs = [
        (
            "workflow",
            any(c.get("usesWorkflow") for c in caps) or bool(plan.get("stateMachine")),
            "import { workflow } from \"../lib/workflow.js\" and drive the row "
            "lifecycle with workflow.claim/attempt/sweepStale — do not hand-roll "
            "a claim/try/update loop",
        ),
        (
            "config",
            any(c.get("usesConfig") for c in caps),
            "import { config } from \"../lib/config.js\" and read/write settings "
            "with config.get/set — do not SELECT settings from a custom table",
        ),
        (
            "money",
            any(c.get("touchesMoney") for c in caps),
            "import { money } from \"../lib/money.js\" and use money.toMinorUnits/"
            "sum/percentage — do not inline Math.round(parseFloat(x)*100) or raw +/*",
        ),
        (
            "paginate",
            any(c.get("returnsList") for c in caps),
            "import { paginate } from \"../lib/paginate.js\" for the list route(s) "
            "— do not hand-roll LIMIT/OFFSET or a separate COUNT(*) query",
        ),
    ]

    failures: List[str] = []
    for helper, needed, directive in needs:
        if needed and f"lib/{helper}" not in blob:
            failures.append(
                f"helper-reuse: the plan declares a capability that needs the "
                f"`{helper}` helper, but no generated file imports it. {directive}."
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

    # Structure + types are sound — run the semantic micro-validators.
    from subagents.w_coding_agent.validators import run_validators

    return run_validators(ctx)
