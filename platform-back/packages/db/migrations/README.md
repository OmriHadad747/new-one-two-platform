# platform-back migrations

Single consolidated initial schema. Replaces the 4-file migration history
in `platform/packages/db/migrations/` (now reference-only).

## Files

- **0001_initial_schema.sql** — full schema. Includes the platform-back
  addition `apps.handler_sa_email` (used by `/services/*` to map a
  verified Cloud Run ID token's `email` claim back to `(tenantId, appId)`).

## Applying

For now, apply manually against the dev/prod Postgres:

```
psql "$DATABASE_URL" -f packages/db/migrations/0001_initial_schema.sql
```

There's no migration runner inside platform-back yet — handler containers
have their own `migrate.ts` runner for *tenant* schemas, but the main
platform schema is rebuild-on-clean for now. A platform-back runner is
follow-up work.

## Adding new migrations

When platform-back makes its own schema additions, add a new file
(`0002_…`, `0003_…`) — do NOT edit `0001_initial_schema.sql`. The 0001
file is the rebuild-on-clean baseline.
