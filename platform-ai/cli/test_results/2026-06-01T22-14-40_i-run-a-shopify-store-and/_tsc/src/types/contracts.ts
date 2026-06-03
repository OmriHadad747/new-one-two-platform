// ─── Branded ID types ────────────────────────────────────────────────────────
export type WaitlistEntryId = string & { __brand: "WaitlistEntryId" };
export type NotificationBatchId = string & { __brand: "NotificationBatchId" };
export type NotificationSendId = string & { __brand: "NotificationSendId" };
export type ConversionId = string & { __brand: "ConversionId" };
export type EmailTemplateId = string & { __brand: "EmailTemplateId" };
export type AppSettingsId = string & { __brand: "AppSettingsId" };

/** Shopify numeric IDs as strings (returned by postgres BIGINT columns) */
export type ProductExternalId = string & { __brand: "ProductExternalId" };
export type VariantExternalId = string & { __brand: "VariantExternalId" };
export type InventoryItemExternalId = string & { __brand: "InventoryItemExternalId" };
export type LocationExternalId = string & { __brand: "LocationExternalId" };
export type OrderExternalId = string & { __brand: "OrderExternalId" };

// ─── Status enums ─────────────────────────────────────────────────────────────
export type WaitlistEntryStatus = "active" | "notified" | "removed";
export type WaitlistEntryScope = "variant" | "product";
export type NotificationBatchStatus = "open" | "completed" | "cancelled";
export type NotificationSendStatus = "queued" | "dispatched" | "failed" | "skipped";

// ─── DB Row types ─────────────────────────────────────────────────────────────

export interface WaitlistEntryRow {
  id: WaitlistEntryId;
  shopper_email: string;
  product_external_id: string; // BIGINT comes back as string from postgres
  variant_external_id: string | null; // nullable BIGINT
  scope: WaitlistEntryScope;
  unsubscribe_token: string;
  status: WaitlistEntryStatus;
  signed_up_at: Date;
  deleted_at: Date | null;
}

export interface NotificationBatchRow {
  id: NotificationBatchId;
  product_external_id: string;
  variant_external_id: string | null;
  restock_detected_at: Date;
  available_quantity_at_restock: number;
  notify_cap: number;
  total_queued: number;
  total_sent: number;
  status: NotificationBatchStatus;
  created_at: Date;
}

export interface NotificationSendRow {
  id: NotificationSendId;
  batch_id: NotificationBatchId;
  waitlist_entry_id: WaitlistEntryId;
  shopper_email: string;
  queue_position: number;
  status: NotificationSendStatus;
  failure_reason: string | null;
  queued_at: Date;
  dispatched_at: Date | null;
}

export interface ConversionRow {
  id: ConversionId;
  notification_send_id: NotificationSendId;
  order_external_id: string;
  converted_at: Date;
}

export interface EmailTemplateRow {
  id: EmailTemplateId;
  subject_template: string;
  body_template: string;
  updated_at: Date;
}

export interface AppSettingsRow {
  id: AppSettingsId;
  quiet_hours_start: number;
  quiet_hours_end: number;
  per_restock_notify_cap: number;
  updated_at: Date;
}

export interface WaitlistSnapshotRow {
  product_external_id: string;
  product_title: string;
  active_entry_count: number;
  total_notified_count: number;
  total_conversion_count: number;
  last_updated_at: Date;
}

// ─── Webhook Payload Types ────────────────────────────────────────────────────

/** inventory_levels/update */
export interface InventoryLevelUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number | null;
  updated_at: string;
}

/** products/delete */
export interface ProductDeletePayload {
  id: number;
}

/** orders/paid — line item sub-shape */
export interface OrderLineItem {
  variant_id: number | null;
  product_id: number | null;
  quantity: number;
  title: string;
}

/** orders/paid */
export interface OrderPaidPayload {
  id: number;
  email: string | null;
  processed_at: string;
  line_items: OrderLineItem[];
}

// ─── Shopify GraphQL response shapes ─────────────────────────────────────────

export interface InventoryItemQueryResponse {
  inventoryItem: {
    id: string;
    variant: {
      id: string;
      product: {
        id: string;
      };
    } | null;
  } | null;
}

