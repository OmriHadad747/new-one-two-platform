/**
 * Runs a tenant-scoped SQL migration from a FeatureBundle.
 *
 * Safety checks (regex-based, pre-execution) — all LLM-authored SQL is run
 * through `validateMigrationSql` before a single byte reaches Postgres:
 *
 *   - Denylist of destructive / privilege / escape-hatch statements
 *     (DROP *, TRUNCATE, DELETE, UPDATE … SET, GRANT/REVOKE, DO $$ blocks,
 *     COPY … FROM PROGRAM, CREATE EXTENSION/FUNCTION/TRIGGER,
 *     SET ROLE/SESSION AUTHORIZATION, CONCURRENTLY).
 *   - ALTER TABLE only allowed for ENABLE ROW LEVEL SECURITY or
 *     ADD COLUMN IF NOT EXISTS.
 *   - Every CREATE TABLE must include a `tenant_id` column.
 *
 * CREATE POLICY statements are made idempotent by wrapping them in a
 * DO $migration$ ... $migration$; block in `makeIdempotent()` — note that
 * `makeIdempotent` runs AFTER `validateMigrationSql`, so the DO-block
 * denylist entry doesn't prevent our own wrapping from working.
 *
 * The migration runs inside withTenantContext so RLS is active.
 * Empty sql is a no-op (some features may not need a DB table).
 *
 * Longer term (audit finding H10): pivot to a Postgres-AST allowlist via
 * pg-query-emscripten rather than a regex denylist. This module's tests
 * pin the current behaviour so that refactor can land without regressing
 * any of the rejections below.
 *
 * Caveat: the regexes run against raw SQL — they match inside comments and
 * string literals too. A line like `-- will DELETE FROM old` or
 * `COMMENT ON TABLE t IS 'TRUNCATE reminder'` will be rejected. This is
 * intentional conservatism (fail closed); operators should rewrite such
 * comments to use different wording. The AST-based allowlist in H10 will
 * make this precise.
 */
import { withTenantContext } from "@new-one-two/db";
import { logger } from "@new-one-two/logger";

/**
 * Statements that must never appear in a tenant-authored migration.
 * Each entry is paired with a short reason so the operator error message
 * names the offending construct.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Destructive / data-mutating
  { pattern: /\bDROP\s+TABLE\b/i,      reason: "DROP TABLE" },
  { pattern: /\bDROP\s+COLUMN\b/i,     reason: "DROP COLUMN" },
  { pattern: /\bDROP\s+INDEX\b/i,      reason: "DROP INDEX" },
  { pattern: /\bDROP\s+POLICY\b/i,     reason: "DROP POLICY" },
  { pattern: /\bDROP\s+SCHEMA\b/i,     reason: "DROP SCHEMA" },
  { pattern: /\bDROP\s+DATABASE\b/i,   reason: "DROP DATABASE" },
  { pattern: /\bDROP\s+TYPE\b/i,       reason: "DROP TYPE" },
  { pattern: /\bDROP\s+FUNCTION\b/i,   reason: "DROP FUNCTION" },
  { pattern: /\bDROP\s+TRIGGER\b/i,    reason: "DROP TRIGGER" },
  { pattern: /\bDROP\s+ROLE\b/i,       reason: "DROP ROLE" },
  { pattern: /\bDROP\s+USER\b/i,       reason: "DROP USER" },
  { pattern: /\bTRUNCATE\b/i,          reason: "TRUNCATE" },
  { pattern: /\bDELETE\s+FROM\b/i,     reason: "DELETE FROM (no data mutation in migrations)" },
  { pattern: /\bUPDATE\s+[\w."]+\s+SET\b/i, reason: "UPDATE … SET (no data mutation in migrations)" },

  // Transaction / performance escape hatches
  //   CONCURRENTLY cannot run inside the transaction that runTenantMigration
  //   wraps around the SQL — it silently turns a transactional migration
  //   into a half-applied partial schema.
  { pattern: /\bCONCURRENTLY\b/i, reason: "CONCURRENTLY (cannot run inside a transaction)" },

  // Privilege / role changes
  { pattern: /\bGRANT\b/i,  reason: "GRANT" },
  { pattern: /\bREVOKE\b/i, reason: "REVOKE" },
  { pattern: /\bSET\s+ROLE\b/i, reason: "SET ROLE" },
  { pattern: /\bSET\s+SESSION\s+AUTHORIZATION\b/i, reason: "SET SESSION AUTHORIZATION" },
  {
    pattern: /\bALTER\s+(POLICY|ROLE|USER|DEFAULT\s+PRIVILEGES|SYSTEM)\b/i,
    reason: "ALTER POLICY/ROLE/USER/DEFAULT PRIVILEGES/SYSTEM",
  },

  // Arbitrary-code escape hatches
  //   COPY ... FROM PROGRAM is server-side shell exec.
  { pattern: /\bCOPY\b[^;]*\bFROM\s+PROGRAM\b/i, reason: "COPY … FROM PROGRAM (server-side shell exec)" },
  //   DO $$ ... $$ / DO $tag$ ... $tag$ are PL/pgSQL blocks that the regex
  //   denylist cannot see into. Forbidden for LLM input; `makeIdempotent()`
  //   is allowed to emit them because it runs AFTER this validator.
  { pattern: /\bDO\s*\$/i, reason: "DO $$ / DO $tag$ PL/pgSQL block" },
  //   New extensions, functions, or triggers would let the LLM run arbitrary
  //   code on every write. Platform migrations (0001) are not subject to
  //   this validator, only tenant-authored bundles.
  { pattern: /\bCREATE\s+EXTENSION\b/i, reason: "CREATE EXTENSION" },
  { pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i, reason: "CREATE FUNCTION" },
  { pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i,  reason: "CREATE TRIGGER" },
];

/**
 * Validates an LLM-authored migration SQL script. Throws with an explicit
 * reason on the first failure. Exported for unit-testing; production code
 * should prefer `runTenantMigration()`.
 */
