"""
Coding-agent runner.

Top-level entry point — the CLI calls `run_coding_agent(...)` after HLD
validation passes. This module:

  1. Sets up the run directory (`test_results/<ts>_<slug>/codegen/`).
  2. Builds the user message from intent + HLD.
  3. Builds the cached system prompt.
  4. Runs the multi-turn loop (loop.run_loop).
  5. Returns the result with token totals.

Out of scope for this module (handled elsewhere):
  - `app.json → migrations/0001_app.sql` rendering (renderer.py — TODO)
  - `app.json → src/server.ts` rendering (renderer.py — TODO)
  - `tsc --noEmit` execution (tsc_runner.py — TODO)
  - Final integrity checks (integrity.py — TODO)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from subagents.w_coding_agent.loop import RunResult, run_loop
from subagents.w_coding_agent.prompt import build_full_system_prompt
from subagents.w_coding_agent.tools import RunnerContext


REPO_ROOT = Path(__file__).resolve().parents[3]


# ── Public entry point ──────────────────────────────────────────────────────


@dataclass
class CodingAgentResult:
    run_result: RunResult
    work_dir: Path           # the scaffold/ dir is at work_dir/scaffold
    run_dir: Path            # logs + tool_calls
    todos: list              # final todo list from the agent
    incomplete_reason: Optional[str] = None  # set if the run ended without a clean done()
    # Token usage of the done()-gate micro-validators (Haiku), summed over
    # the run. The coding agent's own tokens live in `run_result`.
    validator_usage: Optional[Dict[str, int]] = None


def run_coding_agent(
    *,
    merchant_prompt: str,
    intent: Dict[str, Any],
    plan: Dict[str, Any],
    run_dir: Path,
    on_tool_call: Optional[Callable[[str], None]] = None,
) -> CodingAgentResult:
    """Run the coding agent end-to-end for one app generation.

    Parameters
    ----------
    merchant_prompt:
        The merchant's verbatim request.
    intent:
        Structured intent from a_product_agent.
    plan:
        Validated HLD from c_hld_agent + e_hld_v_agent.
    run_dir:
        Caller-owned dir for logs and the scaffold/. The agent creates
        `tool_calls/` and `scaffold/` under it.
    on_tool_call:
        Optional callable invoked with each tool call's one-line CLI
        summary, so the CLI can render live progress.
    """
    run_dir.mkdir(parents=True, exist_ok=True)
    work_dir = run_dir  # scaffold/ lives directly under run_dir

    ctx = RunnerContext(
        repo_root=REPO_ROOT,
        work_dir=work_dir,
        run_dir=run_dir,
        plan=plan,
    )

    system_prompt = build_full_system_prompt()
    user_message = _build_user_message(merchant_prompt, intent, plan)

    # Persist the prompts so they're inspectable post-run.
    _persist_prompts(run_dir, system_prompt, user_message)

    result = run_loop(
        ctx,
        system_prompt=system_prompt,
        user_message=user_message,
        on_tool_call=on_tool_call,
    )

    if result.done_called:
        incomplete_reason = None
    elif result.hit_turn_cap:
        incomplete_reason = "hit the turn cap before the done() gate passed"
    else:
        incomplete_reason = "the agent stopped before calling done()"

    _persist_token_usage(run_dir, result, ctx.validator_usage)

    return CodingAgentResult(
        run_result=result,
        work_dir=work_dir,
        run_dir=run_dir,
        todos=ctx.todos,
        incomplete_reason=incomplete_reason,
        validator_usage=ctx.validator_usage,
    )


# ── Internals ───────────────────────────────────────────────────────────────


_USER_TEMPLATE = """\
You are starting a new run. Read everything in this message carefully — it is the only application-specific information you will receive.

═══ MERCHANT REQUEST ═══

{merchant_prompt}

═══ PRODUCT INTENT (from a_product_agent) ═══

{intent_json}

═══ HLD PLAN (validated by e_hld_v_agent) ═══

{plan_json}

═══ FILE-LEVEL PLAN SLICES ═══

