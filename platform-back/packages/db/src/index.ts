export { sql, closeDb } from "./connection.js";
export {
  updateAppBundles,
  getAppBundles,
  type AppBundles,
} from "./bundles.js";
export {
  getAppById,
  getAppByIdUnsafe,
  getAppSlugs,
  resolveAppHandler,
  listAppsForTenant,
  listAdminAppsForShop,
  createApp,
  updateAppName,
  updateAppStatus,
  setThemeInjection,
  clearThemeInjection,
  deactivateAppInfrastructure,
  hardDeleteApp,
  getActiveWebhookSubscriptionsForApp,
  getActiveWebhookSubscriptionsForTenant,
  getAppVersionSemvers,
  getLatestDeployedVersionForApp,
  getActiveAppCount,
  type AppRecord,
  type AppFullRecord,
  type CreateAppInput,
  type ResolvedHandler,
  type ActiveWebhookSubscription,
  type TenantWebhookSubscription,
  type LatestDeployedVersion,
} from "./handlers.js";
export {
  createTenant,
  getTenantBasics,
  getTenantById,
  getTenantByShopDomain,
  getTenantAccessTokenSecretName,
  getTenantStorefrontTokenSecretName,
  getTenantStats,
  updateTenantAccessToken,
  type TenantBasics,
  type TenantRecord,
  type TenantStats,
} from "./tenants.js";
export {
  getWidgetInvocationLogs,
  getAdminInvocationLogs,
  getRecentWebhookInvocationLogs,
  type WidgetInvocationLogRow,
  type AdminInvocationLogRow,
  type WebhookInvocationLogRow,
} from "./invocation-logs.js";
export {
  upsertGeneration,
  getGenerationByJobId,
  markGenerationDeployed,
  createPendingGeneration,
  getLatestGenerationForApp,
  getLatestCompletedGenerationForApp,
  listGenerationsForApp,
  type UpsertGenerationInput,
  type GenerationRow,
} from "./generations.js";
export {
  resolveWebhookContext,
  createWebhookInvocationLog,
  updateWebhookInvocationLog,
  upsertWebhookSubscriptions,
  deactivateRemovedWebhookSubscriptions,
  type WebhookContext,
  type WebhookSubscriptionRow,
  type CreateWebhookInvocationLogInput,
  type UpdateWebhookInvocationLogInput,
} from "./webhooks.js";
export {
  insertActiveFileAtomic,
  insertPendingFile,
  finalizeFile,
  deleteFileRow,
  getFileForApp,
  getFinalizableFileForApp,
  getTenantStorageUsage,
  getTenantBillingPlan,
  sweepStalePendingFiles,
  getGcsObjectsForApp,
  type FileRecord,
  type InsertFileInput,
} from "./files.js";
export { trackAppExecution } from "./usage.js";
export {
  getOrCreateUsageRecord,
  incrementUsage,
  checkUsageQuota,
  getUsageHistory,
  type UsageCounter,
  type UsagePeriodSummary,
} from "./usage.js";
export {
  updateTenantBilling,
  logBillingEvent,
  getBillingEvents,
  storeRevisionClassification,
  getRevisionAnalytics,
  type BillingEvent,
  type RevisionAnalytics,
} from "./billing.js";
export {
  // tenant brand
  getTenantBrand,
  upsertTenantBrand,
  // app email config
  getAppEmailConfig,
  getAppEmailVariables,
  createAppEmailConfigFromStarter,
  updateAppEmailConfig,
  // deliveries
  insertEmailDelivery,
  updateEmailDeliveryStatus,
  updateEmailDeliveryByProviderId,
  getAppEmailStats,
  // suppression
  isEmailSuppressed,
  insertEmailSuppression,
  // deploy flags
  setAppUsesEmail,
  isAppEmailConfigured,
} from "./email.js";
