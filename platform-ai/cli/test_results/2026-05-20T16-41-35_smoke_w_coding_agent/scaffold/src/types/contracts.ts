// Shared contracts for the tiered bundle builder app.
// Every cross-file type lives here. Admin client, widget client, route
// handlers, webhook handlers, and cron jobs all import from this module.

// ─── Branded ids ───────────────────────────────────────────────────────

export type BundleId = string & { __brand: "BundleId" };
export type BundleItemId = string & { __brand: "BundleItemId" };
export type BundleTierId = string & { __brand: "BundleTierId" };
export type PurchaseRecordId = string & { __brand: "PurchaseRecordId" };

// ─── Enums / unions ────────────────────────────────────────────────────

export type BundleMode = "fixed" | "flexible";
export type BundleHealth = "healthy" | "warned" | "auto_disabled";
export type VariantAvailability = "available" | "out_of_stock" | "deleted";
export type HealthEventKind = "auto_disabled" | "warned" | "cleared";

// ─── DB row types (one-to-one with database.tables in app.json) ────────

export interface BundleRow {
  id: BundleId;
  title: string;
  description: string | null;
  mode: BundleMode;
  enabled: boolean;
  health_status: BundleHealth;
  created_at: Date;
  updated_at: Date;
}

export interface BundleItemRow {
  id: BundleItemId;
  bundle_id: BundleId;
  variant_external_id: string; // BIGINT → string at the driver
  product_external_id: string;
  observed_availability: VariantAvailability;
  added_at: Date;
}

