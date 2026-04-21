export { sql, closeDb } from "./connection.js";
export {
  updateAppBundles,
  getAppBundles,
  type AppBundles,
} from "./bundles.js";
export {
  getAppById,
  getAppSlugs,
  resolveAppHandler,
  type AppRecord,
  type ResolvedHandler,
} from "./handlers.js";
export {
  createTenant,
  getTenantBasics,
  getTenantByShopDomain,
  getTenantAccessTokenSecretName,
  getTenantStorefrontTokenSecretName,
  updateTenantAccessToken,
  type TenantBasics,
} from "./tenants.js";
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
  insertActiveFile,
  insertPendingFile,
  finalizeFile,
  deleteFileRow,
  getFileForApp,
  getFinalizableFileForApp,
  getTenantStorageUsage,
  getTenantStorageLimit,
  getStalePendingFiles,
  type FileRecord,
  type InsertFileInput,
} from "./files.js";
export { trackAppExecution } from "./usage.js";
export {
  getOrCreateUsageRecord,
  incrementUsage,
  checkUsageQuota,
  type UsageCounter,
} from "./usage.js";
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
