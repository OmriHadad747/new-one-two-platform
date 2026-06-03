// ============================================================
// Branded ID types
// ============================================================

export type WaitlistEntryId = string & { __brand: "WaitlistEntryId" };
export type RestockEventId = string & { __brand: "RestockEventId" };
export type ConversionRecordId = string & { __brand: "ConversionRecordId" };
export type NotificationSettingsId = string & { __brand: "NotificationSettingsId" };

/** Shopify external numeric ids stored as bigint — represented as number in TS */
export type ItemExternalId = number & { __brand: "ItemExternalId" };
export type ProductExternalId = number & { __brand: "ProductExternalId" };
export type OrderExternalId = number & { __brand: "OrderExternalId" };
export type InventoryItemExternalId = number & { __brand: "InventoryItemExternalId" };

// ============================================================
// Enums / discriminated unions
// ============================================================

export type ItemScope = "variant" | "product";
export type WaitlistStatus = "active" | "notified" | "converted" | "unsubscribed" | "purged";
export type RestockEventStatus = "open" | "dispatching" | "completed";

// ============================================================
// DB Row types — mirror database.tables[].columns one-to-one
// ============================================================

export interface WaitlistEntryRow {
  id: WaitlistEntryId;
  email: string;
  item_external_id: ItemExternalId;
  item_scope: ItemScope;
  product_external_id: ProductExternalId;
  queue_position: number;
  status: WaitlistStatus;
  unsubscribe_token: string;
  restock_event_id: RestockEventId | null;
  notified_at: Date | null;
  converted_at: Date | null;
  created_at: Date;
}

export interface RestockEventRow {
  id: RestockEventId;
  item_external_id: ItemExternalId;
  item_scope: ItemScope;
  inventory_item_external_id: InventoryItemExternalId;
  available_quantity: number;
  notification_budget: number;
  notified_count: number;
  status: RestockEventStatus;
  detected_at: Date;
}

export interface ConversionRecordRow {
  id: ConversionRecordId;
  waitlist_entry_id: WaitlistEntryId;
  order_external_id: OrderExternalId;
  item_external_id: ItemExternalId;
  converted_at: Date;
}

export interface NotificationSettingsRow {
  id: NotificationSettingsId;
  template_subject: string;
  template_body: string;
  quiet_hours_start: number;
  quiet_hours_end: number;
  updated_at: Date;
}

// ============================================================
// Webhook payload narrowings
// ============================================================

/** inventory_levels/update */
export interface InventoryLevelUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number;
}

/** products/delete */
export interface ProductDeletePayload {
  id: number;
}

/** orders/paid — line_items is an array */
export interface OrderLineItem {
  variant_id: number | null;
}

export interface OrderPaidPayload {
  id: number;
  email: string | null;
  line_items: OrderLineItem[];
}

// ============================================================
// Widget route contracts
// ============================================================

// GET /widget/availability
export interface WidgetAvailabilityRequest {
  item_external_id: string; // query string — parsed to number in handler
  item_scope: ItemScope;
}

export interface WidgetAvailabilityResponse {
  sold_out: boolean;
  item_title: string;
  item_scope: ItemScope;
}

// GET /widget/signup
export interface WidgetSignupCheckRequest {
  email: string;
  item_external_id: string;
  item_scope: ItemScope;
}

export interface WidgetSignupCheckResponse {
  already_signed_up: boolean;
  queue_position: number | null;
}

// POST /widget/signup
export interface WidgetSignupRequest {
  email: string;
  item_external_id: number;
  item_scope: ItemScope;
  product_external_id: number;
}

export interface WidgetSignupResponse {
  success: boolean;
  queue_position: number;
  already_existed: boolean;
}

// POST /widget/unsubscribe
export interface WidgetUnsubscribeRequest {
  unsubscribe_token: string;
}

export interface WidgetUnsubscribeResponse {
  success: boolean;
  removed_count: number;
}

// ============================================================
// Admin route contracts
// ============================================================

// GET /admin/dashboard
export interface AdminDashboardRequest {
  cursor?: string;
}

export interface DashboardItem {
  item_external_id: number;
  item_scope: ItemScope;
  product_external_id: number;
  active_count: number;
  total_count: number;
  notified_count: number;
  converted_count: number;
}

export interface AdminDashboardResponse {
  items: DashboardItem[];
  next_cursor: string | null;
  total_count: number;
}

// GET /admin/waitlist
export interface AdminWaitlistRequest {
  item_external_id: string;
  item_scope: ItemScope;
  status_filter?: WaitlistStatus;
  cursor?: string;
}

export interface AdminWaitlistResponse {
  entries: WaitlistEntryRow[];
  next_cursor: string | null;
  total_count: number;
}

// GET /admin/waitlist/export
export interface AdminWaitlistExportRequest {
  item_external_id: string;
  item_scope: ItemScope;
}

export interface AdminWaitlistExportResponse {
  csv_data: string;
}

// GET /admin/settings
export interface AdminSettingsResponse {
  settings: NotificationSettingsRow | null;
}

// PUT /admin/settings
export interface AdminSettingsSaveRequest {
  template_subject: string;
  template_body: string;
  quiet_hours_start: number;
  quiet_hours_end: number;
}

export interface AdminSettingsSaveResponse {
  success: boolean;
}

// GET /admin/stats
export interface AdminStatsRequest {
  cursor?: string;
}

export interface AdminStatsResponse {
  total_signups: number;
  total_notified: number;
  total_converted: number;
  conversion_rate: number;
  next_cursor: string | null;
  total_count: number;
}

// ============================================================
// Storefront Shopify query shapes (used internally by widget route)
// ============================================================

export interface StorefrontProductVariant {
  id: string;
  title: string;
  availableForSale: boolean;
}

export interface StorefrontProduct {
  id: string;
  title: string;
  availableForSale: boolean;
  variants: {
    edges: Array<{
      node: StorefrontProductVariant;
    }>;
  };
}
