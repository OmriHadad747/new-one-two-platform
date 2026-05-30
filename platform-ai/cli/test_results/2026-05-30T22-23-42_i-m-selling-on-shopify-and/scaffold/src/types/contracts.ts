// ─── Branded ID types ────────────────────────────────────────────────────────

export type BundleId = string & { __brand: "BundleId" };
export type BundleComponentId = string & { __brand: "BundleComponentId" };
export type BundleTierId = string & { __brand: "BundleTierId" };
export type BundleAttributionId = string & { __brand: "BundleAttributionId" };

/** Shopify numeric IDs — stored as BIGINT, come back as strings from Postgres */
export type ShopifyProductExternalId = string & { __brand: "ShopifyProductExternalId" };
export type ShopifyVariantExternalId = string & { __brand: "ShopifyVariantExternalId" };
export type ShopifyOrderExternalId = string & { __brand: "ShopifyOrderExternalId" };
export type ShopifyDiscountExternalId = string & { __brand: "ShopifyDiscountExternalId" };

// ─── Enums ───────────────────────────────────────────────────────────────────

export type BundleType = "fixed" | "flexible";
export type DiscountKind = "percentage" | "flat-amount" | "buy-x-get-y";
export type HealthStatus = "ok" | "degraded";

// ─── DB Row Types ─────────────────────────────────────────────────────────────

export interface BundleDefinitionRow {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  flexible_pick_count: number | null;
  discount_kind: DiscountKind;
  enabled: boolean;
  health_status: HealthStatus;
  shopify_bundle_product_external_id: string | null; // BIGINT → string from Postgres
  purchase_count: number;
  created_at: string;
  updated_at: string;
}

export interface BundleComponentRow {
  id: BundleComponentId;
  bundle_id: BundleId;
  product_external_id: string; // BIGINT → string from Postgres
  variant_external_id: string | null; // BIGINT → string from Postgres; null = any variant
  quantity: number;
  position: number;
}

export interface BundleDiscountTierRow {
  id: BundleTierId;
  bundle_id: BundleId;
  min_item_count: number;
  discount_value: string | null;   // BIGINT stored as basis points → string from Postgres
  discount_amount: string | null;  // BIGINT minor units → string from Postgres
  free_item_count: number | null;
  discount_code: string;
  discount_external_id: string;    // BIGINT → string from Postgres
  created_at: string;
}

export interface BundlePurchaseAttributionRow {
  id: BundleAttributionId;
  order_external_id: string;      // BIGINT → string from Postgres
  bundle_id: BundleId;
  tier_id: BundleTierId;
  discount_code: string;
  order_total: string;            // BIGINT minor units → string from Postgres
  currency: string;
  created_at: string;
}

// ─── Component input shapes (shared across admin create/update) ───────────────

export interface BundleComponentInput {
  product_external_id: ShopifyProductExternalId;
  variant_external_id: ShopifyVariantExternalId | null;
  quantity: number;
  position: number;
}

export interface BundleTierInput {
  min_item_count: number;
  /** basis points, e.g. 2000 = 20% — used for percentage kind */
  discount_value: number | null;
  /** minor units e.g. 500 = $5.00 — used for flat-amount kind */
  discount_amount: number | null;
  /** for buy-x-get-y kind */
  free_item_count: number | null;
}

// ─── Admin HTTP contracts ─────────────────────────────────────────────────────

// GET /admin/bundles
export interface AdminListBundlesRequest {
  cursor?: string;
  status_filter?: "all" | "enabled" | "disabled" | "degraded";
}

export interface AdminBundleSummary {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  discount_kind: DiscountKind;
  enabled: boolean;
  health_status: HealthStatus;
  purchase_count: number;
  component_count: number;
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
  bundle_type: BundleType;
  flexible_pick_count: number | null;
  discount_kind: DiscountKind;
  components: BundleComponentInput[];
  tiers: BundleTierInput[];
}

export interface AdminCreateBundleResponse {
  bundle_id: BundleId;
  status: "created" | "error";
  warnings: string[];
}

// PUT /admin/bundles/update
export interface AdminUpdateBundleRequest {
  bundle_id: BundleId;
  title: string;
  bundle_type: BundleType;
  flexible_pick_count: number | null;
  discount_kind: DiscountKind;
  components: BundleComponentInput[];
  tiers: BundleTierInput[];
  enabled: boolean;
}

export interface AdminUpdateBundleResponse {
  bundle_id: BundleId;
  status: "updated" | "error";
  warnings: string[];
}

// POST /admin/bundles/toggle
export interface AdminToggleBundleRequest {
  bundle_ids: BundleId[];
  enabled: boolean;
}

export interface AdminToggleBundleResponse {
  updated_count: number;
  errors: string[];
}

// GET /admin/bundles/detail
export interface AdminBundleDetailRequest {
  bundle_id: BundleId;
}

export interface AdminBundleDetail {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  flexible_pick_count: number | null;
  discount_kind: DiscountKind;
  enabled: boolean;
  health_status: HealthStatus;
  shopify_bundle_product_external_id: string | null;
  components: BundleComponentRow[];
  tiers: BundleDiscountTierRow[];
  created_at: string;
  updated_at: string;
}

export interface AdminBundleDetailResponse {
  bundle: AdminBundleDetail;
  purchase_count: number;
}

// ─── Widget HTTP contracts ────────────────────────────────────────────────────

// GET /widget/bundles
export interface WidgetListBundlesRequest {
  product_external_id: ShopifyProductExternalId;
  cursor?: string;
}

