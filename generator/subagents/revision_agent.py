"""
Revision Agent — holistic code update for existing app bundles.

Invoked on the first codegen attempt when request.priorBundle is present.
Instead of running 3–4 parallel individual generators that may diverge,
this single agent reads all prior artifacts together and applies the minimum
targeted changes needed to implement the merchant's revision request.

Advantages over per-generator revision:
  - Holistic: knows all prior artifacts simultaneously — cross-artifact changes
    stay consistent (e.g. renaming a field in the handler also renames it in the widget)
  - Targeted: compares prior code against the new architect+codespec plan, patches
    only what changed, preserves working logic
  - Atomic: one LLM call rather than 3–4 parallel ones that can diverge

Output: { "handler": "...", "migration": "...", "widget_js": "...", "admin_ui": "..." }
Keys widget_js and admin_ui are null when not applicable.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Dict, Optional

from models.adapter import extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.base import CodegenContext
from templates.harness_contract import HARNESS_BASE

log = logging.getLogger(__name__)

# ── System prompt ──────────────────────────────────────────────────────────────

REVISION_SYSTEM = f"""You are an expert Shopify automation code revision specialist.

You receive existing working handler code (and optionally widget + admin UI code)
along with a revised architect + codespec plan. Apply MINIMUM targeted changes.

{HARNESS_BASE}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REVISION RULES — read before editing
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

APPROACH:
1. Read existing code — understand what it does and what contracts it maintains.
2. Identify exactly what is different in the new plan vs. the existing code.
3. Apply only the changes required by the new plan — preserve everything else.
4. If a field name changes in the handler, also change it in the widget and admin UI.

HANDLER:
- Output MUST be a full CommonJS module: module.exports = {{ webhookTopics, cronSchedule, handler }}
- Follow the new codeSpec steps in order — do not interpolate old steps with new ones
- Update webhookTopics and cronSchedule only if the new plan changes them
- Preserve existing DB queries that the new plan does not touch

MIGRATION:
- Output ONLY incremental DDL
- NEVER drop, recreate, or modify existing columns/tables (the prior migration was already applied)
- New table → full CREATE TABLE IF NOT EXISTS ... statement
- New column → ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...
- If nothing changed in the schema → output exactly: -- no schema changes

WIDGET (widget_js, if applicable):
- Keep the same host.call() / host.storefront() / host.context structural pattern
- Update path names, field names, and UI logic only where the new plan requires it
- Set to null (JSON null) if this is a backend-only app

ADMIN UI (admin_ui, if applicable):
- Keep the same bridge.call() / bridge.subscribe() pattern
- Update path names and response field names where the new plan requires it
- Set to null (JSON null) if this app has no admin panel

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

    return f"""Merchant revision request: {intent.get("desiredOutcome", "")}

Feature intent:
{json.dumps(intent, indent=2)}

Shopify plan (architect):
{json.dumps(plan.get("shopifyPlan", {}), indent=2)}

Implementation spec (includes new codeSpec steps):
{json.dumps(plan.get("implementationSpec", {}), indent=2)}
{issues_block}
═══════════════════════════════════════════════════════════════
EXISTING CODE — apply targeted changes only
═══════════════════════════════════════════════════════════════

── handler.js (prior) ──
{prior_handler}

── migration.sql (prior — NEVER drop or recreate these tables) ──
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
) -> Dict[str, str]:
    """
    Holistic code revision agent. Produces all artifacts in one LLM call.

    Parameters
    ----------
    ctx:
        CodegenContext with prior_* fields populated from the existing bundle.
        plan must already contain the merged architect + codeSpec output.
    is_storefront:
        True if the app has a storefront widget (widget_js artifact expected).
    is_admin_ui:
        True if the app has an admin UI panel (admin_ui artifact expected).
    validation_issues:
        Optional list of high-confidence issues from the LLM validator.
        When provided, the agent is instructed to fix these specific misalignments.

    Returns
    -------
    Dict with keys matching generator names: "handler", "migration",
    and optionally "widget_js" and/or "admin_ui".
    Returns {} on parse failure — caller should fall back to run_codegen_parallel.
    """
    user = _build_user_prompt(
        ctx,
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        validation_issues=validation_issues,
    )
    llm = get_llm(model=get_agent_model("revision"), max_tokens=16000)
    result = invoke(llm, REVISION_SYSTEM, user)
    raw = extract_json(result.content)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        log.warning("revision_agent: JSON parse error %s — snippet: %s", e, raw[:300])
        return {}

    artifacts: Dict[str, str] = {}

    handler = parsed.get("handler")
    if isinstance(handler, str) and handler.strip():
        code = re.sub(
            r"^```(?:javascript|js)?\s*", "", handler.strip(), flags=re.MULTILINE
        )
        code = re.sub(r"```\s*$", "", code.strip(), flags=re.MULTILINE)
        artifacts["handler"] = code.strip()

    migration = parsed.get("migration")
    if isinstance(migration, str) and migration.strip():
        artifacts["migration"] = migration.strip()

    if is_storefront:
        widget = parsed.get("widget_js")
        if isinstance(widget, str) and widget.strip():
            code = re.sub(
                r"^```(?:javascript|js)?\s*", "", widget.strip(), flags=re.MULTILINE
            )
            code = re.sub(r"```\s*$", "", code.strip(), flags=re.MULTILINE)
            artifacts["widget_js"] = code.strip()

    if is_admin_ui:
        admin = parsed.get("admin_ui")
        if isinstance(admin, str) and admin.strip():
            code = re.sub(
                r"^```(?:javascript|js)?\s*", "", admin.strip(), flags=re.MULTILINE
            )
            code = re.sub(r"```\s*$", "", code.strip(), flags=re.MULTILINE)
            artifacts["admin_ui"] = code.strip()

    return artifacts
