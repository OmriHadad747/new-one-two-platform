// ═══════════════════════════════════════════════════════════
// Branded ID types
// ═══════════════════════════════════════════════════════════

export type WaitlistSignupId = string & { __brand: "WaitlistSignupId" };
export type NotificationBatchId = string & { __brand: "NotificationBatchId" };
export type NotificationSendId = string & { __brand: "NotificationSendId" };
export type ConversionId = string & { __brand: "ConversionId" };
export type DemandStatsSnapshotId = string & { __brand: "DemandStatsSnapshotId" };

/** Shopify numeric ids — stored as BIGINT, arrive from JS as string */
export type ItemExternalId = string & { __brand: "ItemExternalId" };
export type ProductExternalId = string & { __brand: "ProductExternalId" };
export type VariantExternalId = string & { __brand: "VariantExternalId" };
export type OrderExternalId = string & { __brand: "OrderExternalId" };
export type InventoryItemExternalId = string & { __brand: "InventoryItemExternalId" };
export type LocationExternalId = string & { __brand: "LocationExternalId" };

export type UnsubscribeToken = string & { __brand: "UnsubscribeToken" };

// ═══════════════════════════════════════════════════════════
// Enum / status vocabularies (from persistence)
// ═══════════════════════════════════════════════════════════

export type ItemType = "variant" | "product";
export type SignupStatus = "pending" | "notified" | "unsubscribed" | "deleted";
export type BatchStatus = "pending" | "running" | "completed" | "failed";
export type SendStatus = "pending" | "sent" | "failed";

// ═══════════════════════════════════════════════════════════
// DB Row types — one per table, columns match schema one-to-one
// ═══════════════════════════════════════════════════════════

export interface WaitlistSignupRow {
  id: WaitlistSignupId;
  email: string;
  item_external_id: string; // BIGINT returned as string from postgres.js
  item_type: ItemType;
  product_external_id: string; // BIGINT as string
  unsubscribe_token: UnsubscribeToken;
  status: SignupStatus;
  signed_up_at: string; // TIMESTAMPTZ as ISO string
  deleted_at: string | null;
}

export interface NotificationBatchRow {
  id: NotificationBatchId;
  item_external_id: string;
  item_type: ItemType;
  product_external_id: string;
  restock_date_bucket: string; // YYYY-MM-DD
  signups_selected: number;
  emails_sent: number;
  status: BatchStatus;
  created_at: string;
  deleted_at: string | null;
}

export interface NotificationSendRow {
  id: NotificationSendId;
  batch_id: NotificationBatchId;
  signup_id: WaitlistSignupId;
  sent_at: string | null;
  status: SendStatus;
}

export interface ConversionRow {
  id: ConversionId;
  order_external_id: string;
  signup_id: WaitlistSignupId;
  item_external_id: string;
  converted_at: string;
}

export interface DemandStatsSnapshotRow {
  id: DemandStatsSnapshotId;
  item_external_id: string;
  item_type: ItemType;
  product_external_id: string;
  product_title: string | null;
  variant_title: string | null;
  waitlist_count: number;
  total_signups: number;
  total_notified: number;
  total_conversions: number;
  last_refreshed_at: string;
}

// ═══════════════════════════════════════════════════════════
// Webhook payload types
// ═══════════════════════════════════════════════════════════

/** inventory_levels/update */
export interface InventoryLevelUpdatePayload {
  inventory_item_id: number; // Shopify sends numeric
  available: number | null;
  location_id: number;
  updated_at: string;
}

/** products/delete */
export interface ProductDeletePayload {
  id: number; // Shopify product id
}

/** orders/paid — only the fields we consume per payloadBindings */
export interface OrderPaidLineItem {
  variant_id: number | null;
}

export interface OrderPaidPayload {
  id: number; // order external id
  email: string | null;
  line_items: OrderPaidLineItem[];
}

// ═══════════════════════════════════════════════════════════
// Widget HTTP contracts
// ═══════════════════════════════════════════════════════════

/** POST /widget/signup */
export interface WidgetSignupRequest {
  email: string;
  item_external_id: string;
  item_type: ItemType;
  product_external_id: string;
}

export interface WidgetSignupResponse {
  result: "created" | "duplicate" | "error";
  message: string;
}

/** GET /widget/signup/status */
export interface WidgetSignupStatusRequest {
  email: string;
  item_external_id: string;
}

export interface WidgetSignupStatusResponse {
  signed_up: boolean;
  item_external_id: string;
}

/** GET /unsubscribe */
export interface UnsubscribeRequest {
  token: string;
}

export interface UnsubscribeResponse {
  result: "success" | "not_found" | "error";
  message: string;
}

// ═══════════════════════════════════════════════════════════
// Admin HTTP contracts
// ═══════════════════════════════════════════════════════════

/** GET /admin/dashboard */
export interface AdminDashboardRequest {
  page?: number;
  page_size?: number;
}

export interface AdminDashboardResponse {
  items: DemandStatsSnapshotRow[];
  total: number;
  page: number;
  page_size: number;
}

/** GET /admin/products/subscribers */
export interface AdminSubscribersRequest {
  item_external_id: string;
  page?: number;
  page_size?: number;
}

export interface AdminSubscribersResponse {
  items: WaitlistSignupRow[];
  total: number;
  page: number;
  page_size: number;
}

/** GET /admin/products/subscribers/export */
export interface AdminSubscribersExportRequest {
  item_external_id: string;
}

export interface AdminSubscribersExportResponse {
  csv_url: string;
}

/** GET /admin/settings */
export interface AdminSettingsResponse {
  settings: AppSettings;
}

/** PUT /admin/settings */
export interface AdminSettingsSaveRequest {
  batch_size: number;
  quiet_hours_start: string; // "HH:MM" 24-hour
  quiet_hours_end: string;   // "HH:MM" 24-hour
  conversion_attribution_window_days: number;
}

export interface AdminSettingsSaveResponse {
  settings: AppSettings;
}

/** Shared settings shape */
export interface AppSettings {
  batch_size: number;
  quiet_hours_start: string;
  quiet_hours_end: string;
  conversion_attribution_window_days: number;
}

// ═══════════════════════════════════════════════════════════
// Cron / job payload types
// ═══════════════════════════════════════════════════════════

export interface DispatchDeferredEmailsPayload {
  triggered_at: string; // ISO timestamp of the cron tick
}

// ═══════════════════════════════════════════════════════════
// Internal shared shapes (used across route files)
// ═══════════════════════════════════════════════════════════

/** Resolved Shopify variant info for email templating */
export interface ResolvedVariantInfo {
  product_title: string;
  variant_title: string;
  product_url: string;
  variant_image_url: string | null;
}

/** Notification send row joined with signup for email dispatch */
export interface NotificationSendWithSignup {
  send_id: NotificationSendId;
  batch_id: NotificationBatchId;
  signup_id: WaitlistSignupId;
  email: string;
  unsubscribe_token: UnsubscribeToken;
  item_external_id: string;
  item_type: ItemType;
}
