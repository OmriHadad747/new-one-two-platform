// Validates LLM-authored migration SQL before it reaches Postgres, and
// rewrites it to be idempotent on re-runs. Ported from platform/'s
// migration-runner with one delta: the legacy "every CREATE TABLE must
// include tenant_id" rule is GONE, because in the new architecture
// tenant isolation is at the SCHEMA level (decision 3 — one schema per
// tenant) rather than at the row level. A handler's tables live inside
// `tenant_<uuid>.…`, so a `tenant_id` column would be redundant.
//
// Two-step contract:
//   1. validateMigrationSql(sql) — throws on any forbidden construct
//   2. makeIdempotent(sql) — rewrites to add IF NOT EXISTS / DO blocks
// Order matters: makeIdempotent emits DO blocks, which the validator
// would reject. ALWAYS validate first.

const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Destructive / data-mutating
  { pattern: /\bDROP\s+TABLE\b/i, reason: "DROP TABLE" },
  { pattern: /\bDROP\s+COLUMN\b/i, reason: "DROP COLUMN" },
  { pattern: /\bDROP\s+INDEX\b/i, reason: "DROP INDEX" },
  { pattern: /\bDROP\s+POLICY\b/i, reason: "DROP POLICY" },
  { pattern: /\bDROP\s+SCHEMA\b/i, reason: "DROP SCHEMA" },
  { pattern: /\bDROP\s+DATABASE\b/i, reason: "DROP DATABASE" },
  { pattern: /\bDROP\s+TYPE\b/i, reason: "DROP TYPE" },
  { pattern: /\bDROP\s+FUNCTION\b/i, reason: "DROP FUNCTION" },
  { pattern: /\bDROP\s+TRIGGER\b/i, reason: "DROP TRIGGER" },
  { pattern: /\bDROP\s+ROLE\b/i, reason: "DROP ROLE" },
  { pattern: /\bDROP\s+USER\b/i, reason: "DROP USER" },
  { pattern: /\bTRUNCATE\b/i, reason: "TRUNCATE" },
  {
    pattern: /\bDELETE\s+FROM\b/i,
    reason: "DELETE FROM (no data mutation in migrations)",
  },
  {
    pattern: /\bUPDATE\s+[\w."]+\s+SET\b/i,
    reason: "UPDATE … SET (no data mutation in migrations)",
  },

  // Transaction / performance escape hatches
  {
    pattern: /\bCONCURRENTLY\b/i,
    reason: "CONCURRENTLY (cannot run inside a transaction)",
  },

  // Privilege / role changes
  { pattern: /\bGRANT\b/i, reason: "GRANT" },
  { pattern: /\bREVOKE\b/i, reason: "REVOKE" },
  { pattern: /\bSET\s+ROLE\b/i, reason: "SET ROLE" },
  {
    pattern: /\bSET\s+SESSION\s+AUTHORIZATION\b/i,
    reason: "SET SESSION AUTHORIZATION",
  },
  {
    pattern: /\bALTER\s+(POLICY|ROLE|USER|DEFAULT\s+PRIVILEGES|SYSTEM)\b/i,
    reason: "ALTER POLICY/ROLE/USER/DEFAULT PRIVILEGES/SYSTEM",
  },

  // Arbitrary-code escape hatches
  {
    pattern: /\bCOPY\b[^;]*\bFROM\s+PROGRAM\b/i,
    reason: "COPY … FROM PROGRAM (server-side shell exec)",
  },
  // DO $$ … $$ blocks let the LLM smuggle PL/pgSQL the regex denylist
  // can't see into. makeIdempotent() emits DO blocks itself, but it
  // runs AFTER the validator.
  { pattern: /\bDO\s*\$/i, reason: "DO $$ / DO $tag$ PL/pgSQL block" },
  { pattern: /\bCREATE\s+EXTENSION\b/i, reason: "CREATE EXTENSION" },
  {
    pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i,
    reason: "CREATE FUNCTION",
  },
  {
    pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i,
    reason: "CREATE TRIGGER",
  },

  // Schema-isolation architecture (decision 3): each tenant has its own
  // Postgres schema; RLS is gone. Generator migrations MUST NOT emit
  // ENABLE RLS or CREATE POLICY — those are carry-over from the legacy
  // row-level model. The template's baseline migration
  // (0001_processed_webhooks.sql) ships processed_webhooks + cron_queue
  // and bypasses the validator so its own DDL is unaffected.
  {
    pattern: /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
    reason: "ENABLE ROW LEVEL SECURITY (schema isolation replaces RLS)",
  },
  {
    pattern: /\bCREATE\s+POLICY\b/i,
    reason: "CREATE POLICY (schema isolation replaces RLS)",
  },

  // Cron scheduling is deployer-owned (TD-023): pg_cron's metadata lives
  // in a different database than the tenant schema, so the generator
  // can't emit these cleanly. The deployer calls cron.schedule(...)
  // directly after migrations run, with the fully qualified tenant
  // schema substituted in the body.
  {
    pattern: /\bcron\.(schedule|unschedule)\b/i,
    reason: "cron.schedule / cron.unschedule (deployer-owned)",
  },
];

