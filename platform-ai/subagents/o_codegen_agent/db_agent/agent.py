"""
DB Generator — produces PostgreSQL DDL from the LLD's database.tables[].

The LLD is the authoritative spec — every column's name, sqlType, constraints,
enum, foreignKeys, uniqueConstraint, and indexes are spec'd there. This
generator is a near-mechanical translation from that structure into DDL.

System prompt lives in subagents/o_codegen_agent/db_agent/prompt.py (DB_BASE).

Isolation model: each tenant has its own Postgres schema; the deployer runs
migrations with search_path pinned to that schema, so `CREATE TABLE foo`
lands at `tenant_<uuid>.foo` automatically. Emitted SQL therefore has no
tenant_id column, no RLS, no CREATE POLICY.

Validator allow-list (enforced by both `subagents.o_codegen_agent.db_agent.validator`
and platform-back's `packages/deployer/src/sql-validator.ts`):
  Allowed:     CREATE TABLE, CREATE INDEX (incl. UNIQUE),
               ALTER TABLE ADD COLUMN IF NOT EXISTS, COMMENT ON.
  Forbidden:   DROP*, TRUNCATE, DELETE FROM, UPDATE SET, GRANT/REVOKE,
               ENABLE RLS / CREATE POLICY, CREATE FUNCTION / TRIGGER /
               EXTENSION, DO $$ blocks, CONCURRENTLY, COPY FROM PROGRAM,
               SELECT cron.schedule(...).

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.o_codegen_agent.db_agent.prompt import DB_BASE
from subagents.o_codegen_agent.db_agent.validator import validate_db_artifact
from subagents.m_pre_codegen_agent import format_alignment_for

_SQL_KEYWORDS = ("CREATE", "ALTER", "INSERT", "DROP", "GRANT", "REVOKE", "COMMENT")


class DbGenerator(Generator):
    name = "db"
    max_tokens = 2048

    # Near-mechanical translation of LLD database.tables into DDL — reasoning
    # surface does not scale with app complexity, so extended thinking goes
    # unused. Opt out to save tokens and trim latency.
    supports_thinking = False

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return DB_BASE

    def user_prompt(self, ctx: CodegenContext) -> str:
        tables_block = _format_lld_tables(ctx.lld)
        prior_block = _format_prior_db(ctx.prior_db_sql)

        if ctx.prior_db_sql:
            closing = (
                "Generate ONLY the incremental DDL needed for this revision.\n"
                "Do NOT recreate tables that already exist (listed above).\n"
                "Use ALTER TABLE ... ADD COLUMN IF NOT EXISTS for new columns "
                "on existing tables.\n"
                "If no schema change is needed, output nothing at all — zero "
                "characters.\n"
                "Output ONLY raw SQL (no markdown fences)."
            )
        else:
            closing = (
                "Generate the PostgreSQL DDL migration for this feature.\n"
                "Plain CREATE TABLE / CREATE INDEX against unqualified names.\n"
                "Add COMMENT ON TABLE / COMMENT ON COLUMN where the LLD "
                "supplies a `purpose`.\n"
                "No tenant_id, no RLS, no CREATE POLICY — see the isolation\n"
                "model in the system prompt.\n"
                "Output ONLY raw SQL (no markdown fences)."
            )

        alignment_block = format_alignment_for(ctx.alignment_notes, self.name)
        return (
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n"
            f"Triggers: {', '.join(ctx.intent.get('triggerTypes', []))}\n\n"
            f"{tables_block}"
            f"{prior_block}"
            f"{alignment_block}"
            f"{closing}"
        )

    def parse(self, raw: str) -> str:
        sql = raw.strip()
        sql = re.sub(r"^```sql\s*", "", sql, flags=re.MULTILINE)
        sql = re.sub(r"```\s*$", "", sql, flags=re.MULTILINE)
        sql = sql.strip()
        # If the model returned prose instead of SQL, treat as empty
        # (no tables needed).
        if sql and not sql.upper().startswith(_SQL_KEYWORDS):
            return ""
        return sql

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        prior_tables = _extract_table_names(ctx.prior_db_sql or "")
        return validate_db_artifact(artifact, prior_tables=prior_tables)


# ── Private prompt-building helpers ───────────────────────────────────────────


def _extract_table_names(sql: str) -> List[str]:
    """Return all table names found in CREATE TABLE statements."""
    return re.findall(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", sql, re.IGNORECASE
    )


def _format_lld_tables(lld: Dict[str, Any]) -> str:
    """
    Render the LLD's `database.tables[]` block as the authoritative spec
    for DDL emission. Each entry shows the exact column shape, plus
    uniqueConstraint / indexes / foreignKeys / purpose so the generator
    has nothing to derive — only translate.
    """
    tables = ((lld or {}).get("database") or {}).get("tables") or []
    if not tables:
        return "LLD database.tables: empty — this feature requires no new tables.\n\n"

    parts = [
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "LLD database.tables — authoritative column definitions (implement exactly):",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ]
    for table in tables:
        name = table.get("name", "?")
        purpose = (table.get("purpose") or "").strip()
        columns = table.get("columns") or []
        unique = table.get("uniqueConstraint")
        indexes = table.get("indexes") or []
        foreign_keys = table.get("foreignKeys") or []

        parts.append(f"\nTable: {name}")
        if purpose:
            parts.append(f"  purpose: {purpose}")
        for col in columns:
            constraints = (col.get("constraints") or "").strip()
            enum_values = col.get("enum")
            if isinstance(enum_values, list) and enum_values:
                literal_list = ", ".join(f"'{v}'" for v in enum_values)
                check_clause = f"CHECK ({col['name']} IN ({literal_list}))"
                if check_clause not in constraints:
                    constraints = (
                        f"{constraints} {check_clause}".strip()
                        if constraints
                        else check_clause
                    )
            line = f"  {col['name']}  {col.get('sqlType', '?')}  {constraints}".rstrip()
            col_purpose = (col.get("purpose") or "").strip()
            if col_purpose:
                line += f"   -- {col_purpose}"
            parts.append(line)
        if unique:
            cols = unique.get("columns", []) if isinstance(unique, dict) else unique
            if cols:
                parts.append(f"  UNIQUE ({', '.join(cols)})")
        if foreign_keys:
            for fk in foreign_keys:
                col_name = fk.get("column", "?")
                refs = fk.get("references", "?")
                on_delete = fk.get("onDelete", "RESTRICT")
                # Skip when the column's `constraints` already encodes this FK
                # (LLD allows duplication — codegen dedupes).
                already_inline = any(
                    c.get("name") == col_name
                    and "REFERENCES" in (c.get("constraints") or "").upper()
                    for c in columns
                )
                if already_inline:
                    continue
                parts.append(
                    f"  FOREIGN KEY ({col_name}) REFERENCES {refs} ON DELETE {on_delete}"
                )
        if indexes:
            # One entry per line so single-column indexes vs. comma-separated
            # composite indexes are unambiguous (`Indexes: a, b` would be
            # ambiguous between two singles vs. one composite).
            parts.append("  Indexes:")
            for idx in indexes:
                parts.append(f"    - {idx}")

    parts.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
    return "\n".join(parts) + "\n"


def _format_prior_db(prior_sql: Any) -> str:
    """
    Show the already-applied schema for revision runs so the agent only emits
    incremental DDL (new tables or ADD COLUMN) instead of recreating
    everything.
    """
    if not prior_sql:
        return ""
    prior_tables = _extract_table_names(prior_sql)
    table_list = ", ".join(prior_tables) if prior_tables else "(none)"
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "REVISION RUN — schema already applied to the database:\n"
        f"Tables already deployed (DO NOT recreate): {table_list}\n"
        "For these tables: do NOT emit CREATE TABLE, ALTER TABLE ENABLE RLS,\n"
        "or CREATE POLICY — they are already in place. Only ADD COLUMN IF\n"
        "NOT EXISTS for genuinely new columns, or nothing at all if no\n"
        "schema change is needed.\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{prior_sql}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
