# component_rules/db.md

Conventions for the database schema. Read before writing the `database`
section of `app.json`.

## You do NOT write SQL

The agent does not emit `migrations/*.sql`. The runner deterministically
renders `migrations/0001_app.sql` from the `database.tables[]` block
inside `scaffold/app.json`. Your job is the structured JSON, not the DDL.

This file documents the constraints the structured form must satisfy,
and the rules the renderer enforces.

## The `database` block in app.json

```json
{
  "database": {
    "tables": [
      {
        "name": "bundles",
        "purpose": "Stores merchant-defined product bundles.",
        "columns": [
          { "name": "id",         "sqlType": "UUID",        "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()", "purpose": "internal id" },
          { "name": "title",      "sqlType": "TEXT",        "constraints": "NOT NULL" },
          { "name": "enabled",    "sqlType": "BOOLEAN",     "constraints": "NOT NULL DEFAULT true" },
          { "name": "health",     "sqlType": "TEXT",        "constraints": "NOT NULL DEFAULT 'all_available'", "enum": ["all_available", "some_unavailable", "all_unavailable"] },
          { "name": "created_at", "sqlType": "TIMESTAMPTZ", "constraints": "NOT NULL DEFAULT now()" }
        ],
        "uniqueConstraint": ["title"],
        "indexes": [["enabled", "created_at"]],
        "foreignKeys": []
      }
    ]
  }
}
```

## Tenant isolation — the architectural constraint

Migrations run with `search_path` pinned to the tenant's own Postgres
schema. So:

- ❌ NO `tenant_id` column on any table.
- ❌ NO schema qualifier on table names (`public.bundles`, etc.).
- ❌ NO `ENABLE ROW LEVEL SECURITY`, NO `CREATE POLICY`.

Schema isolation REPLACES row-level isolation. The deployer's SQL
validator rejects RLS constructs.

## sqlType allowlist

One of seven literals:

| sqlType       | Use                                                   |
|---------------|-------------------------------------------------------|
| `UUID`        | Internal primary keys (`PRIMARY KEY DEFAULT gen_random_uuid()`) |
| `BIGINT`      | Shopify numeric IDs AND money in minor units          |
| `TEXT`        | Strings, status values, currency codes                |
| `TIMESTAMPTZ` | All timestamps                                        |
| `BOOLEAN`     | Flags                                                 |
| `JSONB`       | Structured blobs (use sparingly — prefer columns)     |
| `INTEGER`     | Small bounded counts only                             |

Money: ALWAYS `BIGINT` in minor units (cents, pence, yen). Persist the
currency code alongside as a TEXT column when needed.

Polymorphic value columns: when a value is gated by a `*_kind`/type
discriminator (e.g. `discount_value` + `discount_kind`), it may be a
PERCENTAGE rather than money — store a percentage as `INTEGER` (whole
percent) or a ratio, never `BIGINT` minor units. The HLD `role` is a hint;
the discriminator wins (see backend.md bug-class 8).

Shopify ids: ALWAYS `BIGINT`. Never `TEXT` — sort order matters and
indexing is faster.

## The `constraints` string

Raw SQL after the type. Common shapes (emit verbatim):

- `PRIMARY KEY DEFAULT gen_random_uuid()`
- `NOT NULL`
- `NULL`
- `NOT NULL DEFAULT 'pending'`
- `NOT NULL DEFAULT now()`
- `NOT NULL REFERENCES other_table(id) ON DELETE CASCADE`

For `enum` columns, add a CHECK in `constraints` OR populate the column's
`enum` field (the renderer adds the CHECK from it). Don't do both.

## `uniqueConstraint`

A list of columns that form a unique key. Renders to `UNIQUE (col1,
col2)` inside the CREATE TABLE.

Without this, handlers that use `ON CONFLICT (col1, col2) DO ...` crash
at runtime with "no unique or exclusion constraint matching the ON
CONFLICT specification".

## `indexes`

A list of column tuples. Each tuple is a SINGLE composite index — not
per-column indexes.

```json
"indexes": [["enabled", "created_at"], ["external_id"]]
```

Renders to:

```sql
CREATE INDEX idx_bundles_enabled_created_at ON bundles (enabled, created_at);
CREATE INDEX idx_bundles_external_id ON bundles (external_id);
```

The renderer drops leading-prefix duplicates of composite indexes (e.g.
a standalone `(enabled)` is dropped if `(enabled, created_at)` exists)
and drops indexes that duplicate `uniqueConstraint` column tuples
(Postgres creates an implicit index for every UNIQUE).

## Workflow tables

For any table that drives a `pending → running → completed/failed`
lifecycle via the `workflow` helper:

- MUST include a `status TEXT` column with `enum` populated.
- Recommended: `started_at TIMESTAMPTZ`, `finished_at TIMESTAMPTZ`,
  `failure_reason TEXT`.
- MUST have a paired cron sweeper job (see
  [cron.md](cron.md) — "stale sweepers").

## Template-shipped tables — do not redeclare

The template ships these tables with every handler. Do NOT add them to
`app.json.database.tables[]`:

- `processed_webhooks` — webhook dedup
- `cron_queue` — cron-runner queue
- `app_config` — `config.*` helper backing store

If you reference them in a query, fine. If you declare them, the
migration fails.

## Foreign keys

Declare inline in `constraints` (`NOT NULL REFERENCES other(id) ON
DELETE CASCADE`) OR as a separate entry in `foreignKeys[]`. The
renderer dedups inline references against `foreignKeys[]` entries
automatically.

```json
"foreignKeys": [
  { "column": "bundle_id", "references": "bundles(id)", "onDelete": "CASCADE" }
]
```

## Comments

A table's `purpose` becomes `COMMENT ON TABLE`. A column's `purpose`
becomes `COMMENT ON COLUMN`. Optional but recommended for tables that
aren't self-explanatory.
