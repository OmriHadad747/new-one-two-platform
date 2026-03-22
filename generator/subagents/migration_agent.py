"""
Migration Sub-agent — generates tenant-scoped PostgreSQL DDL.

Rules enforced by the system prompt (and double-checked by the validation agent):
  - All CREATE TABLE statements include tenant_id UUID NOT NULL
  - Row Level Security (RLS) policies are declared for each new table
  - No DROP TABLE, no ALTER TABLE on existing tables
  - No TRUNCATE

Model: claude-haiku (lighter task, schema is simpler than code)
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from models.adapter import get_llm, invoke

SYSTEM_PROMPT = """You are a PostgreSQL database expert generating tenant-scoped migrations.

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


def run_migration_agent(
    intent: Dict[str, Any],
    api_plan: Dict[str, Any],
    previous_errors: Optional[List[str]] = None,
) -> str:
    """
    Generate SQL migration DDL from the intent and API plan.

    Returns raw SQL string (empty string if no tables needed).
    """
    llm = get_llm(max_tokens=2048)

    retry_context = ""
    if previous_errors:
        retry_context = (
            "\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n"
            + "\n".join(f"- {e}" for e in previous_errors)
            + "\n\nFix ALL listed errors.\n"
        )

    db_tables = _extract_db_tables(api_plan)

    user_prompt = f"""{retry_context}Feature: {intent.get('desiredOutcome', '')}
Trigger: {intent.get('triggerType', '')}

Data to persist:
{json.dumps(db_tables, indent=2)}

Generate the PostgreSQL DDL migration for this feature.
Follow the tenant isolation pattern exactly.
Output ONLY raw SQL (no markdown fences)."""

    result = invoke(llm, SYSTEM_PROMPT, user_prompt)
    sql = result.content.strip()

    # Strip any accidental markdown fences
    import re
    sql = re.sub(r"^```sql\s*", "", sql, flags=re.MULTILINE)
    sql = re.sub(r"```\s*$", "", sql, flags=re.MULTILINE)
    sql = sql.strip()

    # If the model returned prose instead of SQL, treat as empty (no migration needed).
    # Valid SQL must start with a SQL keyword — anything else is a natural-language response.
    SQL_KEYWORDS = ("CREATE", "ALTER", "INSERT", "DROP", "GRANT", "REVOKE", "COMMENT")
    if sql and not sql.upper().startswith(SQL_KEYWORDS):
        return ""

    return sql


def _extract_db_tables(api_plan: Dict[str, Any]) -> List[str]:
    """Extract table/storage hints from the API plan operations."""
    tables = []
    for op in api_plan.get("operations", []):
        desc = op.get("description", "").lower()
        if any(kw in desc for kw in ["insert", "store", "save", "create record", "table"]):
            tables.append(op.get("description", ""))
    return tables
