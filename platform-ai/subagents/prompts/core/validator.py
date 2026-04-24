"""
Validator agent prompts — always-on core + per-Q prose + Part A/B rubric text.

VALIDATOR_BASE        — system prompt (Part A / Part B rubric, anti-self-
                        contradiction rule, JSON-only output discipline).

Per-run user prompt content lives here as prose constants; validator_agent.
_build_prompt assembles the dynamic parts (artifacts, plan JSON, expected
question keys, response-shape dict) around these.

  Q1_TABLE_NAMES / Q2_COLUMN_NAMES / Q3_WIDGET_FIELDS / Q4_ADMIN_FIELDS /
  Q5_CRON_BULK_FETCH / Q7_SCHEMA_COMPLETENESS — fixed prose per Q.

  Q6_STATE_MACHINE_TEMPLATE — has {entity} / {tracked_field} placeholders;
  _build_prompt formats it from the plan's stateMachine contract.

  PART_A_HEADER / PART_B_BASE / PART_B_QUALITY_BRIEF_COVERAGE /
  QUALITY_BRIEF_HEADER / RESPONSE_FORMAT_HEADER — block prelude text.
"""

from subagents.prompts.topics.template_tables import (
    VALIDATOR as _TEMPLATE_TABLES_VALIDATOR,
)


VALIDATOR_BASE = """You are a code review specialist. You receive generated artifacts alongside the architect
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
- Each finding MUST cite a specific artifact. For handler files use the path
  ("src/routes/webhook-handlers.ts" / "src/routes/admin.ts" / "src/routes/widget.ts" /
  "src/routes/cron.ts" / "src/lib/<name>.ts"). For the migration file use
  "migration". And a precise location within it (symbol name, route path, job
  name, loop, branch — or line range if obvious).
- Each finding MUST describe HOW it fails at runtime, not just why it "could be better".
- SKIP anything Part A already covers — do not restate those findings here.
- SKIP style, naming, missing comments, micro-optimisation, or "consider doing X instead".
- CAP findings at 8. Return an empty list if nothing deploy-blocking stands out.
- Prefer silence over speculation. If you are not confident the issue is real, leave it out.

Respond ONLY with the single JSON object described in the QUESTIONS block. No markdown,
no prose outside the JSON."""


# ─── Part A — per-Q prose ─────────────────────────────────────────────────────

Q1_TABLE_NAMES = (
    "Q1 — TABLE NAMES (q1_table_names)\n"
    "Do all table names referenced in handler TypeScript SQL (INSERT / SELECT / UPDATE\n"
    "/ DELETE inside `sql` tagged-template literals, across every file in the handler\n"
    "bundle) exactly match the CREATE TABLE names in the migration SQL?\n"
    "Schema isolation pins search_path at deploy time, so bare names are expected —\n"
    "verify the bare name matches the DDL. Flag only if you can name the specific\n"
    "table name that differs."
)

Q2_COLUMN_NAMES = (
    "Q2 — COLUMN NAMES (q2_column_names)\n"
    "Do all column names used in handler TypeScript SQL queries (any file in the\n"
    "handler bundle) exactly match the column definitions in the migration SQL for\n"
    "those tables? Flag only if you can name the specific column name that differs."
)

Q3_WIDGET_FIELDS = (
    "Q3 — WIDGET FIELDS (q3_widget_fields)\n"
    "For each route registered in src/routes/widget.ts (widgetRouter.<method>('<path>',\n"
    "...)):\n"
    "  Do the exact field names destructured from `req.body` match the architect's\n"
    "  widgetApiCatalog requestShape? Look for aliased keys, rest-spread captures, or\n"
    "  indirect reads that static regex can miss."
)

Q4_ADMIN_FIELDS = (
    "Q4 — ADMIN FIELDS (q4_admin_fields)\n"
    "For each route registered in src/routes/admin.ts (adminRouter.<method>('<path>',\n"
    "...)):\n"
    "  Do the exact field names destructured from `req.body` match the architect's\n"
    "  adminApiCatalog requestShape? Check for aliasing, spreads, or indirect reads."
)


Q7_SCHEMA_COMPLETENESS = (
    "Q7 — SCHEMA COMPLETENESS (q7_schema_completeness)\n"
    "For each INSERT statement in handler TypeScript SQL (inside `sql` template\n"
    "literals, any file in the bundle):\n"
    "  a) Do the inserted columns include ALL columns that are NOT NULL with no\n"
    "     DEFAULT in the migration SQL for that table? A missing required column\n"
    "     causes a Postgres runtime error.\n"
    "  b) Do the column names in the migration SQL match what the architect specified\n"
    "     in dbContracts? Flag if the migration added or dropped columns relative to\n"
    "     the spec.\n"
    "Reminder: schema isolation replaces row-level tenant_id — a tenant_id column\n"
    "inside an INSERT or a CREATE TABLE is drift and should be flagged.\n"
    "Set aligned=false only if you can name the specific table and missing/mismatched\n"
    "column."
)


# ─── Block preludes ───────────────────────────────────────────────────────────

PART_A_HEADER = (
    "PART A — MANDATORY CHECKS\n═════════════════════════\n\n"
    f"{_TEMPLATE_TABLES_VALIDATOR}\n\n"
)

PART_B_BASE = (
    "PART B — OPEN REVIEW\n════════════════════\n\n"
    "Apply the system-prompt Part B rubric to the artifacts above. Return an\n"
    "empty open_findings list when nothing deploy-blocking stands out."
)

# Appended to PART_B_BASE ONLY when the quality brief is present. The
# QUALITY BRIEF block (rendered earlier in the user prompt) already defines
# what counts as an explicit requirement; this section carries only the
# mechanical instruction — verify coverage, flag gaps as Part B findings,
# HIGH confidence only.
PART_B_QUALITY_BRIEF_COVERAGE = (
    "\n\nQuality-brief coverage (when a QUALITY BRIEF is provided above):\n"
    "For each EXPLICIT requirement named in the brief, verify the code\n"
    "actually addresses it; flag any gap as a Part B finding with HIGH\n"
    "confidence only (artifact + location + failure_mode). Example:\n"
    "brief requires customer email-consent handling → handler never reads\n"
    "email_marketing_consent or an equivalent opt-out signal.\n"
    "Do NOT flag things the brief only implies — only direct misses."
)

QUALITY_BRIEF_HEADER = (
    "QUALITY BRIEF\n═════════════\n\n"
    "The product agent wrote this brief describing what a good version of\n"
    "this specific app does well. Treat EXPLICIT requirements it names\n"
    "(edge cases to handle, UX details that matter, opt-out / unsubscribe\n"
    "expectations, metrics the merchant will want, etc.) as quality\n"
    "criteria to check coverage against in Part B.\n\n"
)

RESPONSE_FORMAT_HEADER = (
    "RESPONSE FORMAT\n═══════════════\n\n"
    "Respond ONLY with this JSON shape (Part A keys exactly as shown in parentheses;\n"
    "open_findings is a list — empty if nothing to report):\n"
)
