// ─── Branded IDs ────────────────────────────────────────────────────────────

export type BundleId = string & { __brand: "BundleId" };
export type BundleItemId = string & { __brand: "BundleItemId" };
export type BundleTierId = string & { __brand: "BundleTierId" };
export type BundlePurchaseRecordId = string & { __brand: "BundlePurchaseRecordId" };
export type BundleHealthEventId = string & { __brand: "BundleHealthEventId" };

// Shopify external IDs stored as BIGINT, carried as number in TS
export type VariantExternalId = number & { __brand: "VariantExternalId" };
export type ProductExternalId = number & { __brand: "ProductExternalId" };
export type OrderExternalId = number & { __brand: "OrderExternalId" };
export type InventoryItemId = number & { __brand: "InventoryItemId" };

// ─── Enums / Vocabulary ──────────────────────────────────────────────────────

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
  variant_external_id: VariantExternalId;
  product_external_id: ProductExternalId;
  observed_availability: ObservedAvailability;
  added_at: Date;
}

export interface BundleTierRow {
  id: BundleTierId;
  bundle_id: BundleId;
  minimum_item_count: number;
  /** discount rate in basis points (e.g. 1000 = 10%) */
  discount_rate: number;
  display_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface BundlePurchaseRecordRow {
  id: BundlePurchaseRecordId;
  bundle_id: BundleId;
  order_external_id: OrderExternalId;
  order_placed_at: Date;
  variant_external_ids: VariantExternalId[];
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
  event_kind: HealthEventKind;
  affected_variant_external_id: VariantExternalId | null;
  reason: string;
  occurred_at: Date;
}

// ─── Admin Route: List Bundles ────────────────────────────────────────────────

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

// ─── Admin Route: Create Bundle ───────────────────────────────────────────────

export interface CreateBundleRequest {
  title: string;
  mode: BundleMode;
  description?: string;
}

export interface CreateBundleResponse {
  bundle_id: BundleId;
  status: "created";
}

// ─── Admin Route: Update Bundle ───────────────────────────────────────────────

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

// ─── Admin Route: Remove Bundle ───────────────────────────────────────────────

export interface RemoveBundleRequest {
  bundle_id: BundleId;
}

export interface RemoveBundleResponse {
  success: boolean;
}

// ─── Admin Route: Clone Bundle ────────────────────────────────────────────────

export interface CloneBundleRequest {
  source_bundle_id: BundleId;
}

export interface CloneBundleResponse {
  new_bundle_id: BundleId;
  status: "created";
}

// ─── Admin Route: Bulk Status ────────────────────────────────────────────────

export interface BulkStatusRequest {
  bundle_ids: BundleId[];
  enabled: boolean;
}

export interface BulkStatusResponse {
  updated_count: number;
  skipped_count: number;
}

// ─── Admin Route: List Bundle Items ─────────────────────────────────────────

export interface ListBundleItemsRequest {
  bundle_id: BundleId;
  cursor?: string;
  page_size?: number;
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

// ─── Admin Route: Save Bundle Items ─────────────────────────────────────────

export interface SaveBundleItemsRequest {
  bundle_id: BundleId;
  /** Array of [variant_external_id, product_external_id] pairs */
  variant_external_ids: VariantExternalId[];
  product_external_ids: ProductExternalId[];
}

export interface SaveBundleItemsResponse {
  saved_count: number;
  unavailable_variants: VariantExternalId[];
}

// ─── Admin Route: List Bundle Tiers ─────────────────────────────────────────

export interface ListBundleTiersRequest {
  bundle_id: BundleId;
  cursor?: string;
  page_size?: number;
}

export interface BundleTierSummary {
  id: BundleTierId;
  bundle_id: BundleId;
  minimum_item_count: number;
  /** basis points */
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

// ─── Admin Route: Save Bundle Tiers ─────────────────────────────────────────

export interface TierInput {
  minimum_item_count: number;
  /** basis points, e.g. 1000 = 10% */
  discount_rate: number;
}

export interface SaveBundleTiersRequest {
  bundle_id: BundleId;
  tiers: TierInput[];
}

export interface SaveBundleTiersResponse {
  saved_count: number;
}

// ─── Admin Route: Purchase History ──────────────────────────────────────────

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
  bundle_title: string;
  order_external_id: OrderExternalId;
  order_placed_at: string;
  variant_external_ids: VariantExternalId[];
  item_count: number;
  discount_rate_applied: number;
  order_total: number;
  currency_code: string;
  recorded_at: string;
}

export interface ListPurchaseHistoryResponse {
  records: PurchaseRecordSummary[];
  next_cursor: string | null;
  total_count: number;
}

// ─── Widget Route: Read Bundle ───────────────────────────────────────────────

export interface WidgetBundleRequest {
  bundle_id: BundleId;
  cursor?: string;
}

export interface WidgetBundleResponse {
  bundle: {
    id: BundleId;
    title: string;
    description: string | null;
    mode: BundleMode;
    enabled: boolean;
    health_status: BundleHealthStatus;
  };
  tiers: BundleTierSummary[];
  items: BundleItemSummary[];
  next_cursor: string | null;
  total_count: number;
}

// ─── Widget Route: Validate Selection ────────────────────────────────────────

export interface ValidateBundleRequest {
  bundle_id: BundleId;
  selected_variant_ids: VariantExternalId[];
}

export interface ValidateBundleResponse {
  valid: boolean;
  earned_tier: BundleTierSummary | null;
  discount_rate: number;
  validation_errors: string[];
}

// ─── Widget Route: Cart Add ───────────────────────────────────────────────────

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

// ─── Webhook Payloads ────────────────────────────────────────────────────────

export interface OrderLineItem {
  id: number;
  variant_id: number | null;
  product_id: number | null;
  quantity: number;
  price: string;
  name: string;
}

export interface OrderDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface OrdersPaidPayload {
  id: OrderExternalId;
  created_at: string;
  currency: string;
  total_price: string;
  line_items: OrderLineItem[];
  discount_codes: OrderDiscountCode[];
  note_attributes: Array<{ name: string; value: string }>;
}

export interface InventoryLevelsUpdatePayload {
  inventory_item_id: InventoryItemId;
  location_id: number;
  available: number | null;
  updated_at: string;
}

export interface ProductsDeletePayload {
  id: ProductExternalId;
}

// ─── Health Evaluation ───────────────────────────────────────────────────────

export interface BundleHealthEvaluation {
  bundle_id: BundleId;
  new_health_status: BundleHealthStatus;
  /** whether enabled should be set false */
  should_disable: boolean;
  event_kind: HealthEventKind;
  reason: string;
}

// ─── Job Payloads ────────────────────────────────────────────────────────────

export interface UpdateVariantAvailabilityPayload {
  inventory_item_id: InventoryItemId;
  available: number | null;
}

export interface ProcessProductDeletePayload {
  product_external_id: ProductExternalId;
}
