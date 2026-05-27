// ─── Branded IDs ────────────────────────────────────────────────────────────
export type BundleId = string & { __brand: "BundleId" };
export type BundleItemId = string & { __brand: "BundleItemId" };
export type BundleTierId = string & { __brand: "BundleTierId" };
export type BundlePurchaseRecordId = string & { __brand: "BundlePurchaseRecordId" };
export type BundleHealthEventId = string & { __brand: "BundleHealthEventId" };
/** Shopify numeric variant ID */
export type VariantExternalId = string & { __brand: "VariantExternalId" };
/** Shopify numeric product ID */
export type ProductExternalId = string & { __brand: "ProductExternalId" };
/** Shopify numeric order ID */
export type OrderExternalId = string & { __brand: "OrderExternalId" };

// ─── Enums ───────────────────────────────────────────────────────────────────
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
  variant_external_id: string; // postgres BIGINT comes back as string
  product_external_id: string;
  observed_availability: ObservedAvailability;
  added_at: Date;
}

export interface BundleTierRow {
  id: BundleTierId;
  bundle_id: BundleId;
  minimum_item_count: number;
  discount_rate: number; // stored as integer bps, e.g. 1000 = 10%
  display_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface BundlePurchaseRecordRow {
  id: BundlePurchaseRecordId;
  bundle_id: BundleId;
  order_external_id: string;
  order_placed_at: Date;
  variant_external_ids: string; // JSON-serialized array
  item_count: number;
  discount_rate_applied: number;
  order_total: string; // BIGINT as string
  order_currency: string;
  recorded_at: Date;
}

export interface BundleHealthEventRow {
  id: BundleHealthEventId;
  bundle_id: BundleId;
  event_kind: HealthEventKind;
  affected_variant_external_id: string | null;
  reason: string;
  occurred_at: Date;
}

// ─── Admin HTTP Request/Response Shapes ──────────────────────────────────────

// GET /admin/bundles
export interface ListBundlesRequest {
  status_filter?: string; // "enabled" | "disabled" | "all"
  health_filter?: string;
  cursor?: string;
}
export interface BundleSummary {
  id: BundleId;
  title: string;
  description: string | null;
  mode: BundleMode;
  enabled: boolean;
  health_status: BundleHealthStatus;
  tier_count: number;
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
  status: string;
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
  status: string;
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
}
export interface BundleItemSummary {
  id: BundleItemId;
  bundle_id: BundleId;
  variant_external_id: VariantExternalId;
  product_external_id: ProductExternalId;
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
  variant_external_ids: VariantExternalId[];
  product_external_ids: ProductExternalId[];
}
export interface SaveBundleItemsResponse {
  saved_count: number;
  unavailable_variants: VariantExternalId[];
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
  discount_rate: number; // percentage * 100, e.g. 1000 = 10%
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
}
export interface PurchaseRecordSummary {
  id: BundlePurchaseRecordId;
  bundle_id: BundleId;
  order_external_id: OrderExternalId;
  order_placed_at: string;
  variant_external_ids: VariantExternalId[];
  item_count: number;
  discount_rate_applied: number;
  order_total: number; // minor units
  order_currency: string;
  recorded_at: string;
}
export interface ListPurchaseHistoryResponse {
  records: PurchaseRecordSummary[];
  next_cursor: string | null;
  total_count: number;
}

// ─── Widget HTTP Request/Response Shapes ─────────────────────────────────────

// GET /widget/bundle
export interface GetWidgetBundleRequest {
  bundle_id: BundleId;
  cursor?: string;
}
export interface WidgetTier {
  id: BundleTierId;
  minimum_item_count: number;
  discount_rate: number;
  display_order: number;
}
export interface WidgetItem {
  id: BundleItemId;
  variant_external_id: VariantExternalId;
  product_external_id: ProductExternalId;
  observed_availability: ObservedAvailability;
}
export interface WidgetBundle {
  id: BundleId;
  title: string;
  description: string | null;
  mode: BundleMode;
  enabled: boolean;
  health_status: BundleHealthStatus;
}
export interface GetWidgetBundleResponse {
  bundle: WidgetBundle;
  tiers: WidgetTier[];
  items: WidgetItem[];
  next_cursor: string | null;
  total_count: number;
}

// POST /widget/bundle/validate
export interface ValidateBundleRequest {
  bundle_id: BundleId;
  selected_variant_ids: VariantExternalId[];
}
export interface EarnedTier {
  id: BundleTierId;
  minimum_item_count: number;
  discount_rate: number;
}
export interface ValidateBundleResponse {
  valid: boolean;
  earned_tier: EarnedTier | null;
  discount_rate: number;
  validation_errors: string[];
}

// POST /widget/cart/add
export interface CartAddRequest {
  bundle_id: BundleId;
  selected_variant_ids: VariantExternalId[];
  quantities: number[];
}
export interface CartAddResponse {
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
  title: string;
  quantity: number;
  price: string;
  properties: Array<{ name: string; value: string }>;
  discount_allocations: Array<{ amount: string; discount_application_index: number }>;
}

export interface OrderDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface OrdersPaidPayload {
  id: number;
  created_at: string;
  updated_at: string;
  currency: string;
  total_price: string;
  line_items: OrderLineItem[];
  discount_codes: OrderDiscountCode[];
  note_attributes: Array<{ name: string; value: string }>;
}

export interface InventoryLevelUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number | null;
  updated_at: string;
}

export interface ProductVariantPayload {
  id: number;
  product_id: number;
  title: string;
  inventory_quantity: number;
}

export interface ProductUpdatePayload {
  id: number;
  title: string;
  status: string;
  updated_at: string;
  variants: ProductVariantPayload[];
  variant_gids: Array<{ admin_graphql_api_id: string }>;
}

export interface ProductDeletePayload {
  id: number;
}

// ─── Bundle Health Evaluation ─────────────────────────────────────────────────

export interface BundleHealthEvalResult {
  bundle_id: BundleId;
  new_health_status: BundleHealthStatus;
  should_disable: boolean;
  event_kind: HealthEventKind;
  reason: string;
  affected_variant_external_id: string | null;
}
