import postgres from "postgres";
import type {
  Tenant,
  App,
  AppVersion,
  DeployedFunction,
  DeployedFunctionRuntime,
  WebhookSubscription,
  VersionStatus,
  AppArchetype,
} from "@new-one-two/types";

// ─── Connection Pool ──────────────────────────────────────────────────────────

const sql = postgres(process.env["DATABASE_URL"]!, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  transform: postgres.camel, // snake_case → camelCase automatically
});

export { sql };

// ─── RLS Context Helper ───────────────────────────────────────────────────────
// Sets app.current_tenant_id for the duration of a transaction so RLS policies
// filter correctly. Always use this wrapper for tenant-scoped queries.

export async function withTenantContext<TResult>(
  tenantId: string,
  fn: (sql: postgres.TransactionSql) => Promise<TResult>
): Promise<TResult> {
  // postgres.TransactionSql extends Omit<Sql, ...>, which strips call signatures
  // in TypeScript's type system. Cast tx to any to work around this type bug.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, TRUE)`;
    return fn(tx);
  }) as Promise<TResult>;
}

// ─── Webhook Gateway Queries ──────────────────────────────────────────────────
// These are hot-path queries called on every inbound webhook. They're designed
// to be fetched together in a single query to minimize round-trips.

export interface GatewayContext {
  tenant: Tenant;
  app: App;
  deployedFunction: DeployedFunction;
  subscription: WebhookSubscription;
}

/**
 * Resolves everything the webhook gateway needs in ONE query.
 * Returns null if tenant/app doesn't exist, is inactive, or has no active function.
 */
