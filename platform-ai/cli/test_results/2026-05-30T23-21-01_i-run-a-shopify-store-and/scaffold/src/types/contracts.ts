// ─── Branded ID types ────────────────────────────────────────────────────────

export type ProductExternalId = bigint & { __brand: "ProductExternalId" };
export type VariantExternalId = bigint & { __brand: "VariantExternalId" };
export type InventoryItemExternalId = bigint & { __brand: "InventoryItemExternalId" };
export type OrderExternalId = bigint & { __brand: "OrderExternalId" };
export type WaitlistEntryId = string & { __brand: "WaitlistEntryId" };
export type NotificationBatchId = string & { __brand: "NotificationBatchId" };
export type ConversionId = string & { __brand: "ConversionId" };
export type DashboardSnapshotId = string & { __brand: "DashboardSnapshotId" };
export type NotificationSettingsId = string & { __brand: "NotificationSettingsId" };
export type UnsubscribeToken = string & { __brand: "UnsubscribeToken" };

// ─── Status/Enum types ───────────────────────────────────────────────────────

export type SignupLevel = "variant" | "product";
export type WaitlistStatus = "active" | "notified" | "converted" | "unsubscribed";
export type BatchStatus = "pending" | "sending" | "completed";

// ─── DB Row types ────────────────────────────────────────────────────────────

export interface WaitlistEntryRow {
  id: WaitlistEntryId;
  shopper_email: string;
  product_external_id: bigint;
  variant_external_id: bigint | null;
  item_display_name: string;
  item_page_url: string;
  signup_level: SignupLevel;
  status: WaitlistStatus;
  unsubscribe_token: UnsubscribeToken;
  signed_up_at: Date;
  notified_at: Date | null;
  notification_batch_id: NotificationBatchId | null;
}

export interface NotificationBatchRow {
  id: NotificationBatchId;
  product_external_id: bigint;
  variant_external_id: bigint | null;
  variant_gid: string | null; // canonical Shopify GID from inventoryItem API response
  available_quantity_at_detection: number;
  status: BatchStatus;
  entries_notified: number;
  detected_at: Date;
  scheduled_send_at: Date;
  completed_at: Date | null;
}

export interface ConversionRow {
  id: ConversionId;
  waitlist_entry_id: WaitlistEntryId;
  order_external_id: bigint;
  shopper_email: string;
  product_external_id: bigint;
  variant_external_id: bigint | null;
  notified_at: Date;
  converted_at: Date;
}

export interface NotificationSettingsRow {
  id: NotificationSettingsId;
  notification_subject_template: string;
  notification_body_template: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
  updated_at: Date;
}

export interface DashboardSnapshotRow {
  id: DashboardSnapshotId;
  product_external_id: bigint;
  variant_external_id: bigint | null;
  item_display_name: string;
  active_waitlist_count: number;
  total_signups: number;
  total_notified: number;
  total_conversions: number;
  last_restock_at: Date | null;
  snapshot_updated_at: Date;
}

// ─── Webhook payload types ───────────────────────────────────────────────────

export interface InventoryLevelUpdatePayload {
  admin_graphql_api_id: string;
  available: number | null;
  inventory_item_id: number;
  location_id: number;
  updated_at: string;
}

export interface ProductsDeletePayload {
  id: number;
}

export interface OrderLineItem {
  variant_id: number | null;
}

export interface OrdersPaidPayload {
  id: number;
  email: string;
  processed_at: string;
  line_items: OrderLineItem[];
}

// ─── Shopify Admin GraphQL response shapes ───────────────────────────────────

export interface InventoryItemQueryResult {
  inventoryItem: {
    id: string;
    variant: {
      id: string;
      product: {
        id: string;
      };
    };
  } | null;
}

export interface ProductVariantQueryResult {
  productVariant: {
    id: string; // canonical GID returned by Shopify: gid://shopify/ProductVariant/<n>
    availableForSale: boolean;
    inventoryQuantity: number | null;
  } | null;
}