/**
 * Throws on the first forbidden construct. Caller maps the throw to a
 * "deploy failed: invalid migration" error visible to the merchant.
 *
 * Caveat (inherited from legacy): regexes match inside SQL comments
 * and string literals too. A line like `-- will DELETE FROM old`
 * triggers a rejection. Intentional fail-closed — tell the generator
 * to avoid those words in comments.
 */
export function validateMigrationSql(migrationSql: string): void {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(migrationSql)) {
      throw new Error(
        `Migration SQL contains forbidden construct '${reason}'. ` +
          "Only CREATE TABLE, CREATE INDEX, CREATE POLICY, ALTER TABLE " +
          "(ENABLE RLS | ADD COLUMN IF NOT EXISTS), and COMMENT ON are allowed.",
      );
    }
  }

  // ALTER TABLE allowed only for ADD COLUMN IF NOT EXISTS. ENABLE RLS is
  // rejected by the FORBIDDEN_PATTERNS block above — the ALTER TABLE
  // gate here just confirms the only legitimate shape.
  const alterMatches = migrationSql.match(/\bALTER\s+TABLE\b[^;]+;/gi);
  if (alterMatches) {
    for (const stmt of alterMatches) {
      const isAddCol = /\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i.test(stmt);
      if (!isAddCol) {
        throw new Error(
          "ALTER TABLE is only allowed for ADD COLUMN IF NOT EXISTS. " +
            `Forbidden statement: ${stmt.substring(0, 120)}`,
        );
      }
    }
  }
}

/**
 * Rewrites a migration to be idempotent on re-run. Required because
 * deploys can hit the same migration multiple times (retries, re-deploys
 * of the same version).
 *
 *   CREATE TABLE foo        → CREATE TABLE IF NOT EXISTS foo
 *   CREATE INDEX foo        → CREATE INDEX IF NOT EXISTS foo
 *   CREATE UNIQUE INDEX foo → CREATE UNIQUE INDEX IF NOT EXISTS foo
 *   CREATE POLICY ...;      → DO $migration$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
 *
 * MUST run AFTER validateMigrationSql — the CREATE POLICY rewrite emits
 * a DO block that the validator would reject.
 */
export function makeIdempotent(sql: string): string {
  return sql
    .replace(/\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s)/gi, "CREATE TABLE IF NOT EXISTS ")
    .replace(
      /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\s)/gi,
      (_, unique) => `CREATE ${unique ?? ""}INDEX IF NOT EXISTS `,
    )
    .replace(
      /(CREATE\s+POLICY\b[^;]+;)/gi,
      (match) =>
        `DO $migration$ BEGIN ${match} EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;`,
    );
}
