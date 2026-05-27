// ─── Branded ID types ───────────────────────────────────────────────────────

export type BundleId = string & { __brand: "BundleId" };
export type BundleItemId = string & { __brand: "BundleItemId" };
export type BundleTierId = string & { __brand: "BundleTierId" };
export type BundlePurchaseRecordId = string & { __brand: "BundlePurchaseRecordId" };
export type BundleHealthEventId = string & { __brand: "BundleHealthEventId" };

// Shopify external IDs are numeric (BIGINT in DB, number in JS)
export type VariantExternalId = number & { __brand: "VariantExternalId" };
export type ProductExternalId = number & { __brand: "ProductExternalId" };
export type OrderExternalId = number & { __brand: "OrderExternalId" };

// ─── Enum / union types ──────────────────────────────────────────────────────

export type BundleMode = "fixed" | "flexible";

export type BundleHealthStatus = "healthy" | "warned" | "auto_disabled";

export type ObservedAvailability = "available" | "out_of_stock" | "deleted";

export type BundleHealthEventKind = "auto_disabled" | "warned" | "cleared";

// ─── DB Row types ────────────────────────────────────────────────────────────

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
  /** discount rate in basis points, e.g. 1000 = 10% */
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
  /** discount rate in basis points */
  discount_rate_applied: number;
  /** order total in minor currency units */
  order_total: number;
  currency_code: string;
  recorded_at: Date;
}

export interface BundleHealthEventRow {
  id: BundleHealthEventId;
  bundle_id: BundleId;
  event_kind: BundleHealthEventKind;
  affected_variant_external_id: number | null;
  reason: string;
  occurred_at: Date;
}

// ─── Admin API request / response types ──────────────────────────────────────

// GET /admin/bundles
export interface ListBundlesRequest {
  status_filter?: "enabled" | "disabled" | "all";
  health_filter?: BundleHealthStatus | "all";
  cursor?: string;
  page_size?: number;
}

