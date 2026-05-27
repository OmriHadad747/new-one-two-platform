// ─── Branded IDs ─────────────────────────────────────────────────────────────

export type BundleId = string & { __brand: "BundleId" };
export type BundleItemId = string & { __brand: "BundleItemId" };
export type BundleTierId = string & { __brand: "BundleTierId" };
export type BundlePurchaseRecordId = string & { __brand: "BundlePurchaseRecordId" };
export type BundleHealthEventId = string & { __brand: "BundleHealthEventId" };

// Shopify external IDs are numeric; stored as BIGINT, transported as number
export type VariantExternalId = number & { __brand: "VariantExternalId" };
export type ProductExternalId = number & { __brand: "ProductExternalId" };
export type OrderExternalId = number & { __brand: "OrderExternalId" };

// ─── Enums / Status Unions ────────────────────────────────────────────────────

export type BundleMode = "fixed" | "flexible";

export type BundleHealthStatus = "healthy" | "warned" | "auto_disabled";

export type ObservedAvailability = "available" | "out_of_stock" | "deleted";

export type HealthEventKind = "auto_disabled" | "warned" | "cleared";

// ─── DB Row Types ─────────────────────────────────────────────────────────────

export interface BundleRow {
  id: BundleId;
  title: string;
  description: string | null;
  mode: BundleMode;
  enabled: boolean;
  health_status: BundleHealthStatus;
  created_at: Date;
  updated_at: Date;
}

export interface BundleItemRow {
  id: BundleItemId;
  bundle_id: BundleId;
  variant_external_id: number;
  product_external_id: number;
  observed_availability: ObservedAvailability;
  added_at: Date;
}

