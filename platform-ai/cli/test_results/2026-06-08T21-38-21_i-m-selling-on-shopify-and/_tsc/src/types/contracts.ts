// ─── Branded ID types ─────────────────────────────────────────────────────────
export type BundleId = string & { __brand: "BundleId" };
export type BundleItemId = string & { __brand: "BundleItemId" };
export type BundleItemVariantId = string & { __brand: "BundleItemVariantId" };
export type BundleTierId = string & { __brand: "BundleTierId" };
export type BundleOrderIncrementId = string & { __brand: "BundleOrderIncrementId" };

// Shopify external ids (numeric stored as BIGINT; normalized to string on JS boundary)
export type ProductExternalId = string & { __brand: "ProductExternalId" };
export type VariantExternalId = string & { __brand: "VariantExternalId" };
export type OrderExternalId = string & { __brand: "OrderExternalId" };
export type ShopifyDiscountNodeId = string & { __brand: "ShopifyDiscountNodeId" };
// Shopify GID strings (e.g. "gid://shopify/ProductVariant/123")
export type VariantMerchandiseGid = string & { __brand: "VariantMerchandiseGid" };
export type CartGid = string & { __brand: "CartGid" };

// ─── Domain enums ─────────────────────────────────────────────────────────────
export type BundleType = "fixed" | "flexible";
export type DiscountType = "percentage" | "flat" | "bxgy";
export type VariantMode = "all" | "specific";

// ─── DB Row types (mirror app.json tables one-to-one) ────────────────────────

export interface BundleRow {
  id: BundleId;
  name: string;
  bundle_type: BundleType;
  enabled: boolean;
  required_item_count: number | null;
  discount_type: DiscountType;
  shopify_discount_external_id: ShopifyDiscountNodeId | null;
  discount_code_string: string | null;
  purchase_count: number;
  created_at: string;
  updated_at: string;
}

export interface BundleItemRow {
  id: BundleItemId;
  bundle_id: BundleId;
  product_external_id: string; // BIGINT comes back as string from postgres.js
  variant_mode: VariantMode;
  available: boolean;
}

export interface BundleItemVariantRow {
  id: BundleItemVariantId;
  bundle_item_id: BundleItemId;
  variant_external_id: string; // BIGINT comes back as string
  variant_gid: string;         // Full Shopify GID, e.g. "gid://shopify/ProductVariant/123"
}

export interface BundleDiscountTierRow {
  id: BundleTierId;
  bundle_id: BundleId;
  min_item_count: number;
  discount_ratio: string | null; // TEXT in DB (e.g. "0.10")
  discount_amount: string | null; // BIGINT comes back as string
  is_bxgy: boolean;
}

export interface BundleOrderIncrementRow {
  id: BundleOrderIncrementId;
  bundle_id: BundleId;
  order_external_id: string; // BIGINT comes back as string
  created_at: string;
}

// ─── Nested shapes used in responses ─────────────────────────────────────────

export interface DiscountTierShape {
  min_item_count: number;
  discount_ratio: string | null;
  discount_amount: string | null;
  is_bxgy: boolean;
}

export interface BundleItemVariantShape {
  variant_external_id: string;
  /** Storefront GID: "gid://shopify/ProductVariant/<id>" */
  live_variant_gid: VariantMerchandiseGid;
}

export interface BundleItemShape {
  id: BundleItemId;
  bundle_id: BundleId;
  product_external_id: string;
  variant_mode: VariantMode;
  available: boolean;
  variants: BundleItemVariantShape[];
}

export interface BundleWithDetails extends BundleRow {
  items: BundleItemShape[];
  discount_tiers: DiscountTierShape[];
}

// ─── Admin route contracts ────────────────────────────────────────────────────

// GET /admin/bundles
export interface AdminListBundlesRequest {
  page?: number;
  page_size?: number;
}
export interface AdminBundleSummary {
  id: BundleId;
  name: string;
  bundle_type: BundleType;
  enabled: boolean;
  purchase_count: number;
}
export interface AdminListBundlesResponse {
  bundles: AdminBundleSummary[];
  total: number;
  page: number;
  page_size: number;
}

// GET /admin/bundles/detail
export interface AdminBundleDetailRequest {
  bundle_id: BundleId;
}
export interface AdminBundleDetailResponse {
  bundle: BundleWithDetails | null;
}

// GET /admin/products/search
export interface AdminProductSearchRequest {
  query: string;
  page?: number;
  page_size?: number;
}
export interface AdminProductVariantShape {
  id: string;         // numeric id
  title: string;
  gid: VariantMerchandiseGid;
}
export interface AdminProductShape {
  id: string;         // numeric id
  title: string;
  gid: string;
  variants: AdminProductVariantShape[];
}
export interface AdminProductSearchResponse {
  products: AdminProductShape[];
  total: number;
  page: number;
  page_size: number;
}