export interface BundleSummary {
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

export interface ListBundlesResponse {
  bundles: BundleSummary[];
  next_cursor: string | null;
  total_count: number;
}

// POST /admin/bundles/create
export interface CreateBundleRequest {
  title: string;
  mode: BundleMode;
  description?: string;
}

export interface CreateBundleResponse {
  bundle_id: BundleId;
  status: "created";
}

// PUT /admin/bundles/update
export interface UpdateBundleRequest {
  bundle_id: BundleId;
  title?: string;
  description?: string | null;
  mode?: BundleMode;
  enabled?: boolean;
}

export interface UpdateBundleResponse {
  bundle_id: BundleId;
  updated_at: string;
}

// POST /admin/bundles/remove
export interface RemoveBundleRequest {
  bundle_id: BundleId;
}

export interface RemoveBundleResponse {
  success: boolean;
}

// POST /admin/bundles/clone
export interface CloneBundleRequest {
  source_bundle_id: BundleId;
}

export interface CloneBundleResponse {
  new_bundle_id: BundleId;
  status: "created";
}

// POST /admin/bundles/bulk-status
export interface BulkSetStatusRequest {
  bundle_ids: BundleId[];
  enabled: boolean;
}

export interface BulkSetStatusResponse {
  updated_count: number;
  skipped_count: number;
}

// GET /admin/bundles/items
export interface ListBundleItemsRequest {
  bundle_id: BundleId;
  cursor?: string;
  page_size?: number;
}

export interface BundleItemSummary {
  id: BundleItemId;
  bundle_id: BundleId;
  variant_external_id: number;
  product_external_id: number;
  observed_availability: ObservedAvailability;
  added_at: string;
}

export interface ListBundleItemsResponse {
  items: BundleItemSummary[];
  next_cursor: string | null;
  total_count: number;
}

// POST /admin/bundles/items/save
export interface SaveBundleItemsRequest {
  bundle_id: BundleId;
  /** Array of [variantId, productId] pairs */
  variant_product_pairs: Array<{ variant_external_id: number; product_external_id: number }>;
}

export interface SaveBundleItemsResponse {
  saved_count: number;
  unavailable_variants: number[];
}

// GET /admin/bundles/tiers
export interface ListBundleTiersRequest {
  bundle_id: BundleId;
  cursor?: string;
}

export interface BundleTierSummary {
  id: BundleTierId;
  bundle_id: BundleId;
  minimum_item_count: number;
  /** basis points */
  discount_rate: number;
  display_order: number;
}

export interface ListBundleTiersResponse {
  tiers: BundleTierSummary[];
  next_cursor: string | null;
  total_count: number;
}

// POST /admin/bundles/tiers/save
export interface TierInput {
  minimum_item_count: number;
  /** basis points e.g. 1000 = 10% */
  discount_rate: number;
}

export interface SaveBundleTiersRequest {
  bundle_id: BundleId;
  tiers: TierInput[];
}

export interface SaveBundleTiersResponse {
  saved_count: number;
}

// GET /admin/purchase-history
export interface ListPurchaseHistoryRequest {
  bundle_id?: BundleId;
  date_from?: string;
  date_to?: string;
  cursor?: string;
  page_size?: number;
}

export interface PurchaseRecordSummary {
  id: BundlePurchaseRecordId;
  bundle_id: BundleId;
  order_external_id: number;
  order_placed_at: string;
  variant_external_ids: number[];
  item_count: number;
  /** basis points */
  discount_rate_applied: number;
  /** minor currency units */
  order_total: number;
  currency_code: string;
  recorded_at: string;
}

export interface ListPurchaseHistoryResponse {
  records: PurchaseRecordSummary[];
  next_cursor: string | null;
  total_count: number;
}

// ─── Widget API request / response types ─────────────────────────────────────

// GET /widget/bundle
export interface GetWidgetBundleRequest {
  bundle_id: BundleId;
  cursor?: string;
}

export interface WidgetBundleInfo {
  id: BundleId;
  title: string;
  description: string | null;
  mode: BundleMode;
  enabled: boolean;
  health_status: BundleHealthStatus;
}

export interface WidgetTierInfo {
  id: BundleTierId;
  minimum_item_count: number;
  /** basis points */
  discount_rate: number;
  display_order: number;
}

export interface WidgetItemInfo {
  id: BundleItemId;
  variant_external_id: number;
  product_external_id: number;
  observed_availability: ObservedAvailability;
}

export interface GetWidgetBundleResponse {
  bundle: WidgetBundleInfo;
  tiers: WidgetTierInfo[];
  items: WidgetItemInfo[];
  next_cursor: string | null;
  total_count: number;
}

// POST /widget/bundle/validate
export interface ValidateBundleSelectionRequest {
  bundle_id: BundleId;
  selected_variant_ids: number[];
}

export interface EarnedTierInfo {
  id: BundleTierId;
  minimum_item_count: number;
  /** basis points */
  discount_rate: number;
}

export interface ValidateBundleSelectionResponse {
  valid: boolean;
  earned_tier: EarnedTierInfo | null;
  /** basis points */
  discount_rate: number;
  validation_errors: string[];
}

// POST /widget/cart/add
export interface AddBundleToCartRequest {
  bundle_id: BundleId;
  selected_variant_ids: number[];
  quantities: number[];
}

export interface AddBundleToCartResponse {
  success: boolean;
  cart_external_id: string | null;
  /** basis points */
  applied_discount_rate: number;
  errors: string[];
}

// ─── Webhook payload types ───────────────────────────────────────────────────

export interface OrderLineItem {
  variant_id: number | null;
  product_id: number | null;
  quantity: number;
  name: string;
  price: string;
  properties: Array<{ name: string; value: string }>;
}

export interface OrderDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface OrdersPaidPayload {
  id: number;
  admin_graphql_api_id: string;
  created_at: string;
  processed_at: string;
  currency: string;
  total_price: string;
  current_total_price: string;
  line_items: OrderLineItem[];
  discount_codes: OrderDiscountCode[];
  name: string;
}

export interface VariantStockPayload {
  id: number;
  product_id: number;
  inventory_quantity: number;
  admin_graphql_api_id: string;
}

export interface ProductDeletePayload {
  id: number;
}

// ─── Internal computation types ──────────────────────────────────────────────

export interface BundleHealthResult {
  health_status: BundleHealthStatus;
  event_kind: BundleHealthEventKind | null;
  reason: string | null;
  should_disable: boolean;
}

export interface VariantAvailabilityMap {
  [variantId: number]: boolean;
}

// Job payload types (for any future cron jobs)
export interface GenericJobPayload {
  [key: string]: unknown;
}
