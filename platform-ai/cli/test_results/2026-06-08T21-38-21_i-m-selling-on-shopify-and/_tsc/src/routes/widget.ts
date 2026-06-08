import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { money } from "../lib/money.js";
import { paginate } from "../lib/paginate.js";
import type {
  BundleId,
  BundleRow,
  BundleItemRow,
  BundleItemVariantRow,
  BundleDiscountTierRow,
  BundleItemShape,
  BundleItemVariantShape,
  BundleWithDetails,
  DiscountTierShape,
  WidgetListBundlesResponse,
  WidgetAddToCartRequest,
  WidgetAddToCartResponse,
  CartGid,
  VariantMerchandiseGid,
  CartLinesAddResponse,
  CartDiscountCodesUpdateResponse,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── GET /widget/bundles ──────────────────────────────────────────────────────
// Returns all enabled bundles relevant to the given product_external_id.
widgetRouter.get("/widget/bundles", async (req: Request, res: Response) => {
  const productExternalIdParam =
    typeof req.query.product_external_id === "string"
      ? req.query.product_external_id
      : null;

  if (!productExternalIdParam) {
    res.status(400).json({ error: "Missing product_external_id" });
    return;
  }

  // Validate that product_external_id is a numeric string
  if (!/^\d+$/.test(productExternalIdParam)) {
    res.status(400).json({ error: "Invalid product_external_id" });
    return;
  }

  const pageNum =
    typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
  const pageSizeNum =
    typeof req.query.page_size === "string"
      ? parseInt(req.query.page_size, 10)
      : 20;

  const productId = parseInt(productExternalIdParam, 10);

  // Use paginate() helper for the offset-paginated list of enabled bundles.
  const result = await paginate(
    sql,
    sql`
      SELECT DISTINCT b.id, b.name, b.bundle_type, b.enabled, b.required_item_count,
             b.discount_type, b.shopify_discount_external_id, b.discount_code_string,
             b.purchase_count, b.created_at, b.updated_at
      FROM bundles b
      JOIN bundle_items bi ON bi.bundle_id = b.id
      WHERE b.enabled = true
        AND bi.product_external_id = ${productId}
      ORDER BY b.created_at DESC, b.id DESC
    `,
    { page: pageNum, page_size: pageSizeNum }
  );

  const bundleRows = result.items as BundleRow[];

  // Enrich each bundle with its items and discount tiers.
  const enrichedBundles: BundleWithDetails[] = await Promise.all(
    bundleRows.map(async (bundle) => {
      const itemRows = await sql<BundleItemRow[]>`
        SELECT id, bundle_id, product_external_id, variant_mode, available
        FROM bundle_items
        WHERE bundle_id = ${bundle.id}
      `;

      const itemsWithVariants: BundleItemShape[] = await Promise.all(
        itemRows.map(async (item) => {
          let variantShapes: BundleItemVariantShape[] = [];
          if (item.variant_mode === "specific") {
            const variantRows = await sql<BundleItemVariantRow[]>`
              SELECT id, bundle_item_id, variant_external_id
              FROM bundle_item_variants
              WHERE bundle_item_id = ${item.id}
            `;
            variantShapes = variantRows.map((vr) => ({
              variant_external_id: String(vr.variant_external_id),
              // Use the stored GID directly — never reconstruct from numeric id
              live_variant_gid: vr.variant_gid as VariantMerchandiseGid,
            }));
          }
          return {
            id: item.id,
            bundle_id: item.bundle_id,
            product_external_id: String(item.product_external_id),
            variant_mode: item.variant_mode,
            available: item.available,
            variants: variantShapes,
          };
        })
      );

      const tierRows = await sql<BundleDiscountTierRow[]>`
        SELECT id, bundle_id, min_item_count, discount_ratio, discount_amount, is_bxgy
        FROM bundle_discount_tiers
        WHERE bundle_id = ${bundle.id}
        ORDER BY min_item_count ASC
      `;

      const discountTiers: DiscountTierShape[] = tierRows.map((t) => ({
        min_item_count: t.min_item_count,
        discount_ratio: t.discount_ratio,
        discount_amount: t.discount_amount,
        is_bxgy: t.is_bxgy,
      }));

      return {
        ...bundle,
        items: itemsWithVariants,
        discount_tiers: discountTiers,
      };
    })
  );

  const response: WidgetListBundlesResponse = {
    bundles: enrichedBundles,
    total: result.total,
    page: result.page,
    page_size: result.page_size,
  };
  res.json(response);
});

// ─── POST /widget/bundles/add-to-cart ─────────────────────────────────────────
widgetRouter.post("/widget/bundles/add-to-cart", async (req: Request, res: Response) => {
  const body = req.body as WidgetAddToCartRequest;

  const bundleId =
    typeof body.bundle_id === "string" ? (body.bundle_id as BundleId) : null;
  const cartExternalId =
    typeof body.cart_external_id === "string"
      ? (body.cart_external_id as CartGid)
      : null;
  const selectedVariantIds: VariantMerchandiseGid[] = Array.isArray(
    body.selected_variant_ids
  )
    ? body.selected_variant_ids
    : [];

  if (!bundleId) {
    res.status(400).json({ status: "error", error: "Missing bundle_id", discount_applied: false, cart_external_id: "" as CartGid });
    return;
  }
  if (!cartExternalId) {
    res.status(400).json({ status: "error", error: "Missing cart_external_id", discount_applied: false, cart_external_id: "" as CartGid });
    return;
  }
  if (selectedVariantIds.length === 0) {
    res.status(400).json({ status: "error", error: "No variants selected", discount_applied: false, cart_external_id: cartExternalId });
    return;
  }

  // Validate that all selectedVariantIds are GIDs starting with the ProductVariant prefix
  for (const gid of selectedVariantIds) {
    if (!gid.startsWith("gid://shopify/ProductVariant/")) {
      res.status(400).json({
        status: "error",
        error: `Invalid variant id format: ${gid}`,
        discount_applied: false,
        cart_external_id: cartExternalId,
      });
      return;
    }
  }

  // Fetch the bundle.
  const [bundle] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${bundleId} AND enabled = true
  `;
  if (!bundle) {
    res.status(404).json({ status: "error", error: "Bundle not found or disabled", discount_applied: false, cart_external_id: cartExternalId });
    return;
  }
  if (!bundle.discount_code_string) {
    res.status(422).json({ status: "error", error: "Bundle has no discount code", discount_applied: false, cart_external_id: cartExternalId });
    return;
  }

  // Validate flexible bundle count.
  if (bundle.bundle_type === "flexible" && bundle.required_item_count !== null) {
    if (selectedVariantIds.length < bundle.required_item_count) {
      res.status(400).json({
        status: "error",
        error: `Must select at least ${bundle.required_item_count} items`,
        discount_applied: false,
        cart_external_id: cartExternalId,
      });
      return;
    }
  }

  // Fetch discount tiers for logging the best-match tier discount value.
  const tierRows = await sql<BundleDiscountTierRow[]>`
    SELECT id, bundle_id, min_item_count, discount_ratio, discount_amount, is_bxgy
    FROM bundle_discount_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY min_item_count ASC
  `;

  // Find best-matching tier for logging purposes using money helper.
  const itemCount = selectedVariantIds.length;
  const bestTier = tierRows
    .filter((t) => t.min_item_count <= itemCount)
    .sort((a, b) => b.min_item_count - a.min_item_count)[0] ?? tierRows[0];

  if (bestTier && bundle.discount_type === "percentage" && bestTier.discount_ratio !== null) {
    // Use money.percentage for correct currency math.
    // We log at 10000 minor units as a representative total (no line-item prices available).
    const sampleTotal = 10000;
    const discountValue = money.percentage(sampleTotal, parseFloat(bestTier.discount_ratio) * 100);
    console.log(
      { requestId: req.platform!.requestId, bundleId, discountValue, tier: bestTier.min_item_count },
      "Best-match discount tier selected"
    );
  }

  const shopify = await shopifyClientFor(req.platform!);

  // Step 1: Add all selected variants to the cart.
  const cartLines = selectedVariantIds.map((gid) => ({
    merchandiseId: gid,
    quantity: 1,
  }));

  const addResult = await shopify.storefront<CartLinesAddResponse>(
    `mutation AddBundleLines($cartId: ID!, $lines: [CartLineInput!]!) {
       cartLinesAdd(cartId: $cartId, lines: $lines) {
         cart { id }
         userErrors { field message }
       }
     }`,
    { cartId: cartExternalId, lines: cartLines }
  );

  if (addResult.cartLinesAdd.userErrors.length > 0) {
    const msg = addResult.cartLinesAdd.userErrors.map((e) => e.message).join("; ");
    const resp: WidgetAddToCartResponse = {
      cart_external_id: cartExternalId,
      status: "error",
      discount_applied: false,
      error: msg,
    };
    res.status(422).json(resp);
    return;
  }

  const updatedCartId =
    (addResult.cartLinesAdd.cart?.id as CartGid | undefined) ?? cartExternalId;

  // Step 2: Apply the bundle's discount code to the cart.
  const discountResult = await shopify.storefront<CartDiscountCodesUpdateResponse>(
    `mutation ApplyBundleDiscount($cartId: ID!, $discountCodes: [String!]!) {
       cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
         cart { id }
         userErrors { field message }
       }
     }`,
    { cartId: updatedCartId, discountCodes: [bundle.discount_code_string] }
  );

  let discountApplied = true;
  if (discountResult.cartDiscountCodesUpdate.userErrors.length > 0) {
    // Log but do not fail — cart items were already added.
    console.log(
      { requestId: req.platform!.requestId, bundleId, cartId: updatedCartId },
      "Discount code application had errors: " +
        discountResult.cartDiscountCodesUpdate.userErrors.map((e) => e.message).join("; ")
    );
    discountApplied = false;
  }

  const finalCartId =
    (discountResult.cartDiscountCodesUpdate.cart?.id as CartGid | undefined) ??
    updatedCartId;

  console.log(
    { requestId: req.platform!.requestId, bundleId, cartId: finalCartId, discountApplied },
    "Bundle added to cart"
  );

  const resp: WidgetAddToCartResponse = {
    cart_external_id: finalCartId,
    status: "ok",
    discount_applied: discountApplied,
  };
  res.json(resp);
});
