"""
Migration Generator — produces tenant-scoped PostgreSQL DDL.

Rules enforced by both the system prompt and validate():
  - Every CREATE TABLE must include tenant_id UUID NOT NULL
  - Every table must have ALTER TABLE ENABLE ROW LEVEL SECURITY
  - Every table must have a CREATE POLICY for tenant isolation
  - No DROP TABLE, no ALTER TABLE on existing tables, no TRUNCATE

The implementationSpec contributes schema decisions: the state column must be
NULLABLE when the state machine uses null as the unknown sentinel, and any
migration-specific guidance from migrationGuidance.

Model: claude-haiku (prefers_code_model = False — DDL is simpler than handler code)
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.validation import validate_migration

_SYSTEM_PROMPT = """You are a PostgreSQL database expert generating tenant-scoped migrations.

The platform uses PostgreSQL Row Level Security (RLS) for multi-tenancy.
Every table you create MUST follow the tenant isolation pattern exactly.

REQUIRED PATTERN for every CREATE TABLE:
```sql
CREATE TABLE {table_name} (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,   -- REQUIRED on every table
  -- ... other columns ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
5. NO DROP TABLE, NO ALTER TABLE on existing tables, NO TRUNCATE
6. Use gen_random_uuid() for UUID primary keys
7. If the feature doesn't need any new tables, output nothing at all — zero characters, no explanation
8. Add useful indexes (tenant_id is always a candidate)
9. Shopify entity IDs (variant_id, product_id, order_id, customer_id, inventory_item_id) are
   numeric integers — store them as BIGINT or TEXT, NEVER as UUID.
   Only tenant_id and internal record primary keys use the UUID type.
10. Do NOT create a standalone (tenant_id) index when a composite index already starts with
    tenant_id — the composite index satisfies tenant-only range scans too. Redundant indexes
    waste write overhead and storage.
11. Do NOT add domain-alias timestamp columns (e.g. signed_up_at, enrolled_at) that duplicate
    created_at — use created_at for record creation time. Only add a separate domain timestamp
    when it can differ from created_at (e.g. notified_at, fulfilled_at, cancelled_at).
12. Derive ALL table columns from the "DB operations from codeSpec" section in the user prompt.
    Every column that appears in SELECT …, INSERT INTO (…), UPDATE … SET col =, or UPSERT …
    clauses MUST be present in the corresponding CREATE TABLE. The codeSpec operations are the
    authoritative column list — do not rely solely on the schema guidance text, which may be
    incomplete. If a step says SET notified_at = NOW(), the table needs notified_at TIMESTAMPTZ."""

_SQL_KEYWORDS = ("CREATE", "ALTER", "INSERT", "DROP", "GRANT", "REVOKE", "COMMENT")


class MigrationGenerator(Generator):
    name = "migration"
    prefers_code_model = False
    max_tokens = 2048

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return _SYSTEM_PROMPT

    def user_prompt(self, ctx: CodegenContext) -> str:
        retry_block = self.format_retry_block(ctx.previous_errors)
        schema_block = _format_schema_guidance(ctx.plan)
        sql_steps = _extract_codespec_sql_steps(ctx.plan)
        sql_block = "\n".join(f"  {s}" for s in sql_steps) if sql_steps else "  (none)"
        prior_block = _format_prior_migration(ctx.prior_migration_sql)

        if ctx.prior_migration_sql:
            closing = (
                "Generate ONLY the incremental DDL needed for this revision.\n"
                "Do NOT recreate tables that already exist in the schema above.\n"
                "Use ALTER TABLE ... ADD COLUMN IF NOT EXISTS for new columns on existing tables.\n"
                "New tables must still follow the full tenant isolation pattern.\n"
                "If no schema change is needed, output nothing at all.\n"
                "Output ONLY raw SQL (no markdown fences)."
            )
        else:
            closing = (
                "Generate the PostgreSQL DDL migration for this feature.\n"
                "Follow the tenant isolation pattern exactly.\n"
                "Output ONLY raw SQL (no markdown fences)."
            )

        return (
            f"{retry_block}"
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n"
            f"Triggers: {', '.join(ctx.intent.get('triggerTypes', []))}\n\n"
            f"DB operations from codeSpec (ground truth for required tables and columns):\n"
            f"{sql_block}\n"
            f"{schema_block}"
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
        return validate_migration(artifact)


# ── Private prompt-building helpers ───────────────────────────────────────────


def _format_prior_migration(prior_sql: Any) -> str:
    """
    Show the already-applied schema for revision runs so the agent only emits
    incremental DDL (new tables or ADD COLUMN) instead of recreating everything.
    """
    if not prior_sql:
        return ""
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "REVISION RUN — schema already applied to the database:\n"
        "(These tables and columns ALREADY EXIST. Do NOT recreate them.\n"
        " Only emit DDL for new tables or new columns on existing tables.)\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{prior_sql}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _format_schema_guidance(plan: Dict[str, Any]) -> str:
    """Render schema decisions from implementationSpec relevant to DDL generation."""
    impl = plan.get("implementationSpec") or {}
    parts: List[str] = []

    sm = impl.get("stateMachine") or {}
    if sm.get("needsStateTracking"):
        sentinel = sm.get("unknownSentinel", "null")
        parts.append(
            f"\nSchema guidance:\n"
            f"  - The state column must be NULLABLE "
            f"({sentinel!r} = no prior observation, distinct from any real value).\n"
            f"  - Tracked entity: {sm.get('trackedEntity', '')}"
        )

    guidance = (impl.get("migrationGuidance") or "").strip()
    if guidance:
        header = "\nSchema guidance:" if not parts else ""
        parts.append(f"{header}\n  - {guidance}")

    return "\n".join(parts) + "\n" if parts else ""


def _extract_codespec_sql_steps(plan: Dict[str, Any]) -> List[str]:
    """
    Extract DB operation steps from the codeSpec — ground truth for required columns.

    Scans all path arrays in codeSpec for steps that contain SQL keywords.
    These steps carry the exact table names and column lists the handler will use,
    so the migration agent can derive the full schema from them rather than relying
    on the architect's free-text migrationGuidance (which can omit columns).
    """
    impl = plan.get("implementationSpec") or {}
    code_spec = impl.get("codeSpec") or {}

    all_steps: List[str] = []
    for path_key in ("webhookPath", "cronPath", "widgetPath"):
        all_steps.extend(code_spec.get(path_key) or [])

    sql_keywords = ("SELECT", "INSERT", "UPDATE", "UPSERT", "DELETE")
    return [
        step for step in all_steps
        if any(kw in step.upper() for kw in sql_keywords)
    ]
