import { Request, Response, Router } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { paginate } from "../lib/paginate.js";
import { money } from "../lib/money.js";
import type {
  BundleId,
  BundleRow,
  BundleMemberRow,
  BundleDiscountTierRow,
  BundleDiscountExternalRefRow,
  BundleListItem,
  MemberInput,
  TierInput,
  BundleType,
  DiscountKind,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── helpers ─────────────────────────────────────────────────────────────────

function safeStr(raw: string): string {
  return raw.replace(/\0/g, "");
}

function buildDiscountTitle(bundleTitle: string, tierIndex: number): string {
  return safeStr(`Bundle: ${bundleTitle} - Tier ${tierIndex + 1}`);
}

async function provisionBasicDiscount(
  shopify: Awaited<ReturnType<typeof shopifyClientFor>>,
  title: string,
  discountKind: DiscountKind,
  tier: TierInput,
  shopifyProductGid: string
): Promise<string> {
  let customerGetsValue: Record<string, unknown>;
  if (discountKind === "percentage") {
    const pct = parseFloat(tier.discount_value ?? "0");
    customerGetsValue = { percentage: pct };
  } else {
    // flat_amount
    const amountMinor = tier.discount_amount ?? 0;
    const cur = tier.discount_currency ?? "USD";
    const amountStr = money.format(amountMinor, cur);
    customerGetsValue = { discountAmount: { amount: amountStr, appliesOnEachItem: false } };
  }

  const result = await shopify.graphql<{
    discountAutomaticBasicCreate: {
      automaticDiscountNode: { id: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(
    `mutation CreateBasicDiscount($input: DiscountAutomaticBasicInput!) {
       discountAutomaticBasicCreate(automaticBasicDiscount: $input) {
         automaticDiscountNode { id }
         userErrors { field message }
       }
     }`,
    {
      input: {
        title,
        startsAt: new Date().toISOString(),
        customerGets: {
          value: customerGetsValue,
          items: {
            products: { productsToAdd: [shopifyProductGid] },
          },
        },
      },
    }
  );

  const { automaticDiscountNode, userErrors } = result.discountAutomaticBasicCreate;
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join("; "));
  }
  if (!automaticDiscountNode) {
    throw new Error("discountAutomaticBasicCreate returned no node");
  }
  return automaticDiscountNode.id;
}

async function provisionBxgyDiscount(
  shopify: Awaited<ReturnType<typeof shopifyClientFor>>,
  title: string,
  tier: TierInput,
  shopifyProductGid: string
): Promise<string> {
  const buyQty = tier.min_item_count;
  const freeQty = tier.free_item_count ?? 1;

  const result = await shopify.graphql<{
    discountAutomaticBxgyCreate: {
      automaticDiscountNode: { id: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(
    `mutation CreateBxgyDiscount($input: DiscountAutomaticBxgyInput!) {
       discountAutomaticBxgyCreate(automaticBxgyDiscount: $input) {
         automaticDiscountNode { id }
         userErrors { field message }
       }
     }`,
    {
      input: {
        title,
        startsAt: new Date().toISOString(),
        customerBuys: {
          value: { quantity: String(buyQty) },
          items: {
            products: { productsToAdd: [shopifyProductGid] },
          },
        },
        customerGets: {
          value: {
            discountOnQuantity: {
              quantity: String(freeQty),
              effect: { percentage: 1.0 },
            },
          },
          items: {
            products: { productsToAdd: [shopifyProductGid] },
          },
        },
      },
    }
  );

  const { automaticDiscountNode, userErrors } = result.discountAutomaticBxgyCreate;
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join("; "));
  }
  if (!automaticDiscountNode) {
    throw new Error("discountAutomaticBxgyCreate returned no node");
  }
  return automaticDiscountNode.id;
}

/**
 * Attempt to deactivate a list of Shopify automatic discounts.
 * Best-effort — errors are logged but not thrown.
 */
async function deactivateDiscounts(
  shopify: Awaited<ReturnType<typeof shopifyClientFor>>,
  discountGids: string[]
): Promise<void> {
  for (const gid of discountGids) {
    try {
      // Validate GID format before calling
      if (!gid.startsWith("gid://shopify/DiscountAutomatic")) {
        console.warn({ discountGid: gid }, "Skipping deactivation for unexpected GID format");
        continue;
      }
      await shopify.graphql<{
        discountAutomaticDeactivate: {
          automaticDiscountNode: { id: string } | null;
          userErrors: { field: string[] | null; message: string }[];
        };
      }>(
        `mutation DeactivateDiscount($id: ID!) {
           discountAutomaticDeactivate(id: $id) {
             automaticDiscountNode { id }
             userErrors { field message }
           }
         }`,
        { id: gid }
      );
    } catch (err) {
      console.error({ discountGid: gid, err: String(err) }, "Failed to deactivate discount during cleanup");
    }
  }
}

/**
 * Attempt to delete a Shopify product bundle (best-effort rollback).
 */
async function deleteShopifyProduct(
  shopify: Awaited<ReturnType<typeof shopifyClientFor>>,
  productGid: string
): Promise<void> {
  try {
    await shopify.graphql<{
      productDelete: {
        deletedProductId: string | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation DeleteProduct($input: ProductDeleteInput!) {
         productDelete(input: $input) {
           deletedProductId
           userErrors { field message }
         }
       }`,
      { input: { id: productGid } }
    );
  } catch (err) {
    console.error({ productGid, err: String(err) }, "Failed to delete Shopify product during rollback");
  }
}

// ─── GET /admin/bundles ───────────────────────────────────────────────────────

adminRouter.get("/admin/bundles", async (req: Request, res: Response) => {
  const pageRaw = typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
  const pageSizeRaw = typeof req.query.page_size === "string" ? parseInt(req.query.page_size, 10) : 20;
  const statusFilter = typeof req.query.status_filter === "string" ? req.query.status_filter : "all";

  const page = isNaN(pageRaw) || pageRaw < 1 ? 1 : pageRaw;
  const page_size = isNaN(pageSizeRaw) || pageSizeRaw < 1 ? 20 : pageSizeRaw;

  const rows = await paginate<BundleListItem>(
    sql,
    sql`
      SELECT
        b.id,
        b.title,
        b.bundle_type,
        b.discount_kind,
        b.enabled,
        b.created_at,
        COALESCE(bpc.cnt, 0)::INTEGER AS purchase_count
      FROM bundles b
      LEFT JOIN (
        SELECT bundle_id, COUNT(*) AS cnt
        FROM bundle_purchase_counts
        GROUP BY bundle_id
      ) bpc ON bpc.bundle_id = b.id
      ${statusFilter === "enabled" ? sql`WHERE b.enabled = true` : statusFilter === "disabled" ? sql`WHERE b.enabled = false` : sql``}
      ORDER BY b.created_at DESC
    `,
    { page, page_size }
  );

  res.json(rows);
});

// ─── GET /admin/bundles/detail ────────────────────────────────────────────────

adminRouter.get("/admin/bundles/detail", async (req: Request, res: Response) => {
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
    WHERE id = ${bundleId}
  `;
  if (!bundle) {
    res.status(404).json({ error: "Bundle not found" });
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

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM bundle_purchase_counts
    WHERE bundle_id = ${bundleId}
  `;
  const purchase_count = parseInt(countRow?.count ?? "0", 10);

  res.json({ bundle, members, tiers, purchase_count });
});

// ─── POST /admin/bundles/create ───────────────────────────────────────────────

adminRouter.post("/admin/bundles/create", async (req: Request, res: Response) => {
  const {
    title: rawTitle,
    bundle_type,
    discount_kind,
    required_selection_count,
    members,
    tiers,
    enabled,
  } = req.body as {
    title: string;
    bundle_type: BundleType;
    discount_kind: DiscountKind;
    required_selection_count: number;
    members: MemberInput[];
    tiers: TierInput[];
    enabled: boolean;
  };

  // Validate inputs
  const errors: string[] = [];
  if (!rawTitle || typeof rawTitle !== "string") errors.push("title is required");
  if (!["fixed", "flexible"].includes(bundle_type)) errors.push("invalid bundle_type");
  if (!["percentage", "flat_amount", "bxgy"].includes(discount_kind)) errors.push("invalid discount_kind");
  if (!Array.isArray(members) || members.length === 0) errors.push("members must be a non-empty array");
  if (!Array.isArray(tiers) || tiers.length === 0) errors.push("tiers must be a non-empty array");
  if (errors.length > 0) {
    res.status(400).json({ bundle_id: null, status: "error", errors });
    return;
  }

  const title = safeStr(rawTitle);
  const shopify = await shopifyClientFor(req.platform!);

  // Step 1: Create Shopify product bundle — must succeed before we persist anything
  const componentProductGids = [...new Set((members as MemberInput[]).map(
    (m) => `gid://shopify/Product/${m.product_external_id}`
  ))];

  let shopifyProductGid: string;
  let shopifyProductExternalId: string;

  try {
    const bundleResult = await shopify.graphql<{
      productBundleCreate: {
        productBundleOperation: { product: { id: string } } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation CreateBundle($input: ProductBundleCreateInput!) {
         productBundleCreate(input: $input) {
           productBundleOperation {
             product { id }
           }
           userErrors { field message }
         }
       }`,
      {
        input: {
          title,
          components: componentProductGids.map((pid) => ({
            productId: pid,
            optionSelections: [],
          })),
        },
      }
    );

    const { productBundleOperation, userErrors: bundleErrors } = bundleResult.productBundleCreate;
    if (bundleErrors.length > 0) {
      res.status(422).json({ bundle_id: null, status: "error", errors: bundleErrors.map((e) => e.message) });
      return;
    }
    if (!productBundleOperation?.product?.id) {
      res.status(500).json({ bundle_id: null, status: "error", errors: ["Shopify productBundleCreate did not return a product id"] });
      return;
    }
    shopifyProductGid = productBundleOperation.product.id;
    shopifyProductExternalId = shopifyProductGid.split("/").pop() ?? "";
    if (!shopifyProductExternalId) {
      res.status(500).json({ bundle_id: null, status: "error", errors: ["Could not parse product id from Shopify GID"] });
      return;
    }
  } catch (err) {
    res.status(500).json({ bundle_id: null, status: "error", errors: [String(err)] });
    return;
  }

  // Step 2: Provision all Shopify discounts BEFORE persisting to DB.
  const tierInputs = tiers as TierInput[];
  const discountProvisions: Array<{ discountGid: string; discountTitle: string; discountRefKind: "basic" | "bxgy" }> = [];
  const discountErrors: string[] = [];

  for (let i = 0; i < tierInputs.length; i++) {
    const tier = tierInputs[i];
    if (!tier) continue;
    const discountTitle = buildDiscountTitle(title, i);
    try {
      let discountGid: string;
      let discountRefKind: "basic" | "bxgy";
      if (discount_kind === "bxgy") {
        discountGid = await provisionBxgyDiscount(shopify, discountTitle, tier, shopifyProductGid);
        discountRefKind = "bxgy";
      } else {
        discountGid = await provisionBasicDiscount(shopify, discountTitle, discount_kind, tier, shopifyProductGid);
        discountRefKind = "basic";
      }
      discountProvisions.push({ discountGid, discountTitle, discountRefKind });
    } catch (err) {
      discountErrors.push(`Tier ${i + 1}: ${String(err)}`);
    }
  }

  // If any discount provision failed, roll back the Shopify product bundle and return error
  if (discountErrors.length > 0) {
    // Deactivate any discounts that DID succeed before failing
    const succeededGids = discountProvisions.map((d) => d.discountGid);
    await deactivateDiscounts(shopify, succeededGids);
    // Delete the Shopify product bundle (best-effort rollback)
    await deleteShopifyProduct(shopify, shopifyProductGid);

    res.status(422).json({
      bundle_id: null,
      status: "error",
      errors: [
        "Discount provisioning failed. No bundle was saved. Please retry.",
        ...discountErrors,
      ],
    });
    return;
  }

  // Step 3: Persist everything in a single transaction
  let bundleId: BundleId | null = null;

  try {
    await sql.begin(async (tx) => {
      const [newBundle] = await tx<{ id: BundleId }[]>`
        INSERT INTO bundles (title, bundle_type, discount_kind, required_selection_count,
                             shopify_product_external_id, enabled)
        VALUES (${title}, ${bundle_type}, ${discount_kind},
                ${required_selection_count ?? 0},
                ${shopifyProductExternalId},
                ${enabled ?? true})
        RETURNING id
      `;
      if (!newBundle) throw new Error("Bundle insert returned no row");
      bundleId = newBundle.id;

      for (const member of members as MemberInput[]) {
        await tx`
          INSERT INTO bundle_members (bundle_id, product_external_id, variant_external_id, position)
          VALUES (${bundleId}, ${String(member.product_external_id)},
                  ${member.variant_external_id ? String(member.variant_external_id) : null},
                  ${member.position})
        `;
      }

      for (let i = 0; i < tierInputs.length; i++) {
        const tier = tierInputs[i];
        if (!tier) continue;
        const provision = discountProvisions[i];
        if (!provision) continue;

        const [newTier] = await tx<{ id: string }[]>`
          INSERT INTO bundle_discount_tiers (bundle_id, min_item_count, discount_value,
                                             discount_amount, discount_currency, free_item_count, position)
          VALUES (${bundleId}, ${tier.min_item_count},
                  ${tier.discount_value ?? null},
                  ${tier.discount_amount != null ? String(tier.discount_amount) : null},
                  ${tier.discount_currency ?? null},
                  ${tier.free_item_count ?? null},
                  ${i})
          RETURNING id
        `;
        if (!newTier) throw new Error(`Tier ${i + 1} insert returned no row`);

        await tx`
          INSERT INTO bundle_discount_external_refs
            (bundle_id, tier_id, discount_external_id, discount_title, discount_kind)
          VALUES (${bundleId}, ${newTier.id}, ${provision.discountGid},
                  ${provision.discountTitle}, ${provision.discountRefKind})
        `;
      }
    });
  } catch (err) {
    res.status(500).json({ bundle_id: null, status: "error", errors: [String(err)] });
    return;
  }

  if (!bundleId) {
    res.status(500).json({ bundle_id: null, status: "error", errors: ["Unexpected: no bundle id after insert"] });
    return;
  }

  res.status(201).json({ bundle_id: bundleId, status: "created", errors: [] });
});

// ─── PUT /admin/bundles/update ────────────────────────────────────────────────

adminRouter.put("/admin/bundles/update", async (req: Request, res: Response) => {
  const {
    bundle_id,
    title: rawTitle,
    discount_kind,
    required_selection_count,
    members,
    tiers,
    enabled,
  } = req.body as {
    bundle_id: BundleId;
    title?: string;
    discount_kind?: DiscountKind;
    required_selection_count?: number;
    members?: MemberInput[];
    tiers?: TierInput[];
    enabled?: boolean;
  };

  if (!bundle_id) {
    res.status(400).json({ bundle_id: null, status: "error", errors: ["bundle_id is required"] });
    return;
  }

  const [existingBundle] = await sql<BundleRow[]>`
    SELECT id, title, bundle_type, discount_kind, required_selection_count,
           shopify_product_external_id, enabled, created_at, updated_at
    FROM bundles WHERE id = ${bundle_id}
  `;
  if (!existingBundle) {
    res.status(404).json({ bundle_id, status: "error", errors: ["Bundle not found"] });
    return;
  }

  const newTitle = rawTitle ? safeStr(rawTitle) : existingBundle.title;
  const newDiscountKind = discount_kind ?? existingBundle.discount_kind;
  const newSelectionCount = required_selection_count ?? existingBundle.required_selection_count;
  const newEnabled = enabled !== undefined ? enabled : existingBundle.enabled;

  const shopify = await shopifyClientFor(req.platform!);
  const errors: string[] = [];

  // Update Shopify product bundle title if changed
  if (existingBundle.shopify_product_external_id) {
    const shopifyProductGid = `gid://shopify/Product/${existingBundle.shopify_product_external_id}`;
    try {
      const updateResult = await shopify.graphql<{
        productBundleUpdate: {
          productBundleOperation: { product: { id: string } } | null;
          userErrors: { field: string[] | null; message: string }[];
        };
      }>(
        `mutation UpdateBundle($input: ProductBundleUpdateInput!) {
           productBundleUpdate(input: $input) {
             productBundleOperation { product { id } }
             userErrors { field message }
           }
         }`,
        {
          input: {
            productId: shopifyProductGid,
            title: newTitle,
          },
        }
      );
      const { userErrors: bundleErrors } = updateResult.productBundleUpdate;
      if (bundleErrors.length > 0) {
        errors.push(...bundleErrors.map((e) => e.message));
      }
    } catch (err) {
      errors.push(`Bundle product update: ${String(err)}`);
    }
  }

  // If tiers are being changed, provision new discounts BEFORE touching the DB
  let newDiscountProvisions: Array<{ discountGid: string; discountTitle: string; discountRefKind: "basic" | "bxgy" }> = [];

  if (tiers !== undefined) {
    if (!existingBundle.shopify_product_external_id) {
      res.status(422).json({
        bundle_id,
        status: "error",
        errors: ["Cannot re-provision discounts: bundle has no Shopify product reference. Please recreate the bundle."],
      });
      return;
    }

    const productGid = `gid://shopify/Product/${existingBundle.shopify_product_external_id}`;
    const tierErrors: string[] = [];

    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      if (!tier) continue;
      const discountTitle = buildDiscountTitle(newTitle, i);
      try {
        let discountGid: string;
        let discountRefKind: "basic" | "bxgy";
        if (newDiscountKind === "bxgy") {
          discountGid = await provisionBxgyDiscount(shopify, discountTitle, tier, productGid);
          discountRefKind = "bxgy";
        } else {
          discountGid = await provisionBasicDiscount(shopify, discountTitle, newDiscountKind, tier, productGid);
          discountRefKind = "basic";
        }
        newDiscountProvisions.push({ discountGid, discountTitle, discountRefKind });
      } catch (err) {
        tierErrors.push(`Tier ${i + 1} discount: ${String(err)}`);
      }
    }

    if (tierErrors.length > 0) {
      // Deactivate any discounts that succeeded before failing
      const succeededGids = newDiscountProvisions.map((d) => d.discountGid);
      await deactivateDiscounts(shopify, succeededGids);
      newDiscountProvisions = [];

      res.status(422).json({
        bundle_id,
        status: "error",
        errors: ["Discount provisioning failed; no changes were saved.", ...tierErrors],
      });
      return;
    }
  }

  // Fetch old discount GIDs before DB update (for deactivation after successful DB write)
  let oldDiscountGids: string[] = [];
  if (tiers !== undefined) {
    const oldRefs = await sql<{ discount_external_id: string }[]>`
      SELECT discount_external_id
      FROM bundle_discount_external_refs
      WHERE bundle_id = ${bundle_id}
    `;
    oldDiscountGids = oldRefs.map((r) => r.discount_external_id);
  }

  // Update DB in a transaction — everything or nothing
  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE bundles
        SET title = ${newTitle},
            discount_kind = ${newDiscountKind},
            required_selection_count = ${newSelectionCount},
            enabled = ${newEnabled},
            updated_at = now()
        WHERE id = ${bundle_id}
      `;

      if (members !== undefined) {
        await tx`DELETE FROM bundle_members WHERE bundle_id = ${bundle_id}`;
        for (const member of members) {
          await tx`
            INSERT INTO bundle_members (bundle_id, product_external_id, variant_external_id, position)
            VALUES (${bundle_id}, ${String(member.product_external_id)},
                    ${member.variant_external_id ? String(member.variant_external_id) : null},
                    ${member.position})
          `;
        }
      }

      if (tiers !== undefined) {
        // Remove old tiers (cascades to discount_external_refs)
        await tx`DELETE FROM bundle_discount_tiers WHERE bundle_id = ${bundle_id}`;

        for (let i = 0; i < tiers.length; i++) {
          const tier = tiers[i];
          if (!tier) continue;
          const provision = newDiscountProvisions[i];
          if (!provision) continue;

          const [newTier] = await tx<{ id: string }[]>`
            INSERT INTO bundle_discount_tiers (bundle_id, min_item_count, discount_value,
                                               discount_amount, discount_currency, free_item_count, position)
            VALUES (${bundle_id}, ${tier.min_item_count},
                    ${tier.discount_value ?? null},
                    ${tier.discount_amount != null ? String(tier.discount_amount) : null},
                    ${tier.discount_currency ?? null},
                    ${tier.free_item_count ?? null},
                    ${i})
            RETURNING id
          `;
          if (!newTier) throw new Error(`Tier ${i + 1} insert returned no row`);

          await tx`
            INSERT INTO bundle_discount_external_refs
              (bundle_id, tier_id, discount_external_id, discount_title, discount_kind)
            VALUES (${bundle_id}, ${newTier.id}, ${provision.discountGid},
                    ${provision.discountTitle}, ${provision.discountRefKind})
          `;
        }
      }
    });
  } catch (err) {
    // DB update failed — deactivate the newly provisioned discounts since they won't be referenced
    if (newDiscountProvisions.length > 0) {
      await deactivateDiscounts(shopify, newDiscountProvisions.map((d) => d.discountGid));
    }
    errors.push(`Database update failed: ${String(err)}`);
    res.status(500).json({ bundle_id, status: "error", errors });
    return;
  }

  // DB update succeeded — now deactivate the old Shopify discounts
  if (oldDiscountGids.length > 0) {
    await deactivateDiscounts(shopify, oldDiscountGids);
  }

  res.json({ bundle_id, status: errors.length === 0 ? "updated" : "error", errors });
});

// ─── POST /admin/bundles/toggle ───────────────────────────────────────────────

adminRouter.post("/admin/bundles/toggle", async (req: Request, res: Response) => {
  const { bundle_id, enabled } = req.body as { bundle_id: BundleId; enabled: boolean };

  if (!bundle_id) {
    res.status(400).json({ bundle_id: null, enabled: false, status: "error", errors: ["bundle_id is required"] });
    return;
  }
  if (typeof enabled !== "boolean") {
    res.status(400).json({ bundle_id, enabled: false, status: "error", errors: ["enabled must be boolean"] });
    return;
  }

  const [existingBundle] = await sql<{ id: BundleId }[]>`
    SELECT id FROM bundles WHERE id = ${bundle_id}
  `;
  if (!existingBundle) {
    res.status(404).json({ bundle_id, enabled, status: "error", errors: ["Bundle not found"] });
    return;
  }

  // Get all discount refs for this bundle
  const discountRefs = await sql<BundleDiscountExternalRefRow[]>`
    SELECT id, bundle_id, tier_id, discount_external_id, discount_title, discount_kind, created_at, updated_at
    FROM bundle_discount_external_refs
    WHERE bundle_id = ${bundle_id}
  `;

  const shopify = await shopifyClientFor(req.platform!);
  const errors: string[] = [];

  // Activate or deactivate each Shopify automatic discount
  for (const ref of discountRefs) {
    // Validate GID format — must be a Shopify DiscountAutomatic node ID
    if (!ref.discount_external_id.startsWith("gid://shopify/DiscountAutomatic")) {
      console.warn({ bundleId: bundle_id, discountGid: ref.discount_external_id }, "Unexpected discount GID format, skipping");
      continue;
    }

    try {
      if (enabled) {
        const result = await shopify.graphql<{
          discountAutomaticActivate: {
            automaticDiscountNode: { id: string } | null;
            userErrors: { field: string[] | null; message: string }[];
          };
        }>(
          `mutation ActivateDiscount($id: ID!) {
             discountAutomaticActivate(id: $id) {
               automaticDiscountNode { id }
               userErrors { field message }
             }
           }`,
          { id: ref.discount_external_id }
        );
        const { userErrors } = result.discountAutomaticActivate;
        if (userErrors.length > 0) {
          errors.push(...userErrors.map((e) => e.message));
        }
      } else {
        const result = await shopify.graphql<{
          discountAutomaticDeactivate: {
            automaticDiscountNode: { id: string } | null;
            userErrors: { field: string[] | null; message: string }[];
          };
        }>(
          `mutation DeactivateDiscount($id: ID!) {
             discountAutomaticDeactivate(id: $id) {
               automaticDiscountNode { id }
               userErrors { field message }
             }
           }`,
          { id: ref.discount_external_id }
        );
        const { userErrors } = result.discountAutomaticDeactivate;
        if (userErrors.length > 0) {
          errors.push(...userErrors.map((e) => e.message));
        }
      }
    } catch (err) {
      errors.push(`Discount ${ref.discount_external_id}: ${String(err)}`);
    }
  }

  // Update bundle enabled flag regardless of Shopify sync status
  await sql`
    UPDATE bundles SET enabled = ${enabled}, updated_at = now()
    WHERE id = ${bundle_id}
  `;

  res.json({ bundle_id, enabled, status: errors.length === 0 ? "ok" : "error", errors });
});
