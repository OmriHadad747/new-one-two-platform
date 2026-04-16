"""
Migration Generator — produces tenant-scoped PostgreSQL DDL from dbContracts.

The Architect's dbContracts are the authoritative column definitions — the migration
generator produces DDL mechanically from those typed table definitions.

Rules enforced by both the system prompt and validate():
  - Every CREATE TABLE must include tenant_id UUID NOT NULL
  - Every table must have ALTER TABLE ENABLE ROW LEVEL SECURITY
  - Every table must have a CREATE POLICY for tenant isolation
  - No DROP TABLE, no DROP COLUMN, no TRUNCATE

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.static_validation import validate_migration_artifact

_SYSTEM_PROMPT = """You are a PostgreSQL database expert generating tenant-scoped migrations.

The platform uses PostgreSQL Row Level Security (RLS) for multi-tenancy.
Every table you create MUST follow the tenant isolation pattern exactly.

REQUIRED PATTERN for every CREATE TABLE:
```sql
CREATE TABLE {table_name} (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,   -- REQUIRED on every table
  -- ... other columns ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;

CREATE POLICY {table_name}_tenant_isolation ON {table_name}
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

ABSOLUTE RULES:
1. Output ONLY the SQL — no markdown fences, no explanation
2. Every CREATE TABLE must include tenant_id UUID NOT NULL
3. Every CREATE TABLE must be followed by ALTER TABLE ENABLE ROW LEVEL SECURITY
4. Every CREATE TABLE must have a CREATE POLICY for tenant isolation
5. NO DROP TABLE, NO TRUNCATE. NO ALTER TABLE except:
   - ALTER TABLE {name} ENABLE ROW LEVEL SECURITY  (required after CREATE TABLE)
   - ALTER TABLE {name} ADD COLUMN IF NOT EXISTS ...  (revision runs only)
6. Use gen_random_uuid() for UUID primary keys
7. If the feature doesn't need any new tables, output nothing at all — zero characters, no explanation
8. Add useful indexes (tenant_id is always a candidate; avoid redundant standalone indexes
   when a composite index already starts with tenant_id)
9. Derive ALL table columns EXACTLY from the DB contracts in the user prompt.
   Generate every column listed there with the exact name, type, and constraints specified.
   Do not add or remove columns beyond what the contracts declare."""

_SQL_KEYWORDS = ("CREATE", "ALTER", "INSERT", "DROP", "GRANT", "REVOKE", "COMMENT")


class MigrationGenerator(Generator):
    name = "migration"
    max_tokens = 2048

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return _SYSTEM_PROMPT

    def user_prompt(self, ctx: CodegenContext) -> str:
        contracts_block = _format_db_contracts(ctx.plan)
        prior_block = _format_prior_migration(ctx.prior_migration_sql)

        if ctx.prior_migration_sql:
            closing = (
                "Generate ONLY the incremental DDL needed for this revision.\n"
                "Do NOT recreate tables that already exist (listed above).\n"
                "Do NOT emit ALTER TABLE ENABLE ROW LEVEL SECURITY for existing tables.\n"
                "Do NOT emit CREATE POLICY for existing tables.\n"
                "Use ALTER TABLE ... ADD COLUMN IF NOT EXISTS for new columns on existing tables.\n"
                "New tables must still follow the full tenant isolation pattern.\n"
                "If no schema change is needed, output nothing at all — zero characters.\n"
                "Output ONLY raw SQL (no markdown fences)."
            )
        else:
            closing = (
                "Generate the PostgreSQL DDL migration for this feature.\n"
                "Follow the tenant isolation pattern exactly.\n"
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
    return re.findall(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", sql, re.IGNORECASE)


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

        parts.append(f"\nTable: {table}")
        for col in columns:
            parts.append(f"  {col['name']}  {col['type']}  {col.get('constraints', '')}")
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