// POST /admin/bundles/create — request
export interface BundleItemInput {
  product_external_id: string;
  variant_mode: VariantMode;
  variant_external_ids?: string[] | undefined; // numeric ids; required when variant_mode === "specific"
  variant_gids?: string[] | undefined;          // full GIDs parallel to variant_external_ids
}
export interface DiscountTierInput {
  min_item_count: number;
  discount_ratio?: string | undefined;   // e.g. "0.10" for 10%
  discount_amount?: number | undefined;  // minor units (cents)
  is_bxgy?: boolean | undefined;
}
export interface AdminCreateBundleRequest {
  name: string;
  bundle_type: BundleType;
  enabled: boolean;
  required_item_count?: number | undefined; // for flexible bundles
  items: BundleItemInput[];
  discount_type: DiscountType;
  discount_tiers: DiscountTierInput[];
}
export interface AdminCreateBundleResponse {
  bundle_id: BundleId;
  status: "ok" | "error";
  error?: string;
}

// PUT /admin/bundles/update — request
export interface AdminUpdateBundleRequest {
  bundle_id: BundleId;
  name: string;
  bundle_type: BundleType;
  enabled: boolean;
  required_item_count?: number | undefined;
  items: BundleItemInput[];
  discount_type: DiscountType;
  discount_tiers: DiscountTierInput[];
}
export interface AdminUpdateBundleResponse {
  status: "ok" | "error";
  error?: string;
}

// DELETE /admin/bundles/delete
export interface AdminDeleteBundleRequest {
  bundle_id: BundleId;
}
export interface AdminDeleteBundleResponse {
  status: "ok" | "error";
  error?: string;
}

// ─── Widget route contracts ───────────────────────────────────────────────────

// GET /widget/bundles
export interface WidgetListBundlesRequest {
  product_external_id: string;
  page?: number;
  page_size?: number;
}
export interface WidgetListBundlesResponse {
  bundles: BundleWithDetails[];
  total: number;
  page: number;
  page_size: number;
}

// POST /widget/bundles/add-to-cart
export interface WidgetAddToCartRequest {
  bundle_id: BundleId;
  cart_external_id: CartGid;
  selected_variant_ids: VariantMerchandiseGid[];
}
export interface WidgetAddToCartResponse {
  cart_external_id: CartGid;
  status: "ok" | "error";
  discount_applied: boolean;
  error?: string;
}

// ─── Webhook payload types ────────────────────────────────────────────────────

// orders/create
export interface OrderDiscountCode {
  code: string;
  amount: string;
  type: string;
}
export interface OrdersCreatePayload {
  id: number;                          // Shopify order numeric id
  discount_codes: OrderDiscountCode[];
  [key: string]: unknown;
}

// products/update
export interface ProductVariantPayload {
  id: number;
  product_id: number;
  title: string;
  inventory_quantity: number;
  inventory_policy: string;
  [key: string]: unknown;
}
export interface ProductsUpdatePayload {
  id: number;
  status: string;               // "active" | "archived" | "draft"
  variants: ProductVariantPayload[];
  [key: string]: unknown;
}

// products/delete
export interface ProductsDeletePayload {
  id: number;
  [key: string]: unknown;
}

// ─── Shopify GraphQL response shapes ─────────────────────────────────────────

export interface ShopifyDiscountUserError {
  field: string[] | null;
  message: string;
}
export interface ShopifyDiscountCodeNode {
  id: string;
  codeDiscount: {
    codes?: {
      nodes: Array<{ code: string }>;
    };
    [key: string]: unknown;
  };
}

export interface DiscountCodeBasicCreateResponse {
  discountCodeBasicCreate: {
    codeDiscountNode: ShopifyDiscountCodeNode | null;
    userErrors: ShopifyDiscountUserError[];
  };
}
export interface DiscountCodeBxgyCreateResponse {
  discountCodeBxgyCreate: {
    codeDiscountNode: ShopifyDiscountCodeNode | null;
    userErrors: ShopifyDiscountUserError[];
  };
}
export interface DiscountCodeBasicUpdateResponse {
  discountCodeBasicUpdate: {
    codeDiscountNode: ShopifyDiscountCodeNode | null;
    userErrors: ShopifyDiscountUserError[];
  };
}
export interface DiscountCodeBxgyUpdateResponse {
  discountCodeBxgyUpdate: {
    codeDiscountNode: ShopifyDiscountCodeNode | null;
    userErrors: ShopifyDiscountUserError[];
  };
}
export interface DiscountCodeDeleteResponse {
  discountCodeDelete: {
    deletedCodeDiscountId: string | null;
    userErrors: ShopifyDiscountUserError[];
  };
}

export interface ShopifyCartUserError {
  field: string[] | null;
  message: string;
}
export interface CartLinesAddResponse {
  cartLinesAdd: {
    cart: { id: string } | null;
    userErrors: ShopifyCartUserError[];
  };
}
export interface CartDiscountCodesUpdateResponse {
  cartDiscountCodesUpdate: {
    cart: { id: string } | null;
    userErrors: ShopifyCartUserError[];
  };
}

// Admin products query response shape
export interface ShopifyProductsQueryResponse {
  products: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        variants: {
          edges: Array<{
            node: {
              id: string;
              title: string;
            };
          }>;
        };
      };
      cursor: string;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}
