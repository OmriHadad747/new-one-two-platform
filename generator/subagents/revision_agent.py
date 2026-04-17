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

Output: { "handler": "...", "migration": "...", "widget_js": "...", "admin_ui": "..." }
Keys widget_js and admin_ui are null when not applicable.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Dict, FrozenSet, List, Optional, Tuple

from models.adapter import extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.base import CodegenContext
from subagents.prompts.handler import HARNESS_API_SURFACE

log = logging.getLogger(__name__)

# ── System prompt ──────────────────────────────────────────────────────────────
#
# The revision agent uses the compact HARNESS_API_SURFACE rather than the full
# HARNESS_BASE. Revisions see the prior handler code in the user prompt, which
# already embodies the handler patterns; re-sending the full harness contract
# wastes tokens without improving edits.

REVISION_SYSTEM = f"""You are an expert Shopify applications code revision specialist.

You receive existing working handler code (and optionally widget + admin UI code)
along with a revised architect plan. Apply MINIMUM targeted changes.

{HARNESS_API_SURFACE}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REVISION RULES — read before editing
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

APPROACH:
1. Read existing code — understand what it does and what contracts it maintains.
2. Compare the existing code against the new appContracts (dbContracts, webhookContract,
   widgetApiCatalog, adminApiCatalog requestShape/responseShape).
3. Apply only the changes required — preserve everything else.
4. If a field name changes in the handler, also change it in the widget and admin UI.

HANDLER:
- Output MUST be a full CommonJS module: module.exports = {{ webhookTopics, cronSchedule, handler }}
- Implement all routes declared in widgetApiCatalog and adminApiCatalog
- Use exact column names from dbContracts in all SQL queries
- Update webhookTopics and cronSchedule only if the new plan changes them

MIGRATION:
- Output ONLY incremental DDL
- NEVER drop, recreate, or modify existing columns/tables (the prior migration was already applied)
- New table → full CREATE TABLE IF NOT EXISTS ... with tenant isolation pattern
- New column → ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...
- If nothing changed in the schema → output exactly: -- no schema changes

WIDGET (widget_js, if applicable):
- Use EXACTLY the requestShape fields shown in widgetApiCatalog for each host.call() body
- Use EXACTLY the responseShape field names when reading results
- Keep the same host.call() / host.storefront() / host.context structural pattern
- Set to null (JSON null) if this is a backend-only app
  FORBIDDEN — static validator rejects these immediately:
    import statements of any kind • export default • React/JSX/useState/useEffect/createElement
    document.head • document.body • setInterval • eval() • Function() • window.*
    Sole allowed export: export function mount(container, host) { ... }

ADMIN UI (admin_ui, if applicable):
- Use EXACTLY the requestShape fields shown in adminApiCatalog for each bridge.call() body
- Use EXACTLY the responseShape field names when reading results
- Keep the same bridge.call() pattern
- Set to null (JSON null) if this app has no admin panel
  FORBIDDEN — static validator rejects these immediately:
    import statements of any kind • export default • React/JSX/useState/useEffect/createElement
    document.head • document.body • setInterval • eval() • Function() • window.*
    Sole allowed export: export function mount(container, bridge) { ... }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT — respond with ONLY this JSON object (no markdown fences, no explanation):
{{
  "handler": "<full revised handler.js CommonJS module>",
  "migration": "<incremental SQL DDL, or exactly '-- no schema changes'>",
  "widget_js": "<full revised widget ES module, or null>",
  "admin_ui": "<full revised admin UI ES module, or null>"
}}"""


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
    prior_migration = ctx.prior_migration_sql or "(none)"
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
            f"  [{gen}]: {err}"
            for gen, errs in static_errors.items()
            for err in errs
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
        if "migration" in locked_artifacts
        else "migration.sql (prior — NEVER drop or recreate these tables)"
    )

    return f"""Merchant revision request: {intent.get("desiredOutcome", "")}

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
    artifacts_dict keys match generator names: "handler", "migration", and
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
    llm = get_llm(model=get_agent_model("revision"), max_tokens=16000)
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

    if "migration" not in locked_artifacts:
        migration = parsed.get("migration")
        if isinstance(migration, str) and migration.strip():
            artifacts["migration"] = migration.strip()

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