export function validateMigrationSql(migrationSql: string): void {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(migrationSql)) {
      throw new Error(
        `Migration SQL contains forbidden construct '${reason}'. ` +
          "Only CREATE TABLE, CREATE INDEX, CREATE POLICY, ALTER TABLE " +
          "(ENABLE RLS | ADD COLUMN IF NOT EXISTS), and COMMENT ON are allowed."
      );
    }
  }

  // ALTER TABLE is only allowed for ENABLE ROW LEVEL SECURITY or ADD COLUMN IF NOT EXISTS.
  const alterMatches = migrationSql.match(/\bALTER\s+TABLE\b[^;]+;/gi);
  if (alterMatches) {
    for (const stmt of alterMatches) {
      const isRls = /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(stmt);
      const isAddCol = /\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i.test(stmt);
      if (!isRls && !isAddCol) {
        throw new Error(
          `ALTER TABLE is only allowed for ENABLE ROW LEVEL SECURITY or ADD COLUMN IF NOT EXISTS. ` +
            `Forbidden statement: ${stmt.substring(0, 120)}`
        );
      }
    }
  }

  // Every CREATE TABLE must include tenant_id
  const createTableMatches = migrationSql.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w."]+\s*\([\s\S]*?\);/gi
  );
  if (createTableMatches) {
    for (const stmt of createTableMatches) {
      if (!/tenant_id/i.test(stmt)) {
        throw new Error(
          `CREATE TABLE statement missing tenant_id column: ${stmt.substring(0, 80)}...`
        );
      }
    }
  }
}

/**
 * Makes a migration script idempotent so it can be re-run safely on every deploy:
 *
 *   CREATE TABLE foo        → CREATE TABLE IF NOT EXISTS foo
 *   CREATE INDEX foo        → CREATE INDEX IF NOT EXISTS foo
 *   CREATE UNIQUE INDEX foo → CREATE UNIQUE INDEX IF NOT EXISTS foo
 *   CREATE POLICY ...;      → DO $migration$ BEGIN CREATE POLICY ...; EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
 *
 * This eliminates the entire class of 42P07 (relation already exists) and
 * 42710 (duplicate_object) errors on revision re-deploys without any prompt
 * engineering — the runner just guarantees idempotency at the infrastructure level.
 *
 * ⚠️ Must run AFTER `validateMigrationSql`. The CREATE POLICY rewrite emits a
 * `DO $migration$` block, which the validator denies as an escape hatch
 * (see FORBIDDEN_PATTERNS). Exported so the test suite can pin this order
 * contract both ways: the validator accepts the input, then rejects this
 * function's output. If any future refactor runs validation on the idempotent
 * SQL, every migration with a policy will start failing.
 */