export interface BundleTierRow {
  id: BundleTierId;
  bundle_id: BundleId;
  minimum_item_count: number;
  /** discount in basis points, e.g. 1000 = 10% */
  discount_rate: number;
  display_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface BundlePurchaseRecordRow {
  id: BundlePurchaseRecordId;
  bundle_id: BundleId;
  order_external_id: number;
  order_placed_at: Date;
  /** JSON-serialized array of variant IDs */
  variant_external_ids: string;
  item_count: number;
  /** basis points */
  discount_rate_applied: number;
  /** order total in minor units */
  order_total: number;
  order_currency: string;
  recorded_at: Date;
}

export interface BundleHealthEventRow {
  id: BundleHealthEventId;
  bundle_id: BundleId;
  event_kind: HealthEventKind;
  affected_variant_external_id: number | null;
  reason: string;
  occurred_at: Date;
}

// ─── Admin API: Request / Response shapes ────────────────────────────────────

// GET /admin/bundles
export interface AdminListBundlesRequest {
  status_filter?: "enabled" | "disabled" | "all";
  health_filter?: BundleHealthStatus | "all";
  cursor?: string;
  page_size?: number;
}

export interface AdminBundleSummary {
  id: BundleId;
  title: string;
  description: string | null;
  mode: BundleMode;
  enabled: boolean;
  health_status: BundleHealthStatus;
  tier_count: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface AdminListBundlesResponse {
  bundles: AdminBundleSummary[];
  next_cursor: string | null;
  total_count: number;
}

// POST /admin/bundles/create
export interface AdminCreateBundleRequest {
  title: string;
  mode: BundleMode;
  description?: string;
}

export interface AdminCreateBundleResponse {
  bundle_id: BundleId;
  status: "created";
}

// PUT /admin/bundles/update
export interface AdminUpdateBundleRequest {
  bundle_id: BundleId;
  title?: string;
  description?: string | null;
  mode?: BundleMode;
  enabled?: boolean;
}

export interface AdminUpdateBundleResponse {
  bundle_id: BundleId;
  updated_at: string;
}

// POST /admin/bundles/remove
export interface AdminRemoveBundleRequest {
  bundle_id: BundleId;
}

export interface AdminRemoveBundleResponse {
  success: boolean;
}

// POST /admin/bundles/clone
export interface AdminCloneBundleRequest {
  source_bundle_id: BundleId;
}

export interface AdminCloneBundleResponse {
  new_bundle_id: BundleId;
  status: "created";
}

// POST /admin/bundles/bulk-status
export interface AdminBulkStatusRequest {
  bundle_ids: BundleId[];
  enabled: boolean;
}

export interface AdminBulkStatusResponse {
  updated_count: number;
  skipped_count: number;
}

// GET /admin/bundles/items
export interface AdminListBundleItemsRequest {
  bundle_id: BundleId;
  cursor?: string;
  page_size?: number;
}

export interface AdminBundleItemSummary {
  id: BundleItemId;
  bundle_id: BundleId;
  variant_external_id: number;
  product_external_id: number;
  observed_availability: ObservedAvailability;
  added_at: string;
}

export interface AdminListBundleItemsResponse {
  items: AdminBundleItemSummary[];
  next_cursor: string | null;
  total_count: number;
}

// POST /admin/bundles/items/save
export interface AdminSaveBundleItemsRequest {
  bundle_id: BundleId;
  variant_items: Array<{ variant_external_id: number; product_external_id: number }>;
}

export interface AdminSaveBundleItemsResponse {
  saved_count: number;
  unavailable_variants: number[];
}

// GET /admin/bundles/tiers
export interface AdminListBundleTiersRequest {
  bundle_id: BundleId;
  cursor?: string;
}

export interface AdminBundleTierSummary {
  id: BundleTierId;
  bundle_id: BundleId;
  minimum_item_count: number;
  discount_rate: number;
  display_order: number;
}

export interface AdminListBundleTiersResponse {
  tiers: AdminBundleTierSummary[];
  next_cursor: string | null;
  total_count: number;
}

// POST /admin/bundles/tiers/save
export interface TierInput {
  minimum_item_count: number;
  /** discount in basis points */
  discount_rate: number;
}

export interface AdminSaveBundleTiersRequest {
  bundle_id: BundleId;
  /** Caller supplies them in display order; array index determines display_order */
  tiers: TierInput[];
}

export interface AdminSaveBundleTiersResponse {
  saved_count: number;
}

// GET /admin/purchase-history
export interface AdminPurchaseHistoryRequest {
  bundle_id?: BundleId;
  date_from?: string;
  date_to?: string;
  cursor?: string;
  page_size?: number;
}

export interface AdminPurchaseRecordSummary {
  id: BundlePurchaseRecordId;
  bundle_id: BundleId;
  order_external_id: number;
  order_placed_at: string;
  variant_external_ids: number[];
  item_count: number;
  discount_rate_applied: number;
  order_total: number;
  order_currency: string;
  recorded_at: string;
}

export interface AdminPurchaseHistoryResponse {
  records: AdminPurchaseRecordSummary[];
  next_cursor: string | null;
  total_count: number;
}

// ─── Widget API: Request / Response shapes ────────────────────────────────────

// GET /widget/bundle
export interface WidgetGetBundleRequest {
  bundle_id: BundleId;
  cursor?: string;
}

export interface WidgetBundleDetail {
  id: BundleId;
  title: string;
  description: string | null;
  mode: BundleMode;
  enabled: boolean;
  health_status: BundleHealthStatus;
}

export interface WidgetTierDetail {
  id: BundleTierId;
  minimum_item_count: number;
  /** basis points, e.g. 1000 = 10% */
  discount_rate: number;
  display_order: number;
}

export interface WidgetItemDetail {
  id: BundleItemId;
  variant_external_id: number;
  product_external_id: number;
  observed_availability: ObservedAvailability;
}

export interface WidgetGetBundleResponse {
  bundle: WidgetBundleDetail;
  tiers: WidgetTierDetail[];
  items: WidgetItemDetail[];
  next_cursor: string | null;
  total_count: number;
}

// POST /widget/bundle/validate
export interface WidgetValidateBundleRequest {
  bundle_id: BundleId;
  selected_variant_ids: number[];
}

export interface WidgetEarnedTier {
  id: BundleTierId;
  minimum_item_count: number;
  discount_rate: number;
  display_order: number;
}

export interface WidgetValidateBundleResponse {
  valid: boolean;
  earned_tier: WidgetEarnedTier | null;
  discount_rate: number;
  validation_errors: string[];
}

// POST /widget/cart/add
export interface CartVariantQuantity {
  variant_id: number;
  quantity: number;
}

export interface WidgetCartAddRequest {
  bundle_id: BundleId;
  selected_variant_ids: number[];
  quantities: CartVariantQuantity[];
}

export interface WidgetCartAddResponse {
  success: boolean;
  cart_external_id: string | null;
  applied_discount_rate: number;
  errors: string[];
}

// ─── Webhook Payload Types ────────────────────────────────────────────────────

export interface OrderLineItem {
  id: number;
  variant_id: number | null;
  product_id: number | null;
  quantity: number;
  price: string;
}

export interface OrderDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface OrdersPaidPayload {
  id: number;
  created_at: string;
  currency: string;
  total_price: string;
  line_items: OrderLineItem[];
  discount_codes: OrderDiscountCode[];
}

export interface VariantStockPayload {
  id: number;
  product_id: number;
  inventory_quantity: number;
}

export interface ProductDeletePayload {
  id: number;
}

// ─── Internal computation types ───────────────────────────────────────────────

export interface BundleHealthCheckResult {
  bundle_id: BundleId;
  new_health_status: BundleHealthStatus;
  should_auto_disable: boolean;
  event_kind: HealthEventKind;
  reason: string;
}

export interface EarnedTierResult {
  tier: BundleTierRow | null;
  discount_rate: number;
}