// ─── Storefront GraphQL response shapes ──────────────────────────────────────

export interface StorefrontProductVariantNode {
  id: string;
  availableForSale: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
}

export interface StorefrontProductQueryResult {
  product: {
    id: string;
    title: string;
    availableForSale: boolean;
    variants: {
      nodes: StorefrontProductVariantNode[];
    };
  } | null;
}

// ─── Widget route contracts ───────────────────────────────────────────────────

// GET /widget/availability
export interface WidgetAvailabilityRequest {
  product_id: string;
  variant_id?: string;
}

export interface WidgetAvailabilityResponse {
  available: boolean;
  signup_level: SignupLevel;
}

// GET /widget/signup-status
export interface WidgetSignupStatusRequest {
  product_id: string;
  variant_id?: string;
  email: string;
}

export interface WidgetSignupStatusResponse {
  already_signed_up: boolean;
}

// POST /widget/signup
export interface WidgetSignupRequest {
  product_id: string;
  variant_id?: string;
  email: string;
  item_display_name: string;
  item_page_url: string;
  signup_level: SignupLevel;
}

export interface WidgetSignupResponse {
  success: boolean;
  already_signed_up: boolean;
}

// POST /widget/unsubscribe
export interface WidgetUnsubscribeRequest {
  token: string;
}

export interface WidgetUnsubscribeResponse {
  success: boolean;
}

// ─── Admin route contracts ────────────────────────────────────────────────────

// Shared dashboard item shape
export interface DashboardItem {
  product_external_id: string;
  variant_external_id: string | null;
  item_display_name: string;
  active_waitlist_count: number;
  total_signups: number;
  total_notified: number;
  total_conversions: number;
  conversion_rate: number;
  last_restock_at: string | null;
}

// Overall metrics
export interface OverallMetrics {
  total_signups: number;
  total_notified: number;
  total_conversions: number;
  conversion_rate: number;
}

// GET /admin/dashboard
export interface AdminDashboardRequest {
  cursor?: string;
}

export interface AdminDashboardResponse {
  items: DashboardItem[];
  next_cursor: string | null;
  total_count: number;
  overall_metrics: OverallMetrics;
}

// Subscriber item shape
export interface SubscriberItem {
  id: string;
  shopper_email: string;
  product_external_id: string;
  variant_external_id: string | null;
  item_display_name: string;
  signup_level: SignupLevel;
  status: WaitlistStatus;
  signed_up_at: string;
  notified_at: string | null;
  notification_batch_id: string | null;
}

// GET /admin/subscribers
export interface AdminSubscribersRequest {
  product_id: string;
  variant_id?: string;
  cursor?: string;
}

export interface AdminSubscribersResponse {
  subscribers: SubscriberItem[];
  next_cursor: string | null;
  total_count: number;
}

// GET /admin/subscribers/export
export interface AdminSubscribersExportRequest {
  product_id: string;
  variant_id?: string;
  cursor?: string;
}

export interface AdminSubscribersExportResponse {
  csv_data: string;
  next_cursor: string | null;
  total_count: number;
}

// GET /admin/settings
export interface AdminSettingsRequest {
  // no params
}

export interface AdminSettingsResponse {
  notification_subject_template: string;
  notification_body_template: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
}

// PUT /admin/settings/template
export interface AdminSaveTemplateRequest {
  notification_subject_template: string;
  notification_body_template: string;
}

export interface AdminSaveTemplateResponse {
  success: boolean;
  preview_subject: string;
  preview_body: string;
}

// PUT /admin/settings/quiet-hours
export interface AdminSaveQuietHoursRequest {
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
}

export interface AdminSaveQuietHoursResponse {
  success: boolean;
}

// ─── Cron job payload types ───────────────────────────────────────────────────

export interface DispatchNotificationBatchPayload {
  batch_id: NotificationBatchId;
}

export interface SweepNotificationBatchesPayload {
  // no specific payload needed
}
