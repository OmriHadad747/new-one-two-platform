"""
Revision Agent — holistic code update for existing app bundles.

Invoked on the first codegen attempt when request.priorBundle is present.
Instead of running 3–4 parallel individual generators that may diverge,
this single agent reads all prior artifacts together and applies the minimum
targeted changes needed to implement the merchant's revision request.

Advantages over per-generator revision:
  - Holistic: knows all prior artifacts simultaneously — cross-artifact changes
    stay consistent (e.g. renaming a field in the handler also renames it in the widget)
  - Targeted: compares prior code against the new architect plan (shopifyPlan + appContracts), patches
    only what changed, preserves working logic
  - Atomic: one LLM call rather than 3–4 parallel ones that can diverge

Output: { "handler": "...", "db": "...", "widget_js": "...", "admin_ui": "..." }
Keys widget_js and admin_ui are null when not applicable.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Dict, FrozenSet, List, Optional, Tuple

from models.adapter import extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.base import CodegenContext, needs_extended_thinking
from subagents.jit.handler import build_handler_jit_sections
from subagents.prompts.core.revision import REVISION_SYSTEM
from subagents.prompts.topics.handler import HANDLER as HARNESS_BASE

# Extended-thinking budget for the revision agent.  Revision rewrites whole
# artifacts to fix a precise list of validator issues — it is exactly the call
# most likely to introduce new bugs while fixing old ones, so deeper reasoning
# on complex apps earns its cost. 6000 sits between the codegen budget (4000
# — single-artifact output) and the validator budget (8192 — open bug hunt),
# reflecting revision's wider rewrite surface but narrower task definition.
_REVISION_THINKING_BUDGET = 6000

log = logging.getLogger(__name__)


# ── User prompt builder ────────────────────────────────────────────────────────


def _build_user_prompt(
    ctx: CodegenContext,
    *,
    is_storefront: bool,
    is_admin_ui: bool,
    validation_issues: Optional[list] = None,
    locked_artifacts: FrozenSet[str] = frozenset(),
    static_errors: Optional[Dict[str, List[str]]] = None,
) -> str:
    intent = ctx.intent
    plan = ctx.plan

    prior_handler = ctx.prior_handler_code or "(none)"
    prior_migration = ctx.prior_db_sql or "(none)"
    prior_widget = (
        ctx.prior_widget_code or "(none)"
        if is_storefront
        else "(not applicable — backend app)"
    )
    prior_admin = (
        ctx.prior_admin_ui_code or "(none)"
        if is_admin_ui
        else "(not applicable — no admin panel)"
    )

    locked_block = ""
    if locked_artifacts:
        locked_list = ", ".join(sorted(locked_artifacts))
        locked_block = f"""
═══════════════════════════════════════════════════════════════
LOCKED ARTIFACTS — read-only context, do NOT output revisions
═══════════════════════════════════════════════════════════════
{locked_list} are provided below as read-only context only.
Do NOT output revised versions — omit them or set to null in your JSON.
Revise ONLY the unlocked artifacts to align with the locked code's contracts.

"""

    static_errors_block = ""
    if static_errors:
        error_lines = "\n".join(
            f"  [{gen}]: {err}" for gen, errs in static_errors.items() for err in errs
        )
        static_errors_block = f"""
═══════════════════════════════════════════════════════════════
STATIC VALIDATION FAILURES — fix these or output is rejected
═══════════════════════════════════════════════════════════════
Your previous revision was rejected by the static validator.
Fix ONLY the failing artifacts listed. Do NOT change passing artifacts.

{error_lines}

"""

    issues_block = ""
    if validation_issues:
        lines = "\n".join(
            f"  - [{i['question']}] {i['issue']}" for i in validation_issues
        )
        issues_block = f"""
═══════════════════════════════════════════════════════════════
SEMANTIC ISSUES TO FIX — highest priority
═══════════════════════════════════════════════════════════════
The following misalignments were detected by a semantic validator.
Fix ALL of them in your revised output:

{lines}

"""

    handler_label = (
        "handler.js (READ-ONLY — do not output a revised version)"
        if "handler" in locked_artifacts
        else "handler.js (prior)"
    )
    migration_label = (
        "migration.sql (READ-ONLY — do not output a revised version)"
        if "db" in locked_artifacts
        else "migration.sql (prior — NEVER drop or recreate these tables)"
    )

    # Build the same handler-surface view the handler agent sees at first-run
    # time — HARNESS_BASE plus capability docs and topic sections gated by the
    # revised plan. This is what the revision agent must respect when editing.
    widget_catalog = (plan.get("appContracts") or {}).get("widgetApiCatalog") or []
    handler_surface = (
        HARNESS_BASE
        + "\n\n"
        + build_handler_jit_sections(
            plan, widget_catalog, intent_hint=intent.get("desiredOutcome") or None
        )
    )

    return f"""{handler_surface}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REVISION REQUEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Merchant revision request: {intent.get("desiredOutcome", "")}

Feature intent:
{json.dumps(intent, indent=2)}

