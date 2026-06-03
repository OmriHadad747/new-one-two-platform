// ─── Branded ID types ────────────────────────────────────────────────────────
export type WaitlistSignupId = string & { __brand: "WaitlistSignupId" };
export type NotificationRunId = string & { __brand: "NotificationRunId" };
export type NotificationSendId = string & { __brand: "NotificationSendId" };
export type ConversionEventId = string & { __brand: "ConversionEventId" };
export type EmailTemplateId = string & { __brand: "EmailTemplateId" };
export type AppSettingsId = string & { __brand: "AppSettingsId" };
export type DemandSnapshotId = string & { __brand: "DemandSnapshotId" };
export type VariantAvailabilityId = string & { __brand: "VariantAvailabilityId" };

// Shopify numeric IDs stored as BIGINT come back from postgres as strings
export type VariantExternalId = string & { __brand: "VariantExternalId" };
export type ProductExternalId = string & { __brand: "ProductExternalId" };
export type OrderExternalId = string & { __brand: "OrderExternalId" };

// ─── DB Row Types ─────────────────────────────────────────────────────────────

export type WaitlistSignupStatus = "active" | "notified" | "unsubscribed" | "purged";

export interface WaitlistSignupRow {
  id: WaitlistSignupId;
  shopper_email: string;
  variant_external_id: VariantExternalId;
  product_external_id: ProductExternalId;
  product_title: string;
  variant_title: string;
  product_url: string;
  unsubscribe_token: string;
  status: WaitlistSignupStatus;
  signed_up_at: string;
  deleted_at: string | null;
}

export type VariantAvailabilityState = "out_of_stock" | "available";

export interface VariantAvailabilityRow {
  id: VariantAvailabilityId;
  variant_external_id: VariantExternalId;
  product_external_id: ProductExternalId;
  availability_state: VariantAvailabilityState;
  last_out_of_stock_at: string | null;
  last_available_at: string | null;
}

export type NotificationRunStatus = "open" | "completed" | "cancelled";

export interface NotificationRunRow {
  id: NotificationRunId;
  variant_external_id: VariantExternalId;
  product_external_id: ProductExternalId;
  product_title: string;
  variant_title: string;
  status: NotificationRunStatus;
  available_units: number;
  sends_enqueued: number;
  sends_dispatched: number;
  sends_failed: number;
  conversions: number;
  created_at: string;
}

export type NotificationSendStatus = "enqueued" | "dispatched" | "failed" | "held_quiet_hours";

export interface NotificationSendRow {
  id: NotificationSendId;
  run_id: NotificationRunId;
  signup_id: WaitlistSignupId;
  shopper_email: string;
  variant_external_id: VariantExternalId;
  status: NotificationSendStatus;
  enqueued_at: string;
  dispatched_at: string | null;
  failure_reason: string | null;
  converted: boolean;
}

export interface ConversionEventRow {
  id: ConversionEventId;
  order_external_id: OrderExternalId;
  send_id: NotificationSendId;
  shopper_email: string;
  variant_external_id: VariantExternalId;
  converted_at: string;
}

export interface EmailTemplateRow {
  id: EmailTemplateId;
  subject_template: string;
  body_template: string;
  updated_at: string;
}

export interface AppSettingsRow {
  id: AppSettingsId;
  quiet_hours_start: number;
  quiet_hours_end: number;
  batch_size: number;
  updated_at: string;
}

export interface DemandSnapshotRow {
  id: DemandSnapshotId;
  variant_external_id: VariantExternalId;
  product_external_id: ProductExternalId;
  product_title: string;
  variant_title: string;
  active_signup_count: number;
  total_notified: number;
  total_converted: number;
  last_restock_at: string | null;
  snapshot_updated_at: string;
}

// ─── Webhook Payload Types ────────────────────────────────────────────────────

export interface VariantInStockPayload {
  id: number;
  product_id: number;
  title: string;
  inventory_quantity: number;
  admin_graphql_api_id: string;
  created_at: string;
  updated_at: string;
  price: string;
  option1: string;
  option2: string | null;
  option3: string | null;
  position: number;
  inventory_policy: string;
  taxable: boolean;
  old_inventory_quantity: number;
}

