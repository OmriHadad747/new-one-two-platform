export { sql, closeDb } from "./connection.js";
export {
  getAppById,
  resolveAppHandler,
  type AppRecord,
  type ResolvedHandler,
} from "./handlers.js";
export { getTenantBasics, type TenantBasics } from "./tenants.js";
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
