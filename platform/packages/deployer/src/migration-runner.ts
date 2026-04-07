/**
 * Runs a tenant-scoped SQL migration from a FeatureBundle.
 *
 * Safety checks (regex-based, pre-execution):
 *   - No DROP TABLE / DROP COLUMN / TRUNCATE
 *   - No ALTER TABLE on existing tables (only CREATE TABLE is allowed)
 *   - All CREATE TABLE statements must include a tenant_id column
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

  // ALTER TABLE is only allowed for ENABLE ROW LEVEL SECURITY.
  // Match each ALTER TABLE statement up to its semicolon so we can inspect
  // the full command regardless of table name format (plain, quoted, schema-qualified).
  const alterMatches = migrationSql.match(/\bALTER\s+TABLE\b[^;]+;/gi);
  if (alterMatches) {
    for (const stmt of alterMatches) {
      if (!/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(stmt)) {
        throw new Error(
          `ALTER TABLE is only allowed for ENABLE ROW LEVEL SECURITY. ` +
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

export async function runTenantMigration(
  tenantId: string,
  migrationSql: string
): Promise<void> {
  if (!migrationSql.trim()) {
    logger.info({ tenantId }, "Migration SQL is empty — skipping");
    return;
  }

  validateMigrationSql(migrationSql);

  await withTenantContext(tenantId, async (tx) => {
    // Execute the full SQL block as a single statement.
    // postgres.js tagged templates don't support raw SQL injection directly,
    // so we use sql.unsafe for the migration content — it's validated above.
    await tx.unsafe(migrationSql);
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
  const tableNames = [...migrationSql.matchAll(/CREATE\s+TABLE\s+(\w+)/gi)].map(
    (m) => m[1]
  );

  if (tableNames.length === 0) return;

  try {
    await withTenantContext(tenantId, async (tx) => {
      for (const tableName of tableNames) {
        logger.warn({ tenantId, tableName }, "Rolling back migration table");
        await tx.unsafe(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
      }
    });
  } catch (err) {
    logger.error(
      { err, tenantId, tableNames },
      "Migration rollback failed — tables may remain"
    );
  }
}
