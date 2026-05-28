// ─── Branded IDs ────────────────────────────────────────────────────────────

export type BundleId = string & { __brand: "BundleId" };
export type BundleComponentId = string & { __brand: "BundleComponentId" };
export type BundleTierRuleId = string & { __brand: "BundleTierRuleId" };
export type BundlePurchaseEventId = string & { __brand: "BundlePurchaseEventId" };

// ─── Domain Enums ────────────────────────────────────────────────────────────

export type BundleType = "fixed" | "flexible";
export type DiscountKind = "percentage" | "flat_amount" | "buy_x_get_y";
export type AvailabilityStatus = "active" | "degraded" | "suspended";

// ─── DB Row Types ─────────────────────────────────────────────────────────────

/** Matches bundles table columns one-to-one */
export interface BundleRow {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  required_count: number | null;
  discount_kind: DiscountKind;
  /** minor units (cents) or basis points for percentage */
  discount_value: bigint | null;
  discount_currency: string | null;
  enabled: boolean;
  availability_status: AvailabilityStatus;
  shopify_product_external_id: bigint | null;
  shopify_product_gid: string | null;
  shopify_discount_external_id: bigint | null;
  shopify_discount_gid: string | null;
  purchase_count: number;
  created_at: Date;
  updated_at: Date;
}

/** Matches bundle_components table columns one-to-one */
export interface BundleComponentRow {
  id: BundleComponentId;
  bundle_id: BundleId;
  product_external_id: bigint;
  variant_external_id: bigint | null;
  position: number;
  is_available: boolean;
  created_at: Date;
}

/** Matches bundle_tier_rules table columns one-to-one */
export interface BundleTierRuleRow {
  id: BundleTierRuleId;
  bundle_id: BundleId;
  min_quantity: number;
  /** minor units or basis points depending on bundle discount_kind */
  discount_value: bigint;
  position: number;
}

/** Matches bundle_purchase_events table columns one-to-one */
export interface BundlePurchaseEventRow {
  id: BundlePurchaseEventId;
  bundle_id: BundleId;
  order_external_id: bigint;
  discount_codes_applied: string | null;
  created_at: Date;
}

// ─── Shared Sub-Types ─────────────────────────────────────────────────────────

export interface TierRuleInput {
  min_quantity: number;
  discount_value: number;
  position: number;
}

export interface ComponentInput {
  product_external_id: number;
  variant_external_id?: number | null;
  position: number;
}

export interface ComponentDetail {
  id: BundleComponentId;
  bundle_id: BundleId;
  product_external_id: number;
  variant_external_id: number | null;
  position: number;
  is_available: boolean;
}

export interface TierRuleDetail {
  id: BundleTierRuleId;
  bundle_id: BundleId;
  min_quantity: number;
  discount_value: number;
  position: number;
}

// ─── Bundle Summary (for admin list) ─────────────────────────────────────────

export interface BundleSummary {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  discount_kind: DiscountKind;
  enabled: boolean;
  availability_status: AvailabilityStatus;
  purchase_count: number;
  created_at: string;
  updated_at: string;
}

// ─── Admin Route Contracts ────────────────────────────────────────────────────

// GET /admin/bundles
export interface AdminListBundlesRequest {
  page: number;
  page_size: number;
  status_filter?: AvailabilityStatus | "all";
  enabled_filter?: boolean;
}

export interface AdminListBundlesResponse {
  items: BundleSummary[];
  total: number;
  page: number;
  page_size: number;
}

// POST /admin/bundles/create
export interface AdminCreateBundleRequest {
  title: string;
  bundle_type: BundleType;
  required_count?: number | null;
  discount_kind: DiscountKind;
  /** decimal number; e.g. 10 for 10%, or dollar amount for flat */
  discount_value?: number | null;
  discount_currency?: string | null;
  tier_rules?: TierRuleInput[];
  components?: ComponentInput[];
  enabled: boolean;
}

export interface AdminCreateBundleResponse {
  bundle_id: BundleId;
  validation_errors: string[];
}

// PUT /admin/bundles/update
export interface AdminUpdateBundleRequest {
  bundle_id: BundleId;
  title?: string;
  bundle_type?: BundleType;
  required_count?: number | null;
  discount_kind?: DiscountKind;
  discount_value?: number | null;
  discount_currency?: string | null;
  tier_rules?: TierRuleInput[];
  components?: ComponentInput[];
  enabled?: boolean;
}

