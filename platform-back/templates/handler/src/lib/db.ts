import postgres from "postgres";

// Per locked decision 3: one shared Postgres, one schema per tenant
// (tenant_<uuid>). The handler's role is granted USAGE on its own schema
// only — RLS isn't the boundary here, role grants are. We pin search_path
// at connection time so plain `SELECT * FROM widgets` lands in the right
// schema without every query naming it explicitly.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`FATAL: ${name} is not set`);
  return v;
}

const DATABASE_URL = required("DATABASE_URL");
const TENANT_SCHEMA = required("TENANT_SCHEMA");

// Light validation — schema name is user-controlled at deploy time, but
// any deviation from the expected shape almost certainly means a wiring
// bug we want to catch loudly rather than risk a search_path injection.
if (!/^tenant_[a-z0-9_]{1,60}$/.test(TENANT_SCHEMA)) {
  throw new Error(
    `FATAL: TENANT_SCHEMA "${TENANT_SCHEMA}" does not match expected pattern`,
  );
}

export const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
  connection: {
    // Set search_path for every connection in the pool. `processed_webhooks`
    // and any tenant-owned table are reachable as bare names; `pg_catalog`
    // stays available for built-ins.
    search_path: `${TENANT_SCHEMA}, public`,
  },
  onnotice: () => {},
});

export async function closeDb(): Promise<void> {
  try {
    await sql.end({ timeout: 5 });
  } catch {
    // Swallow — process is exiting either way.
  }
}
