export { sql, closeDb } from "./connection.js";
export {
  getAppById,
  resolveAppHandler,
  type AppRecord,
  type ResolvedHandler,
} from "./handlers.js";
export {
  createTenant,
  getTenantBasics,
  getTenantByShopDomain,
  getTenantAccessTokenSecretName,
  updateTenantAccessToken,
  type TenantBasics,
} from "./tenants.js";
export {
  upsertGeneration,
  getGenerationByJobId,
  markGenerationDeployed,
  type UpsertGenerationInput,
  type GenerationRow,
} from "./generations.js";
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