export interface BundleTierRow {
  id: BundleTierId;
  bundle_id: BundleId;
  minimum_item_count: number;
  discount_rate: number; // basis points (0..10000)
  display_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface BundlePurchaseRecordRow {
  id: PurchaseRecordId;
  bundle_id: BundleId;
  order_external_id: string;
  order_placed_at: Date;
  variant_external_ids: string;
  item_count: number;
  discount_rate_applied: number;
  order_total: string; // BIGINT → string at the driver
  currency_code: string;
  recorded_at: Date;
}

export interface BundleHealthEventRow {
  id: string;
  bundle_id: BundleId;
  event_kind: HealthEventKind;
  affected_variant_external_id: string | null;
  reason: string;
  occurred_at: Date;
}

// ─── Wire shapes for admin routes ──────────────────────────────────────

export interface AdminListBundlesRequest {
  status_filter?: "all" | "enabled" | "disabled" | "warned" | "auto_disabled" | null;
  page?: number;
  page_size?: number;
}
export interface AdminBundleSummary {
  id: BundleId;
  title: string;
  mode: BundleMode;
  enabled: boolean;
  health_status: BundleHealth;
  tier_count: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}
export interface AdminListBundlesResponse {
  items: AdminBundleSummary[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminCreateBundleRequest {
  title: string;
  mode: BundleMode;
  description?: string | null;
}
export interface AdminCreateBundleResponse {
  bundle_id: BundleId;
  status: "created";
}

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
  blocking_variants?: string[];
  blocked?: boolean;
}

export interface AdminRemoveBundleRequest {
  bundle_id: BundleId;
}
export interface AdminRemoveBundleResponse {
  success: boolean;
}

export interface AdminCloneBundleRequest {
  source_bundle_id: BundleId;
}
export interface AdminCloneBundleResponse {
  new_bundle_id: BundleId;
  status: "cloned";
}

export interface AdminBulkStatusRequest {
  bundle_ids: BundleId[];
  enabled: boolean;
}
export interface AdminBulkStatusResponse {
  updated_count: number;
  skipped_count: number;
}

export interface AdminListItemsRequest {
  bundle_id: BundleId;
  page?: number;
  page_size?: number;
}
export interface AdminItemView {
  id: BundleItemId;
  variant_external_id: string;
  product_external_id: string;
  observed_availability: VariantAvailability;
  added_at: string;
}
export interface AdminListItemsResponse {
  items: AdminItemView[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminSaveItemsRequest {
  bundle_id: BundleId;
  items: { variant_external_id: string; product_external_id: string }[];
}
export interface AdminSaveItemsResponse {
  saved_count: number;
  unavailable_variants: string[];
}

export interface AdminListTiersRequest {
  bundle_id: BundleId;
  page?: number;
  page_size?: number;
}
export interface AdminTierView {
  id: BundleTierId;
  minimum_item_count: number;
  discount_rate: number;
  display_order: number;
}
export interface AdminListTiersResponse {
  items: AdminTierView[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminSaveTiersRequest {
  bundle_id: BundleId;
  tiers: { minimum_item_count: number; discount_rate: number }[];
}
export interface AdminSaveTiersResponse {
  saved_count: number;
}

export interface AdminPurchaseHistoryRequest {
  bundle_id?: BundleId | null;
  date_from?: string | null;
  date_to?: string | null;
  page?: number;
  page_size?: number;
}
export interface AdminPurchaseRecord {
  id: PurchaseRecordId;
  bundle_id: BundleId;
  bundle_title: string;
  order_external_id: string;
  order_placed_at: string;
  item_count: number;
  discount_rate_applied: number;
  order_total_minor: string;
  currency_code: string;
}
export interface AdminPurchaseHistoryResponse {
  items: AdminPurchaseRecord[];
  total: number;
  page: number;
  page_size: number;
}

// ─── Wire shapes for widget routes ─────────────────────────────────────

export interface WidgetBundleRequest {
  bundle_id: BundleId;
}
export interface WidgetTierView {
  minimum_item_count: number;
  discount_rate: number;
  display_order: number;
}
export interface WidgetItemView {
  variant_external_id: string;
  product_external_id: string;
  observed_availability: VariantAvailability;
  live_available: boolean;
}
export interface WidgetBundleView {
  id: BundleId;
  title: string;
  description: string | null;
  mode: BundleMode;
  enabled: boolean;
  health_status: BundleHealth;
}
export interface WidgetBundleResponse {
  bundle: WidgetBundleView | null;
  tiers: WidgetTierView[];
  items: WidgetItemView[];
}

export interface WidgetValidateRequest {
  bundle_id: BundleId;
  selected_variant_ids: string[];
}
export interface WidgetEarnedTier {
  minimum_item_count: number;
  discount_rate: number;
}
export interface WidgetValidateResponse {
  valid: boolean;
  earned_tier: WidgetEarnedTier | null;
  discount_rate: number;
  validation_errors: string[];
  unavailable_variants: string[];
}

export interface WidgetCartAddRequest {
  bundle_id: BundleId;
  selected_variant_ids: string[];
  quantities: number[];
}
export interface WidgetCartAddResponse {
  success: boolean;
  applied_discount_rate: number;
  discount_code: string | null;
  errors: string[];
}

// ─── Webhook payload shapes (subset we actually read) ──────────────────

export interface OrdersPaidPayload {
  id: number;
  created_at: string;
  total_price: string;
  currency: string;
  line_items: Array<{
    id: number;
    variant_id: number | null;
    product_id: number | null;
    quantity: number;
  }>;
}

export interface InventoryLevelsUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number | null;
  updated_at: string;
}

export interface ProductsUpdatePayload {
  id: number;
  status: string;
  variants: Array<{
    id: number;
    product_id: number;
    inventory_quantity?: number;
  }>;
  variant_gids: Array<{ admin_graphql_api_id: string }>;
}

export interface ProductsDeletePayload {
  id: number;
}

// ─── Cron job payloads ────────────────────────────────────────────────

export interface UpdateAvailabilityJobPayload {
  variant_external_id: string;
  product_external_id?: string | null;
  new_status: VariantAvailability;
}

export interface EvaluateBundleHealthJobPayload {
  bundle_id: BundleId;
  triggering_variant_id: string | null;
}