export async function resolveWebhookContext(
  tenantSlug: string,
  appSlug: string,
  topic: string
): Promise<GatewayContext | null> {
  const rows = await sql<
    Array<{
      tenantId: string;
      tenantSlug: string;
      tenantName: string;
      tenantStatus: string;
      tenantPlan: string;
      tenantKmsKeyName: string;
      tenantShopDomain: string | null;
      tenantShopifyAccessTokenSecretName: string | null;
      appId: string;
      appTenantId: string;
      appSlug: string;
      appName: string;
      appStatus: string;
      appArchetype: string;
      appWidgetJs: string | null;
      appShopifyClientId: string;
      appShopifySecretName: string;
      appShopifyAccessTokenSecretName: string | null;
      appShopDomain: string;
      appCreatedAt: Date;
      appUpdatedAt: Date;
      dfId: string;
      dfFunctionUrl: string;
      dfMemoryMb: number;
      dfTimeoutSec: number;
      dfEnvVarsEncrypted: string | null;
      wsId: string;
      wsTopic: string;
      wsShopifyWebhookId: string;
      wsCallbackUrl: string;
    }>
  >`
    SELECT
      t.id                                   AS tenant_id,
      t.slug                                 AS tenant_slug,
      t.name                                 AS tenant_name,
      t.status                               AS tenant_status,
      t.plan                                 AS tenant_plan,
      t.kms_key_name                         AS tenant_kms_key_name,
      t.shop_domain                          AS tenant_shop_domain,
      t.shopify_access_token_secret_name     AS tenant_shopify_access_token_secret_name,

      a.id                                   AS app_id,
      a.tenant_id                            AS app_tenant_id,
      a.slug                                 AS app_slug,
      a.name                                 AS app_name,
      a.status                               AS app_status,
      a.app_archetype                        AS app_archetype,
      a.widget_js                            AS app_widget_js,
      a.shopify_client_id                      AS app_shopify_client_id,
      a.shopify_secret_name                  AS app_shopify_secret_name,
      a.shopify_access_token_secret_name     AS app_shopify_access_token_secret_name,
      a.shop_domain                          AS app_shop_domain,
      a.created_at                           AS app_created_at,
      a.updated_at                           AS app_updated_at,

      df.id           AS df_id,
      df.function_url AS df_function_url,
      df.memory_mb    AS df_memory_mb,
      df.timeout_sec  AS df_timeout_sec,
      df.env_vars_encrypted AS df_env_vars_encrypted,

      ws.id                  AS ws_id,
      ws.topic               AS ws_topic,
      ws.shopify_webhook_id  AS ws_shopify_webhook_id,
      ws.callback_url        AS ws_callback_url

    FROM tenants t
    JOIN apps a
      ON a.tenant_id = t.id
      AND a.slug = ${appSlug}
      AND a.status = 'active'
    JOIN webhook_subscriptions ws
      ON ws.app_id = a.id
      AND ws.topic = ${topic}
      AND ws.active = TRUE
    JOIN deployed_functions df
      ON df.id = ws.deployed_function_id
      AND df.is_active = TRUE
    WHERE
      t.slug = ${tenantSlug}
      AND t.status = 'active'
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    tenant: {
      id: row.tenantId,
      slug: row.tenantSlug,
      name: row.tenantName,
      status: row.tenantStatus as Tenant["status"],
      plan: row.tenantPlan,
      kmsKeyName: row.tenantKmsKeyName,
      shopDomain: row.tenantShopDomain,
      shopifyAccessTokenSecretName: row.tenantShopifyAccessTokenSecretName,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    app: {
      id: row.appId,
      tenantId: row.appTenantId,
      slug: row.appSlug,
      name: row.appName,
      status: row.appStatus as App["status"],
      appArchetype: row.appArchetype as AppArchetype,
      widgetJs: row.appWidgetJs,
      shopifyClientId: row.appShopifyClientId,
      shopifySecretName: row.appShopifySecretName,
      shopifyAccessTokenSecretName: row.appShopifyAccessTokenSecretName,
      shopDomain: row.appShopDomain,
      createdAt: row.appCreatedAt,
      updatedAt: row.appUpdatedAt,
    },
    deployedFunction: {
      id: row.dfId,
      appVersionId: "",
      appId: row.appId,
      tenantId: row.tenantId,
      functionUrl: row.dfFunctionUrl,
      runtime: "nodejs20",
      memoryMb: row.dfMemoryMb,
      timeoutSec: row.dfTimeoutSec,
      envVarsEncrypted: row.dfEnvVarsEncrypted ?? "",
      deployedAt: new Date(),
      isActive: true,
    },
    subscription: {
      id: row.wsId,
      appId: row.appId,
      tenantId: row.tenantId,
      deployedFunctionId: row.dfId,
      topic: row.wsTopic as WebhookSubscription["topic"],
      shopifyWebhookId: row.wsShopifyWebhookId,
      callbackUrl: row.wsCallbackUrl,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

/**
 * Creates an execution log entry (idempotent — returns existing if duplicate).
 * The unique index on (app_id, shopify_webhook_id) enforces at-most-once queuing.
 */
export async function createExecutionLog(params: {
  webhookSubscriptionId: string;
  deployedFunctionId: string;
  appId: string;
  tenantId: string;
  topic: string;
  shopifyWebhookId: string;
  requestPayloadHash: string;
}): Promise<{ id: string; isDuplicate: boolean }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO execution_logs (
      webhook_subscription_id,
      deployed_function_id,
      app_id,
      tenant_id,
      topic,
      shopify_webhook_id,
      request_payload_hash,
      status
    ) VALUES (
      ${params.webhookSubscriptionId},
      ${params.deployedFunctionId},
      ${params.appId},
      ${params.tenantId},
      ${params.topic},
      ${params.shopifyWebhookId},
      ${params.requestPayloadHash},
      'queued'
    )
    ON CONFLICT (app_id, shopify_webhook_id) DO NOTHING
    RETURNING id
  `;

  if (rows.length === 0) {
    // Duplicate — find the existing log
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM execution_logs
      WHERE app_id = ${params.appId}
        AND shopify_webhook_id = ${params.shopifyWebhookId}
      LIMIT 1
    `;
    return { id: existing[0]!.id, isDuplicate: true };
  }

  return { id: rows[0]!.id, isDuplicate: false };
}

/**
 * Transitions execution log status. Called by the worker.
 */
export async function updateExecutionStatus(
  id: string,
  update: {
    status: "running" | "success" | "failed" | "timeout";
    durationMs?: number;
    responseStatusCode?: number;
    errorMessage?: string;
    invocationId?: string;
    shopifyApiCalls?: number;
    startedAt?: Date;
    completedAt?: Date;
  }
): Promise<void> {
  await sql`
    UPDATE execution_logs
    SET
      status               = ${update.status},
      duration_ms          = ${update.durationMs ?? null},
      response_status_code = ${update.responseStatusCode ?? null},
      error_message        = ${update.errorMessage ?? null},
      invocation_id        = ${update.invocationId ?? null},
      shopify_api_calls    = ${update.shopifyApiCalls ?? 0},
      started_at           = ${update.startedAt ?? null},
      completed_at         = ${update.completedAt ?? null}
    WHERE id = ${id}
  `;
}

// ─── Deployer Queries ─────────────────────────────────────────────────────────
// These run as the platform service (no RLS). They need cross-tenant visibility
// for build orchestration. Do NOT wrap in withTenantContext.

/**
 * Fetches an AppVersion with its parent App and Tenant for the deployment pipeline.
 */
export async function getAppVersionWithCode(appVersionId: string): Promise<{
  version: AppVersion;
  app: App;
  tenant: Pick<Tenant, "id" | "slug" | "kmsKeyName" | "shopifyAccessTokenSecretName">;
} | null> {
  const rows = await sql<
    Array<{
      versionId: string;
      versionAppId: string;
      versionTenantId: string;
      versionSemver: string;
      versionStatus: string;
      versionGeneratedCode: Record<string, string>;
      versionBuildLogs: string | null;
      versionGcsBundlePath: string | null;
      versionCreatedAt: Date;
      versionUpdatedAt: Date;
      appId: string;
      appTenantId: string;
      appSlug: string;
      appName: string;
      appStatus: string;
      appArchetype: string;
      appWidgetJs: string | null;
      appShopifyClientId: string;
      appShopifySecretName: string;
      appShopifyAccessTokenSecretName: string | null;
      appShopDomain: string;
      appCreatedAt: Date;
      appUpdatedAt: Date;
      tenantId: string;
      tenantSlug: string;
      tenantKmsKeyName: string;
      tenantShopifyAccessTokenSecretName: string | null;
    }>
  >`
    SELECT
      av.id                AS "versionId",
      av.app_id            AS "versionAppId",
      av.tenant_id         AS "versionTenantId",
      av.semver            AS "versionSemver",
      av.status            AS "versionStatus",
      av.generated_code    AS "versionGeneratedCode",
      av.build_logs        AS "versionBuildLogs",
      av.gcs_bundle_path   AS "versionGcsBundlePath",
      av.created_at        AS "versionCreatedAt",
      av.updated_at        AS "versionUpdatedAt",

      a.id                                   AS "appId",
      a.tenant_id                            AS "appTenantId",
      a.slug                                 AS "appSlug",
      a.name                                 AS "appName",
      a.status                               AS "appStatus",
      a.app_archetype                        AS "appArchetype",
      a.widget_js                            AS "appWidgetJs",
      a.shopify_client_id                      AS "appShopifyClientId",
      a.shopify_secret_name                  AS "appShopifySecretName",
      a.shopify_access_token_secret_name     AS "appShopifyAccessTokenSecretName",
      a.shop_domain                          AS "appShopDomain",
      a.created_at                           AS "appCreatedAt",
      a.updated_at                           AS "appUpdatedAt",

      t.id                                 AS "tenantId",
      t.slug                               AS "tenantSlug",
      t.kms_key_name                       AS "tenantKmsKeyName",
      t.shopify_access_token_secret_name   AS "tenantShopifyAccessTokenSecretName"

    FROM app_versions av
    JOIN apps a ON a.id = av.app_id
    JOIN tenants t ON t.id = av.tenant_id
    WHERE av.id = ${appVersionId}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    version: {
      id: row.versionId,
      appId: row.versionAppId,
      tenantId: row.versionTenantId,
      semver: row.versionSemver,
      status: row.versionStatus as VersionStatus,
      generatedCode: row.versionGeneratedCode,
      buildLogs: row.versionBuildLogs,
      gcsBundlePath: row.versionGcsBundlePath,
      createdAt: row.versionCreatedAt,
      updatedAt: row.versionUpdatedAt,
    },
    app: {
      id: row.appId,
      tenantId: row.appTenantId,
      slug: row.appSlug,
      name: row.appName,
      status: row.appStatus as App["status"],
      appArchetype: row.appArchetype as AppArchetype,
      widgetJs: row.appWidgetJs,
      shopifyClientId: row.appShopifyClientId,
      shopifySecretName: row.appShopifySecretName,
      shopifyAccessTokenSecretName: row.appShopifyAccessTokenSecretName,
      shopDomain: row.appShopDomain,
      createdAt: row.appCreatedAt,
      updatedAt: row.appUpdatedAt,
    },
    tenant: {
      id: row.tenantId,
      slug: row.tenantSlug,
      kmsKeyName: row.tenantKmsKeyName,
      shopifyAccessTokenSecretName: row.tenantShopifyAccessTokenSecretName,
    },
  };
}

