"""
Validator Agent — post-static-check semantic alignment verification.

Runs 7 targeted questions against the generated artifacts to catch cross-artifact
misalignments that static analysis cannot detect.

Both widget.js and admin_ui.js communicate with the same handler.js.
The 7 questions cover the full alignment surface:
  Q1  table names        migration DDL ↔ handler SQL
  Q2  column names       migration DDL ↔ handler SQL
  Q3  widget→handler     host.call() body fields ↔ ctx.widgetBody destructuring
  Q4  handler→widget     handler return value ↔ widgetApiCatalog responseShape
  Q5  admin→handler      bridge.call() body fields ↔ ctx.adminBody destructuring
  Q6  handler→admin      handler return value per admin route ↔ what admin_ui reads
  Q7  codespec coverage  codeSpec steps ↔ handler implementation

Only HIGH confidence issues trigger an automatic revision. MEDIUM issues are
logged but not acted upon (false positive mitigation).

Controlled by LLM_VALIDATION_ENABLED=true in environment (default: false).
"""
from __future__ import annotations

import json
import logging
from typing import Dict, List

from models.adapter import extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.base import CodegenContext

log = logging.getLogger(__name__)

# ── System prompt ──────────────────────────────────────────────────────────────

VALIDATOR_SYSTEM = """\
You are a code review specialist performing cross-artifact alignment checks.

You receive generated artifacts (handler.js, migration.sql, optional widget.js,
optional admin_ui.js) alongside the architect plan and codeSpec.

Both widget.js and admin_ui.js communicate with the SAME handler.js:
  widget  → host.call(path, body)    → handler reads ctx.widgetBody
  admin   → bridge.call(path, body)  → handler reads ctx.adminBody
Alignment must hold in both directions (caller→handler body, handler→caller response)
for both callers.

Answer exactly 7 targeted alignment questions. For each question:
- Set "aligned": true if the artifacts agree on this dimension. Set "aligned": false ONLY if
  you can name the exact identifier that is wrong (a specific field, column, or table name).
- "issue": must be null when aligned is true. When aligned is false, name the EXACT mismatch
  (e.g. "widget sends customerId but handler reads userId for route /subscribe").
  NEVER write an issue that says the code is correct or that things align — that contradicts
  aligned=false and is a logic error.
- "confidence": "high" means you are certain of the specific mismatch you named.
  "medium" means something looks suspicious but context might explain it.
  When aligned is true, set confidence to "high".

CRITICAL RULE: aligned=false + issue saying "both align correctly" or similar is FORBIDDEN.
If you believe the code is correct, set aligned=true and issue=null.

Respond with ONLY this JSON (no markdown fences, no explanation):
{
  "q1_table_names": {
    "aligned": true,
    "issue": null,
    "confidence": "high"
  },
  "q2_column_names": {
    "aligned": true,
    "issue": null,
    "confidence": "high"
  },
  "q3_widget_body_to_handler": {
    "aligned": true,
    "issue": null,
    "confidence": "high"
  },
  "q4_handler_response_to_widget": {
    "aligned": true,
    "issue": null,
    "confidence": "high"
  },
  "q5_admin_body_to_handler": {
    "aligned": true,
    "issue": null,
    "confidence": "high"
  },
  "q6_handler_response_to_admin": {
    "aligned": true,
    "issue": null,
    "confidence": "high"
  },
  "q7_codespec_coverage": {
    "aligned": true,
    "issue": null,
    "confidence": "high"
  }
}"""


# ── User prompt builder ────────────────────────────────────────────────────────

