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
    when it can differ from created_at (e.g. notified_at, fulfilled_at, cancelled_at)."""

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
        db_hints = _extract_db_hints(ctx.plan)

        return (
            f"{retry_block}"
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n"
            f"Trigger: {ctx.intent.get('triggerType', '')}\n\n"
            f"Data to persist:\n{json.dumps(db_hints, indent=2)}\n"
            f"{schema_block}"
            "Generate the PostgreSQL DDL migration for this feature.\n"
            "Follow the tenant isolation pattern exactly.\n"
            "Output ONLY raw SQL (no markdown fences)."
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


def _extract_db_hints(plan: Dict[str, Any]) -> List[str]:
    """Extract table/storage hints from the shopifyPlan operations list."""
    hints = []
    for op in (plan.get("shopifyPlan") or {}).get("operations", []):
        desc = op.get("description", "").lower()
        if any(kw in desc for kw in ["insert", "store", "save", "create record", "table"]):
            hints.append(op.get("description", ""))
    return hints
