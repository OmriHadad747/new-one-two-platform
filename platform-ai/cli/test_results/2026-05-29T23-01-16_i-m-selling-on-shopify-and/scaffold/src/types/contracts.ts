// ─── Branded IDs ─────────────────────────────────────────────────────────────

export type BundleId = string & { __brand: "BundleId" };
export type BundleMemberId = string & { __brand: "BundleMemberId" };
export type BundleDiscountTierId = string & { __brand: "BundleDiscountTierId" };
export type BundleDiscountExternalRefId = string & { __brand: "BundleDiscountExternalRefId" };
export type BundlePurchaseCountId = string & { __brand: "BundlePurchaseCountId" };

// ─── Domain Literals ─────────────────────────────────────────────────────────

export type BundleType = "fixed" | "flexible";
export type DiscountKind = "percentage" | "flat_amount" | "bxgy";
export type DiscountRefKind = "basic" | "bxgy";

// ─── DB Row Types ─────────────────────────────────────────────────────────────

export interface BundleRow {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  discount_kind: DiscountKind;
  required_selection_count: number;
  shopify_product_external_id: string | null; // BIGINT stored as string from pg
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BundleMemberRow {
  id: BundleMemberId;
  bundle_id: BundleId;
  product_external_id: string; // BIGINT from pg
  variant_external_id: string | null; // BIGINT from pg
  available: boolean;
  position: number;
  created_at: Date;
  updated_at: Date;
}

export interface BundleDiscountTierRow {
  id: BundleDiscountTierId;
  bundle_id: BundleId;
  min_item_count: number;
  discount_value: string | null; // decimal string e.g. "0.10"
  discount_amount: string | null; // BIGINT minor units as string from pg
  discount_currency: string | null;
  free_item_count: number | null;
  position: number;
  created_at: Date;
}

export interface BundleDiscountExternalRefRow {
  id: BundleDiscountExternalRefId;
  bundle_id: BundleId;
  tier_id: BundleDiscountTierId;
  discount_external_id: string; // Shopify GID
  discount_title: string;
  discount_kind: DiscountRefKind;
  created_at: Date;
  updated_at: Date;
}

export interface BundlePurchaseCountRow {
  id: BundlePurchaseCountId;
  bundle_id: BundleId;
  order_external_id: string; // BIGINT from pg
  incremented_at: Date;
}

// ─── Shared sub-shapes ───────────────────────────────────────────────────────

export interface MemberInput {
  product_external_id: string;
  variant_external_id?: string | null;
  position: number;
}

export interface TierInput {
  min_item_count: number;
  discount_value?: string | null;    // for percentage
  discount_amount?: number | null;   // for flat_amount (minor units)
  discount_currency?: string | null;
  free_item_count?: number | null;   // for bxgy
  position: number;
}

export interface BundleDetail {
  bundle: BundleRow;
  members: BundleMemberRow[];
  tiers: BundleDiscountTierRow[];
  purchase_count: number;
}

export interface BundleListItem {
  id: BundleId;
  title: string;
  bundle_type: BundleType;
  discount_kind: DiscountKind;
  enabled: boolean;
  created_at: Date;
  purchase_count: number;
}

// ─── Admin Route Contracts ────────────────────────────────────────────────────

// GET /admin/bundles
export interface AdminListBundlesRequest {
  page: number;
  page_size: number;
  status_filter?: "enabled" | "disabled" | "all";
}

export interface AdminListBundlesResponse {
  items: BundleListItem[];
  total: number;
  page: number;
  page_size: number;
}

// GET /admin/bundles/detail
export interface AdminBundleDetailRequest {
  bundle_id: BundleId;
}

export interface AdminBundleDetailResponse {
  bundle: BundleRow;
  members: BundleMemberRow[];
  tiers: BundleDiscountTierRow[];
  purchase_count: number;
}

// POST /admin/bundles/create
export interface AdminCreateBundleRequest {
  title: string;
  bundle_type: BundleType;
  discount_kind: DiscountKind;
  required_selection_count: number;
  members: MemberInput[];
  tiers: TierInput[];
  enabled: boolean;
}

export interface AdminCreateBundleResponse {
  bundle_id: BundleId;
  status: "created" | "error";
  errors: string[];
}

// PUT /admin/bundles/update
export interface AdminUpdateBundleRequest {
  bundle_id: BundleId;
  title?: string;
  discount_kind?: DiscountKind;
  required_selection_count?: number;
  members?: MemberInput[];
  tiers?: TierInput[];
  enabled?: boolean;
}

export interface AdminUpdateBundleResponse {
  bundle_id: BundleId;
  status: "updated" | "error";
  errors: string[];
}

// POST /admin/bundles/toggle
export interface AdminToggleBundleRequest {
  bundle_id: BundleId;
  enabled: boolean;
}

export interface AdminToggleBundleResponse {
  bundle_id: BundleId;
  enabled: boolean;
  status: "ok" | "error";
  errors: string[];
}

// ─── Widget Route Contracts ───────────────────────────────────────────────────

export interface VariantLiveInfo {
  variant_external_id: string;
  title: string;
  price_amount: string;
  price_currency: string;
  available_for_sale: boolean;
  image_url: string | null;
}

export interface MemberWithLiveInfo extends BundleMemberRow {
  live: VariantLiveInfo | null;
}

// GET /widget/bundle
export interface WidgetBundleRequest {
  bundle_id: BundleId;
}

export interface WidgetBundleResponse {
  bundle: {
    id: BundleId;
    title: string;
    bundle_type: BundleType;
    discount_kind: DiscountKind;
    required_selection_count: number;
    enabled: boolean;
  };
  members: MemberWithLiveInfo[];
  tiers: BundleDiscountTierRow[];
}

// POST /widget/bundle/preview-total
export interface WidgetPreviewTotalRequest {
  bundle_id: BundleId;
  selected_variant_ids: string[];
}

export interface TierMatchedInfo {
  id: BundleDiscountTierId;
  min_item_count: number;
  discount_value: string | null;
  discount_amount: string | null;
  discount_currency: string | null;
  free_item_count: number | null;
}

export interface WidgetPreviewTotalResponse {
  original_total: number;       // minor units
  discounted_total: number;     // minor units
  discount_amount: number;      // minor units
  currency: string;
  tier_matched: TierMatchedInfo | null;
}

// POST /widget/bundle/add-to-cart
export interface WidgetAddToCartRequest {
  bundle_id: BundleId;
  selected_variant_ids: string[];
}

export interface WidgetAddToCartResponse {
  cart_id: string | null;
  checkout_url: string | null;
  errors: string[];
}

// ─── Webhook Payload Narrowings ───────────────────────────────────────────────

export interface OrderPaidLineItem {
  id: number;
  product_id: number | null;
  variant_id: number | null;
  quantity: number;
  title: string;
  properties: Array<{ name: string; value: string }>;
}

export interface OrderPaidDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface OrderPaidPayload {
  id: number;
  name: string;
  email: string;
  line_items: OrderPaidLineItem[];
  discount_codes: OrderPaidDiscountCode[];
  tags: string;
  total_price: string;
  currency: string;
}

export interface ProductUpdateVariant {
  id: number;
  product_id: number;
  title: string;
  price: string;
  available: boolean;
}

export interface ProductUpdatePayload {
  id: number;
  title: string;
  status: string; // "active" | "draft" | "archived"
  variants: ProductUpdateVariant[];
  admin_graphql_api_id: string;
}
