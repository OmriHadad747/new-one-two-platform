"""
Validator Agent — post-static-check semantic verification.

Runs targeted questions against the generated artifacts to catch issues that
static analysis cannot detect reliably.

System prompt lives in subagents/prompts/validator/ (VALIDATOR_BASE).
Per-run Q1–Q7 strings and the response-shape JSON are built dynamically below
(_build_prompt) because they depend on which surfaces this app has.

Questions and their unique value over static checks:
  Q1  table names     migration DDL ↔ handler SQL      — static can't parse SQL inside template literals
  Q2  column names    migration DDL ↔ handler SQL      — same reason as Q1
  Q3  widget fields   widgetApiCatalog requestShape ↔ req.body destructuring in src/routes/widget.ts — static misses aliasing, spreads
  Q4  admin fields    adminApiCatalog requestShape ↔ req.body destructuring in src/routes/admin.ts — same as Q3
  Q5  cron batching   when declared: no per-item Shopify calls inside loop — cannot be reliably static-checked
  Q6  state machine   when declared: handler reads prior DB state before comparing — verifies logic, not just presence
  Q7  schema completeness — handler INSERT omits NOT NULL/no-DEFAULT columns → Postgres runtime error

Q3 fires when widgetApiCatalog is non-empty; Q4 fires when adminApiCatalog is non-empty.
Widget and admin routes live inside the handler bundle (src/routes/widget.ts and
src/routes/admin.ts) — Q3/Q4 check those files against the architect's catalogs.
Q3/Q4 differ from static cross-artifact checks: static uses regex on catalog shapes,
this catches semantic mismatches (aliased field names, spread operators, indirect reads).
Q5/Q6 are only asked when the plan declares cronBatching/stateMachine.
Q7 always runs: catches the inverse of Q2 — not "wrong column name" but "missing required column".

Part B — open review:
  The validator also flags deploy-blocking bugs it sees in the artifacts that
  Part A and static rules do not already cover (races, pagination, numeric
  overflow, orphaned state, etc.). Each Part B finding is scoped to a specific
  artifact and merged into the same issues list as Part A with a synthetic
  question key `open_review[<artifact>]`; the `artifact` field drives revision
  locking (handler/migration → backend unlock).

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
from subagents.prompts.core.validator import (
    PART_A_HEADER,
    PART_B_BASE,
    PART_B_QUALITY_BRIEF_COVERAGE,
    Q1_TABLE_NAMES,
    Q2_COLUMN_NAMES,
    Q3_WIDGET_FIELDS,
    Q4_ADMIN_FIELDS,
    Q7_SCHEMA_COMPLETENESS,
    QUALITY_BRIEF_HEADER,
    RESPONSE_FORMAT_HEADER,
    VALIDATOR_BASE,
)
from subagents.prompts.topics.shopify_loop import VALIDATOR as Q5_CRON_BULK_FETCH
from subagents.prompts.topics.state_machine import VALIDATOR as Q6_STATE_MACHINE_TEMPLATE

log = logging.getLogger(__name__)

# Extended-thinking budget for the validator call. Part A is mechanical matching
# (thinking helps marginally); Part B is real multi-artifact bug-finding where
# deeper reasoning earns its cost. 8192 is enough for the model to trace a few
# suspected issues end-to-end without blowing the per-call latency ceiling.
_VALIDATOR_THINKING_BUDGET = 8192

_VALID_OPEN_ARTIFACTS = {"handler", "migration"}


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
    quality_brief = (ctx.intent or {}).get("qualityBrief") or ""

    handler = artifacts.get("handler", "(missing)")
    migration = artifacts.get("migration", "(missing)")
    widget = (
        artifacts.get("widget_js", "(not applicable)")
        if is_storefront
        else "(not applicable)"
    )
    admin = (
        artifacts.get("admin_ui", "(not applicable)")
        if is_admin_ui
        else "(not applicable)"
    )

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
    if widget_catalog:
        plan_parts.append(f"widgetApiCatalog:\n{json.dumps(widget_catalog, indent=2)}")
    if admin_catalog:
        plan_parts.append(f"adminApiCatalog:\n{json.dumps(admin_catalog, indent=2)}")
    if has_cron_batching:
        plan_parts.append(f"cronBatching:\n{json.dumps(cron_batching, indent=2)}")
    if has_state_machine:
        plan_parts.append(f"stateMachine:\n{json.dumps(sm, indent=2)}")
    plan_block = (
        "PLAN CONTEXT\n════════════\n\n" + "\n\n".join(plan_parts) if plan_parts else ""
    )

    # ── Quality brief (per-app intent) ────────────────────────────────────────
    # Rendered as a standalone block. Validator checks that explicitly-stated
    # quality criteria in the brief are reflected in the code — see Part B's
    # quality-brief coverage guidance (appended only when this block is set).
    quality_block = (
        f"{QUALITY_BRIEF_HEADER}{quality_brief.strip()}"
        if quality_brief.strip()
        else ""
    )

    # ── Questions (only relevant ones) ───────────────────────────────────────
    questions: List[str] = [Q1_TABLE_NAMES, Q2_COLUMN_NAMES]
    expected_keys: List[str] = ["q1_table_names", "q2_column_names"]

    if widget_catalog:
        questions.append(Q3_WIDGET_FIELDS)
        expected_keys.append("q3_widget_fields")

    if admin_catalog:
        questions.append(Q4_ADMIN_FIELDS)
        expected_keys.append("q4_admin_fields")

    if has_cron_batching:
        questions.append(Q5_CRON_BULK_FETCH)
        expected_keys.append("q5_cron_bulk_fetch")

    if has_state_machine:
        questions.append(
            Q6_STATE_MACHINE_TEMPLATE.format(
                entity=sm.get("entity", "?"),
                tracked_field=sm.get("trackedField", "?"),
            )
        )
        expected_keys.append("q6_state_machine")

    if db_contracts:
        questions.append(Q7_SCHEMA_COMPLETENESS)
        expected_keys.append("q7_schema_completeness")

    # Build the expected JSON shape hint (Part A closed questions + Part B open findings).
    shape: Dict[str, object] = {
        k: {"aligned": True, "issue": None, "confidence": "high"} for k in expected_keys
    }
    shape["open_findings"] = [
        {
            "artifact": "handler | migration",
            "location": "symbol / loop / branch — or line range",
            "issue": "what is wrong",
            "failure_mode": "how this fails at runtime",
            "confidence": "high | medium",
        }
    ]

    part_a_block = PART_A_HEADER + "\n\n".join(questions)

    part_b_block = PART_B_BASE + (
        PART_B_QUALITY_BRIEF_COVERAGE if quality_brief.strip() else ""
    )

    response_block = RESPONSE_FORMAT_HEADER + json.dumps(shape, indent=2)

    return "\n\n".join(
        filter(
            None,
            [
                artifacts_block,
                plan_block,
                quality_block,
                part_a_block,
                part_b_block,
                response_block,
            ],
        )
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
        response = invoke(llm, VALIDATOR_BASE, user)
        in_tok = response.input_tokens
        out_tok = response.output_tokens
        raw = extract_json(response.content)
        result = json.loads(raw)
    except Exception as exc:
        log.warning(
            "validator_agent: failed to get/parse response (%s) — fail-open", exc
        )
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
            log.info(
                "validator_agent: %s HIGH confidence issue — %s", q_key, issue_text
            )
            issues.append(
                {"question": q_key, "issue": issue_text, "confidence": "high"}
            )
        else:
            log.info(
                "validator_agent: %s medium confidence (skipped) — %s",
                q_key,
                issue_text,
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
                "(artifact=%s)",
                artifact,
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
