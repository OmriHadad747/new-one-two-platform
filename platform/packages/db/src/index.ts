// ─── @new-one-two/db barrel ───────────────────────────────────────────────────
// Re-exports everything from the domain files so consumers don't need to change
// their import paths.

export { sql, withTenantContext } from "./connection.js";

export type { GatewayContext } from "./gateway.js";
export {
  resolveWebhookContext,
  createWebhookInvocationLog,
  updateWebhookInvocationLog,
} from "./gateway.js";

export {
  getAppVersionWithCode,
  getAppByIdOnly,
  getActiveWebhookTopicsForTenant,
  updateVersionStatus,
  upsertDeployedFunction,
} from "./deployer.js";

export type { GenerationSessionRow, GenerationSessionWithBundle } from "./generation.js";
export {
  createGenerationSession,
  updateGenerationSession,
  cancelGenerationSession,
  insertGenerationEvent,
  createDraftAppVersion,
  getLatestSessionForApp,
  getSessionsForApp,
  getLatestCompletedSessionForApp,
  getSessionByJobId,
  storeBundleInSession,
  saveChatMessages,
  resolveWidgetJs,
  resolveAdminUiJs,
  resolveAppFunctionUrl,
} from "./generation.js";

export {
  createTenant,
  getTenantById,
  getTenantByShopDomain,
  updateTenantAccessToken,
  updateTenantStorefrontToken,
  createApp,
  getAppById,
  updateAppStatus,
  updateAppWidgetJs,
  updateAppAdminUiJs,
  updateAppArchetype,
  updateAppName,
  setThemeInjection,
  clearThemeInjection,
  getAppsByTenantId,
  getRecentWebhookInvocationLogs,
  createWidgetInvocationLog,
  updateWidgetInvocationLog,
  getWidgetInvocationLogs,
  createAdminInvocationLog,
  updateAdminInvocationLog,
  getAdminInvocationLogs,
  getTenantStats,
  getAdminUiAppsByShop,
  getActiveWebhookSubscriptionsForApp,
  deactivateAppInfrastructure,
  getAppVersionSemvers,
  getLatestMigrationSqlForApp,
  getLatestDeployedVersionForApp,
  hardDeleteApp,
  upsertWebhookSubscription,
} from "./tenants.js";

export {
  getOrCreateUsageRecord,
  incrementUsage,
  getActiveAppCount,
  updateTenantBilling,
  storeRevisionClassification,
  logBillingEvent,
  getRevisionAnalytics,
  checkUsageQuota,
  getUsageHistory,
  getBillingEvents,
} from "./billing.js";

export {
  getTenantBrand,
  upsertTenantBrand,
  getAppEmailConfig,
  createAppEmailConfigFromStarter,
  updateAppEmailConfig,
  insertEmailDelivery,
  updateEmailDeliveryStatus,
  updateEmailDeliveryByProviderId,
  getAppEmailStats,
  isEmailSuppressed,
  insertEmailSuppression,
  setAppUsesEmail,
  isAppEmailConfigured,
} from "./email.js";
