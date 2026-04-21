import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { logger } from "@platform-back/logger";
import { makeIdempotent, validateMigrationSql } from "./sql-validator.js";

// Runs handler-template + generator-emitted SQL migrations against the
// tenant's Postgres schema.
//
// Per locked decision 9 the canonical place for these is a Cloud Run
// pre-deploy *job* (separate resource type, runs the same image with
// `node dist/migrate.js` as CMD). For phase 1 we cut that corner: the
// deployer connects to the same Postgres directly and runs the SQL
// itself. Same outcome (schema applied before service traffic), one
// fewer resource type in the loop.
//
// Switch to a real Cloud Run Job before we have customers — captured as
// follow-up tech debt. The handler container's own dist/migrate.js is
// still the contract; this module just shortcuts the invocation.
//
// Validator gate: any migration whose filename appears in
// `generatorAuthoredNames` is treated as LLM output — it MUST pass
// validateMigrationSql + be rewritten through makeIdempotent before
// running. Migrations shipped by handler-template (e.g.
// 0001_processed_webhooks.sql) are hand-written by us and skip the
// gate; they're trusted by construction.

const TENANT_SCHEMA_RE = /^tenant_[a-z0-9_]{1,60}$/;

export interface RunMigrationsInput {
  /** Absolute path to the assembled build context (contains migrations/). */
  buildContextDir: string;
  /** Tenant DB schema name — `tenant_<uuid>`. Created here if missing. */
  tenantSchema: string;
  /** Postgres connection string. Same DATABASE_URL the handler will use. */
  databaseUrl: string;
  /**
   * Filenames (basename, e.g. "0002_widgets.sql") of generator-emitted
   * migrations. Each gets validated + rewritten before applying.
   * Empty/omitted = treat all migrations as platform-trusted.
   */
  generatorAuthoredNames?: string[];
}

