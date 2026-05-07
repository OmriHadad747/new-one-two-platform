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
// 0001_template_baseline.sql) are hand-written by us and skip the
// gate; they're trusted by construction.

// Per-app schema format: `tenant_<tenantIdHex>_app_<first16OfAppIdHex>`.
// 5 + 32 + 5 + 16 = 58 chars, comfortably under Postgres' 63-char identifier
// limit. Both UUID halves are lowercased hex with hyphens stripped. Derived
// via `appSchemaName(tenantId, appId)` — the single canonical builder.
const TENANT_SCHEMA_RE = /^tenant_[0-9a-f]{32}_app_[0-9a-f]{16}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical per-app schema name. Every app gets its own Postgres schema so
 * teardown is a single `DROP SCHEMA CASCADE` — no prefix-walking, no leak
 * risk for un-prefixed generator output, no cross-app visibility for
 * sibling apps under the same tenant.
 *
 * Used by routes, the orchestrator's TENANT_SCHEMA env, lifecycle's
 * teardown/reactivate, and (indirectly) the handler's db.ts which sets
 * search_path from the env var.
 */
export function appSchemaName(tenantId: string, appId: string): string {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`appSchemaName: tenantId "${tenantId}" is not a UUID`);
  }
  if (!UUID_RE.test(appId)) {
    throw new Error(`appSchemaName: appId "${appId}" is not a UUID`);
  }
  const tenantHex = tenantId.replace(/-/g, "").toLowerCase();
  const appHex = appId.replace(/-/g, "").toLowerCase().slice(0, 16);
  const name = `tenant_${tenantHex}_app_${appHex}`;
  // Defence-in-depth: the regex is the authoritative shape check for every
  // DB call site, so assert the builder output matches.
  if (!TENANT_SCHEMA_RE.test(name)) {
    throw new Error(`appSchemaName: derived "${name}" is malformed`);
  }
  return name;
}

export interface RunMigrationsInput {
  /** Absolute path to the assembled build context (contains migrations/). */
  buildContextDir: string;
  /** Per-app Postgres schema — see `appSchemaName`. Created here if missing. */
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
    await sql.unsafe(`SET search_path TO ${input.tenantSchema}, public`);

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const alreadyApplied = new Set(
      (await sql<Array<{ name: string }>>`SELECT name FROM schema_migrations`).map((r) => r.name),
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
        logger.debug({ name: file.name }, "Migration passed LLM-author validation gate");
      }

      logger.info({ name: file.name, schema: input.tenantSchema }, "Applying migration");
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO ${input.tenantSchema}, public`);
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

// ─── Per-app schema teardown ─────────────────────────────────────────────────
//
// Each app owns its own Postgres schema (see `appSchemaName`). Permanent
// delete is a single `DROP SCHEMA CASCADE` — atomic, captures every object
// the generator ever created (tables, views, sequences, cron_queue,
// processed_webhooks), and leaves no orphan rows even if the generator
// skipped a naming convention. Sibling apps live in different schemas by
// construction, so there's no cross-app collateral.

export interface DropAppSchemaInput {
  /** Per-app schema name from `appSchemaName(tenantId, appId)`. */
  tenantSchema: string;
  databaseUrl: string;
}

/**
 * Drops the app's entire Postgres schema via `DROP SCHEMA ... CASCADE`.
 *
 * Idempotent: `IF EXISTS` makes a second call a no-op. Safe to call even
 * when the app never applied any migrations (schema may not exist yet).
 * Called by permanentDeleteApp.
 */
export async function dropAppSchema(input: DropAppSchemaInput): Promise<{ dropped: boolean }> {
  if (!TENANT_SCHEMA_RE.test(input.tenantSchema)) {
    throw new Error(
      `dropAppSchema: refusing schema "${input.tenantSchema}" — must match ${TENANT_SCHEMA_RE}`,
    );
  }
  const sql = postgres(input.databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    // Identifier substitution is safe: schema is regex-gated against the
    // fixed `tenant_<hex>_app_<hex>` shape, no attacker-controlled chars.
    // Check existence first so we can surface `dropped: false` to the
    // caller for clean logging on never-migrated apps.
    const rows = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_namespace WHERE nspname = ${input.tenantSchema}
      ) AS exists
    `;
    if (!rows[0]?.exists) {
      logger.info(
        { schema: input.tenantSchema },
        "dropAppSchema: schema did not exist — nothing to drop",
      );
      return { dropped: false };
    }
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${input.tenantSchema} CASCADE`);
    logger.info({ schema: input.tenantSchema }, "dropAppSchema: schema dropped");
    return { dropped: true };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
