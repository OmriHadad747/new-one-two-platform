// ─── Branded IDs ────────────────────────────────────────────────────────────

export type BundleId = string & { __brand: "BundleId" };
export type BundleItemId = string & { __brand: "BundleItemId" };
export type BundleTierId = string & { __brand: "BundleTierId" };
export type BundlePurchaseRecordId = string & { __brand: "BundlePurchaseRecordId" };
export type BundleHealthEventId = string & { __brand: "BundleHealthEventId" };

// ─── Domain Enums ────────────────────────────────────────────────────────────

export type BundleMode = "fixed" | "flexible";

export type BundleHealthStatus = "healthy" | "warned" | "auto_disabled";

export type ObservedAvailability = "available" | "out_of_stock" | "deleted";

export type HealthEventKind = "auto_disabled" | "warned" | "cleared";

// ─── DB Row Types ─────────────────────────────────────────────────────────────
// These match database.tables[].columns one-to-one.

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
  variant_external_id: bigint;
  product_external_id: bigint;
  observed_availability: ObservedAvailability;
  added_at: Date;
}

export interface BundleTierRow {
  id: BundleTierId;
  bundle_id: BundleId;
  minimum_item_count: number;
  discount_rate: number;   // integer percentage, e.g. 10 = 10%
  display_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface BundlePurchaseRecordRow {
  id: BundlePurchaseRecordId;
  bundle_id: BundleId;
  order_external_id: bigint;
  order_placed_at: Date;
  variant_external_ids: string;  // JSON-serialized array
  item_count: number;
  discount_rate_applied: number; // integer percentage
  order_total: bigint;           // minor currency units
  order_currency: string;
  recorded_at: Date;
}

export interface BundleHealthEventRow {
  id: BundleHealthEventId;
  bundle_id: BundleId;
  event_kind: HealthEventKind;
  affected_variant_external_id: bigint | null;
  reason: string;
  occurred_at: Date;
}

// ─── Admin HTTP Route Contracts ───────────────────────────────────────────────

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
  description?: string;
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
export interface BulkSetBundleStatusRequest {
  bundle_ids: BundleId[];
  enabled: boolean;
}

export interface BulkSetBundleStatusResponse {
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
  variant_external_id: string;   // string for JSON serialization (bigint-safe)
  product_external_id: string;
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
  variant_external_ids: string[];   // Shopify variant IDs as strings
  product_external_ids: string[];   // parallel array of parent product IDs
}

export interface SaveBundleItemsResponse {
  saved_count: number;
  unavailable_variants: string[];
}

// GET /admin/bundles/tiers
export interface ListBundleTiersRequest {
  bundle_id: BundleId;
  cursor?: string;
  page_size?: number;
}

export interface BundleTierSummary {
  id: BundleTierId;
  bundle_id: BundleId;
  minimum_item_count: number;
  discount_rate: number;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface ListBundleTiersResponse {
  tiers: BundleTierSummary[];
  next_cursor: string | null;
  total_count: number;
}

// POST /admin/bundles/tiers/save
export interface TierInput {
  minimum_item_count: number;
  discount_rate: number;  // integer percentage
}

export interface SaveBundleTiersRequest {
  bundle_id: BundleId;
  tiers: TierInput[];  // caller-supplied order becomes display_order
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
  order_external_id: string;
  order_placed_at: string;
  variant_external_ids: string[];
  item_count: number;
  discount_rate_applied: number;
  order_total: string;     // decimal string for display
  order_currency: string;
  recorded_at: string;
}

export interface ListPurchaseHistoryResponse {
  records: PurchaseRecordSummary[];
  next_cursor: string | null;
  total_count: number;
}

// ─── Widget HTTP Route Contracts ──────────────────────────────────────────────

// GET /widget/bundle
export interface GetBundleForWidgetRequest {
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

export interface GetBundleForWidgetResponse {
  bundle: WidgetBundleDetail;
  tiers: BundleTierSummary[];
  items: BundleItemSummary[];
  next_cursor: string | null;
  total_count: number;
}

// POST /widget/bundle/validate
export interface ValidateBundleSelectionRequest {
  bundle_id: BundleId;
  selected_variant_ids: string[];
}

export interface EarnedTier {
  id: BundleTierId;
  minimum_item_count: number;
  discount_rate: number;
  display_order: number;
}

export interface ValidateBundleSelectionResponse {
  valid: boolean;
  earned_tier: EarnedTier | null;
  discount_rate: number;
  validation_errors: string[];
}

// POST /widget/cart/add
export interface CartAddLineItem {
  variant_id: string;
  quantity: number;
}

export interface AddBundleToCartRequest {
  bundle_id: BundleId;
  selected_variant_ids: string[];
  quantities: number[];
}

export interface AddBundleToCartResponse {
  success: boolean;
  cart_external_id: string | null;
  applied_discount_rate: number;
  errors: string[];
}

// ─── Webhook Payload Narrowings ───────────────────────────────────────────────

// orders/paid
export interface OrderPaidLineItem {
  id: number;
  variant_id: number | null;
  product_id: number | null;
  quantity: number;
  price: string;
  name: string;
  properties: Array<{ name: string; value: string }>;
}

export interface OrderPaidDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface OrderPaidPayload {
  id: number;
  created_at: string;
  currency: string;
  total_price: string;
  total_price_set: {
    shop_money: { amount: string; currency_code: string };
    presentment_money: { amount: string; currency_code: string };
  };
  line_items: OrderPaidLineItem[];
  discount_codes: OrderPaidDiscountCode[];
  financial_status: string;
  processed_at: string;
}

// inventory_levels/update
export interface InventoryLevelUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number | null;
  updated_at: string;
  admin_graphql_api_id: string;
}

// products/delete
export interface ProductDeletePayload {
  id: number;
}

// ─── Internal Helper Types ────────────────────────────────────────────────────

// Result of bundle health evaluation
export interface BundleHealthEvaluationResult {
  bundle_id: BundleId;
  new_health_status: BundleHealthStatus;
  should_disable: boolean;
  event_kind: HealthEventKind;
  reason: string;
}

// Storefront variant availability response (from Shopify Ajax)
export interface StorefrontVariantAvailability {
  variant_id: string;
  available: boolean;
}
