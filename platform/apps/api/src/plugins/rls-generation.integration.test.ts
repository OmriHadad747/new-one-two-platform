/**
 * RLS contract test for `generation_sessions`.
 *
 * Pins the three invariants migration 0003 establishes:
 *
 *   (1) A raw `sql\`SELECT * FROM generation_sessions\`` outside
 *       withTenantContext returns zero rows (FORCE bites the owner role).
 *   (2) `getSessionByJobId(tenantA, jobA)` run via withTenantContext returns
 *       the row.
 *   (3) `getSessionByJobId(tenantB, jobA)` — wrong tenant in the context,
 *       correct jobId — returns null. Cross-tenant attempts fail closed.
 *
 * The db package's `DATABASE_URL` is bound at module-load time. To redirect
 * it at the throwaway container, this suite uses a dynamic `import()` after
 * the container is up and `process.env.DATABASE_URL` has been rewritten.
 *
 * Why testcontainers instead of the system postgres binary: `postgres:16-alpine`
 * is exactly what we ship in docker-compose and what Cloud SQL for Postgres
 * boots. A system-installed binary on a CI runner could be a different major,
 * different defaults, or require root. Testcontainers pins the version and
 * the role model — critical here because the bug this test prevents is
 * "forgot withTenantContext," which only surfaces against a non-superuser
 * role (see migration 0003's dev-mode caveat).
 *
 * Skip behaviour: if Docker is unavailable (sandbox, minimal CI image), the
 * suite self-skips with a loud warning rather than failing. In a future CI
 * with a Docker daemon this suite runs on every PR that touches
 * `generation_sessions` or RLS, pinning the invariant.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Dynamic at runtime — types only at import time.
type DbModule = typeof import("@new-one-two/db");
type PostgresSql = import("postgres").Sql;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../packages/db/migrations");

/**
 * Returns every `NNNN_*.sql` file in the migrations directory, sorted by the
 * numeric prefix so `0010_*` lands after `0009_*` (naive lexical sort works
 * because the prefix is zero-padded to four digits).
 *
 * Dynamic discovery — previously this list was hardcoded. Hardcoding it
 * meant the test silently drifted from the migrations directory: a new
 * `0004_generation_events.sql` (TD-004) lands on main, the test suite keeps
 * applying only the old three files, and whatever invariant the new
 * migration establishes goes uncovered. A glob-and-sort makes the suite
 * always run against the full committed schema.
 */
