"""
Migration-artifact validation — runs on the generated migration SQL.

Public entry point: validate_db_artifact.
"""

from __future__ import annotations

import re
from typing import List

from utils.static_validations.sql_parse import (
    strip_comments_and_strings as _strip_comments_and_strings,
)


def validate_db_artifact(
    sql: str, prior_tables: List[str] | None = None
) -> List[str]:
    """
    Validate the generated PostgreSQL DDL migration.

    Mirrors the platform-back deployer's sql-validator.ts so a migration
    that passes here also passes the deployer's pre-run gate. Allowed:
      CREATE TABLE (incl. IF NOT EXISTS)
      CREATE INDEX / CREATE UNIQUE INDEX (incl. IF NOT EXISTS)
      ALTER TABLE … ADD COLUMN IF NOT EXISTS
      COMMENT ON TABLE / COLUMN
    Forbidden: everything else — see MIGRATION_BASE prompt for the full
    list. tenant_id / RLS / CREATE POLICY are forbidden because tenant
    isolation is now schema-level, not row-level. cron.schedule is
    forbidden because it's deployer-owned (pg_cron metadata lives in a
    different database; see TD-023).

    prior_tables: table names already deployed in a previous revision.
    A CREATE TABLE for such a table is flagged so the revision flow uses
    ADD COLUMN IF NOT EXISTS for schema evolution instead of recreating.
    """
    errors: List[str] = []
    _prior = {t.lower() for t in (prior_tables or [])}

    if not sql.strip():
        return errors  # empty migration is valid

    # Mirrors sql-validator.ts FORBIDDEN_PATTERNS (fail-closed, matches
    # inside comments/strings too — MIGRATION_BASE warns about this).
    forbidden: List[tuple[str, str]] = [
        (r"\bDROP\s+TABLE\b", "DROP TABLE"),
        (r"\bDROP\s+COLUMN\b", "DROP COLUMN"),
        (r"\bDROP\s+INDEX\b", "DROP INDEX"),
        (r"\bDROP\s+POLICY\b", "DROP POLICY"),
        (r"\bDROP\s+SCHEMA\b", "DROP SCHEMA"),
        (r"\bDROP\s+DATABASE\b", "DROP DATABASE"),
        (r"\bDROP\s+TYPE\b", "DROP TYPE"),
        (r"\bDROP\s+FUNCTION\b", "DROP FUNCTION"),
        (r"\bDROP\s+TRIGGER\b", "DROP TRIGGER"),
        (r"\bDROP\s+ROLE\b", "DROP ROLE"),
        (r"\bDROP\s+USER\b", "DROP USER"),
        (r"\bTRUNCATE\b", "TRUNCATE"),
        (r"\bDELETE\s+FROM\b", "DELETE FROM"),
        (r"\bUPDATE\s+[\w.\"]+\s+SET\b", "UPDATE … SET"),
        (r"\bGRANT\b", "GRANT"),
        (r"\bREVOKE\b", "REVOKE"),
        (r"\bSET\s+ROLE\b", "SET ROLE"),
        (r"\bSET\s+SESSION\s+AUTHORIZATION\b", "SET SESSION AUTHORIZATION"),
        (
            r"\bALTER\s+(POLICY|ROLE|USER|DEFAULT\s+PRIVILEGES|SYSTEM)\b",
            "ALTER POLICY/ROLE/USER/DEFAULT PRIVILEGES/SYSTEM",
        ),
        (r"\bCONCURRENTLY\b", "CONCURRENTLY"),
        (r"\bCOPY\b[^;]*\bFROM\s+PROGRAM\b", "COPY … FROM PROGRAM"),
        (r"\bDO\s*\$", "DO $$ / DO $tag$ PL/pgSQL block"),
        (r"\bCREATE\s+EXTENSION\b", "CREATE EXTENSION"),
        (r"\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b", "CREATE FUNCTION"),
        (r"\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b", "CREATE TRIGGER"),
        # Schema-isolation architecture: row-level security is off the table.
        (
            r"\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b",
            "ENABLE ROW LEVEL SECURITY (schema isolation replaces RLS — drop it)",
        ),
        (
            r"\bCREATE\s+POLICY\b",
            "CREATE POLICY (schema isolation replaces RLS — drop it)",
        ),
        # Cron scheduling is deployer-owned (pg_cron meta lives elsewhere).
        (
            r"\bcron\.(schedule|unschedule)\b",
            "cron.schedule / cron.unschedule (deployer-owned — see TD-023)",
        ),
    ]
    # FORBIDDEN_PATTERNS run against RAW SQL — this mirrors the platform-back
    # deployer's sql-validator.ts, which fails-closed on any forbidden token
    # anywhere in the output (comments and strings included). The MIGRATION_BASE
    # prompt warns the model upfront. Scrubbing locally would silently accept
    # migrations the deployer rejects.
    for pattern, name in forbidden:
        if re.search(pattern, sql, re.IGNORECASE):
            errors.append(f"forbidden SQL construct: {name}")

    # The remaining checks are LOCAL (not mirrored by the deployer). Run them
    # against scrubbed SQL — a column comment like `-- not adding tenant_id,
    # schema isolation now` or a comment mentioning `CREATE TABLE
    # processed_webhooks would conflict` would otherwise FP.
    scrubbed = _strip_comments_and_strings(sql)

    # ALTER TABLE is allowed only for `ADD COLUMN IF NOT EXISTS` — matches
    # sql-validator.ts (the ENABLE RLS case is already forbidden above).
    for stmt in re.findall(r"\bALTER\s+TABLE\b[^;]+;", scrubbed, re.IGNORECASE):
        if not re.search(r"\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b", stmt, re.IGNORECASE):
            errors.append(
                "ALTER TABLE is only allowed for ADD COLUMN IF NOT EXISTS. "
                f"Forbidden statement: {stmt[:120].strip()}"
            )

    # tenant_id column is now forbidden — schema isolation replaces it. Flag
    # any column named tenant_id inside a CREATE TABLE body so a drifted
    # generation doesn't silently add it.
    for stmt in re.findall(
        r"CREATE\s+TABLE[^;]+\([\s\S]*?\);", scrubbed, re.IGNORECASE
    ):
        if re.search(r"\btenant_id\b", stmt, re.IGNORECASE):
            errors.append(
                "CREATE TABLE must NOT declare a tenant_id column — each tenant "
                "has its own schema (search_path is pinned at deploy time); "
                "tenant_id is redundant and marks a drift from the new isolation model"
            )

    # Template-owned table names — rejecting recreate attempts.
    created_tables = {
        t.lower()
        for t in re.findall(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", scrubbed, re.IGNORECASE
        )
    }
    template_owned = {"processed_webhooks", "cron_queue"} & created_tables
    for name in sorted(template_owned):
        errors.append(
            f"CREATE TABLE {name} is template-owned — the handler template "
            "ships this table unconditionally (migrations/"
            "0001_processed_webhooks.sql). Emitting it here causes a duplicate-"
            "name conflict even with idempotency wrappers."
        )

    # Revision-run gate: re-emitting CREATE TABLE for an already-deployed
    # table isn't a SQL error (the deployer adds IF NOT EXISTS), but it's a
    # generator mistake — use ADD COLUMN IF NOT EXISTS for schema evolution
    # instead so the diff is explicit and reviewable.
    for name in created_tables & _prior:
        errors.append(
            f"CREATE TABLE {name} repeats a table from the prior deploy — "
            "this is a revision run; for schema evolution use "
            "ALTER TABLE … ADD COLUMN IF NOT EXISTS … instead"
        )

    return errors
