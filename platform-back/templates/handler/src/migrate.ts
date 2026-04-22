import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Migration runner. Per locked decision 9, this runs as a Cloud Run
// pre-deploy job — never on container start. If it fails, the deploy
// fails and the previous revision keeps serving.
//
// Strategy: every .sql file in migrations/ is applied in lexical order
// (0001, 0002, …). Applied filenames are tracked in
// <tenant_schema>.schema_migrations. Migrations are wrapped in a
// transaction so partial failures don't leave the DB half-migrated.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`FATAL: ${name} is not set`);
  return v;
}

const DATABASE_URL = required("DATABASE_URL");
const TENANT_SCHEMA = required("TENANT_SCHEMA");
if (!/^tenant_[0-9a-f]{32}_app_[0-9a-f]{16}$/.test(TENANT_SCHEMA)) {
  throw new Error(`FATAL: invalid TENANT_SCHEMA "${TENANT_SCHEMA}"`);
}

const here = dirname(fileURLToPath(import.meta.url));
// Compiled location is dist/migrate.js; migrations/ ships next to dist/.
const migrationsDir = join(here, "..", "migrations");

async function loadMigrations(): Promise<Array<{ name: string; sql: string }>> {
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    sqlFiles.map(async (name) => ({
      name,
      sql: await readFile(join(migrationsDir, name), "utf-8"),
    })),
  );
}

async function main(): Promise<void> {
  const sql = postgres(DATABASE_URL, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });

  try {
    // Schema is created by the provisioner before this job runs; we only
    // verify it exists. Creating it here would mean migrations could
    // accidentally provision new tenants on the wrong DB instance.
    const schemaRows = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata
        WHERE schema_name = ${TENANT_SCHEMA}
      ) AS exists
    `;
    if (!schemaRows[0]?.exists) {
      throw new Error(
        `Schema ${TENANT_SCHEMA} does not exist. Provisioner must create it before running migrations.`,
      );
    }

    await sql.unsafe(`SET search_path TO ${TENANT_SCHEMA}, public`);

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const applied = new Set(
      (
        await sql<Array<{ name: string }>>`SELECT name FROM schema_migrations`
      ).map((r) => r.name),
    );

    const all = await loadMigrations();
    const pending = all.filter((m) => !applied.has(m.name));

    if (pending.length === 0) {
      console.log(`[migrate] up to date (${all.length} applied)`);
      return;
    }

    for (const m of pending) {
      console.log(`[migrate] applying ${m.name}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO ${TENANT_SCHEMA}, public`);
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migrations (name) VALUES (${m.name})`;
      });
    }

    console.log(`[migrate] applied ${pending.length} migration(s)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[migrate] FAILED", err);
  process.exit(1);
});