/**
 * Returns all active webhook topics across all apps for a tenant.
 * Used by the OAuth callback to re-register webhooks after re-install.
 */
export async function getActiveWebhookTopicsForTenant(
  tenantId: string
): Promise<Array<{ tenantSlug: string; appSlug: string; topic: string }>> {
  return sql<Array<{ tenantSlug: string; appSlug: string; topic: string }>>`
    SELECT DISTINCT
      t.slug  AS "tenantSlug",
      a.slug  AS "appSlug",
      ws.topic
    FROM webhook_subscriptions ws
    JOIN apps    a ON a.id  = ws.app_id
    JOIN tenants t ON t.id  = a.tenant_id
    WHERE ws.tenant_id = ${tenantId}
      AND ws.active    = TRUE
    ORDER BY a.slug, ws.topic
  `;
}

/**
 * Sets an AppVersion's build status.
 */
export async function updateVersionStatus(
  appVersionId: string,
  status: VersionStatus,
  buildLogs?: string
): Promise<void> {
  await sql`
    UPDATE app_versions
    SET
      status     = ${status},
      build_logs = ${buildLogs ?? null},
      updated_at = NOW()
    WHERE id = ${appVersionId}
  `;
}

/**
 * Atomically inserts a new deployed_functions row (is_active=true) and
 * deactivates all prior active rows for the same app. Single CTE to prevent
 * race conditions where two rows are briefly both active.
 */