export async function runMigrations(input: RunMigrationsInput): Promise<{
  applied: string[];
  skipped: string[];
}> {
  if (!TENANT_SCHEMA_RE.test(input.tenantSchema)) {
    throw new Error(
      `runMigrations: refusing schema "${input.tenantSchema}" — must match ${TENANT_SCHEMA_RE}`,
    );
  }

  const migrationsDir = join(input.buildContextDir, "migrations");
  const files = await loadMigrations(migrationsDir);
  if (files.length === 0) {
    logger.info(
      { migrationsDir },
      "runMigrations: no .sql files in migrations/ — nothing to apply",
    );
    return { applied: [], skipped: [] };
  }

  const sql = postgres(input.databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Idempotent schema create — the orchestrator may call into us
    // before any handler has ever run, so the schema may not exist yet.
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${input.tenantSchema}`);
    await sql.unsafe(
      `SET search_path TO ${input.tenantSchema}, public`,
    );

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const alreadyApplied = new Set(
      (
        await sql<Array<{ name: string }>>`SELECT name FROM schema_migrations`
      ).map((r) => r.name),
    );

    const validatorGate = new Set(input.generatorAuthoredNames ?? []);
    for (const file of files) {
      if (alreadyApplied.has(file.name)) {
        skipped.push(file.name);
        continue;
      }

      // Validate + rewrite generator-emitted migrations. Hand-written
      // template migrations bypass the gate.
      let sqlToApply = file.sql;
      if (validatorGate.has(file.name)) {
        validateMigrationSql(file.sql);
        sqlToApply = makeIdempotent(file.sql);
        logger.debug(
          { name: file.name },
          "Migration passed LLM-author validation gate",
        );
      }

      logger.info(
        { name: file.name, schema: input.tenantSchema },
        "Applying migration",
      );
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL search_path TO ${input.tenantSchema}, public`,
        );
        await tx.unsafe(sqlToApply);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file.name})`;
      });
      applied.push(file.name);
    }

    logger.info(
      { schema: input.tenantSchema, applied: applied.length, skipped: skipped.length },
      "Migrations complete",
    );
    return { applied, skipped };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function loadMigrations(
  migrationsDir: string,
): Promise<Array<{ name: string; sql: string }>> {
  let entries: string[];
  try {
    entries = await readdir(migrationsDir);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    sqlFiles.map(async (name) => ({
      name,
      sql: await readFile(join(migrationsDir, name), "utf-8"),
    })),
  );
}

// ─── Path C: per-app table prefix ────────────────────────────────────────────
//
// Generated migrations MUST prefix every created object with
// `app_<appIdNoHyphens>_`. Permanent-delete drops everything in the
// tenant schema that matches the prefix. No matched rollback SQL is
// persisted — the prefix convention is self-documenting.
//
// Static validation (platform-ai) enforces the convention on generator
// output. The deployer trusts it at runtime: if the generator emitted
// an unprefixed table, dropAppTables won't find it and it'll leak. That
// leak is a bug in validation, not in deploy-time behaviour.

const APP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The required per-app table-name prefix. Exported so the static
 * validator and generator prompt can use the exact same derivation.
 */
export function appTablePrefix(appId: string): string {
  if (!APP_ID_RE.test(appId)) {
    throw new Error(`appTablePrefix: "${appId}" is not a UUID`);
  }
  return `app_${appId.replace(/-/g, "")}_`;
}

export interface DropAppTablesInput {
  tenantSchema: string;
  appId: string;
  databaseUrl: string;
}

/**
 * Drops every object in `tenantSchema` whose name starts with the
 * app's prefix — tables first, then views, sequences, functions. Uses
 * `DROP ... CASCADE` so constraints across the dropped set (FKs,
 * default-generated sequences) don't block the teardown. Siblings
 * under the same schema are untouched by construction: their prefix
 * is a different 32-hex string.
 *
 * Called by permanentDeleteApp. Safe to re-run — each object is
 * already-dropped idempotent via IF EXISTS.
 */
export async function dropAppTables(
  input: DropAppTablesInput,
): Promise<{ droppedTables: string[] }> {
  if (!TENANT_SCHEMA_RE.test(input.tenantSchema)) {
    throw new Error(
      `dropAppTables: refusing schema "${input.tenantSchema}" — must match ${TENANT_SCHEMA_RE}`,
    );
  }
  const prefix = appTablePrefix(input.appId);
  const matchPattern = `${prefix}%`;

  const sql = postgres(input.databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    // Collect every object under the app's prefix. pg_class is the
    // source of truth — covers tables, views, sequences, materialised
    // views, foreign tables. We don't need to distinguish kinds because
    // DROP TABLE IF EXISTS / DROP VIEW IF EXISTS are both safe no-ops
    // for the wrong kind.
    const rows = await sql<Array<{ relname: string; relkind: string }>>`
      SELECT c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${input.tenantSchema}
         AND c.relname LIKE ${matchPattern}
         AND c.relkind IN ('r', 'v', 'm', 'S', 'f')
    `;
    const droppedTables: string[] = [];
    if (rows.length === 0) {
      logger.info(
        { schema: input.tenantSchema, prefix, droppedTables: [] },
        "dropAppTables: no matching objects",
      );
      return { droppedTables };
    }

    // Drop in one transaction so cross-table FK references either all
    // go together or none do (caller treats failure as non-fatal).
    await sql.begin(async (tx) => {
      for (const row of rows) {
        const kind = row.relkind;
        const name = row.relname;
        // Identifier substitution is safe here: schema is regex-gated and
        // name came from pg_class for THIS schema (not attacker input).
        const stmt =
          kind === "v"
            ? `DROP VIEW IF EXISTS ${input.tenantSchema}."${name}" CASCADE`
            : kind === "m"
              ? `DROP MATERIALIZED VIEW IF EXISTS ${input.tenantSchema}."${name}" CASCADE`
              : kind === "S"
                ? `DROP SEQUENCE IF EXISTS ${input.tenantSchema}."${name}" CASCADE`
                : kind === "f"
                  ? `DROP FOREIGN TABLE IF EXISTS ${input.tenantSchema}."${name}" CASCADE`
                  : `DROP TABLE IF EXISTS ${input.tenantSchema}."${name}" CASCADE`;
        await tx.unsafe(stmt);
        droppedTables.push(name);
      }
    });

    logger.info(
      { schema: input.tenantSchema, prefix, count: droppedTables.length },
      "dropAppTables: done",
    );
    return { droppedTables };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
