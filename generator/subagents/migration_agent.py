"""
Migration Generator — produces tenant-scoped PostgreSQL DDL.

Rules enforced by both the system prompt and validate():
  - Every CREATE TABLE must include tenant_id UUID NOT NULL
  - Every table must have ALTER TABLE ENABLE ROW LEVEL SECURITY
  - Every table must have a CREATE POLICY for tenant isolation
  - No DROP TABLE, no ALTER TABLE on existing tables, no TRUNCATE

The strategy brief contributes schema decisions: column nullability (the state
column must be NULLABLE when the state machine uses null as the unknown sentinel)
and any migration-specific guidance from the Strategy Agent.

Model: claude-haiku (prefers_code_model = False — DDL is simpler than handler code)
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

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
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

ABSOLUTE RULES:
1. Output ONLY the SQL — no markdown fences, no explanation
2. Every CREATE TABLE must include tenant_id UUID NOT NULL
3. Every CREATE TABLE must be followed by ALTER TABLE ENABLE ROW LEVEL SECURITY
4. Every CREATE TABLE must have a CREATE POLICY for tenant isolation
5. NO DROP TABLE, NO ALTER TABLE on existing tables, NO TRUNCATE
6. Use gen_random_uuid() for UUID primary keys
7. If the feature doesn't need any new tables, output nothing at all — zero characters, no explanation
8. Add useful indexes (tenant_id is always a candidate)"""

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
        strategy_block = _format_strategy_block(ctx.strategy)
        db_hints = _extract_db_hints(ctx.api_plan)

        return (
            f"{retry_block}"
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n"
            f"Trigger: {ctx.intent.get('triggerType', '')}\n\n"
            f"Data to persist:\n{json.dumps(db_hints, indent=2)}\n"
            f"{strategy_block}"
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


def _format_strategy_block(strategy: Optional[Dict[str, Any]]) -> str:
    """Render the strategy fields relevant to schema design."""
    if not strategy:
        return ""

    parts: List[str] = []

    sm = strategy.get("stateMachine")
    if sm and sm.get("needsStateTracking"):
        sentinel = sm.get("unknownSentinel", "null")
        parts.append(
            f"\nSchema guidance from feature strategy:\n"
            f"  - The state column must be NULLABLE "
            f"({sentinel!r} = no prior observation, distinct from any real value).\n"
            f"  - Tracked entity: {sm.get('trackedEntity', '')}"
        )

    guidance = (strategy.get("migrationGuidance") or "").strip()
    if guidance:
        header = "\nSchema guidance from feature strategy:" if not parts else ""
        parts.append(f"{header}\n  - {guidance}")

    return "\n".join(parts) + "\n" if parts else ""


def _extract_db_hints(api_plan: Dict[str, Any]) -> List[str]:
    """Extract table/storage hints from the API plan operations."""
    hints = []
    for op in api_plan.get("operations", []):
        desc = op.get("description", "").lower()
        if any(kw in desc for kw in ["insert", "store", "save", "create record", "table"]):
            hints.append(op.get("description", ""))
    return hints