export async function upsertDeployedFunction(params: {
  appVersionId: string;
  appId: string;
  tenantId: string;
  functionUrl: string;
  runtime: DeployedFunctionRuntime;
  memoryMb: number;
  timeoutSec: number;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    WITH deactivate AS (
      UPDATE deployed_functions
      SET is_active = FALSE
      WHERE app_id = ${params.appId} AND is_active = TRUE
    )
    INSERT INTO deployed_functions (
      app_version_id, app_id, tenant_id,
      function_url, runtime, memory_mb, timeout_sec,
      is_active, deployed_at
    ) VALUES (
      ${params.appVersionId}, ${params.appId}, ${params.tenantId},
      ${params.functionUrl}, ${params.runtime}, ${params.memoryMb}, ${params.timeoutSec},
      TRUE, NOW()
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

// ─── Generator Queries ────────────────────────────────────────────────────────
// Service-level operations (no RLS). Called by apps/generator.

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
 * Resolves the widget JS and active backend function URL for a shop/app pair.
 * Called by GET /widgets/:shop/:appId.js on the API service.
 *
 * Returns null if not found, backend_only, or widget not yet generated.
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
  if (!row || row.appArchetype !== "storefront_ui" || !row.widgetJs) return null;
  return { widgetJs: row.widgetJs, functionUrl: row.functionUrl };
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

// ─── Tenant / App Management Queries ─────────────────────────────────────────

export async function createTenant(params: {
  id?: string;
  slug: string;
  name: string;
  plan?: string;
  shopDomain?: string;
  shopifyAccessTokenSecretName?: string;
  kmsKeyName?: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tenants (id, slug, name, status, plan, shop_domain, shopify_access_token_secret_name, kms_key_name)
    VALUES (
      ${params.id ?? sql`uuid_generate_v4()`},
      ${params.slug},
      ${params.name},
      'active',
      ${params.plan ?? "starter"},
      ${params.shopDomain ?? null},
      ${params.shopifyAccessTokenSecretName ?? null},
      ${params.kmsKeyName ?? "projects/local/locations/global/keyRings/dev/cryptoKeys/dev-key"}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const rows = await sql<
    Array<{
      id: string;
      slug: string;
      name: string;
      status: string;
      plan: string;
      kmsKeyName: string;
      shopDomain: string | null;
      shopifyAccessTokenSecretName: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      id,
      slug,
      name,
      status,
      plan,
      kms_key_name                         AS "kmsKeyName",
      shop_domain                          AS "shopDomain",
      shopify_access_token_secret_name     AS "shopifyAccessTokenSecretName",
      created_at                           AS "createdAt",
      updated_at                           AS "updatedAt"
    FROM tenants
    WHERE id = ${id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as Tenant["status"],
    plan: row.plan,
    kmsKeyName: row.kmsKeyName,
    shopDomain: row.shopDomain,
    shopifyAccessTokenSecretName: row.shopifyAccessTokenSecretName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds a tenant by shop domain. Used during OAuth callback to detect re-installs.
 */
export async function getTenantByShopDomain(shopDomain: string): Promise<Tenant | null> {
  const rows = await sql<
    Array<{
      id: string;
      slug: string;
      name: string;
      status: string;
      plan: string;
      kmsKeyName: string;
      shopDomain: string | null;
      shopifyAccessTokenSecretName: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      id,
      slug,
      name,
      status,
      plan,
      kms_key_name                         AS "kmsKeyName",
      shop_domain                          AS "shopDomain",
      shopify_access_token_secret_name     AS "shopifyAccessTokenSecretName",
      created_at                           AS "createdAt",
      updated_at                           AS "updatedAt"
    FROM tenants
    WHERE shop_domain = ${shopDomain}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as Tenant["status"],
    plan: row.plan,
    kmsKeyName: row.kmsKeyName,
    shopDomain: row.shopDomain,
    shopifyAccessTokenSecretName: row.shopifyAccessTokenSecretName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Updates a tenant's Shopify access token secret name. Used on OAuth re-install.
 */
export async function updateTenantAccessToken(
  tenantId: string,
  shopifyAccessTokenSecretName: string
): Promise<void> {
  await sql`
    UPDATE tenants
    SET
      shopify_access_token_secret_name = ${shopifyAccessTokenSecretName},
      updated_at = NOW()
    WHERE id = ${tenantId}
  `;
}

export async function createApp(params: {
  id?: string;
  tenantId: string;
  slug: string;
  name: string;
  shopDomain: string;
  appArchetype?: string;
  shopifyClientId?: string;
  shopifySecretName?: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO apps (
      id, tenant_id, slug, name, status,
      shop_domain, app_archetype, shopify_client_id, shopify_secret_name
    ) VALUES (
      ${params.id ?? sql`uuid_generate_v4()`},
      ${params.tenantId},
      ${params.slug},
      ${params.name},
      'active',
      ${params.shopDomain},
      ${params.appArchetype ?? "backend_only"},
      ${params.shopifyClientId ?? "dev-api-key"},
      ${params.shopifySecretName ?? "projects/local/secrets/dev/versions/latest"}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export async function getAppById(
  tenantId: string,
  appId: string
): Promise<App | null> {
  const rows = await sql<
    Array<{
      id: string;
      tenantId: string;
      slug: string;
      name: string;
      status: string;
      appArchetype: string;
      widgetJs: string | null;
      shopifyClientId: string;
      shopifySecretName: string;
      shopifyAccessTokenSecretName: string | null;
      shopDomain: string;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      id,
      tenant_id                            AS "tenantId",
      slug,
      name,
      status,
      app_archetype                        AS "appArchetype",
      widget_js                            AS "widgetJs",
      shopify_client_id                      AS "shopifyClientId",
      shopify_secret_name                  AS "shopifySecretName",
      shopify_access_token_secret_name     AS "shopifyAccessTokenSecretName",
      shop_domain                          AS "shopDomain",
      created_at                           AS "createdAt",
      updated_at                           AS "updatedAt"
    FROM apps
    WHERE id = ${appId} AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    status: row.status as App["status"],
    appArchetype: row.appArchetype as AppArchetype,
    widgetJs: row.widgetJs,
    shopifyClientId: row.shopifyClientId,
    shopifySecretName: row.shopifySecretName,
    shopifyAccessTokenSecretName: row.shopifyAccessTokenSecretName,
    shopDomain: row.shopDomain,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Stores the widget JS for a platform app (storefront_ui archetype).
 * Called by the deployer after a successful bundle deployment.
 */
export async function updateAppWidgetJs(
  appId: string,
  widgetJs: string | null
): Promise<void> {
  await sql`
    UPDATE apps
    SET widget_js  = ${widgetJs},
        updated_at = NOW()
    WHERE id = ${appId}
  `;
}

/**
 * Updates the app_archetype for a platform app.
 * Called by the deployer when deploying a bundle — archetype is inferred from
 * whether widgetModule is present (storefront_ui) or null (backend_only).
 */
export async function updateAppArchetype(
  appId: string,
  appArchetype: AppArchetype
): Promise<void> {
  await sql`
    UPDATE apps
    SET app_archetype = ${appArchetype},
        updated_at    = NOW()
    WHERE id = ${appId}
  `;
}

/**
 * Returns all apps for a tenant, newest first.
 */
export async function getAppsByTenantId(tenantId: string): Promise<App[]> {
  const rows = await sql<
    Array<{
      id: string;
      tenantId: string;
      slug: string;
      name: string;
      status: string;
      appArchetype: string;
      widgetJs: string | null;
      shopifyClientId: string;
      shopifySecretName: string;
      shopifyAccessTokenSecretName: string | null;
      shopDomain: string;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      id,
      tenant_id                            AS "tenantId",
      slug,
      name,
      status,
      app_archetype                        AS "appArchetype",
      widget_js                            AS "widgetJs",
      shopify_client_id                    AS "shopifyClientId",
      shopify_secret_name                  AS "shopifySecretName",
      shopify_access_token_secret_name     AS "shopifyAccessTokenSecretName",
      shop_domain                          AS "shopDomain",
      created_at                           AS "createdAt",
      updated_at                           AS "updatedAt"
    FROM apps
    WHERE tenant_id = ${tenantId}
      AND status != 'deleted'
    ORDER BY updated_at DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    status: row.status as App["status"],
    appArchetype: row.appArchetype as AppArchetype,
    widgetJs: row.widgetJs,
    shopifyClientId: row.shopifyClientId,
    shopifySecretName: row.shopifySecretName,
    shopifyAccessTokenSecretName: row.shopifyAccessTokenSecretName,
    shopDomain: row.shopDomain,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Returns the most recent execution logs across all apps for a tenant.
 */
export async function getRecentExecutionLogs(
  tenantId: string,
  limit = 20
): Promise<
  Array<{
    id: string;
    appId: string;
    appName: string;
    topic: string;
    status: string;
    durationMs: number | null;
    errorMessage: string | null;
    queuedAt: Date;
  }>
> {
  return sql<
    Array<{
      id: string;
      appId: string;
      appName: string;
      topic: string;
      status: string;
      durationMs: number | null;
      errorMessage: string | null;
      queuedAt: Date;
    }>
  >`
    SELECT
      el.id,
      el.app_id          AS "appId",
      a.name             AS "appName",
      el.topic,
      el.status,
      el.duration_ms     AS "durationMs",
      el.error_message   AS "errorMessage",
      el.queued_at       AS "queuedAt"
    FROM execution_logs el
    JOIN apps a ON a.id = el.app_id
    WHERE el.tenant_id = ${tenantId}
    ORDER BY el.queued_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Returns dashboard stats for a tenant: app counts and execution metrics for current month.
 */
export async function getTenantStats(tenantId: string): Promise<{
  totalApps: number;
  liveApps: number;
  apiCallsThisMonth: number;
  avgResponseMs: number;
}> {
  const [appStats, execStats] = await Promise.all([
    sql<Array<{ total: string; live: string }>>`
      SELECT
        COUNT(*)                                                      AS "total",
        COUNT(*) FILTER (WHERE status = 'active')                    AS "live"
      FROM apps
      WHERE tenant_id = ${tenantId} AND status != 'deleted'
    `,
    sql<Array<{ calls: string; avgMs: string | null }>>`
      SELECT
        COUNT(*)                           AS "calls",
        AVG(duration_ms)                   AS "avgMs"
      FROM execution_logs
      WHERE tenant_id  = ${tenantId}
        AND queued_at >= date_trunc('month', NOW())
    `,
  ]);

  const appRow = appStats[0] ?? { total: "0", live: "0" };
  const execRow = execStats[0] ?? { calls: "0", avgMs: null };

  return {
    totalApps: parseInt(appRow.total, 10),
    liveApps: parseInt(appRow.live, 10),
    apiCallsThisMonth: parseInt(execRow.calls, 10),
    avgResponseMs: execRow.avgMs ? Math.round(parseFloat(execRow.avgMs)) : 0,
  };
}

/**
 * Creates or replaces a webhook subscription for an (app, topic) pair.
 * Uses RLS — must be called within withTenantContext.
 */
export async function upsertWebhookSubscription(params: {
  appId: string;
  tenantId: string;
  deployedFunctionId: string;
  topic: string;
  shopifyWebhookId: string;
  callbackUrl: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO webhook_subscriptions (
      app_id, tenant_id, deployed_function_id,
      topic, shopify_webhook_id, callback_url, active
    ) VALUES (
      ${params.appId}, ${params.tenantId}, ${params.deployedFunctionId},
      ${params.topic}, ${params.shopifyWebhookId}, ${params.callbackUrl}, TRUE
    )
    ON CONFLICT (app_id, topic) DO UPDATE SET
      deployed_function_id = EXCLUDED.deployed_function_id,
      shopify_webhook_id   = EXCLUDED.shopify_webhook_id,
      callback_url         = EXCLUDED.callback_url,
      active               = TRUE,
      updated_at           = NOW()
    RETURNING id
  `;
  return { id: rows[0]!.id };
}