def _build_prompt(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> str:
    impl_spec = (ctx.plan.get("implementationSpec") or {})
    code_spec = impl_spec.get("codeSpec") or {}
    catalog = impl_spec.get("widgetApiCatalog") or []
    admin_catalog = impl_spec.get("adminApiCatalog") or []

    handler = artifacts.get("handler", "(missing)")
    migration = artifacts.get("migration", "(missing)")
    widget = artifacts.get("widget_js", "(not applicable)") if is_storefront else "(not applicable)"
    admin = artifacts.get("admin_ui", "(not applicable)") if is_admin_ui else "(not applicable)"

    return f"""ARTIFACTS
═════════

── handler.js ──
{handler}

── migration.sql ──
{migration}

── widget.js ──
{widget}

── admin_ui.js ──
{admin}

PLAN CONTEXT
════════════

codeSpec:
{json.dumps(code_spec, indent=2)}

widgetApiCatalog (widget↔handler routes and expected response shapes):
{json.dumps(catalog, indent=2)}

adminApiCatalog (admin↔handler routes and expected response shapes):
{json.dumps(admin_catalog, indent=2)}

QUESTIONS
═════════

Q1 — TABLE NAMES
Do all table names referenced in handler.js (INSERT/SELECT/UPDATE/DELETE) exactly
match the table names defined in migration.sql (CREATE TABLE)?
Answer "aligned": true if names match everywhere.

Q2 — COLUMN NAMES
Do all column names referenced in handler.js SQL queries exactly match the column
definitions in migration.sql for the same tables?
Answer "aligned": true if column names match everywhere.

Q3 — WIDGET BODY → HANDLER
For each route that widget.js calls via host.call(path, body):
  Does the body the widget sends contain exactly the fields the handler reads
  from ctx.widgetBody for that route?
Check both directions: no field the handler reads should be absent from the widget call;
no field the widget sends should be silently ignored by the handler.
Pay special attention to fields available in the widget context (e.g. customerId from
host.context) that the handler expects but the widget may have forgotten to include.
Answer "aligned": true if there is no widget (backend-only app).

Q4 — HANDLER RESPONSE → WIDGET
For each route the widget calls, does the handler's return value contain exactly the
fields the widget reads from the result?
Cross-check against widgetApiCatalog responseShape if present.
Answer "aligned": true if there is no widget (backend-only app).

Q5 — ADMIN BODY → HANDLER
For each route that admin_ui.js calls via bridge.call(path, body):
  Does the body the admin panel sends contain exactly the fields the handler reads
  from ctx.adminBody for that route?
Check both directions: no field the handler reads should be absent from the admin call.
Answer "aligned": true if there is no admin_ui (not applicable).

Q6 — HANDLER RESPONSE → ADMIN
For each admin route, does the handler's return value contain exactly the fields
that admin_ui.js reads from the response?
Cross-check against adminApiCatalog responseShape if present.
Answer "aligned": true if there is no admin_ui (not applicable).

Q7 — CODESPEC COVERAGE
Does handler.js implement all steps listed in codeSpec (webhookPath + cronPath)?
Check that every named step has corresponding logic in the handler module.

Respond with the JSON format specified in your system prompt."""


# ── Public API ─────────────────────────────────────────────────────────────────

def run_validator_agent(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> List[Dict]:
    """
    Run 7 targeted semantic alignment questions against the generated artifacts.

    Returns a list of HIGH-confidence issue dicts:
        [{"question": "q3_widget_body_to_handler", "issue": "...", "confidence": "high"}, ...]

    MEDIUM-confidence issues are logged but not returned (false positive mitigation).
    Returns [] on parse failure or when all checks pass (fail-open).
    """
    model = get_agent_model("validator")
    llm = get_llm(model=model, max_tokens=1800)
    user = _build_prompt(artifacts, ctx, is_storefront, is_admin_ui)

    try:
        response = invoke(llm, VALIDATOR_SYSTEM, user)
        raw = extract_json(response.content)
        result = json.loads(raw)
    except Exception as exc:
        log.warning("validator_agent: failed to get/parse response (%s) — fail-open", exc)
        return []

    # Phrases that indicate the LLM contradicted itself by flagging a non-issue.
    _SELF_CONTRADICTING = (
        "align correctly",
        "both align",
        "correctly aligned",
        "are aligned",
        "both routes align",
        "no misalignment",
        "fields match",
        "correctly match",
    )

    issues: List[Dict] = []
    for q_key, data in result.items():
        if not isinstance(data, dict):
            continue
        aligned = data.get("aligned", True)
        confidence = data.get("confidence", "medium")
        issue_text = data.get("issue")

        if not aligned and issue_text:
            # Guard: reject self-contradicting issues where the issue text itself
            # says the code is correct (LLM confused aligned=false with aligned=true).
            lower = issue_text.lower()
            if any(phrase in lower for phrase in _SELF_CONTRADICTING):
                log.warning(
                    "validator_agent: %s flagged as misaligned but issue says code is correct "
                    "— treating as false positive and skipping: %s",
                    q_key,
                    issue_text,
                )
                continue

            if confidence == "high":
                log.info(
                    "validator_agent: %s HIGH confidence issue — %s", q_key, issue_text
                )
                issues.append({"question": q_key, "issue": issue_text, "confidence": "high"})
            else:
                log.info(
                    "validator_agent: %s medium confidence (skipped) — %s", q_key, issue_text
                )

    return issues
