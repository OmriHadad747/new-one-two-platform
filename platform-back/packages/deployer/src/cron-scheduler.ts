import postgres from "postgres";
import { logger } from "@platform-back/logger";

// pg_cron scheduling for handler-owned cron jobs.
//
// Handlers have a cron_queue table (see templates/handler migrations) and
// a runner that processes rows; they don't own scheduling. Scheduling is
// centralized here because:
//   a) pg_cron lives in the platform DB, accessed via the `cron` schema,
//      and cron.schedule/unschedule require privileges the handler's DB
//      role doesn't (and shouldn't) have.
//   b) Deploy/redeploy is the only correct moment to create or rewrite a
//      schedule; the deployer already owns those boundaries.
//
// Per-tick behaviour: the scheduled command inserts one row into the
// tenant's cron_queue and NOTIFYs the app's wake channel. The handler's
// runner wakes via LISTEN, claims the row with FOR UPDATE SKIP LOCKED,
// and dispatches to the generator-authored jobs map.
//
// Prereqs (infra-level, not SQL):
//   - shared_preload_libraries must include 'pg_cron' in the Postgres
//     instance config. On Cloud SQL this is a `cloudsql.enable_pg_cron`
//     flag + instance restart. Captured in deploy/docs; migration 0001
//     runs CREATE EXTENSION IF NOT EXISTS pg_cron once the flag is on.

// ─── Validation ──────────────────────────────────────────────────────────────

// Per-app schema: `tenant_<tenantIdHex>_app_<first16OfAppIdHex>`. Mirrors
// migration-runner's appSchemaName derivation so mismatches throw here
// rather than silently scheduling against the wrong schema.
const TENANT_SCHEMA_RE = /^tenant_[0-9a-f]{32}_app_[0-9a-f]{16}$/;
const NOTIFY_CHANNEL_RE = /^cron_tick_[a-z0-9_]{1,80}$/;
// pg_cron job names can't contain spaces or start with a digit. We
// synthesise them from appIds, which are UUIDs — replace hyphens with
// underscores and prefix so the result is always a valid identifier.
const JOB_NAME_RE = /^app_[a-z0-9_]{1,80}$/;
// A conservative cron-expression matcher: 5 or 6 space-separated fields,
// each a non-empty blob of cron-legal chars. We're not parsing the cron
// semantics here — pg_cron will reject malformed expressions on
// cron.schedule() — but we do need to stop shell-metacharacter injection
// since the expression lands inside a SQL string literal.
const CRON_EXPR_RE = /^[0-9*/,\-?LW# ]{1,80}$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

function jobNameForApp(appId: string): string {
  const name = `app_${appId.replace(/-/g, "_")}`;
  if (!JOB_NAME_RE.test(name)) {
    throw new Error(`cron-scheduler: derived job name "${name}" is malformed`);
  }
  return name;
}

function openPlatformConn(databaseUrl: string) {
  // Short-lived superuser-tier connection — cron.schedule / cron.unschedule
  // require privileges the handler role never has. One connection per call
  // keeps the cost minimal and avoids keeping a privileged pool warm.
  return postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ScheduleAppCronInput {
  /** UUID of the app. Used to derive the pg_cron job name + LISTEN channel. */
  appId: string;
  /** Per-app Postgres schema from appSchemaName. Where cron_queue lives. */
  tenantSchema: string;
  /** Cron expression, 5 or 6 fields. Validated; malformed → throw. */
  cronExpression: string;
  /** Platform Postgres URL. Must be a role with cron.schedule privileges. */
  databaseUrl: string;
}

/**
 * Create or replace the pg_cron registration that ticks this app. Calls
 * cron.schedule with a stable per-app job name — pg_cron replaces the
 * existing schedule if the name is reused, so re-deploys with a changed
 * expression just work without an explicit unschedule step.
 *
 * The scheduled command INSERTs into the tenant's cron_queue and NOTIFYs
 * the app's wake channel. Both are fully qualified inside the command so
 * pg_cron doesn't need a search_path or role impersonation to reach the
 * right rows.
 */
export async function scheduleAppCron(
  input: ScheduleAppCronInput,
): Promise<void> {
  if (!TENANT_SCHEMA_RE.test(input.tenantSchema)) {
    throw new Error(
      `scheduleAppCron: refusing schema "${input.tenantSchema}" — must match ${TENANT_SCHEMA_RE}`,
    );
  }
  if (!CRON_EXPR_RE.test(input.cronExpression)) {
    throw new Error(
      `scheduleAppCron: refusing cron expression "${input.cronExpression}" — contains unsupported characters`,
    );
  }
  const jobName = jobNameForApp(input.appId);
  const channel = `cron_tick_${input.appId.replace(/-/g, "_")}`;
  if (!NOTIFY_CHANNEL_RE.test(channel)) {
    throw new Error(`scheduleAppCron: derived channel "${channel}" is malformed`);
  }

  // The command pg_cron will run on every tick. Built as a single SQL
  // string with the tenant schema and channel inlined — both are
  // regex-validated above so no injection vector via tenantSchema / appId.
  // `job_name='default'` keeps the handler-side contract simple: the
  // generator's src/routes/cron.ts jobs map is expected to export a
  // `default` handler for single-schedule apps.
  const tickCommand =
    `INSERT INTO ${input.tenantSchema}.cron_queue (job_name, payload) ` +
    `VALUES ('default', '{}'::jsonb); ` +
    `NOTIFY ${channel};`;

  const sql = openPlatformConn(input.databaseUrl);
  try {
    // cron.schedule returns bigint jobid; we don't need it. When the job
    // name already exists, pg_cron replaces the schedule + command in
    // place. Idempotent by design.
    await sql`
      SELECT cron.schedule(
        ${jobName},
        ${input.cronExpression},
        ${tickCommand}
      )
    `;
    logger.info(
      { appId: input.appId, jobName, cronExpression: input.cronExpression },
      "pg_cron schedule registered",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface UnscheduleAppCronInput {
  appId: string;
  databaseUrl: string;
}

/**
 * Remove the pg_cron registration for an app. Safe to call when no
 * schedule exists — cron.unschedule returns FALSE in that case and we
 * swallow the zero-row result. Used on re-deploys that drop cron and on
 * app deactivation.
 */
export async function unscheduleAppCron(
  input: UnscheduleAppCronInput,
): Promise<{ removed: boolean }> {
  const jobName = jobNameForApp(input.appId);
  const sql = openPlatformConn(input.databaseUrl);
  try {
    // cron.unschedule(name) returns bool: TRUE if a job was removed,
    // FALSE if nothing matched. We surface the bool so callers can log
    // the redeploy-with-cron-dropped case informatively.
    const rows = await sql<Array<{ unschedule: boolean }>>`
      SELECT cron.unschedule(${jobName}) AS unschedule
    `;
    const removed = rows[0]?.unschedule === true;
    logger.info(
      { appId: input.appId, jobName, removed },
      "pg_cron schedule removal attempted",
    );
    return { removed };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