Shopify plan:
{json.dumps(plan.get("shopifyPlan", {}), indent=2)}

App contracts (dbContracts, webhookContract, widgetApiCatalog, adminApiCatalog):
{json.dumps(plan.get("appContracts", {}), indent=2)}
{locked_block}{static_errors_block}{issues_block}
═══════════════════════════════════════════════════════════════
EXISTING CODE — apply targeted changes only
═══════════════════════════════════════════════════════════════

── {handler_label} ──
{prior_handler}

── {migration_label} ──
{prior_migration}

── widget.js (prior) ──
{prior_widget}

── admin_ui.js (prior) ──
{prior_admin}

Output the revised artifacts as a single JSON object.
"""


# ── Public API ─────────────────────────────────────────────────────────────────


def run_revision_agent(
    ctx: CodegenContext,
    *,
    is_storefront: bool,
    is_admin_ui: bool,
    validation_issues: Optional[list] = None,
    locked_artifacts: FrozenSet[str] = frozenset(),
    static_errors: Optional[Dict[str, List[str]]] = None,
) -> Tuple[Dict[str, str], int, int]:
    """
    Holistic code revision agent. Produces all artifacts in one LLM call.

    Parameters
    ----------
    ctx:
        CodegenContext with prior_* fields populated from the existing bundle.
        plan must already contain the architect output (shopifyPlan + appContracts).
    is_storefront:
        True if the app has a storefront widget (widget_js artifact expected).
    is_admin_ui:
        True if the app has an admin UI panel (admin_ui artifact expected).
    validation_issues:
        Optional list of high-confidence issues from the LLM validator.
        When provided, the agent is instructed to fix these specific misalignments.
    locked_artifacts:
        Set of artifact keys that the revision agent must NOT output revised versions
        of. They are passed as read-only context. Keys in this set are skipped during
        output parsing even if the LLM emits them.
    static_errors:
        Dict of {generator_name: [error_strings]} from a previous revision attempt
        that failed static validation. Injected into the prompt so the agent knows
        exactly what structural violations to fix.

    Returns
    -------
    Tuple of (artifacts_dict, input_tokens, output_tokens).
    artifacts_dict keys match generator names: "handler", "db", and
    optionally "widget_js" and/or "admin_ui".
    Returns ({}, in, out) on parse failure — caller falls back to run_codegen_parallel.
    """
    log.info(
        "revision_agent: enter — issues=%d locked=%s static_retry=%s storefront=%s admin_ui=%s",
        len(validation_issues or []),
        sorted(locked_artifacts) if locked_artifacts else [],
        bool(static_errors),
        is_storefront,
        is_admin_ui,
    )
    user = _build_user_prompt(
        ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        validation_issues=validation_issues,
        locked_artifacts=locked_artifacts,
        static_errors=static_errors,
    )
    thinking_budget = (
        _REVISION_THINKING_BUDGET if needs_extended_thinking(ctx.plan) else None
    )
    llm = get_llm(
        model=get_agent_model("revision"),
        max_tokens=16000,
        thinking_budget=thinking_budget,
    )
    result = invoke(llm, REVISION_SYSTEM, user)
    in_tok = result.input_tokens
    out_tok = result.output_tokens
    raw = extract_json(result.content)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        log.warning("revision_agent: JSON parse error %s — snippet: %s", e, raw[:300])
        return {}, in_tok, out_tok

    artifacts: Dict[str, str] = {}

    if "handler" not in locked_artifacts:
        handler = parsed.get("handler")
        if isinstance(handler, str) and handler.strip():
            code = re.sub(
                r"^```(?:javascript|js)?\s*", "", handler.strip(), flags=re.MULTILINE
            )
            code = re.sub(r"```\s*$", "", code.strip(), flags=re.MULTILINE)
            artifacts["handler"] = code.strip()

    if "db" not in locked_artifacts:
        migration = parsed.get("db")
        if isinstance(migration, str) and migration.strip():
            artifacts["db"] = migration.strip()

    if is_storefront and "widget_js" not in locked_artifacts:
        widget = parsed.get("widget_js")
        if isinstance(widget, str) and widget.strip():
            code = re.sub(
                r"^```(?:javascript|js)?\s*", "", widget.strip(), flags=re.MULTILINE
            )
            code = re.sub(r"```\s*$", "", code.strip(), flags=re.MULTILINE)
            artifacts["widget_js"] = code.strip()

    if is_admin_ui and "admin_ui" not in locked_artifacts:
        admin = parsed.get("admin_ui")
        if isinstance(admin, str) and admin.strip():
            code = re.sub(
                r"^```(?:javascript|js)?\s*", "", admin.strip(), flags=re.MULTILINE
            )
            code = re.sub(r"```\s*$", "", code.strip(), flags=re.MULTILINE)
            artifacts["admin_ui"] = code.strip()

    log.info(
        "revision_agent: exit — returned=%s in_tokens=%d out_tokens=%d",
        sorted(artifacts.keys()),
        in_tok,
        out_tok,
    )
    return artifacts, in_tok, out_tok