The plan above has been sliced per scaffold file. When you call `todo_write`
for any of these files, COPY the matching slice into the todo's
`implements` / `consumes` / `produces` / `do_not` fields VERBATIM (don't
paraphrase — paraphrasing is how producer/consumer bugs sneak in). Add
more entries if your design needs them; never drop the ones below.

{file_slices}

═══ YOUR JOB ═══

Build the app under `scaffold/`. Follow the loop: plan (todo_write) → spine (app.json, contracts.ts) → bodies (per-file) → verify (run_tsc) → done().

Start with `todo_write` to lay out your plan. Each file todo must carry its slice from above."""


def _build_user_message(
    merchant_prompt: str,
    intent: Dict[str, Any],
    plan: Dict[str, Any],
) -> str:
    return _USER_TEMPLATE.format(
        merchant_prompt=merchant_prompt.strip(),
        intent_json=json.dumps(intent, indent=2),
        plan_json=json.dumps(plan, indent=2),
        file_slices=_render_file_plan_slices(plan),
    )


# ── File-level plan slice renderer ──────────────────────────────────────────


def _render_file_plan_slices(plan: Dict[str, Any]) -> str:
    """Mechanically derive a per-file slice of the plan.

    Each block targets one scaffold file and lists the `implements`,
    `consumes`, `produces`, and `do_not` entries the agent should copy
    into that file's `todo_write` item. The point isn't to enumerate the
    whole plan again — it's to put the *consume* list at the moment of
    planning so the agent can't forget that, e.g., the storefront widget
    must read `member.live.<field>` returned by its own GET route rather
    than the raw DB column it shadows.

    The slices are advisory in detail but mandatory in structure: the
    coding agent prompt tells the model to copy them verbatim.
    """
    triggers = plan.get("triggers") or []
    capabilities = plan.get("capabilities") or []
    contracts = plan.get("externalContracts") or []
    persistence = plan.get("persistence") or []

    admin_contracts = [c for c in contracts if c.get("surface") == "admin"]
    widget_contracts = [c for c in contracts if c.get("surface") == "widget"]
    storefront_caps = [
        c for c in capabilities if c.get("integration") == "shopify-storefront"
    ]
    shopify_admin_caps = [
        c for c in capabilities if c.get("integration") == "shopify-admin"
    ]
    nullable_purposeful = [
        (t["name"], col["name"], col["purpose"])
        for t in persistence
        for col in t.get("columns", [])
        if col.get("nullable") and col.get("purpose")
    ]

    blocks: list[str] = []

    # ── webhook-handlers.ts ──
    if triggers:
        consumes: list[str] = []
        for t in triggers:
            topic = t.get("shopifyTopic") or "<topic>"
            consumes.append(f"[{topic}] event: {t.get('event', '')}")
            for b in t.get("payloadBindings") or []:
                field = b.get("signalField", "?")
                source = b.get("source", "?")
                if source == "payload":
                    consumes.append(
                        f"  '{field}' ← payload.{b.get('payloadPath', '?')}"
                    )
                else:
                    consumes.append(
                        f"  '{field}' ← {b.get('resolution', 'declared resolution hop')}"
                    )
        do_not = [
            "early-return when a declared signalField is empty (silently disables the trigger)",
            "read an undeclared payload field (paths above are the contract)",
            "ignore a declared payloadBinding — every signalField above must be read at least once",
        ]
        blocks.append(
            _format_block(
                file="scaffold/src/routes/webhook-handlers.ts",
                role="webhook handlers (one entry per declared trigger)",
                implements=[t.get("event", "?") for t in triggers],
                consumes=consumes,
                produces=[
                    "idempotent DB writes per the capability each trigger drives",
                    "ON CONFLICT on every dedup-keyed insert (per persistence keyedBy)",
                ],
                do_not=do_not,
            )
        )

    # ── routes/admin.ts ──
    if admin_contracts or shopify_admin_caps:
        consumes = []
        produces = []
        for c in admin_contracts:
            consumes.append(
                f"{c.get('method')} {c.get('path')} requestShape: "
                + ", ".join(sorted((c.get("requestShape") or {}).keys()))
            )
            produces.append(
                f"{c.get('method')} {c.get('path')} responseShape: "
                + ", ".join(sorted((c.get("responseShape") or {}).keys()))
            )
        for cap in shopify_admin_caps:
            steps = cap.get("shopifySteps") or []
            for s in steps:
                if s.get("consumes"):
                    consumes.append(
                        f"[{cap.get('id')}/{s.get('op')}] consumes: {s.get('consumes')}"
                    )
                if s.get("produces"):
                    produces.append(
                        f"[{cap.get('id')}/{s.get('op')}] produces: {s.get('produces')}"
                    )
        blocks.append(
            _format_block(
                file="scaffold/src/routes/admin.ts",
                role="admin route handlers (the admin UI calls these)",
                implements=[c.get("id") for c in shopify_admin_caps],
                consumes=consumes,
                produces=produces,
                do_not=[
                    "pass a literal/placeholder GID (e.g. 'gid://shopify/Product/0') to any Shopify op — fail-fast instead",
                    "call a bound op only to discard its returned id — every produces above must be persisted or threaded forward",
                    "provision Shopify side-effects outside the DB transaction without a rollback path",
                ],
            )
        )

    # ── routes/widget.ts ──
    if widget_contracts or storefront_caps:
        consumes = []
        produces = []
        for c in widget_contracts:
            consumes.append(
                f"{c.get('method')} {c.get('path')} requestShape: "
                + ", ".join(sorted((c.get("requestShape") or {}).keys()))
            )
            produces.append(
                f"{c.get('method')} {c.get('path')} responseShape: "
                + ", ".join(sorted((c.get("responseShape") or {}).keys()))
            )
        for cap in storefront_caps:
            for s in cap.get("shopifySteps") or []:
                if s.get("consumes"):
                    consumes.append(
                        f"[{cap.get('id')}/{s.get('op')}] consumes: {s.get('consumes')}"
                    )
                if s.get("produces"):
                    produces.append(
                        f"[{cap.get('id')}/{s.get('op')}] produces: {s.get('produces')}"
                    )
        blocks.append(
            _format_block(
                file="scaffold/src/routes/widget.ts",
                role="storefront route handlers (the widget calls these)",
                implements=[c.get("id") for c in storefront_caps],
                consumes=consumes,
                produces=produces
                + [
                    "for every member/row this route returns: include resolved `live.<field>` for any reference the storefront will pass to cartCreate (so the widget never has to fall back to a raw DB column)",
                ],
                do_not=[
                    "fall back from a resolved live.<field> to the raw DB column it shadows (e.g. `?? member.product_external_id`)",
                    "accept caller-supplied ids without validating shape (variant ids are numeric strings; merchandise GIDs go to ProductVariant, not Product)",
                ],
            )
        )

    # ── admin/ui.ts ──
    if admin_contracts:
        consumes = [
            f"calls {c.get('method')} {c.get('path')} — responseShape: "
            + ", ".join(sorted((c.get("responseShape") or {}).keys()))
            for c in admin_contracts
        ]
        produces = [
            f"sends {c.get('method')} {c.get('path')} — requestShape: "
            + ", ".join(sorted((c.get("requestShape") or {}).keys()))
            for c in admin_contracts
        ]
        if nullable_purposeful:
            produces.append(
                "UI inputs for these nullable-with-purpose columns (every row's purpose is a stated feature):"
            )
            for table, col, purpose in nullable_purposeful:
                produces.append(f"  • {table}.{col} — {purpose}")
        blocks.append(
            _format_block(
                file="scaffold/admin/ui.ts",
                role="admin UI surface",
                implements=[c.get("path") for c in admin_contracts],
                consumes=consumes,
                produces=produces,
                do_not=[
                    "send a placeholder/sentinel (e.g. '0', '', null) for a reference column the plan declares NOT NULL — use real picker data",
                    "omit a UI affordance for a nullable-with-purpose column above (the merchant has no other way to set it)",
                    "store a variant id where a product id is required (or vice versa)",
                ],
            )
        )

    # ── widget/widget.ts ──
    if widget_contracts:
        consumes = []
        for c in widget_contracts:
            consumes.append(
                f"calls {c.get('method')} {c.get('path')} — responseShape: "
                + ", ".join(sorted((c.get("responseShape") or {}).keys()))
            )
        consumes.append(
            "for ANY response field shaped `live.<field>` or a resolved id, USE that field for selection / cart / submit — never the raw DB column it shadows"
        )
        produces = [
            f"sends {c.get('method')} {c.get('path')} — requestShape: "
            + ", ".join(sorted((c.get("requestShape") or {}).keys()))
            for c in widget_contracts
        ]
        blocks.append(
            _format_block(
                file="scaffold/widget/widget.ts",
                role="storefront widget UI",
                implements=[c.get("path") for c in widget_contracts],
                consumes=consumes,
                produces=produces,
                do_not=[
                    "use `member.variant_external_id ?? member.product_external_id` (or any analogue) — a product id wrapped as a variant GID breaks cartCreate",
                    "build a `gid://shopify/ProductVariant/<id>` from anything that wasn't returned by the backend as a variant id",
                    "enable a CTA whose preconditions (selection count, availability) the plan declares — the backend re-validates anyway, but the UI must mirror it",
                ],
            )
        )

    # ── src/types/contracts.ts ──
    blocks.append(
        _format_block(
            file="scaffold/src/types/contracts.ts",
            role="shared type contracts (imported by every other file)",
            implements=["type-level spine for all contracts above"],
            consumes=[
                "every externalContract requestShape + responseShape (define an aliased type per endpoint)",
                "every trigger payload (define a typed shape per topic)",
                "every persistence table (define a Row type)",
                "for routes that augment rows with resolved data, define a `<Row>WithLive` shape that includes the resolved live.<field>",
            ],
            produces=[
                "named, branded id types where the plan implies an id (avoid raw `string`)",
                "exported types every route + UI file imports — no cross-file structural typing",
            ],
            do_not=[
                "use `any` for any field the plan typed",
                "let UI files import from route files or vice versa — contracts.ts is the only shared shape",
            ],
        )
    )

    return "\n\n".join(blocks)


def _format_block(
    *,
    file: str,
    role: str,
    implements: list,
    consumes: list,
    produces: list,
    do_not: list,
) -> str:
    def fmt(items: list) -> str:
        if not items:
            return "    (none)"
        return "\n".join(f"    - {x}" for x in items if x)

    return (
        f"▸ {file}  — {role}\n"
        f"  implements:\n{fmt(implements)}\n"
        f"  consumes:\n{fmt(consumes)}\n"
        f"  produces:\n{fmt(produces)}\n"
        f"  do_not:\n{fmt(do_not)}"
    )


def _persist_prompts(run_dir: Path, system: str, user: str) -> None:
    """Write the prompts to disk for post-hoc inspection, under `inputs/coding/`
    so the coding agent matches the per-agent `inputs/<agent>/` layout of the
    other agents. The loop owns retries internally, so there is a single
    system/user pair (no attempt_N split)."""
    coding_dir = run_dir / "inputs" / "coding"
    coding_dir.mkdir(parents=True, exist_ok=True)
    (coding_dir / "system.txt").write_text(system)
    (coding_dir / "user.txt").write_text(user)


def _persist_token_usage(
    run_dir: Path, run_result: RunResult, validator_usage: Dict[str, int]
) -> None:
    """Write `token_usage.json` so each run yields a measurable cost delta —
    the coding agent's own loop tokens alongside the done()-gate validators'
    Haiku tokens. (HLD tokens are reported separately by run_hld_agent.)"""
    payload = {
        "coding_agent": {
            "input_tokens": run_result.total_input_tokens,
            "output_tokens": run_result.total_output_tokens,
            "cache_read_tokens": run_result.cache_read_tokens,
            "cache_creation_tokens": run_result.cache_creation_tokens,
            "turns_used": run_result.turns_used,
        },
        "validators": validator_usage,
    }
    (run_dir / "token_usage.json").write_text(json.dumps(payload, indent=2))