export interface VariantOutOfStockPayload {
  id: number;
  product_id: number;
  title: string;
  inventory_quantity: number;
  admin_graphql_api_id: string;
  created_at: string;
  updated_at: string;
  price: string;
  option1: string;
  option2: string | null;
  option3: string | null;
  position: number;
  inventory_policy: string;
  taxable: boolean;
  old_inventory_quantity: number;
}

export interface ProductDeletePayload {
  id: number;
}

export interface OrderPaidLineItem {
  id: number;
  variant_id: number | null;
  product_id: number | null;
  title: string;
  quantity: number;
  price: string;
}

export interface OrderPaidPayload {
  id: number;
  email: string;
  line_items: OrderPaidLineItem[];
  created_at: string;
  updated_at: string;
  financial_status: string;
}

// ─── Widget Route Contracts ───────────────────────────────────────────────────

export interface WidgetStatusRequest {
  variant_external_id: string;
  product_external_id: string;
  email?: string;
}

export interface WidgetStatusResponse {
  is_out_of_stock: boolean;
  already_signed_up: boolean;
  variant_title: string;
}

export interface WidgetSignupRequest {
  shopper_email: string;
  variant_external_id: string;
  product_external_id: string;
}

export interface WidgetSignupResponse {
  success: boolean;
  message: string;
}

export interface WidgetUnsubscribeRequest {
  unsubscribe_token: string;
}

export interface WidgetUnsubscribeResponse {
  success: boolean;
}

// ─── Admin Route Contracts ────────────────────────────────────────────────────

// GET /admin/dashboard
export interface AdminDashboardRequest {
  cursor?: string;
}

export interface AdminDashboardItem {
  variant_external_id: VariantExternalId;
  product_external_id: ProductExternalId;
  product_title: string;
  variant_title: string;
  active_signup_count: number;
  total_notified: number;
  total_converted: number;
  last_restock_at: string | null;
}

export interface AdminDashboardResponse {
  items: AdminDashboardItem[];
  next_cursor: string | null;
  total_count: number;
}

// GET /admin/variants/subscribers
export interface AdminVariantSubscribersRequest {
  variant_external_id: string;
  cursor?: string;
}

export interface AdminSubscriberItem {
  id: WaitlistSignupId;
  shopper_email: string;
  variant_title: string;
  status: WaitlistSignupStatus;
  signed_up_at: string;
}

export interface AdminVariantSubscribersResponse {
  subscribers: AdminSubscriberItem[];
  next_cursor: string | null;
  total_count: number;
}

// GET /admin/variants/subscribers/export
export interface AdminSubscribersExportRequest {
  variant_external_id: string;
}

export interface AdminSubscribersExportResponse {
  csv_content: string;
}

// GET /admin/runs
export interface AdminRunsRequest {
  cursor?: string;
}

export interface AdminRunItem {
  id: NotificationRunId;
  variant_external_id: VariantExternalId;
  product_external_id: ProductExternalId;
  product_title: string;
  variant_title: string;
  status: NotificationRunStatus;
  available_units: number;
  sends_enqueued: number;
  sends_dispatched: number;
  sends_failed: number;
  conversions: number;
  created_at: string;
}

export interface AdminRunsResponse {
  runs: AdminRunItem[];
  next_cursor: string | null;
  total_count: number;
}

// GET /admin/email-template
export interface AdminEmailTemplateResponse {
  subject_template: string;
  body_template: string;
  updated_at: string;
}

// PUT /admin/email-template
export interface AdminEmailTemplateSaveRequest {
  subject_template: string;
  body_template: string;
}

export interface AdminEmailTemplateSaveResponse {
  success: boolean;
  updated_at: string;
}

// GET /admin/settings
export interface AdminSettingsResponse {
  quiet_hours_start: number;
  quiet_hours_end: number;
  batch_size: number;
  updated_at: string;
}

// PUT /admin/settings
export interface AdminSettingsSaveRequest {
  quiet_hours_start: number;
  quiet_hours_end: number;
  batch_size: number;
}

export interface AdminSettingsSaveResponse {
  success: boolean;
  updated_at: string;
}

// ─── Cron Job Payload Types ───────────────────────────────────────────────────

export interface DeliverNotificationsPayload {
  triggered_at: string;
}
