import { Request, Response, Router } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { money } from "../lib/money.js";
import type {
  BundleId,
  BundleRow,
  BundleMemberRow,
  BundleDiscountTierRow,
  BundleDiscountExternalRefRow,
  MemberWithLiveInfo,
  VariantLiveInfo,
  TierMatchedInfo,
  WidgetPreviewTotalResponse,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── GET /widget/bundle ───────────────────────────────────────────────────────

widgetRouter.get("/widget/bundle", async (req: Request, res: Response) => {
  const bundleId = typeof req.query.bundle_id === "string"
    ? (req.query.bundle_id as BundleId)
    : null;
  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const [bundle] = await sql<BundleRow[]>`
    SELECT id, title, bundle_type, discount_kind, required_selection_count,
           shopify_product_external_id, enabled, created_at, updated_at
    FROM bundles
    WHERE id = ${bundleId} AND enabled = true
  `;
  if (!bundle) {
    res.status(404).json({ error: "Bundle not found or disabled" });
    return;
  }

  const members = await sql<BundleMemberRow[]>`
    SELECT id, bundle_id, product_external_id, variant_external_id,
           available, position, created_at, updated_at
    FROM bundle_members
    WHERE bundle_id = ${bundleId}
    ORDER BY position ASC
  `;

  const tiers = await sql<BundleDiscountTierRow[]>`
    SELECT id, bundle_id, min_item_count, discount_value, discount_amount,
           discount_currency, free_item_count, position, created_at
    FROM bundle_discount_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY min_item_count ASC
  `;

  const shopify = await shopifyClientFor(req.platform!);
  const membersWithLive: MemberWithLiveInfo[] = [];

  for (const member of members) {
    if (member.variant_external_id) {
      // Member is pinned to a specific variant — fetch live variant data
      try {
        const variantGid = `gid://shopify/ProductVariant/${member.variant_external_id}`;
        const result = await shopify.graphql<{
          productVariant: {
            id: string;
            title: string;
            availableForSale: boolean;
            price: string;
            image: { url: string } | null;
            product: { priceRange: { minVariantPrice: { currencyCode: string } } };
          } | null;
        }>(
          `query GetVariant($id: ID!) {
             productVariant(id: $id) {
               id
               title
               availableForSale
               price
               image { url }
               product {
                 priceRange { minVariantPrice { currencyCode } }
               }
             }
           }`,
          { id: variantGid }
        );

        const v = result.productVariant;
        const liveInfo: VariantLiveInfo | null = v
          ? {
              variant_external_id: member.variant_external_id,
              title: v.title,
              price_amount: v.price,
              price_currency: v.product.priceRange.minVariantPrice.currencyCode,
              available_for_sale: v.availableForSale,
              image_url: v.image?.url ?? null,
            }
          : null;

        membersWithLive.push({ ...member, live: liveInfo });
      } catch {
        membersWithLive.push({ ...member, live: null });
      }
    } else {
      // Product-level member — fetch product and its first available variant
      try {
        const productGid = `gid://shopify/Product/${member.product_external_id}`;
        const result = await shopify.graphql<{
          product: {
            id: string;
            title: string;
            status: string;
            featuredImage: { url: string } | null;
            variants: {
              nodes: Array<{
                id: string;
                title: string;
                availableForSale: boolean;
                price: string;
                image: { url: string } | null;
              }>;
            };
            priceRange: { minVariantPrice: { currencyCode: string } };
          } | null;
        }>(
          `query GetProduct($id: ID!) {
             product(id: $id) {
               id
               title
               status
               featuredImage { url }
               variants(first: 1) {
                 nodes {
                   id
                   title
                   availableForSale
                   price
                   image { url }
                 }
               }
               priceRange { minVariantPrice { currencyCode } }
             }
           }`,
          { id: productGid }
        );

        const p = result.product;
        if (!p) {
          membersWithLive.push({ ...member, live: null });
          continue;
        }

        // Use the first variant's data for pricing and availability
        const firstVariant = p.variants.nodes[0];
        const currency = p.priceRange.minVariantPrice.currencyCode;
        const isProductActive = p.status === "ACTIVE";

        if (firstVariant) {
          const liveInfo: VariantLiveInfo = {
            variant_external_id: firstVariant.id.split("/").pop() ?? member.product_external_id,
            title: p.title,
            price_amount: firstVariant.price,
            price_currency: currency,
            available_for_sale: isProductActive && firstVariant.availableForSale,
            image_url: firstVariant.image?.url ?? p.featuredImage?.url ?? null,
          };
          membersWithLive.push({ ...member, live: liveInfo });
        } else {
          membersWithLive.push({ ...member, live: null });
        }
      } catch {
        membersWithLive.push({ ...member, live: null });
      }
    }
  }

  res.json({
    bundle: {
      id: bundle.id,
      title: bundle.title,
      bundle_type: bundle.bundle_type,
      discount_kind: bundle.discount_kind,
      required_selection_count: bundle.required_selection_count,
      enabled: bundle.enabled,
    },
    members: membersWithLive,
    tiers,
  });
});

// ─── POST /widget/bundle/preview-total ───────────────────────────────────────

widgetRouter.post("/widget/bundle/preview-total", async (req: Request, res: Response) => {
  const { bundle_id, selected_variant_ids } = req.body as {
    bundle_id: BundleId;
    selected_variant_ids: string[];
  };

  if (!bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(selected_variant_ids) || selected_variant_ids.length === 0) {
    res.status(400).json({ error: "selected_variant_ids must be a non-empty array" });
    return;
  }

  const [bundle] = await sql<BundleRow[]>`
    SELECT id, title, bundle_type, discount_kind, required_selection_count,
           shopify_product_external_id, enabled, created_at, updated_at
    FROM bundles
    WHERE id = ${bundle_id} AND enabled = true
  `;
  if (!bundle) {
    res.status(404).json({ error: "Bundle not found or disabled" });
    return;
  }

  // Load tiers fresh from DB
  const tiers = await sql<BundleDiscountTierRow[]>`
    SELECT id, bundle_id, min_item_count, discount_value, discount_amount,
           discount_currency, free_item_count, position, created_at
    FROM bundle_discount_tiers
    WHERE bundle_id = ${bundle_id}
    ORDER BY min_item_count ASC
  `;

  // Fetch prices for each selected variant
  const shopify = await shopifyClientFor(req.platform!);
  const selectionCount = selected_variant_ids.length;

  let totalMinorUnits = 0;
  let currency = "USD";

  for (const variantId of selected_variant_ids) {
    // Validate: variantId must be numeric
    if (!/^\d+$/.test(variantId)) continue;
    const variantGid = `gid://shopify/ProductVariant/${variantId}`;
    try {
      const result = await shopify.graphql<{
        productVariant: {
          price: string;
          product: { priceRange: { minVariantPrice: { currencyCode: string } } };
        } | null;
      }>(
        `query GetVariantPrice($id: ID!) {
           productVariant(id: $id) {
             price
             product { priceRange { minVariantPrice { currencyCode } } }
           }
         }`,
        { id: variantGid }
      );
      const v = result.productVariant;
      if (v) {
        currency = v.product.priceRange.minVariantPrice.currencyCode;
        totalMinorUnits += money.toMinorUnits(v.price, currency);
      }
    } catch {
      // skip unpriceable variants
    }
  }

  // Find the best matching tier (largest min_item_count <= selectionCount)
  let matchedTier: BundleDiscountTierRow | null = null;
  for (const tier of tiers) {
    if (tier.min_item_count <= selectionCount) {
      if (!matchedTier || tier.min_item_count > matchedTier.min_item_count) {
        matchedTier = tier;
      }
    }
  }

  let discountMinorUnits = 0;
  if (matchedTier) {
    if (bundle.discount_kind === "percentage" && matchedTier.discount_value) {
      const pct = parseFloat(matchedTier.discount_value);
      discountMinorUnits = money.percentage(totalMinorUnits, pct * 100);
    } else if (bundle.discount_kind === "flat_amount" && matchedTier.discount_amount) {
      discountMinorUnits = parseInt(String(matchedTier.discount_amount), 10);
    }
    // bxgy: applied at checkout automatically by Shopify's automatic discount engine
  }

  const discountedTotal = Math.max(0, totalMinorUnits - discountMinorUnits);

  const tierMatched: TierMatchedInfo | null = matchedTier
    ? {
        id: matchedTier.id,
        min_item_count: matchedTier.min_item_count,
        discount_value: matchedTier.discount_value,
        discount_amount: matchedTier.discount_amount !== null ? String(matchedTier.discount_amount) : null,
        discount_currency: matchedTier.discount_currency,
        free_item_count: matchedTier.free_item_count,
      }
    : null;

  const response: WidgetPreviewTotalResponse = {
    original_total: totalMinorUnits,
    discounted_total: discountedTotal,
    discount_amount: discountMinorUnits,
    currency,
    tier_matched: tierMatched,
  };

  res.json(response);
});

// ─── POST /widget/bundle/add-to-cart ─────────────────────────────────────────

widgetRouter.post("/widget/bundle/add-to-cart", async (req: Request, res: Response) => {
  const { bundle_id, selected_variant_ids } = req.body as {
    bundle_id: BundleId;
    selected_variant_ids: string[];
  };

  if (!bundle_id) {
    res.status(400).json({ cart_id: null, checkout_url: null, errors: ["bundle_id is required"] });
    return;
  }
  if (!Array.isArray(selected_variant_ids) || selected_variant_ids.length === 0) {
    res.status(400).json({ cart_id: null, checkout_url: null, errors: ["selected_variant_ids must be non-empty"] });
    return;
  }

  // Validate that all selected_variant_ids are numeric strings
  const nonNumeric = selected_variant_ids.filter((id) => !/^\d+$/.test(id));
  if (nonNumeric.length > 0) {
    res.status(400).json({
      cart_id: null,
      checkout_url: null,
      errors: [`Invalid variant id format: ${nonNumeric.join(", ")}`],
    });
    return;
  }

  const [bundle] = await sql<BundleRow[]>`
    SELECT id, title, bundle_type, discount_kind, required_selection_count,
           shopify_product_external_id, enabled, created_at, updated_at
    FROM bundles
    WHERE id = ${bundle_id} AND enabled = true
  `;
  if (!bundle) {
    res.status(404).json({ cart_id: null, checkout_url: null, errors: ["Bundle not found or disabled"] });
    return;
  }

  // Load bundle members from DB to validate selections
  const members = await sql<BundleMemberRow[]>`
    SELECT id, bundle_id, product_external_id, variant_external_id,
           available, position, created_at, updated_at
    FROM bundle_members
    WHERE bundle_id = ${bundle_id}
  `;

  // Build a set of valid variant ids from this bundle's members.
  // For pinned-variant members, use variant_external_id.
  // For product-level members (no pinned variant), we allow any variant of that product —
  // validation is relaxed for product-level members since the customer picks a variant
  // from the widget which fetches live variant data for that product.
  const pinnedVariantIds = new Set<string>();
  const productLevelMemberExists = members.some((m) => !m.variant_external_id);

  for (const member of members) {
    if (member.variant_external_id) {
      pinnedVariantIds.add(String(member.variant_external_id));
    }
  }

  // If ALL members are pinned-variant members, validate the selection strictly.
  // If any product-level members exist, we allow the selected variants through
  // (they came from the widget's live variant fetch for that product).
  if (!productLevelMemberExists && pinnedVariantIds.size > 0) {
    const invalidIds = selected_variant_ids.filter((id) => !pinnedVariantIds.has(String(id)));
    if (invalidIds.length > 0) {
      res.status(422).json({
        cart_id: null,
        checkout_url: null,
        errors: [`Selected variant(s) do not belong to this bundle: ${invalidIds.join(", ")}`],
      });
      return;
    }
  }

  // Server-side validation of selection count and availability
  const selectionErrors: string[] = [];
  if (bundle.bundle_type === "flexible") {
    if (selected_variant_ids.length !== bundle.required_selection_count) {
      selectionErrors.push(
        `Flexible bundle requires exactly ${bundle.required_selection_count} items; got ${selected_variant_ids.length}`
      );
    }
  } else {
    // fixed: check all members are available
    const unavailableMembers = members.filter((m) => !m.available);
    if (unavailableMembers.length > 0) {
      selectionErrors.push("One or more bundle items are currently unavailable");
    }
  }

  // Ensure none of the selected pinned variants are marked unavailable in DB
  const selectedSet = new Set(selected_variant_ids.map(String));
  const unavailableSelected = members.filter(
    (m) => m.variant_external_id && selectedSet.has(m.variant_external_id) && !m.available
  );
  if (unavailableSelected.length > 0) {
    selectionErrors.push("One or more selected items are unavailable");
  }

  if (selectionErrors.length > 0) {
    res.status(422).json({ cart_id: null, checkout_url: null, errors: selectionErrors });
    return;
  }

  // Find best matching discount for the selection
  const tiers = await sql<BundleDiscountTierRow[]>`
    SELECT id, bundle_id, min_item_count, discount_value, discount_amount,
           discount_currency, free_item_count, position, created_at
    FROM bundle_discount_tiers
    WHERE bundle_id = ${bundle_id}
    ORDER BY min_item_count ASC
  `;

  let matchedTier: BundleDiscountTierRow | null = null;
  for (const tier of tiers) {
    if (tier.min_item_count <= selected_variant_ids.length) {
      if (!matchedTier || tier.min_item_count > matchedTier.min_item_count) {
        matchedTier = tier;
      }
    }
  }

  // Get the discount title for this tier (for cart attributes tracking)
  let discountTitle: string | null = null;
  if (matchedTier) {
    const [ref] = await sql<BundleDiscountExternalRefRow[]>`
      SELECT id, bundle_id, tier_id, discount_external_id, discount_title, discount_kind, created_at, updated_at
      FROM bundle_discount_external_refs
      WHERE tier_id = ${matchedTier.id}
    `;
    if (ref) {
      discountTitle = ref.discount_title;
    }
  }

  // Build cart lines — each validated variant with quantity 1
  const cartLines = selected_variant_ids.map((variantId) => ({
    merchandiseId: `gid://shopify/ProductVariant/${variantId}`,
    quantity: 1,
  }));

  const shopify = await shopifyClientFor(req.platform!);

  // NOTE: Automatic discounts provisioned via discountAutomaticBasicCreate /
  // discountAutomaticBxgyCreate apply automatically at checkout based on Shopify's
  // discount engine matching the cart's product contents. No discount code is needed
  // in the cartCreate call. The cart attribute below is used for internal tracking only.
  const cartAttributes = discountTitle
    ? [{ key: "_bundle_discount", value: discountTitle }]
    : [];

  try {
    const result = await shopify.storefront<{
      cartCreate: {
        cart: {
          id: string;
          checkoutUrl: string;
        } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation CreateCart($input: CartInput!) {
         cartCreate(input: $input) {
           cart {
             id
             checkoutUrl
           }
           userErrors { field message }
         }
       }`,
      {
        input: {
          lines: cartLines,
          attributes: cartAttributes,
        },
      }
    );

    const { cart, userErrors } = result.cartCreate;
    if (userErrors.length > 0) {
      res.status(422).json({
        cart_id: null,
        checkout_url: null,
        errors: userErrors.map((e) => e.message),
      });
      return;
    }
    if (!cart) {
      res.status(500).json({ cart_id: null, checkout_url: null, errors: ["Cart creation returned no cart"] });
      return;
    }

    res.json({
      cart_id: cart.id,
      checkout_url: cart.checkoutUrl,
      errors: [],
    });
  } catch (err) {
    res.status(500).json({ cart_id: null, checkout_url: null, errors: [String(err)] });
  }
});