export function makeIdempotent(sql: string): string {
  return sql
    // CREATE TABLE foo → CREATE TABLE IF NOT EXISTS foo (skip if already has IF NOT EXISTS)
    .replace(
      /\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s)/gi,
      "CREATE TABLE IF NOT EXISTS "
    )
    // CREATE [UNIQUE] INDEX foo → CREATE [UNIQUE] INDEX IF NOT EXISTS foo
    .replace(
      /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\s)/gi,
      (_, unique) => `CREATE ${unique ?? ""}INDEX IF NOT EXISTS `
    )
    // CREATE POLICY → idempotent DO block (42710 duplicate_object)
    .replace(
      /(CREATE\s+POLICY\b[^;]+;)/gi,
      (match) =>
        `DO $migration$ BEGIN ${match} EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;`
    );
}

export async function runTenantMigration(
  tenantId: string,
  migrationSql: string
): Promise<void> {
  if (!migrationSql.trim()) {
    logger.info({ tenantId }, "Migration SQL is empty — skipping");
    return;
  }

  validateMigrationSql(migrationSql);

  // Make the migration idempotent: IF NOT EXISTS on tables/indexes, DO blocks on policies.
  const idempotentSql = makeIdempotent(migrationSql);

  await withTenantContext(tenantId, async (tx) => {
    // Execute the full SQL block as a single statement.
    // postgres.js tagged templates don't support raw SQL injection directly,
    // so we use sql.unsafe for the migration content — it's validated above.
    await tx.unsafe(idempotentSql);
  });

  logger.info({ tenantId }, "Tenant migration applied");
}

/**
 * Compensating rollback — drops all tables created by the migration.
 * Called if App Block or handler deployment fails after the migration ran.
 *
 * Extracts table names from CREATE TABLE statements and issues DROP TABLE IF EXISTS.
 * This is best-effort: if the DROP fails, the migration is left in place.
 *
 * Identifier forms supported (the forms the validator in validateMigrationSql
 * already accepts via its permissive [\\w."]+ matcher):
 *
 *   CREATE TABLE foo                      → DROP TABLE IF EXISTS "foo"
 *   CREATE TABLE IF NOT EXISTS foo        → DROP TABLE IF EXISTS "foo"
 *   CREATE TABLE "My Table"               → DROP TABLE IF EXISTS "My Table"
 *   CREATE TABLE public.foo               → DROP TABLE IF EXISTS public.foo
 *   CREATE TABLE public."My Table"        → DROP TABLE IF EXISTS public."My Table"
 *
 * An earlier version of the regex captured only `[\\w"]+|"[^"]+"`, so
 * `CREATE TABLE public.foo` captured just `public`, and rollback issued
 * `DROP TABLE IF EXISTS "public" CASCADE` — wrong object, and dangerous if a
 * public.-prefixed relation existed in the tenant's search_path.
 */
export async function rollbackTenantMigration(
  tenantId: string,
  migrationSql: string
): Promise<void> {
  // One identifier part: either a bare word or a double-quoted name.
  const IDENT = `(?:"[^"]+"|\\w+)`;
  // A full identifier: optionally schema-qualified.
  const CREATE_TABLE_RE = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?((?:${IDENT}\\.)?${IDENT})`,
    "gi"
  );

  const tableIdentifiers = [...migrationSql.matchAll(CREATE_TABLE_RE)]
    .map((m) => m[1])
    .filter((name): name is string => Boolean(name));

  if (tableIdentifiers.length === 0) return;

  try {
    await withTenantContext(tenantId, async (tx) => {
      for (const ident of tableIdentifiers) {
        logger.warn({ tenantId, ident }, "Rolling back migration table");
        // Safe interpolation: the capture group above only accepts a
        // schema-qualified identifier whose parts are each either `\\w+` or
        // `"[^"]+"` — nothing in either branch can contain a SQL-breaking
        // character. We emit:
        //   - schema-qualified (contains a `.` outside of quotes) verbatim
        //   - quoted identifier verbatim
        //   - bare word wrapped in double quotes so reserved words
        //     round-trip safely
        const dropTarget = formatDropIdentifier(ident);
        await tx.unsafe(`DROP TABLE IF EXISTS ${dropTarget} CASCADE`);
      }
    });
  } catch (err) {
    logger.error(
      { err, tenantId, tableIdentifiers },
      "Migration rollback failed — tables may remain"
    );
  }
}

/**
 * Formats an identifier captured by `CREATE_TABLE_RE` for use in a
 * `DROP TABLE IF EXISTS <target> CASCADE` statement. Exported for tests so the
 * behaviour is pinned for every shape the validator permits.
 */
export function formatDropIdentifier(captured: string): string {
  // Schema-qualified or quoted forms parse correctly as-is.
  if (captured.includes(".") || captured.includes('"')) {
    return captured;
  }
  // Bare word: quote for safety (reserved words like `ORDER`, `USER`).
  return `"${captured}"`;
}
