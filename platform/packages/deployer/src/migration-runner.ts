/**
 * Runs a tenant-scoped SQL migration from a FeatureBundle.
 *
 * Safety checks (regex-based, pre-execution):
 *   - No DROP TABLE / DROP COLUMN / TRUNCATE
 *   - ALTER TABLE only allowed for ENABLE ROW LEVEL SECURITY or ADD COLUMN IF NOT EXISTS
 *   - All CREATE TABLE statements must include a tenant_id column
 *
 * CREATE POLICY statements are automatically made idempotent by wrapping them in a
 * DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$ block. This lets
 * the same migration run safely on re-deploy (revision flow) without error 42710.
 *
 * The migration runs inside withTenantContext so RLS is active.
 * Empty sql is a no-op (some features may not need a DB table).
 */
import { withTenantContext } from "@new-one-two/db";
import { logger } from "@new-one-two/logger";

const FORBIDDEN_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
];

function validateMigrationSql(migrationSql: string): void {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(migrationSql)) {
      throw new Error(
        `Migration SQL contains forbidden pattern: ${pattern.source}. ` +
          "Only CREATE TABLE, CREATE INDEX, and CREATE POLICY are allowed."
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
 */
function makeIdempotent(sql: string): string {
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
 */
export async function rollbackTenantMigration(
  tenantId: string,
  migrationSql: string
): Promise<void> {
  // Match CREATE TABLE [IF NOT EXISTS] <identifier> where <identifier> is
  // either a bare word or a double-quoted name. Without the IF NOT EXISTS
  // group the older regex captured the literal word "IF" as a table name
  // whenever the LLM emitted `CREATE TABLE IF NOT EXISTS ...`, producing
  // `DROP TABLE IF EXISTS IF CASCADE` — a syntax error that aborted the
  // whole rollback transaction.
  const CREATE_TABLE_RE =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|\w+)/gi;
  const tableNames = [...migrationSql.matchAll(CREATE_TABLE_RE)]
    .map((m) => m[1])
    .filter((name): name is string => Boolean(name))
    // Strip surrounding quotes so we can re-quote consistently below.
    .map((name) => (name.startsWith('"') ? name.slice(1, -1) : name));

  if (tableNames.length === 0) return;

  try {
    await withTenantContext(tenantId, async (tx) => {
      for (const tableName of tableNames) {
        logger.warn({ tenantId, tableName }, "Rolling back migration table");
        // Always quote the identifier so reserved words and mixed-case names
        // round-trip safely. The capture group above only allows a bare word
        // or a double-quoted name, so interpolating it into the quoted form
        // cannot produce a SQL-injection vector.
        await tx.unsafe(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
      }
    });
  } catch (err) {
    logger.error(
      { err, tenantId, tableNames },
      "Migration rollback failed — tables may remain"
    );
  }
}
