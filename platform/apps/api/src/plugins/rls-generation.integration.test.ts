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
//
// Shared container + db + superuser handle across the suites below. The
// first describe block owns the beforeAll that boots Postgres and seeds
// the baseline; subsequent describes (TD-001/004) reuse them instead of
// paying the ~5s container-startup cost again per suite.

let container: import("testcontainers").StartedTestContainer;
let db: DbModule;
// A superuser connection used only for test setup: seeding the non-RLS
// tenants/apps rows and reading the raw "no context" state. The db module
// under test uses its own module-level sql bound to `app_owner`.
let superSql: PostgresSql;

describeRls("RLS invariant — generation_sessions FORCE ROW LEVEL SECURITY", () => {
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

// ─── TD-001 + TD-004 — meta blob + generation_events fan-out ───────────────
//
// Migration 0004 adds a `meta` JSONB column on `generation_sessions` and a
// normalised `generation_events` projection table. `storeBundleInSession`
// persists both inside a single withTenantContext transaction.
//
// These tests share the beforeAll setup above (container + migrations +
// seeded tenants/apps/sessions). The original rls-generation suite inserts
// sessions directly via superSql; here we drive storeBundleInSession
// end-to-end so both the blob and the event rows are observed.

describeRls("TD-001 + TD-004 — cost visibility write path", () => {
  // New jobIds so we don't clash with JOB_A/JOB_B from the RLS suite.
  const JOB_COST_A = "00000000-0000-4000-8000-00000000100a";
  const JOB_COST_B = "00000000-0000-4000-8000-00000000100b";

  const META_FIXTURE = {
    totalInputTokens: 12_345,
    totalOutputTokens: 6_789,
    generationMs: 45_678,
    agentTrace: [
      { agent: "product",     inputTokens: 1_000, outputTokens:   500, latencyMs: 3_000 },
      { agent: "architect",   inputTokens: 4_000, outputTokens: 2_000, latencyMs: 9_000 },
      { agent: "handler",     inputTokens: 5_000, outputTokens: 3_000, latencyMs: 18_000 },
      { agent: "validation",  inputTokens:   900, outputTokens:   400, latencyMs: 2_000 },
      { agent: "explanation", inputTokens: 1_445, outputTokens:   889, latencyMs: 13_678 },
    ],
  };

  // Create a fresh session per test under the superuser so the write-path
  // under test only has to UPDATE + INSERT, not race with a previous
  // run's rows.
  async function seedEmptySession(tenantId: string, appId: string, jobId: string) {
    await superSql`
      INSERT INTO generation_sessions (app_id, tenant_id, prompt, status, job_id)
      VALUES (${appId}, ${tenantId}, 'cost-fixture', 'running', ${jobId})
    `;
  }

  async function eventsForSession(jobId: string): Promise<
    Array<{ agent_name: string; input_tokens: number; output_tokens: number; latency_ms: number }>
  > {
    // superSql bypasses RLS so the test can directly inspect what landed,
    // independent of whatever context the code under test used.
    return superSql`
      SELECT agent_name, input_tokens, output_tokens, latency_ms
      FROM generation_events
      WHERE job_id = ${jobId}
      ORDER BY agent_name
    `;
  }

  it("(6) storeBundleInSession with meta writes the blob + one event row per agentTrace entry", async () => {
    await seedEmptySession(TENANT_A, APP_A, JOB_COST_A);

    await db.storeBundleInSession(
      TENANT_A,
      JOB_COST_A,
      { handlerModule: { code: "module.exports = {};", webhookTopics: [], cronSchedule: null } },
      "completed",
      undefined,
      META_FIXTURE
    );

    // Blob is persisted (TD-001).
    const [sessionRow] = await superSql<Array<{ meta: Record<string, unknown> }>>`
      SELECT meta FROM generation_sessions WHERE job_id = ${JOB_COST_A}
    `;
    expect(sessionRow?.meta).toMatchObject({
      totalInputTokens: 12_345,
      totalOutputTokens: 6_789,
      generationMs: 45_678,
    });
    expect(Array.isArray((sessionRow?.meta as { agentTrace: unknown[] }).agentTrace)).toBe(true);

    // Events are fanned out (TD-004). One row per agentTrace entry.
    const events = await eventsForSession(JOB_COST_A);
    expect(events).toHaveLength(META_FIXTURE.agentTrace.length);

    const handlerRow = events.find((e) => e.agent_name === "handler");
    expect(handlerRow).toMatchObject({
      input_tokens: 5_000,
      output_tokens: 3_000,
      latency_ms: 18_000,
    });
  });

  it("(7) missing meta doesn't write any event rows — the table stays pristine when the generator doesn't emit meta", async () => {
    await seedEmptySession(TENANT_B, APP_B, JOB_COST_B);

    await db.storeBundleInSession(
      TENANT_B,
      JOB_COST_B,
      { handlerModule: { code: "module.exports = {};", webhookTopics: [], cronSchedule: null } },
      "completed"
      // no errorMessage, no meta
    );

    const events = await eventsForSession(JOB_COST_B);
    expect(events).toHaveLength(0);

    // Blob column is NULL, not overwritten.
    const [row] = await superSql<Array<{ meta: unknown }>>`
      SELECT meta FROM generation_sessions WHERE job_id = ${JOB_COST_B}
    `;
    expect(row?.meta).toBeNull();
  });

  it("(8) generation_events honors the RLS policy the same way sessions do", async () => {
    // Seed-and-assert its own data so the suite can run tests in any order
    // (vitest may shard / randomize in CI). Previously this test read
    // JOB_COST_A's events that test (6) wrote — fine today, flaky tomorrow.
    const JOB_RLS = "00000000-0000-4000-8000-0000000088aa";
    await seedEmptySession(TENANT_A, APP_A, JOB_RLS);
    await db.storeBundleInSession(
      TENANT_A,
      JOB_RLS,
      { handlerModule: { code: "module.exports = {};", webhookTopics: [], cronSchedule: null } },
      "completed",
      undefined,
      META_FIXTURE
    );

    // A query run under context=TENANT_B must see none of A's events.
    const seenAsB = await db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B}, TRUE)`;
      return tx<Array<{ id: string }>>`SELECT id FROM generation_events WHERE job_id = ${JOB_RLS}`;
    });
    expect(seenAsB).toHaveLength(0);

    // And context=TENANT_A sees them (context integrity check).
    const seenAsA = await db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${TENANT_A}, TRUE)`;
      return tx<Array<{ id: string }>>`SELECT id FROM generation_events WHERE job_id = ${JOB_RLS}`;
    });
    expect(seenAsA.length).toBe(META_FIXTURE.agentTrace.length);
  });

  it("(9) malformed meta is rejected by Zod before any DB write — no session mutation, no orphan events", async () => {
    const JOB_ROLLBACK = "00000000-0000-4000-8000-0000000099aa";
    await seedEmptySession(TENANT_A, APP_A, JOB_ROLLBACK);

    // agentTrace[].agent must be a string. An object here fails
    // MetaSchema.parse() inside storeBundleInSession, which throws
    // BEFORE opening the withTenantContext transaction. Both the
    // session UPDATE and the event INSERTs are therefore skipped
    // entirely — no rollback needed because no write ran.
    const brokenMeta = {
      ...META_FIXTURE,
      agentTrace: [
        { agent: "valid", inputTokens: 1, outputTokens: 1, latencyMs: 1 },
        { agent: { oops: "not-a-string" }, inputTokens: 2, outputTokens: 2, latencyMs: 2 },
      ],
    };

    await expect(
      db.storeBundleInSession(
        TENANT_A,
        JOB_ROLLBACK,
        { handlerModule: { code: "", webhookTopics: [], cronSchedule: null } },
        "completed",
        undefined,
        brokenMeta as unknown as Record<string, unknown>
      )
    ).rejects.toThrow(/agent/i); // zod issue path includes "agent"

    // Session row is unchanged: still 'running', no meta, no bundle.
    const [row] = await superSql<Array<{ meta: unknown; status: string; bundle: unknown }>>`
      SELECT meta, status, bundle FROM generation_sessions WHERE job_id = ${JOB_ROLLBACK}
    `;
    expect(row?.meta).toBeNull();
    expect(row?.status).toBe("running"); // unchanged from seedEmptySession
    expect(row?.bundle).toBeNull();

    // No events either.
    const events = await eventsForSession(JOB_ROLLBACK);
    expect(events).toHaveLength(0);
  });

  it("(10) Pub/Sub redelivery is idempotent — calling storeBundleInSession twice leaves one event row per agent, not two", async () => {
    // Simulates what happens when the generator publishes a completion,
    // a post-ack crash prevents the handler from finishing, and Pub/Sub
    // redelivers to a fresh API instance. The DELETE-then-INSERT in the
    // fan-out path makes the second call a no-op for analytics.
    const JOB_REDELIVER = "00000000-0000-4000-8000-0000000077aa";
    await seedEmptySession(TENANT_A, APP_A, JOB_REDELIVER);

    // First delivery — full write.
    await db.storeBundleInSession(
      TENANT_A,
      JOB_REDELIVER,
      { handlerModule: { code: "module.exports = {};", webhookTopics: [], cronSchedule: null } },
      "completed",
      undefined,
      META_FIXTURE
    );

    const firstPass = await eventsForSession(JOB_REDELIVER);
    expect(firstPass).toHaveLength(META_FIXTURE.agentTrace.length);

    // Redelivery with the same meta — DELETE the old rows, INSERT fresh.
    // Final row count equals the agent count, not 2× the agent count.
    await db.storeBundleInSession(
      TENANT_A,
      JOB_REDELIVER,
      { handlerModule: { code: "module.exports = {};", webhookTopics: [], cronSchedule: null } },
      "completed",
      undefined,
      META_FIXTURE
    );

    const secondPass = await eventsForSession(JOB_REDELIVER);
    expect(secondPass).toHaveLength(META_FIXTURE.agentTrace.length);
  });

  it("(11) mid-generation retries are preserved — duplicate agent_name entries stay distinct", async () => {
    // The Python crew can emit multiple entries for the same agent when a
    // later phase forces a retry (e.g. handler validation fails → architect
    // re-runs). DELETE-then-INSERT preserves multiplicity; a naive
    // UNIQUE (session_id, agent_name) constraint would NOT.
    const JOB_RETRY = "00000000-0000-4000-8000-0000000066aa";
    await seedEmptySession(TENANT_A, APP_A, JOB_RETRY);

    const metaWithRetry = {
      ...META_FIXTURE,
      agentTrace: [
        { agent: "product",   inputTokens: 1_000, outputTokens:   500, latencyMs: 3_000 },
        { agent: "architect", inputTokens: 4_000, outputTokens: 2_000, latencyMs: 9_000 },
        { agent: "handler",   inputTokens: 5_000, outputTokens: 3_000, latencyMs: 18_000 },
        { agent: "architect", inputTokens:   500, outputTokens:   300, latencyMs: 2_000 }, // retry
      ],
    };

    await db.storeBundleInSession(
      TENANT_A,
      JOB_RETRY,
      { handlerModule: { code: "module.exports = {};", webhookTopics: [], cronSchedule: null } },
      "completed",
      undefined,
      metaWithRetry
    );

    const rows = await eventsForSession(JOB_RETRY);
    const architectRows = rows.filter((r) => r.agent_name === "architect");
    expect(architectRows).toHaveLength(2);
  });
});
