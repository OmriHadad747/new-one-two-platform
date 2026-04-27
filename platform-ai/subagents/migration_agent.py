"""
Migration Generator — produces PostgreSQL DDL from dbContracts.

The architect's dbContracts are the authoritative column definitions — the
migration generator produces DDL mechanically from those typed table
definitions.

System prompt lives in subagents/prompts/migration/ (MIGRATION_BASE).

Isolation model (see MIGRATION_BASE): each tenant has its own Postgres
schema; the deployer runs migrations with search_path pinned to that
schema, so `CREATE TABLE foo` lands at `tenant_<uuid>.foo` automatically.
Generator-emitted SQL therefore has no tenant_id column, no RLS, no
CREATE POLICY — those belong to the previous (row-level) architecture.

Validator allow-list (enforced by both platform-ai's
static_validation.validate_migration_artifact and platform-back's
packages/deployer/src/sql-validator.ts):
  Allowed:     CREATE TABLE, CREATE INDEX (incl. UNIQUE),
               ALTER TABLE ADD COLUMN IF NOT EXISTS, COMMENT ON.
  Forbidden:   DROP*, TRUNCATE, DELETE FROM, UPDATE SET, GRANT/REVOKE,
               ENABLE RLS / CREATE POLICY, CREATE FUNCTION / TRIGGER /
               EXTENSION, DO $$ blocks, CONCURRENTLY, COPY FROM PROGRAM,
               SELECT cron.schedule(...)  (deployer owns — see TD-023).

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.prompts.core.migration import MIGRATION_BASE
from llm_validations.migration_artifact import validate_migration_artifact

_SQL_KEYWORDS = ("CREATE", "ALTER", "INSERT", "DROP", "GRANT", "REVOKE", "COMMENT")


class MigrationGenerator(Generator):
    name = "migration"
    max_tokens = 2048

    # Migration is a near-mechanical translation of dbContracts into CREATE TABLE
    # DDL — reasoning surface does not scale with app complexity, so extended
    # thinking goes unused. Opt out to save tokens and trim latency.
    supports_thinking = False

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return MIGRATION_BASE

    def user_prompt(self, ctx: CodegenContext) -> str:
        contracts_block = _format_db_contracts(ctx.plan)
        prior_block = _format_prior_migration(ctx.prior_migration_sql)

        if ctx.prior_migration_sql:
            closing = (
                "Generate ONLY the incremental DDL needed for this revision.\n"
                "Do NOT recreate tables that already exist (listed above).\n"
                "Use ALTER TABLE ... ADD COLUMN IF NOT EXISTS for new columns on existing tables.\n"
                "If no schema change is needed, output nothing at all — zero characters.\n"
                "Output ONLY raw SQL (no markdown fences)."
            )
        else:
            closing = (
                "Generate the PostgreSQL DDL migration for this feature.\n"
                "Plain CREATE TABLE / CREATE INDEX against unqualified names.\n"
                "No tenant_id, no RLS, no CREATE POLICY — see the isolation\n"
                "model in the system prompt.\n"
                "Output ONLY raw SQL (no markdown fences)."
            )

        return (
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n"
            f"Triggers: {', '.join(ctx.intent.get('triggerTypes', []))}\n\n"
            f"{contracts_block}"
            f"{prior_block}"
            f"{closing}"
        )

    def parse(self, raw: str) -> str:
        sql = raw.strip()
        sql = re.sub(r"^```sql\s*", "", sql, flags=re.MULTILINE)
        sql = re.sub(r"```\s*$", "", sql, flags=re.MULTILINE)
        sql = sql.strip()
        # If the model returned prose instead of SQL, treat as empty (no tables needed).
        if sql and not sql.upper().startswith(_SQL_KEYWORDS):
            return ""
        return sql

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        prior_tables = _extract_table_names(ctx.prior_migration_sql or "")
        return validate_migration_artifact(artifact, prior_tables=prior_tables)


# ── Private prompt-building helpers ───────────────────────────────────────────


def _extract_table_names(sql: str) -> List[str]:
    """Return all table names found in CREATE TABLE statements."""
    return re.findall(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", sql, re.IGNORECASE
    )


def _format_db_contracts(plan: Dict[str, Any]) -> str:
    """
    Render dbContracts as the authoritative column specification for DDL generation.
    Each table entry lists exact column names, types, and constraints.
    """
    contracts = (plan.get("appContracts") or {}).get("dbContracts") or []
    if not contracts:
        return "DB contracts: none — this feature requires no new tables.\n\n"

    parts = [
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "DB CONTRACTS — authoritative column definitions (implement exactly):",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ]
    for contract in contracts:
        table = contract.get("table", "?")
        columns = contract.get("columns") or []
        unique = contract.get("uniqueConstraint")
        indexes = contract.get("indexes") or []
        is_singleton = bool(contract.get("singleton"))

        parts.append(f"\nTable: {table}")
        if is_singleton:
            # Singleton config tables: one row, ever. The `singleton` boolean
            # PK pins the row by construction so handler upserts can target
            # ON CONFLICT (singleton) instead of inventing a fake conflict
            # target. The architect contract guarantees no `id` column was
            # declared for singletons.
            parts.append(
                "  singleton  BOOLEAN  PRIMARY KEY DEFAULT true CHECK (singleton = true)"
            )
        for col in columns:
            constraints = col.get("constraints", "") or ""
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
            parts.append(f"  {col['name']}  {col['type']}  {constraints}")
        if unique:
            # Architect emits { "columns": ["col_a", "col_b"] }; tolerate a bare
            # list too in case an older plan shape sneaks through.
            cols = unique.get("columns", []) if isinstance(unique, dict) else unique
            if cols:
                parts.append(f"  UNIQUE ({', '.join(cols)})")
        if indexes:
            parts.append(f"  Indexes: {', '.join(indexes)}")

    parts.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
    return "\n".join(parts) + "\n"


def _format_prior_migration(prior_sql: Any) -> str:
    """
    Show the already-applied schema for revision runs so the agent only emits
    incremental DDL (new tables or ADD COLUMN) instead of recreating everything.
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
        "or CREATE POLICY — they are already in place. Only ADD COLUMN IF NOT EXISTS\n"
        "for genuinely new columns, or nothing at all if no schema change is needed.\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{prior_sql}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