export interface ProductVariantQueryResponse {
  productVariant: {
    id: string;
    title: string;
    product: {
      id: string;
      title: string;
      handle: string;
      onlineStoreUrl: string | null;
    };
  } | null;
}

/** Storefront product query for availability check */
export interface StorefrontProductQueryResponse {
  product: {
    id: string;
    title: string;
    variants: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          availableForSale: boolean;
        };
      }>;
    };
  } | null;
}

// ─── Widget API Contracts ─────────────────────────────────────────────────────

/** GET /widget/availability */
export interface WidgetAvailabilityRequest {
  product_external_id: string;
  variant_external_id?: string;
}

export interface WidgetAvailabilityResponse {
  available: boolean;
  product_title: string;
  variant_label: string;
}

/** POST /widget/signup */
export interface WidgetSignupPostRequest {
  shopper_email: string;
  product_external_id: string;
  variant_external_id: string | null;
  scope: WaitlistEntryScope;
}

export interface WidgetSignupPostResponse {
  already_registered: boolean;
  message: string;
}

/** GET /widget/signup */
export interface WidgetSignupGetRequest {
  shopper_email: string;
  product_external_id: string;
  variant_external_id?: string;
}

export interface WidgetSignupGetResponse {
  registered: boolean;
}

/** POST /widget/unsubscribe */
export interface WidgetUnsubscribeRequest {
  unsubscribe_token: string;
}

export interface WidgetUnsubscribeResponse {
  success: boolean;
  entries_removed: number;
}

// ─── Admin API Contracts ──────────────────────────────────────────────────────

/** GET /admin/dashboard */
export interface AdminDashboardRequest {
  cursor?: string;
}

export interface AdminDashboardProduct {
  product_external_id: string;
  product_title: string;
  active_entry_count: number;
  total_notified_count: number;
  total_conversion_count: number;
}

export interface AdminDashboardResponse {
  products: AdminDashboardProduct[];
  next_cursor: string | null;
  total_count: number;
}

/** GET /admin/waitlist */
export interface AdminWaitlistRequest {
  product_external_id: string;
  variant_external_id?: string;
  cursor?: string;
}

export interface AdminWaitlistEntry {
  id: string;
  shopper_email: string;
  product_external_id: string;
  variant_external_id: string | null;
  scope: WaitlistEntryScope;
  status: WaitlistEntryStatus;
  signed_up_at: string;
  deleted_at: string | null;
}

export interface AdminWaitlistResponse {
  entries: AdminWaitlistEntry[];
  next_cursor: string | null;
  total_count: number;
}

/** GET /admin/waitlist/export */
export interface AdminWaitlistExportRequest {
  product_external_id: string;
  variant_external_id?: string;
}

export interface AdminWaitlistExportResponse {
  csv_data: string;
}

/** GET /admin/stats */
export interface AdminStatsRequest {
  date_from?: string;
  date_to?: string;
  cursor?: string;
}

export interface AdminStatsResponse {
  total_signups: number;
  total_notified: number;
  total_converted: number;
  next_cursor: string | null;
  total_count: number;
}

/** GET /admin/template */
export interface AdminTemplateGetResponse {
  subject_template: string;
  body_template: string;
  updated_at: string;
}

/** PUT /admin/template */
export interface AdminTemplatePutRequest {
  subject_template: string;
  body_template: string;
}

export interface AdminTemplatePutResponse {
  success: boolean;
  updated_at: string;
}

/** GET /admin/settings */
export interface AdminSettingsGetResponse {
  quiet_hours_start: number;
  quiet_hours_end: number;
  per_restock_notify_cap: number;
  updated_at: string;
}

/** PUT /admin/settings */
export interface AdminSettingsPutRequest {
  quiet_hours_start: number;
  quiet_hours_end: number;
  per_restock_notify_cap: number;
}

export interface AdminSettingsPutResponse {
  success: boolean;
}

// ─── Cron job payload types ───────────────────────────────────────────────────

export interface NotificationSchedulerPayload {
  triggered_at: string;
}

// ─── Notification send with batch + waitlist context (for cron dispatch) ─────

export interface NotificationSendWithContext extends NotificationSendRow {
  batch_product_external_id: string;
  batch_variant_external_id: string | null;
  unsubscribe_token: string;
}