export interface AdminUpdateBundleResponse {
  success: boolean;
  validation_errors: string[];
}

// POST /admin/bundles/toggle
export interface AdminToggleBundleRequest {
  bundle_id: BundleId;
  enabled: boolean;
}

export interface AdminToggleBundleResponse {
  success: boolean;
}

// DELETE /admin/bundles/delete
export interface AdminDeleteBundleRequest {
  bundle_id: BundleId;
}

export interface AdminDeleteBundleResponse {
  success: boolean;
}

// POST /admin/bundles/components
export interface AdminSetComponentsRequest {
  bundle_id: BundleId;
  components: ComponentInput[];
}

export interface AdminSetComponentsResponse {
  success: boolean;
  validation_errors: string[];
}

// ─── Widget Route Contracts ───────────────────────────────────────────────────

// GET /widget/bundle
export interface WidgetGetBundleRequest {
  bundle_id: BundleId;
}

export interface WidgetBundleDetail {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  required_count: number | null;
  discount_kind: DiscountKind;
  discount_value: number | null;
  tier_rules: TierRuleDetail[];
  enabled: boolean;
  availability_status: AvailabilityStatus;
}

export interface WidgetGetBundleResponse {
  bundle: WidgetBundleDetail;
  components: ComponentDetail[];
}

// POST /widget/bundle/add-to-cart
export interface WidgetAddToCartRequest {
  bundle_id: BundleId;
  selected_variant_ids: number[];
}

export interface CartLine {
  merchandiseId: string; // GID e.g. gid://shopify/ProductVariant/123
  quantity: number;
}

export interface WidgetAddToCartResponse {
  cart_lines: CartLine[];
  bundle_note: string;
  validation_errors: string[];
}

// ─── Webhook Payload Types ────────────────────────────────────────────────────

export interface OrderNoteAttribute {
  name: string;
  value: string;
}

export interface OrderDiscountCode {
  code: string;
  amount: string;
  type: string;
}

/** Narrowed payload for orders/paid */
export interface OrdersPaidPayload {
  id: number;
  note: string | null;
  note_attributes: OrderNoteAttribute[];
  discount_codes: OrderDiscountCode[];
  financial_status: string;
}

/** Narrowed payload for products/delete */
export interface ProductsDeletePayload {
  id: number;
}

export interface ProductVariantWebhook {
  id: number;
  inventory_quantity: number;
  inventory_management: string | null;
}

/** Narrowed payload for products/update */
export interface ProductsUpdatePayload {
  id: number;
  status: string;
  variants: ProductVariantWebhook[];
  admin_graphql_api_id: string;
}

// ─── Shopify GraphQL Response Fragments ──────────────────────────────────────

export interface ShopifyUserError {
  field: string[] | null;
  message: string;
}

export interface ProductBundleOperation {
  product?: {
    id: string;
    legacyResourceId: string;
  };
}

export interface ProductBundleCreatePayload {
  productBundleCreate: {
    productBundleOperation: ProductBundleOperation | null;
    userErrors: ShopifyUserError[];
  };
}

export interface ProductBundleUpdatePayload {
  productBundleUpdate: {
    productBundleOperation: ProductBundleOperation | null;
    userErrors: ShopifyUserError[];
  };
}

export interface DiscountAutomaticAppCreatePayload {
  discountAutomaticAppCreate: {
    automaticAppDiscount: {
      discountId: string;
    } | null;
    userErrors: ShopifyUserError[];
  };
}

export interface DiscountAutomaticAppUpdatePayload {
  discountAutomaticAppUpdate: {
    automaticAppDiscount: { title: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export interface DiscountAutomaticActivatePayload {
  discountAutomaticActivate: {
    automaticDiscountNode: { id: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export interface DiscountAutomaticDeactivatePayload {
  discountAutomaticDeactivate: {
    automaticDiscountNode: { id: string } | null;
    userErrors: ShopifyUserError[];
  };
}

export interface DiscountAutomaticDeletePayload {
  discountAutomaticDelete: {
    deletedAutomaticDiscountId: string | null;
    userErrors: ShopifyUserError[];
  };
}

// ─── Discount Config metafield shape ─────────────────────────────────────────

export interface DiscountTierMetafield {
  min_quantity: number;
  discount_value: number;
}

export interface DiscountFunctionConfig {
  bundle_id: string;
  discount_kind: DiscountKind;
  base_discount_value: number;
  tiers: DiscountTierMetafield[];
  combines_with_order_discounts: boolean;
}
