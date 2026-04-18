"""
Validator Agent — post-static-check semantic verification.

Runs targeted questions against the generated artifacts to catch issues that
static analysis cannot detect reliably.

Questions and their unique value over static checks:
  Q1  table names     migration DDL ↔ handler SQL      — static can't parse SQL inside template literals
  Q2  column names    migration DDL ↔ handler SQL      — same reason as Q1
  Q3  widget fields   host.call() body ↔ ctx.widgetBody — static misses aliasing, spreads, indirect reads
  Q4  admin fields    bridge.call() body ↔ ctx.adminBody — same as Q3
  Q5  cron batching   when declared: no per-item Shopify calls inside loop — cannot be reliably static-checked
  Q6  state machine   when declared: handler reads prior DB state before comparing — verifies logic, not just presence
  Q7  schema completeness — handler INSERT omits NOT NULL/no-DEFAULT columns → Postgres runtime error

Q3/Q4 differ from static cross-artifact checks: static uses regex on catalog shapes,
this catches semantic mismatches (aliased field names, spread operators, indirect reads).
Q5/Q6 are only asked when the plan declares cronBatching/stateMachine.
Q7 always runs: catches the inverse of Q2 — not "wrong column name" but "missing required column".

Part B — open review (new):
  The validator also flags deploy-blocking bugs it sees in the artifacts that
  Part A and static rules do not already cover (races, pagination, numeric
  overflow, orphaned state, etc.). Each Part B finding is scoped to a specific
  artifact and merged into the same issues list as Part A with a synthetic
  question key `open_review[<artifact>]`; the `artifact` field drives revision
  locking (handler/migration → backend unlock, widget_js/admin_ui → frontend only).

Only HIGH confidence issues trigger an automatic revision. MEDIUM issues are
logged but not acted upon (false positive mitigation). Runs on Sonnet with
extended thinking enabled — Part B requires multi-step reasoning across
artifacts that Haiku-no-thinking cannot reliably perform.

Controlled by LLM_VALIDATION_ENABLED=true in environment (default: false).
"""
from __future__ import annotations

import json
import logging
from typing import Dict, List, Tuple

from models.adapter import extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.base import CodegenContext

log = logging.getLogger(__name__)

# Extended-thinking budget for the validator call. Part A is mechanical matching
# (thinking helps marginally); Part B is real multi-artifact bug-finding where
# deeper reasoning earns its cost. 8192 is enough for the model to trace a few
# suspected issues end-to-end without blowing the per-call latency ceiling.
_VALIDATOR_THINKING_BUDGET = 8192

_VALID_OPEN_ARTIFACTS = {"handler", "migration", "widget_js", "admin_ui"}

# ── System prompt ──────────────────────────────────────────────────────────────

VALIDATOR_SYSTEM = """\
You are a code review specialist. You receive generated artifacts alongside the architect
plan contracts. Your job has TWO parts.

═══ PART A — MANDATORY CHECKS ═══
Answer every targeted question you are asked. Only questions relevant to this specific
app are included. For each question:
- "aligned": true if correct, false ONLY if you can name the EXACT identifier that is wrong.
- "issue": null when aligned=true. When false, name the precise mismatch
  (e.g. "widget sends customerId but handler reads userId for /subscribe").
  NEVER write an issue that says the code is correct — that contradicts aligned=false.
- "confidence": "high" = certain of the specific mismatch. "medium" = suspicious but context
  might explain it. Set "high" when aligned=true.

CRITICAL: aligned=false + issue text saying code is correct or things align is FORBIDDEN.
If code is correct: set aligned=true and issue=null.

═══ PART B — OPEN REVIEW ═══
Beyond Part A's closed questions, flag DEPLOY-BLOCKING issues you notice in the artifacts.
This is for real bugs static rules and Part A do not yet cover (races, missing pagination,
unsafe assumptions about DB driver shapes, orphaned state, resource leaks, silent data loss,
numeric overflow, etc.). Apply these rules strictly:
- Each finding MUST cite a specific artifact ("handler" / "migration" / "widget_js" /
  "admin_ui") and a precise location (symbol name, loop, branch — or line range if obvious).
- Each finding MUST describe HOW it fails at runtime, not just why it "could be better".
- SKIP anything Part A already covers — do not restate those findings here.
- SKIP style, naming, missing comments, micro-optimisation, or "consider doing X instead".
- CAP findings at 8. Return an empty list if nothing deploy-blocking stands out.
- Prefer silence over speculation. If you are not confident the issue is real, leave it out.

Respond ONLY with the single JSON object described in the QUESTIONS block. No markdown,
no prose outside the JSON."""


