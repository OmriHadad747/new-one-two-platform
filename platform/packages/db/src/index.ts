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
  WidgetConfig,
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
 *
 * Note: postgres.camel returns flat rows. We use unambiguous snake_case aliases
 * and construct the nested GatewayContext manually.
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
      tenantAppArchetype: string;
      tenantWidgetConfig: WidgetConfig | null;
      appId: string;
      appTenantId: string;
      appSlug: string;
      appName: string;
      appStatus: string;
      appShopifyApiKey: string;
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
      t.id              AS tenant_id,
      t.slug            AS tenant_slug,
      t.name            AS tenant_name,
      t.status          AS tenant_status,
      t.plan            AS tenant_plan,
      t.kms_key_name    AS tenant_kms_key_name,
      t.app_archetype   AS tenant_app_archetype,
      t.widget_config   AS tenant_widget_config,

      a.id                                   AS app_id,
      a.tenant_id                            AS app_tenant_id,
      a.slug                                 AS app_slug,
      a.name                                 AS app_name,
      a.status                               AS app_status,
      a.shopify_api_key                      AS app_shopify_api_key,
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
      appArchetype: row.tenantAppArchetype as AppArchetype,
      widgetConfig: row.tenantWidgetConfig,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    app: {
      id: row.appId,
      tenantId: row.appTenantId,
      slug: row.appSlug,
      name: row.appName,
      status: row.appStatus as App["status"],
      shopifyApiKey: row.appShopifyApiKey,
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
  tenant: Pick<Tenant, "id" | "slug" | "kmsKeyName">;
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
      appShopifyApiKey: string;
      appShopifySecretName: string;
      appShopifyAccessTokenSecretName: string | null;
      appShopDomain: string;
      appCreatedAt: Date;
      appUpdatedAt: Date;
      tenantId: string;
      tenantSlug: string;
      tenantKmsKeyName: string;
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
      a.shopify_api_key                      AS "appShopifyApiKey",
      a.shopify_secret_name                  AS "appShopifySecretName",
      a.shopify_access_token_secret_name     AS "appShopifyAccessTokenSecretName",
      a.shop_domain                          AS "appShopDomain",
      a.created_at                           AS "appCreatedAt",
      a.updated_at                           AS "appUpdatedAt",

      t.id           AS "tenantId",
      t.slug         AS "tenantSlug",
      t.kms_key_name AS "tenantKmsKeyName"

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
      shopifyApiKey: row.appShopifyApiKey,
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
    },
  };
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
    jobId: string; // Phase 4: Pub/Sub correlation UUID
  }>
): Promise<void> {
  // Build dynamic update — only set fields that are provided
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
  // Get count of existing versions to build a unique semver
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

/**
 * Extends GenerationSessionRow with the Phase 4 Pub/Sub columns added in migration 0006.
 */
export interface GenerationSessionWithBundle extends GenerationSessionRow {
  jobId: string | null;
  bundle: Record<string, unknown> | null;
}

/**
 * Looks up a generation session by Pub/Sub job_id.
 * Called by apps/api when it receives generation.completed from Pub/Sub.
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
 * Also updates existing fields for backward compat with the deploy pipeline.
 */
export async function storeBundleInSession(
  jobId: string,
  bundle: Record<string, unknown>,
  status: "completed" | "failed",
  errorMessage?: string
): Promise<void> {
  // Unpack individual fields from the bundle so the legacy columns stay populated
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
 * Resolves widget_config for the App Block renderer.
 * Called by GET /widget-config?shop={shop} on the webhook gateway.
 *
 * Returns the widget_config JSONB for storefront_ui tenants.
 * Returns null if the tenant is backend_only or not found.
 */
export async function resolveWidgetConfig(
  shopDomain: string
): Promise<WidgetConfig | null> {
  const rows = await sql<
    Array<{ widgetConfig: WidgetConfig | null; appArchetype: string }>
  >`
    SELECT
      t.widget_config  AS "widgetConfig",
      t.app_archetype  AS "appArchetype"
    FROM tenants t
    JOIN apps a ON a.tenant_id = t.id AND a.shop_domain = ${shopDomain}
    WHERE t.status = 'active'
    LIMIT 1
  `;

  const row = rows[0];
  if (!row || row.appArchetype !== "storefront_ui") return null;
  return row.widgetConfig;
}

// ─── Tenant / App Management Queries ─────────────────────────────────────────
// Called by the tenant management API (POST /tenants, GET /tenants/:id, etc.).

export async function createTenant(params: {
  id?: string;
  slug: string;
  name: string;
  plan?: string;
  appArchetype?: string;
  kmsKeyName?: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tenants (id, slug, name, status, plan, app_archetype, kms_key_name)
    VALUES (
      ${params.id ?? sql`uuid_generate_v4()`},
      ${params.slug},
      ${params.name},
      'active',
      ${params.plan ?? "starter"},
      ${params.appArchetype ?? "backend_only"},
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
      appArchetype: string;
      widgetConfig: WidgetConfig | null;
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
      kms_key_name    AS "kmsKeyName",
      app_archetype   AS "appArchetype",
      widget_config   AS "widgetConfig",
      created_at      AS "createdAt",
      updated_at      AS "updatedAt"
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
    appArchetype: row.appArchetype as AppArchetype,
    widgetConfig: row.widgetConfig,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createApp(params: {
  id?: string;
  tenantId: string;
  slug: string;
  name: string;
  shopDomain: string;
  shopifyApiKey?: string;
  shopifySecretName?: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO apps (
      id, tenant_id, slug, name, status,
      shop_domain, shopify_api_key, shopify_secret_name
    ) VALUES (
      ${params.id ?? sql`uuid_generate_v4()`},
      ${params.tenantId},
      ${params.slug},
      ${params.name},
      'active',
      ${params.shopDomain},
      ${params.shopifyApiKey ?? "dev-api-key"},
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
      shopifyApiKey: string;
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
      shopify_api_key                      AS "shopifyApiKey",
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
    shopifyApiKey: row.shopifyApiKey,
    shopifySecretName: row.shopifySecretName,
    shopifyAccessTokenSecretName: row.shopifyAccessTokenSecretName,
    shopDomain: row.shopDomain,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Updates the widget_config for a tenant (storefront_ui archetype).
 * Called by the deployer after a successful bundle deployment.
 */
export async function updateTenantWidgetConfig(
  tenantId: string,
  widgetConfig: WidgetConfig | null
): Promise<void> {
  await sql`
    UPDATE tenants
    SET widget_config = ${widgetConfig ? sql.json(widgetConfig as any) : null},
        updated_at    = NOW()
    WHERE id = ${tenantId}
  `;
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
