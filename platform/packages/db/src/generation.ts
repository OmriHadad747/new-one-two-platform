// ─── Generator Queries ────────────────────────────────────────────────────────
//
// Every function that reads or writes `generation_sessions` takes an explicit
// `tenantId` and runs under `withTenantContext(tenantId, ...)`. The
// `generation_sessions` table has `FORCE ROW LEVEL SECURITY` (see migration
// 0003): even the DATABASE_URL role, which owns the table, is subject to the
// policy. A call that forgets to pass `tenantId` — or passes the wrong one —
// returns zero rows instead of silently reading another tenant's data.
//
// Functions in this file that DON'T touch generation_sessions
// (resolveWidgetJs, resolveAdminUiJs, resolveAppFunctionUrl,
// createDraftAppVersion) stay on the shared connection — the tables they hit
// are not force-RLS'd today (see TECH_DEBT TD-014 for the full sweep).

import { sql, withTenantContext } from "./connection.js";

export interface GenerationSessionRow {
  id: string;
  appId: string | null;
  tenantId: string | null;
  prompt: string;
  status: string;
  intent: Record<string, unknown> | null;
  apiPlan: Record<string, unknown> | null;
  generatedCode: string | null;
  explanation: string | null;
  webhookTopics: string[];
  cronSchedule: string | null;
  attemptCount: number;
  appVersionId: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function createGenerationSession(params: {
  appId: string;
  tenantId: string;
  prompt: string;
}): Promise<{ id: string }> {
  return withTenantContext(params.tenantId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO generation_sessions (app_id, tenant_id, prompt, status)
      VALUES (${params.appId}, ${params.tenantId}, ${params.prompt}, 'running')
      RETURNING id
    `;
    return { id: rows[0]!.id };
  });
}

export async function updateGenerationSession(
  tenantId: string,
  id: string,
  update: Partial<{
    status: string;
    intent: Record<string, unknown>;
    apiPlan: Record<string, unknown>;
    generatedCode: string;
    explanation: string;
    webhookTopics: string[];
    cronSchedule: string | null;
    attemptCount: number;
    appVersionId: string;
    errorMessage: string;
    jobId: string;
  }>
): Promise<void> {
  await withTenantContext(tenantId, async (tx) => {
    await tx`
      UPDATE generation_sessions
      SET
        status          = COALESCE(${update.status ?? null}, status),
        intent          = COALESCE(${update.intent ? tx.json(update.intent as Record<string, string>) : null}, intent),
        api_plan        = COALESCE(${update.apiPlan ? tx.json(update.apiPlan as Record<string, string>) : null}, api_plan),
        generated_code  = COALESCE(${update.generatedCode ?? null}, generated_code),
        explanation     = COALESCE(${update.explanation ?? null}, explanation),
        webhook_topics  = COALESCE(${update.webhookTopics ?? null}, webhook_topics),
        cron_schedule   = ${update.cronSchedule !== undefined ? update.cronSchedule : tx`cron_schedule`},
        attempt_count   = COALESCE(${update.attemptCount ?? null}, attempt_count),
        app_version_id  = COALESCE(${update.appVersionId ?? null}, app_version_id),
        error_message   = COALESCE(${update.errorMessage ?? null}, error_message),
        job_id          = COALESCE(${update.jobId ?? null}, job_id),
        updated_at      = NOW()
      WHERE id = ${id}
    `;
  });
}

export async function cancelGenerationSession(
  tenantId: string,
  jobId: string
): Promise<void> {
  await withTenantContext(tenantId, async (tx) => {
    await tx`
      UPDATE generation_sessions
      SET status = 'cancelled', updated_at = NOW()
      WHERE job_id = ${jobId}
    `;
  });
}

/**
 * Creates a draft app_version from generated code.
 * Uses the next sequential patch version for the app.
 *
 * app_versions is not force-RLS'd (see TD-014) so this function stays on
 * the shared connection for now.
 */
export async function createDraftAppVersion(params: {
  appId: string;
  tenantId: string;
  generatedCode: Record<string, string>;
}): Promise<{ id: string }> {
  const countRows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM app_versions WHERE app_id = ${params.appId}
  `;
  const patch = parseInt(countRows[0]?.count ?? "0", 10) + 1;
  const semver = `1.0.${patch}`;

  const rows = await sql<{ id: string }[]>`
    INSERT INTO app_versions (app_id, tenant_id, semver, status, generated_code)
    VALUES (
      ${params.appId},
      ${params.tenantId},
      ${semver},
      'draft',
      ${sql.json(params.generatedCode)}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export interface GenerationSessionWithBundle extends GenerationSessionRow {
  jobId: string | null;
  bundle: Record<string, unknown> | null;
  chatMessages: Record<string, unknown>[] | null;
}

/**
 * Returns the most recent generation session for an app.
 */
export async function getLatestSessionForApp(
  tenantId: string,
  appId: string
): Promise<GenerationSessionWithBundle | null> {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx<
      Array<{
        id: string;
        appId: string | null;
        tenantId: string | null;
        prompt: string;
        status: string;
        intent: Record<string, unknown> | null;
        apiPlan: Record<string, unknown> | null;
        generatedCode: string | null;
        explanation: string | null;
        webhookTopics: string[];
        cronSchedule: string | null;
        attemptCount: number;
        appVersionId: string | null;
        errorMessage: string | null;
        jobId: string | null;
        bundle: Record<string, unknown> | null;
        chatMessages: Record<string, unknown>[] | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >`
      SELECT
        id, app_id AS "appId", tenant_id AS "tenantId", prompt, status,
        intent, api_plan AS "apiPlan", generated_code AS "generatedCode",
        explanation, webhook_topics AS "webhookTopics", cron_schedule AS "cronSchedule",
        attempt_count AS "attemptCount", app_version_id AS "appVersionId",
        error_message AS "errorMessage", job_id AS "jobId", bundle,
        chat_messages AS "chatMessages",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM generation_sessions
      WHERE app_id = ${appId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

/**
 * Returns a summary list of all generation sessions for an app, newest first.
 * Used by the version history panel in the app detail page.
 */
export async function getSessionsForApp(
  tenantId: string,
  appId: string,
  limit = 20
): Promise<
  Array<{
    id: string;
    jobId: string | null;
    status: string;
    prompt: string;
    errorMessage: string | null;
    appVersionId: string | null;
    createdAt: Date;
  }>
> {
  return withTenantContext(tenantId, async (tx) => {
    return tx<
      Array<{
        id: string;
        jobId: string | null;
        status: string;
        prompt: string;
        errorMessage: string | null;
        appVersionId: string | null;
        createdAt: Date;
      }>
    >`
      SELECT
        id,
        job_id         AS "jobId",
        status,
        prompt,
        error_message  AS "errorMessage",
        app_version_id AS "appVersionId",
        created_at     AS "createdAt"
      FROM generation_sessions
      WHERE app_id = ${appId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  });
}

/**
 * Returns the most recent successfully completed generation session for an app.
 * Used by the approve endpoint to fall back when the latest session failed.
 */
export async function getLatestCompletedSessionForApp(
  tenantId: string,
  appId: string
): Promise<GenerationSessionWithBundle | null> {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx<
      Array<{
        id: string;
        appId: string | null;
        tenantId: string | null;
        prompt: string;
        status: string;
        intent: Record<string, unknown> | null;
        apiPlan: Record<string, unknown> | null;
        generatedCode: string | null;
        explanation: string | null;
        webhookTopics: string[];
        cronSchedule: string | null;
        attemptCount: number;
        appVersionId: string | null;
        errorMessage: string | null;
        jobId: string | null;
        bundle: Record<string, unknown> | null;
        chatMessages: Record<string, unknown>[] | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >`
      SELECT
        id, app_id AS "appId", tenant_id AS "tenantId", prompt, status,
        intent, api_plan AS "apiPlan", generated_code AS "generatedCode",
        explanation, webhook_topics AS "webhookTopics", cron_schedule AS "cronSchedule",
        attempt_count AS "attemptCount", app_version_id AS "appVersionId",
        error_message AS "errorMessage", job_id AS "jobId", bundle,
        chat_messages AS "chatMessages",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM generation_sessions
      WHERE app_id = ${appId}
        AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

/**
 * Looks up a generation session by Pub/Sub job_id.
 *
 * Requires tenantId because `generation_sessions` is force-RLS'd. Callers
 * that only have a jobId need to resolve tenantId first — typically from
 * `req.tenantAuth.tenantId` on the authenticated API request. A mismatched
 * (tenantId, jobId) pair returns null.
 */
export async function getSessionByJobId(
  tenantId: string,
  jobId: string
): Promise<GenerationSessionWithBundle | null> {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx<
      Array<{
        id: string;
        appId: string | null;
        tenantId: string | null;
        prompt: string;
        status: string;
        intent: Record<string, unknown> | null;
        apiPlan: Record<string, unknown> | null;
        generatedCode: string | null;
        explanation: string | null;
        webhookTopics: string[];
        cronSchedule: string | null;
        attemptCount: number;
        appVersionId: string | null;
        errorMessage: string | null;
        jobId: string | null;
        bundle: Record<string, unknown> | null;
        chatMessages: Record<string, unknown>[] | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >`
      SELECT
        id, app_id AS "appId", tenant_id AS "tenantId", prompt, status,
        intent, api_plan AS "apiPlan", generated_code AS "generatedCode",
        explanation, webhook_topics AS "webhookTopics", cron_schedule AS "cronSchedule",
        attempt_count AS "attemptCount", app_version_id AS "appVersionId",
        error_message AS "errorMessage", job_id AS "jobId", bundle,
        chat_messages AS "chatMessages",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM generation_sessions
      WHERE job_id = ${jobId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

/**
 * Stores the FeatureBundle JSONB and updates session status once
 * generation.completed arrives. Also persists the GenerationMeta blob on
 * `generation_sessions.meta` and fans out `meta.agentTrace[]` into
 * `generation_events` rows inside the same withTenantContext transaction
 * (see migration 0004) — a rolled-back UPDATE never leaves orphan event
 * rows.
 *
 * `meta` is shaped after `Meta` from @new-one-two/pubsub-client/schemas.ts.
 * Kept as `Record<string, unknown>` here to avoid pulling pubsub-client
 * as a runtime dep of @new-one-two/db; the caller (routes/generation.ts)
 * owns the typed contract end-to-end.
 */
export async function storeBundleInSession(
  tenantId: string,
  jobId: string,
  bundle: Record<string, unknown>,
  status: "completed" | "failed",
  errorMessage?: string,
  meta?: Record<string, unknown> | null
): Promise<void> {
  const handlerModule = bundle["handlerModule"] as Record<string, unknown> | undefined;
  const explanation = bundle["explanation"] as Record<string, unknown> | undefined;

  const generatedCode = (handlerModule?.["code"] as string) ?? null;
  const webhookTopics = (handlerModule?.["webhookTopics"] as string[]) ?? null;
  const cronSchedule = (handlerModule?.["cronSchedule"] as string | null) ?? null;
  const merchantFacing = (explanation?.["merchantFacing"] as string) ?? null;

  await withTenantContext(tenantId, async (tx) => {
    // 1. Upsert generation_sessions — meta goes on the blob column, the
    //    legacy typed columns stay in sync with the bundle for TD-003.
    const updated = await tx<{ id: string }[]>`
      UPDATE generation_sessions
      SET
        bundle          = ${tx.json(bundle as any)},
        meta            = ${meta !== undefined && meta !== null ? tx.json(meta as any) : tx`meta`},
        status          = ${status},
        error_message   = COALESCE(${errorMessage ?? null}, error_message),
        generated_code  = COALESCE(${generatedCode}, generated_code),
        explanation     = COALESCE(${merchantFacing}, explanation),
        webhook_topics  = COALESCE(${webhookTopics}, webhook_topics),
        cron_schedule   = COALESCE(${cronSchedule}, cron_schedule),
        updated_at      = NOW()
      WHERE job_id = ${jobId}
      RETURNING id
    `;

    // 2. Fan out agentTrace[] into generation_events rows. Same transaction
    //    as (1) — a rolled-back session update never leaves orphan events.
    //    Safe to call repeatedly on a re-delivered Pub/Sub message: the
    //    existing rows aren't deduplicated (session_id + agent_name aren't
    //    unique), but at-most-once delivery is enforced upstream by the
    //    `registerCompletedListener` self-unsubscribe in routes/generation.ts.
    //    If duplication becomes a concern later, add a DELETE-before-insert
    //    or a UNIQUE constraint on (session_id, agent_name, created_at).
    const sessionId = updated[0]?.id;
    const agentTrace = Array.isArray(meta?.["agentTrace"])
      ? (meta!["agentTrace"] as Array<Record<string, unknown>>)
      : [];
    if (sessionId && agentTrace.length > 0) {
      for (const entry of agentTrace) {
        const agent = typeof entry["agent"] === "string" ? entry["agent"] : "unknown";
        const inputTokens = typeof entry["inputTokens"] === "number" ? entry["inputTokens"] : 0;
        const outputTokens = typeof entry["outputTokens"] === "number" ? entry["outputTokens"] : 0;
        const latencyMs = typeof entry["latencyMs"] === "number" ? entry["latencyMs"] : 0;
        await tx`
          INSERT INTO generation_events
            (session_id, tenant_id, job_id, agent_name, input_tokens, output_tokens, latency_ms)
          VALUES
            (${sessionId}, ${tenantId}, ${jobId}, ${agent}, ${inputTokens}, ${outputTokens}, ${latencyMs})
        `;
      }
    }
  });
}

/**
 * Persists the frontend chat message history for a generation session.
 * Called via PATCH /generation/:jobId/chat (debounced, fire-and-forget).
 * `messages` is an array of ChatMessage objects with `actions` stripped.
 */
export async function saveChatMessages(
  tenantId: string,
  jobId: string,
  messages: Record<string, unknown>[]
): Promise<void> {
  await withTenantContext(tenantId, async (tx) => {
    await tx`
      UPDATE generation_sessions
      SET
        chat_messages = ${tx.json(messages as any)},
        updated_at    = NOW()
      WHERE job_id = ${jobId}
    `;
  });
}

/**
 * Resolves the widget JS and active backend function URL for a shop/app pair.
 * Called by GET /widgets/:shop/:appId.js on the API service.
 *
 * Returns null if not found, backend archetype, or widget not yet generated.
 * functionUrl is null when the bundle has not been deployed yet.
 */
export async function resolveWidgetJs(
  shopDomain: string,
  appId: string
): Promise<{ widgetJs: string; functionUrl: string | null } | null> {
  const rows = await sql<
    Array<{ widgetJs: string | null; appArchetype: string; functionUrl: string | null }>
  >`
    SELECT
      a.widget_js       AS "widgetJs",
      a.app_archetype   AS "appArchetype",
      df.function_url   AS "functionUrl"
    FROM apps a
    JOIN tenants t ON t.id = a.tenant_id
    LEFT JOIN deployed_functions df
      ON df.app_id = a.id AND df.is_active = TRUE
    WHERE a.shop_domain = ${shopDomain}
      AND a.id = ${appId}
      AND a.status = 'active'
      AND t.status = 'active'
    LIMIT 1
  `;

  const row = rows[0];
  const isStorefront = row?.appArchetype === "storefront_backend" || row?.appArchetype === "storefront_backend_admin";
  if (!row || !isStorefront || !row.widgetJs) return null;
  return { widgetJs: row.widgetJs, functionUrl: row.functionUrl };
}

/**
 * Resolves the admin UI JS and active backend function URL for a shop/app pair.
 * Called by GET /admin-ui/:shop/:appId.js on the API service.
 *
 * Returns null if not found, not storefront_backend_admin, or admin UI not yet generated.
 */
export async function resolveAdminUiJs(
  shopDomain: string,
  appId: string
): Promise<{ adminUiJs: string; functionUrl: string | null } | null> {
  const rows = await sql<
    Array<{ adminUiJs: string | null; appArchetype: string; functionUrl: string | null }>
  >`
    SELECT
      a.admin_ui_js     AS "adminUiJs",
      a.app_archetype   AS "appArchetype",
      df.function_url   AS "functionUrl"
    FROM apps a
    JOIN tenants t ON t.id = a.tenant_id
    LEFT JOIN deployed_functions df
      ON df.app_id = a.id AND df.is_active = TRUE
    WHERE a.shop_domain = ${shopDomain}
      AND a.id = ${appId}
      AND a.status = 'active'
      AND t.status = 'active'
    LIMIT 1
  `;

  const row = rows[0];
  const hasAdmin = row?.appArchetype === "storefront_backend_admin" || row?.appArchetype === "backend_admin";
  if (!row || !hasAdmin || !row.adminUiJs) return null;
  return { adminUiJs: row.adminUiJs, functionUrl: row.functionUrl };
}

/**
 * Returns the active deployed function URL for a shop/app pair.
 * Used by the widget proxy route to forward storefront calls to the container.
 * Returns null if the app is not found, inactive, or not yet deployed.
 */
export async function resolveAppFunctionUrl(
  shopDomain: string,
  appId: string
): Promise<{ functionUrl: string; tenantId: string } | null> {
  const rows = await sql<Array<{ functionUrl: string | null; tenantId: string }>>`
    SELECT df.function_url AS "functionUrl", t.id AS "tenantId"
    FROM apps a
    JOIN tenants t ON t.id = a.tenant_id
    LEFT JOIN deployed_functions df
      ON df.app_id = a.id AND df.is_active = TRUE
    WHERE a.shop_domain = ${shopDomain}
      AND a.id = ${appId}
      AND a.status = 'active'
      AND t.status = 'active'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.functionUrl) return null;
  return { functionUrl: row.functionUrl, tenantId: row.tenantId };
}