/** A bundle component enriched with live-resolved variant GID for cart operations */
export interface WidgetBundleComponent {
  id: BundleComponentId;
  bundle_id: BundleId;
  product_external_id: string;
  variant_external_id: string | null;
  quantity: number;
  position: number;
  /** Resolved Storefront merchandise GID: gid://shopify/ProductVariant/<id>
   *  Only present when variant_external_id is non-null.
   *  Widget MUST use this field for cart operations — never build GIDs locally. */
  live_variant_gid: string | null;
}

export interface WidgetBundleTierSummary {
  id: BundleTierId;
  min_item_count: number;
  discount_value: string | null;
  discount_amount: string | null;
  free_item_count: number | null;
  discount_code: string;
}

export interface WidgetBundleSummary {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  flexible_pick_count: number | null;
  discount_kind: DiscountKind;
  components: WidgetBundleComponent[];
  tiers: WidgetBundleTierSummary[];
}

export interface WidgetListBundlesResponse {
  bundles: WidgetBundleSummary[];
  next_cursor: string | null;
  total_count: number;
}

// POST /widget/bundle/add-to-cart
export interface WidgetAddToCartRequest {
  bundle_id: BundleId;
  cart_external_id: string;
  /** Numeric variant external ids (e.g. "43729076") validated as \d+ — sourced from
   *  component.variant_external_id values returned by GET /widget/bundles */
  selected_variant_external_ids: ShopifyVariantExternalId[];
  /** Storefront merchandise GIDs (gid://shopify/ProductVariant/<id>) sourced from
   *  the live_variant_gid fields on each component returned by GET /widget/bundles.
   *  When provided, these are passed directly to cartLinesAdd without any local GID
   *  construction. Must match selected_variant_external_ids in length and order. */
  selected_variant_gids: string[];
  item_count: number;
}

export interface WidgetAddToCartResponse {
  cart_external_id: string;
  discount_code: string;
  discounted_total: number; // minor units
  warnings: string[];
}

// POST /widget/bundle/preview-total
export interface WidgetPreviewTotalRequest {
  bundle_id: BundleId;
  /** Numeric variant external ids — sourced from component.variant_external_id
   *  values returned by GET /widget/bundles */
  selected_variant_external_ids: ShopifyVariantExternalId[];
  /** Storefront merchandise GIDs sourced from live_variant_gid on each component.
   *  Used to query variant prices without local GID construction. */
  selected_variant_gids: string[];
  item_count: number;
}

/** Storefront GID for a variant: gid://shopify/ProductVariant/<id> */
export type StorefrontVariantGid = string & { __brand: "StorefrontVariantGid" };

export interface WidgetPreviewTotalResponse {
  original_total: number;    // minor units
  discounted_total: number;  // minor units
  tier_label: string;
  discount_amount: number;   // minor units
}

// ─── Webhook payload types ────────────────────────────────────────────────────

export interface OrderDiscountCode {
  code: string;
  amount: string;
  type: string;
}

/** Payload for orders/paid */
export interface OrdersPaidPayload {
  id: number;                          // order external id (numeric from Shopify)
  discount_codes: OrderDiscountCode[];  // array — nullable: false per webhook schema
  total_price: string;                  // decimal string e.g. "149.99"
  currency: string;
}

export interface ProductVariantWebhook {
  id: number;
  product_id: number;
  title: string;
  price: string;
  sku: string | null;
  inventory_quantity: number | null;
}

/** Payload for products/update */
export interface ProductsUpdatePayload {
  id: number;           // product external id
  status: string;       // "active" | "draft" | "archived"
  variants: ProductVariantWebhook[];
}

/** Payload for products/delete — only id is present */
export interface ProductsDeletePayload {
  id: number;           // product external id
}

// ─── Shopify GraphQL response shapes (used by admin.ts) ──────────────────────

export interface ShopifyProductBundleOperation {
  product: {
    id: string;          // GID: gid://shopify/Product/<id>
    legacyResourceId: string;
  } | null;
}

export interface ShopifyDiscountCodeNode {
  id: string;            // GID: gid://shopify/DiscountCodeNode/<id>
  codeDiscount: {
    codes?: {
      nodes: Array<{ code: string }>;
    };
  };
}

export interface ProductBundleCreateResult {
  productBundleCreate: {
    productBundleOperation: ShopifyProductBundleOperation | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

export interface ProductBundleUpdateResult {
  productBundleUpdate: {
    productBundleOperation: ShopifyProductBundleOperation | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

export interface DiscountCodeBasicCreateResult {
  discountCodeBasicCreate: {
    codeDiscountNode: ShopifyDiscountCodeNode | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

export interface DiscountCodeBxgyCreateResult {
  discountCodeBxgyCreate: {
    codeDiscountNode: ShopifyDiscountCodeNode | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

export interface DiscountCodeBasicUpdateResult {
  discountCodeBasicUpdate: {
    codeDiscountNode: ShopifyDiscountCodeNode | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

export interface DiscountCodeBxgyUpdateResult {
  discountCodeBxgyUpdate: {
    codeDiscountNode: ShopifyDiscountCodeNode | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

export interface ProductVariantQueryResult {
  productVariant: {
    id: string;
    price: string;
    availableForSale: boolean;
    legacyResourceId: string;
  } | null;
}

// ─── Storefront GraphQL response shapes (used by widget.ts) ──────────────────

export interface CartLinesAddResult {
  cartLinesAdd: {
    cart: {
      id: string;
      discountCodes: Array<{ code: string; applicable: boolean }>;
    } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

export interface CartDiscountCodesUpdateResult {
  cartDiscountCodesUpdate: {
    cart: {
      id: string;
      discountCodes: Array<{ code: string; applicable: boolean }>;
    } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}
