// ─── Generator Queries ────────────────────────────────────────────────────────
// Service-level operations (no RLS). Called by apps/generator.

import { sql } from "./connection.js";

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
  appId?: string;
  tenantId?: string;
  prompt: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO generation_sessions (app_id, tenant_id, prompt, status)
    VALUES (${params.appId ?? null}, ${params.tenantId ?? null}, ${params.prompt}, 'running')
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export async function updateGenerationSession(
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
  await sql`
    UPDATE generation_sessions
    SET
      status          = COALESCE(${update.status ?? null}, status),
      intent          = COALESCE(${update.intent ? sql.json(update.intent as Record<string, string>) : null}, intent),
      api_plan        = COALESCE(${update.apiPlan ? sql.json(update.apiPlan as Record<string, string>) : null}, api_plan),
      generated_code  = COALESCE(${update.generatedCode ?? null}, generated_code),
      explanation     = COALESCE(${update.explanation ?? null}, explanation),
      webhook_topics  = COALESCE(${update.webhookTopics ?? null}, webhook_topics),
      cron_schedule   = ${update.cronSchedule !== undefined ? update.cronSchedule : sql`cron_schedule`},
      attempt_count   = COALESCE(${update.attemptCount ?? null}, attempt_count),
      app_version_id  = COALESCE(${update.appVersionId ?? null}, app_version_id),
      error_message   = COALESCE(${update.errorMessage ?? null}, error_message),
      job_id          = COALESCE(${update.jobId ?? null}, job_id),
      updated_at      = NOW()
    WHERE id = ${id}
  `;
}

export async function cancelGenerationSession(jobId: string): Promise<void> {
  await sql`
    UPDATE generation_sessions
    SET status = 'cancelled', updated_at = NOW()
    WHERE job_id = ${jobId}
  `;
}

export async function insertGenerationEvent(params: {
  sessionId: string;
  agentName: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: "success" | "failed";
  error?: string;
}): Promise<void> {
  await sql`
    INSERT INTO generation_events (
      session_id, agent_name, provider, model,
      input_tokens, output_tokens, latency_ms, status, error
    ) VALUES (
      ${params.sessionId}, ${params.agentName}, ${params.provider}, ${params.model},
      ${params.inputTokens}, ${params.outputTokens}, ${params.latencyMs},
      ${params.status}, ${params.error ?? null}
    )
  `;
}

/**
 * Creates a draft app_version from generated code.
 * Uses the next sequential patch version for the app.
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
  appId: string
): Promise<GenerationSessionWithBundle | null> {
  const rows = await sql<
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
}

/**
 * Returns a summary list of all generation sessions for an app, newest first.
 * Used by the version history panel in the app detail page.
 */
export async function getSessionsForApp(
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
  return sql<
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
}

/**
 * Returns the most recent successfully completed generation session for an app.
 * Used by the approve endpoint to fall back when the latest session failed.
 */
export async function getLatestCompletedSessionForApp(
  appId: string
): Promise<GenerationSessionWithBundle | null> {
  const rows = await sql<
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
}

/**
 * Looks up a generation session by Pub/Sub job_id.
 */
export async function getSessionByJobId(
  jobId: string
): Promise<GenerationSessionWithBundle | null> {
  const rows = await sql<
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
}

/**
 * Stores the FeatureBundle JSONB and updates session status once generation.completed arrives.
 */
export async function storeBundleInSession(
  jobId: string,
  bundle: Record<string, unknown>,
  status: "completed" | "failed",
  errorMessage?: string
): Promise<void> {
  const handlerModule = bundle["handlerModule"] as Record<string, unknown> | undefined;
  const explanation = bundle["explanation"] as Record<string, unknown> | undefined;

  const generatedCode = (handlerModule?.["code"] as string) ?? null;
  const webhookTopics = (handlerModule?.["webhookTopics"] as string[]) ?? null;
  const cronSchedule = (handlerModule?.["cronSchedule"] as string | null) ?? null;
  const merchantFacing = (explanation?.["merchantFacing"] as string) ?? null;

  await sql`
    UPDATE generation_sessions
    SET
      bundle          = ${sql.json(bundle as any)},
      status          = ${status},
      error_message   = COALESCE(${errorMessage ?? null}, error_message),
      generated_code  = COALESCE(${generatedCode}, generated_code),
      explanation     = COALESCE(${merchantFacing}, explanation),
      webhook_topics  = COALESCE(${webhookTopics}, webhook_topics),
      cron_schedule   = COALESCE(${cronSchedule}, cron_schedule),
      updated_at      = NOW()
    WHERE job_id = ${jobId}
  `;
}

/**
 * Persists the frontend chat message history for a generation session.
 * Called via PATCH /generation/:jobId/chat (debounced, fire-and-forget).
 * `messages` is an array of ChatMessage objects with `actions` stripped.
 */
export async function saveChatMessages(
  jobId: string,
  messages: Record<string, unknown>[]
): Promise<void> {
  await sql`
    UPDATE generation_sessions
    SET
      chat_messages = ${sql.json(messages as any)},
      updated_at    = NOW()
    WHERE job_id = ${jobId}
  `;
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