# ── User prompt builder ────────────────────────────────────────────────────────

def _build_prompt(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> str:
    contracts = ctx.plan.get("appContracts") or {}
    widget_catalog = contracts.get("widgetApiCatalog") or []
    admin_catalog = contracts.get("adminApiCatalog") or []
    db_contracts = contracts.get("dbContracts") or []
    cron_batching = contracts.get("cronBatching") or {}
    has_cron_batching = bool(cron_batching.get("required"))
    sm = contracts.get("stateMachine")
    has_state_machine = bool(sm and isinstance(sm, dict))

    handler = artifacts.get("handler", "(missing)")
    migration = artifacts.get("migration", "(missing)")
    widget = artifacts.get("widget_js", "(not applicable)") if is_storefront else "(not applicable)"
    admin = artifacts.get("admin_ui", "(not applicable)") if is_admin_ui else "(not applicable)"

    # ── Artifacts block ───────────────────────────────────────────────────────
    artifacts_block = f"""ARTIFACTS
═════════

── handler.js ──
{handler}

── migration.sql ──
{migration}"""

    if is_storefront:
        artifacts_block += f"\n\n── widget.js ──\n{widget}"
    if is_admin_ui:
        artifacts_block += f"\n\n── admin_ui.js ──\n{admin}"

    # ── Plan context (only what's needed) ────────────────────────────────────
    plan_parts = []
    if db_contracts:
        plan_parts.append(
            f"dbContracts (architect-specified schema — source of truth for tables and columns):\n"
            f"{json.dumps(db_contracts, indent=2)}"
        )
    if is_storefront:
        plan_parts.append(
            f"widgetApiCatalog:\n{json.dumps(widget_catalog, indent=2)}"
        )
    if is_admin_ui:
        plan_parts.append(
            f"adminApiCatalog:\n{json.dumps(admin_catalog, indent=2)}"
        )
    if has_cron_batching:
        plan_parts.append(
            f"cronBatching:\n{json.dumps(cron_batching, indent=2)}"
        )
    if has_state_machine:
        plan_parts.append(
            f"stateMachine:\n{json.dumps(sm, indent=2)}"
        )
    plan_block = "PLAN CONTEXT\n════════════\n\n" + "\n\n".join(plan_parts) if plan_parts else ""

    # ── Questions (only relevant ones) ───────────────────────────────────────
    questions: List[str] = []
    expected_keys: List[str] = []

    questions.append(
        "Q1 — TABLE NAMES (q1_table_names)\n"
        "Do all table names referenced in handler.js SQL (INSERT/SELECT/UPDATE/DELETE inside\n"
        "ctx.db template literals) exactly match the CREATE TABLE names in migration.sql?\n"
        "Flag only if you can name the specific table name that differs."
    )
    expected_keys.append("q1_table_names")

    questions.append(
        "Q2 — COLUMN NAMES (q2_column_names)\n"
        "Do all column names used in handler.js SQL queries exactly match the column\n"
        "definitions in migration.sql for those tables?\n"
        "Flag only if you can name the specific column name that differs."
    )
    expected_keys.append("q2_column_names")

    if is_storefront:
        questions.append(
            "Q3 — WIDGET FIELDS (q3_widget_fields)\n"
            "For each route widget.js calls via host.call(path, body):\n"
            "  Do the exact field names the widget sends match what the handler reads from\n"
            "  ctx.widgetBody? Look for aliased keys, spread operators, or indirect reads\n"
            "  that static regex can miss. Cross-check against widgetApiCatalog requestShape.\n"
            "  Also verify host.context fields (e.g. customerId) the handler expects are\n"
            "  actually read from host.context in the widget."
        )
        expected_keys.append("q3_widget_fields")

    if is_admin_ui:
        questions.append(
            "Q4 — ADMIN FIELDS (q4_admin_fields)\n"
            "For each route admin_ui.js calls via bridge.call(path, body):\n"
            "  Do the exact field names the admin UI sends match what the handler reads from\n"
            "  ctx.adminBody? Check for aliasing, spreads, or indirect reads.\n"
            "  Cross-check against adminApiCatalog requestShape."
        )
        expected_keys.append("q4_admin_fields")

    if has_cron_batching:
        questions.append(
            "Q5 — CRON BULK-FETCH PATTERN (q5_cron_bulk_fetch)\n"
            "The plan declares cronBatching.required=true, meaning the cron handler MUST\n"
            "bulk-fetch all needed Shopify data BEFORE iterating over items.\n"
            "Does the cron branch in handler.js:\n"
            "  a) Fetch all required Shopify data in one or a few batched API calls BEFORE\n"
            "     the main iteration loop begins?\n"
            "  b) Avoid making per-item Shopify API calls (ctx.shopify.get/post/graphql)\n"
            "     inside the main loop body?\n"
            "Set aligned=false if the handler makes Shopify API calls per-item inside the loop\n"
            "instead of bulk-fetching first. Name the specific loop and API call pattern."
        )
        expected_keys.append("q5_cron_bulk_fetch")

    if has_state_machine:
        questions.append(
            "Q6 — STATE MACHINE LOGIC (q6_state_machine)\n"
            f"The plan declares a stateMachine tracking '{sm.get('trackedField', '?')}' on\n"
            f"'{sm.get('entity', '?')}'. The handler must:\n"
            "  a) Load the last-observed value from the DB snapshot table before comparing.\n"
            "  b) Compare the incoming value against the prior value to detect a transition.\n"
            "  c) Only act (send notifications, update records) when a genuine transition\n"
            "     matches a declared transition pattern.\n"
            "  d) Update the snapshot table with the new value after acting.\n"
            "Set aligned=false if any of these steps is missing or out of order."
        )
        expected_keys.append("q6_state_machine")

    if db_contracts:
        questions.append(
            "Q7 — SCHEMA COMPLETENESS (q7_schema_completeness)\n"
            "For each INSERT statement in handler.js SQL (inside ctx.db template literals):\n"
            "  a) Do the inserted columns include ALL columns that are NOT NULL with no DEFAULT\n"
            "     in migration.sql for that table? A missing required column causes a Postgres\n"
            "     runtime error.\n"
            "  b) Do the column names in migration.sql match what the architect specified in\n"
            "     dbContracts? Flag if the migration added or dropped columns relative to the spec.\n"
            "Set aligned=false only if you can name the specific table and missing/mismatched column."
        )
        expected_keys.append("q7_schema_completeness")

    # Build the expected JSON shape hint (Part A closed questions + Part B open findings).
    shape: Dict[str, object] = {
        k: {"aligned": True, "issue": None, "confidence": "high"} for k in expected_keys
    }
    shape["open_findings"] = [
        {
            "artifact": "handler | migration | widget_js | admin_ui",
            "location": "symbol / loop / branch — or line range",
            "issue": "what is wrong",
            "failure_mode": "how this fails at runtime",
            "confidence": "high | medium",
        }
    ]

    part_a_block = (
        "PART A — MANDATORY CHECKS\n═════════════════════════\n\n"
        + "\n\n".join(questions)
    )

    part_b_block = (
        "PART B — OPEN REVIEW\n════════════════════\n\n"
        "Flag deploy-blocking bugs you see in the artifacts that Part A does not already cover.\n"
        "Follow the rubric in the system prompt: artifact + location + failure_mode required,\n"
        "cap at 8, prefer silence over speculation, skip style/naming/micro-optimisation.\n"
        "Return an empty list when nothing deploy-blocking stands out."
    )

    response_block = (
        "RESPONSE FORMAT\n═══════════════\n\n"
        "Respond ONLY with this JSON shape (Part A keys exactly as shown in parentheses;\n"
        "open_findings is a list — empty if nothing to report):\n"
        + json.dumps(shape, indent=2)
    )

    return "\n\n".join(
        filter(None, [artifacts_block, plan_block, part_a_block, part_b_block, response_block])
    )


# ── Public API ─────────────────────────────────────────────────────────────────

def run_validator_agent(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> Tuple[List[Dict], int, int]:
    """
    Run targeted semantic questions against the generated artifacts.

    Only questions relevant to this app (storefront, admin, cronBatching, stateMachine)
    are included. Returns (issues, input_tokens, output_tokens).
    issues is a list of HIGH-confidence issue dicts with a uniform shape:
        Part A: {"question": "q5_cron_bulk_fetch", "issue": "...", "confidence": "high"}
        Part B: {"question": "open_review[handler]", "issue": "...", "confidence": "high",
                 "artifact": "handler"}
    The ``artifact`` field on Part B entries drives revision locking downstream.

    MEDIUM-confidence issues are logged but not returned (false positive mitigation).
    Returns ([], in, out) on parse failure or when all checks pass (fail-open).
    """
    model = get_agent_model("validator")
    llm = get_llm(
        model=model, max_tokens=2000, thinking_budget=_VALIDATOR_THINKING_BUDGET
    )
    user = _build_prompt(artifacts, ctx, is_storefront, is_admin_ui)

    in_tok = 0
    out_tok = 0
    try:
        response = invoke(llm, VALIDATOR_SYSTEM, user)
        in_tok = response.input_tokens
        out_tok = response.output_tokens
        raw = extract_json(response.content)
        result = json.loads(raw)
    except Exception as exc:
        log.warning("validator_agent: failed to get/parse response (%s) — fail-open", exc)
        return [], in_tok, out_tok

    if not isinstance(result, dict):
        log.warning("validator_agent: response is not a JSON object — fail-open")
        return [], in_tok, out_tok

    issues: List[Dict] = []
    issues.extend(_parse_part_a(result))
    issues.extend(_parse_open_findings(result.get("open_findings")))
    return issues, in_tok, out_tok


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


def _parse_part_a(result: Dict) -> List[Dict]:
    issues: List[Dict] = []
    for q_key, data in result.items():
        if q_key == "open_findings" or not isinstance(data, dict):
            continue
        aligned = data.get("aligned", True)
        confidence = data.get("confidence", "medium")
        issue_text = data.get("issue")

        if aligned or not issue_text:
            continue

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
            log.info("validator_agent: %s HIGH confidence issue — %s", q_key, issue_text)
            issues.append({"question": q_key, "issue": issue_text, "confidence": "high"})
        else:
            log.info(
                "validator_agent: %s medium confidence (skipped) — %s", q_key, issue_text
            )
    return issues


def _parse_open_findings(raw: object) -> List[Dict]:
    """
    Normalise Part B open_findings into the same shape Part A emits.

    Skips findings that are missing a required field, name a non-canonical
    artifact, or look like the schema-hint echoed back verbatim. HIGH-confidence
    only, matching Part A's bar for triggering a revision.
    """
    if not isinstance(raw, list):
        return []

    out: List[Dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        artifact = (entry.get("artifact") or "").strip()
        issue_text = (entry.get("issue") or "").strip()
        location = (entry.get("location") or "").strip()
        failure_mode = (entry.get("failure_mode") or "").strip()
        confidence = (entry.get("confidence") or "medium").strip().lower()

        # Reject the schema-hint echo where the model returns the placeholder
        # string ("handler | migration | widget_js | admin_ui") instead of a
        # concrete artifact name.
        if artifact not in _VALID_OPEN_ARTIFACTS:
            if artifact:
                log.info(
                    "validator_agent: open_finding skipped — artifact=%r not in %s",
                    artifact,
                    sorted(_VALID_OPEN_ARTIFACTS),
                )
            continue

        if not issue_text or not failure_mode:
            log.info(
                "validator_agent: open_finding skipped — missing issue or failure_mode "
                "(artifact=%s)", artifact,
            )
            continue

        composed = (
            f"[{location}] {issue_text} — {failure_mode}"
            if location
            else f"{issue_text} — {failure_mode}"
        )

        if confidence == "high":
            log.info(
                "validator_agent: open_review[%s] HIGH confidence — %s",
                artifact,
                composed,
            )
            out.append(
                {
                    "question": f"open_review[{artifact}]",
                    "issue": composed,
                    "confidence": "high",
                    "artifact": artifact,
                }
            )
        else:
            log.info(
                "validator_agent: open_review[%s] medium confidence (skipped) — %s",
                artifact,
                composed,
            )
    return out