async function listMigrationFiles(): Promise<string[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const APP_A    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_B    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_A    = "00000000-0000-4000-8000-00000000000a";
const JOB_B    = "00000000-0000-4000-8000-00000000000b";

// ─── Docker availability gate ────────────────────────────────────────────────
//
// `testcontainers` throws at container start if the Docker daemon is
// unreachable. We detect that up front and mark the suite skipped with a
// clear message — the alternative is an opaque Unable to connect failure
// buried in the test output.

async function detectDockerAvailable(): Promise<boolean> {
  try {
    const { getContainerRuntimeClient } = await import("testcontainers");
    // getContainerRuntimeClient() returns the cached Docker socket client;
    // it throws synchronously (not rejectedly) when no daemon is reachable.
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await detectDockerAvailable();
if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[rls-generation.integration.test] skipping — Docker daemon not reachable. " +
      "Install Docker to run the RLS invariant suite locally; CI runs this on every PR."
  );
}
const describeRls = dockerAvailable ? describe : describe.skip;

// ─── Suite ───────────────────────────────────────────────────────────────────

describeRls("RLS invariant — generation_sessions FORCE ROW LEVEL SECURITY", () => {
  let container: import("testcontainers").StartedTestContainer;
  let db: DbModule;
  // A superuser connection used only for test setup: seeding the non-RLS
  // tenants/apps rows and reading the raw "no context" state. The db module
  // under test uses its own module-level sql bound to `app_owner`.
  let superSql: PostgresSql;

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import("testcontainers");
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_PASSWORD: "dev",
        POSTGRES_USER: "postgres",
        POSTGRES_DB: "platform_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2)
      )
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);

    // ── Run migrations as the superuser so CREATE TYPE / CREATE TABLE /
    //    ENABLE ROW LEVEL SECURITY all succeed, then hand ownership over to
    //    a dedicated non-superuser role. FORCE ROW LEVEL SECURITY applies
    //    to that role because it's not a superuser and, once we hand over
    //    ownership, it IS the owner. That matches production (Cloud SQL
    //    hands you a non-superuser role that owns your tables).
    const setupUrl = `postgres://postgres:dev@${host}:${port}/platform_test`;
    const { default: postgres } = await import("postgres");
    const bootstrap = postgres(setupUrl);
    try {
      const migrations = await listMigrationFiles();
      for (const f of migrations) {
        const sqlText = await fs.readFile(path.join(MIGRATIONS_DIR, f), "utf8");
        await bootstrap.unsafe(sqlText);
      }
      // Create the owner role and hand over every table so FORCE RLS fires.
      await bootstrap`CREATE ROLE app_owner LOGIN PASSWORD 'x'`;
      await bootstrap`GRANT ALL ON SCHEMA public TO app_owner`;
      const tables = await bootstrap<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `;
      for (const { tablename } of tables) {
        await bootstrap.unsafe(`ALTER TABLE "${tablename}" OWNER TO app_owner`);
      }
    } finally {
      await bootstrap.end();
    }

    // Keep a superuser handle for raw assertions that need to BYPASS RLS
    // (e.g. seed rows across tenants, or sanity-check the owner-scoped view
    // by reading the full set). Superusers bypass RLS regardless of FORCE.
    superSql = postgres(setupUrl);

    // ── Seed two tenants + two sessions under the superuser. RLS on the
    //    tenants / apps tables is ENABLE-only so the superuser bypasses it
    //    and the rows land normally.
    await superSql`
      INSERT INTO tenants (id, slug, name, kms_key_name) VALUES
        (${TENANT_A}, 'tenant-a', 'Tenant A', 'key-a'),
        (${TENANT_B}, 'tenant-b', 'Tenant B', 'key-b')
    `;
    await superSql`
      INSERT INTO apps (id, tenant_id, slug, name, shopify_client_id, shop_domain) VALUES
        (${APP_A}, ${TENANT_A}, 'app-a', 'App A', 'cid', 'a.myshopify.com'),
        (${APP_B}, ${TENANT_B}, 'app-b', 'App B', 'cid', 'b.myshopify.com')
    `;
    await superSql`
      INSERT INTO generation_sessions (app_id, tenant_id, prompt, status, job_id) VALUES
        (${APP_A}, ${TENANT_A}, 'prompt-A', 'completed', ${JOB_A}),
        (${APP_B}, ${TENANT_B}, 'prompt-B', 'completed', ${JOB_B})
    `;

    // ── Now point the db module at the container as the NON-superuser
    //    owner role — that's the role whose "forgot withTenantContext" bug
    //    this suite exists to catch. Dynamic import so the module picks up
    //    the env override, not the hardcoded value from any .env file.
    process.env["DATABASE_URL"] = `postgres://app_owner:x@${host}:${port}/platform_test`;
    db = await import("@new-one-two/db");
  }, 120_000);

  afterAll(async () => {
    await superSql?.end?.();
    await container?.stop?.();
  });

  it("(1) raw SELECT outside withTenantContext returns zero rows — FORCE bites the owner", async () => {
    // The db module's sql handle is the app_owner non-superuser. Without a
    // withTenantContext wrap, `app.current_tenant_id` is unset, the policy
    // is `tenant_id = NULL::uuid` → false for every row → 0 rows.
    const rows = await db.sql`SELECT id FROM generation_sessions`;
    expect(rows).toHaveLength(0);
  });

  it("(2) getSessionByJobId(tenantA, jobA) returns Tenant A's row", async () => {
    const session = await db.getSessionByJobId(TENANT_A, JOB_A);
    expect(session).not.toBeNull();
    expect(session?.prompt).toBe("prompt-A");
    expect(session?.tenantId).toBe(TENANT_A);
  });

  it("(3) getSessionByJobId(tenantB, jobA) — cross-tenant attempt returns null", async () => {
    // The policy scopes by tenant_id, not by job_id. With the "wrong"
    // tenant in context, the query runs but sees zero rows, so the
    // function returns null. A merchant authenticated as B cannot read A's
    // session by knowing A's jobId.
    const session = await db.getSessionByJobId(TENANT_B, JOB_A);
    expect(session).toBeNull();
  });

  it("(4) the superuser still sees both rows — sanity check on our test harness", async () => {
    // If this ever flips to 0, the test container is misconfigured (maybe
    // the superuser lost its BYPASSRLS attribute) — the test infra, not
    // the code under test.
    const rows = await superSql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM generation_sessions ORDER BY tenant_id
    `;
    expect(rows).toHaveLength(2);
  });

  it("(5) getLatestCompletedSessionForApp scopes correctly across tenants", async () => {
    // Same invariant, different entry point. The full TD-014 sweep would
    // pattern-match tests like this across every function * every
    // force-RLS'd table.
    const forOwner = await db.getLatestCompletedSessionForApp(TENANT_A, APP_A);
    expect(forOwner?.prompt).toBe("prompt-A");

    // Cross-tenant: caller B asks for A's app → null (policy filters out
    // rows where tenant_id doesn't match the session context).
    const crossTenant = await db.getLatestCompletedSessionForApp(TENANT_B, APP_A);
    expect(crossTenant).toBeNull();
  });
});
