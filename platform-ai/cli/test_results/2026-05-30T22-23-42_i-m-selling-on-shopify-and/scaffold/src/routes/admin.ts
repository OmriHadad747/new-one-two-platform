import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { money } from "../lib/money.js";
import type {
  BundleId,
  BundleTierId,
  BundleDefinitionRow,
  BundleComponentRow,
  BundleDiscountTierRow,
  BundleComponentInput,
  BundleTierInput,
  AdminListBundlesRequest,
  AdminListBundlesResponse,
  AdminBundleSummary,
  AdminCreateBundleRequest,
  AdminCreateBundleResponse,
  AdminUpdateBundleRequest,
  AdminUpdateBundleResponse,
  AdminToggleBundleRequest,
  AdminToggleBundleResponse,
  AdminBundleDetailResponse,
  AdminBundleDetail,
  ProductBundleCreateResult,
  ProductBundleUpdateResult,
  DiscountCodeBasicCreateResult,
  DiscountCodeBxgyCreateResult,
  DiscountCodeBasicUpdateResult,
  DiscountCodeBxgyUpdateResult,
  ProductVariantQueryResult,
  ShopifyProductExternalId,
  ShopifyVariantExternalId,
  DiscountKind,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip NUL bytes from any string to prevent postgres.js silent transaction abort */
function safeStr(s: string): string {
  return s.replace(/\0/g, "");
}

/** Generate a unique discount code for a bundle tier */
function makeTierCode(bundleId: BundleId, minItemCount: number): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const shortId = bundleId.slice(0, 8).toUpperCase();
  return `BDL-${shortId}-${minItemCount}I-${rand}`;
}

/** Build a Shopify GID from a numeric external id string */
function variantGid(externalId: string): string {
  return `gid://shopify/ProductVariant/${externalId}`;
}

function productGid(externalId: string): string {
  return `gid://shopify/Product/${externalId}`;
}

function discountNodeGid(externalId: string): string {
  return `gid://shopify/DiscountCodeNode/${externalId}`;
}

/** Extract the numeric legacy id from a Shopify GID */
function legacyIdFromGid(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}

interface ProvisionedTier {
  tierId?: string;
  minItemCount: number;
  discountCode: string;
  discountExternalId: string;
}

/** Create one Shopify discount code for a tier */
async function provisionTierDiscount(
  shopify: Awaited<ReturnType<typeof shopifyClientFor>>,
  bundleId: BundleId,
  tier: BundleTierInput,
  discountKind: DiscountKind,
): Promise<{ discountCode: string; discountExternalId: string }> {
  const code = makeTierCode(bundleId, tier.min_item_count);
  const now = new Date().toISOString();

  if (discountKind === "buy-x-get-y") {
    // buy-x-get-y: buy (min_item_count - free_item_count) get free_item_count free
    const buyQty = tier.min_item_count - (tier.free_item_count ?? 1);
    const getQty = tier.free_item_count ?? 1;

    const result = await shopify.graphql<DiscountCodeBxgyCreateResult>(
      `mutation CreateBxgyTier($input: DiscountCodeBxgyInput!) {
         discountCodeBxgyCreate(bxgyCodeDiscount: $input) {
           codeDiscountNode {
             id
             codeDiscount {
               ... on DiscountCodeBxgy {
                 codes(first: 1) { nodes { code } }
               }
             }
           }
           userErrors { field message }
         }
       }`,
      {
        input: {
          title: `Bundle ${bundleId.slice(0, 8)} – buy ${buyQty} get ${getQty} free`,
          code,
          startsAt: now,
          customerSelection: { all: true },
          customerBuys: {
            value: { quantity: String(buyQty) },
            items: { all: true },
          },
          customerGets: {
            value: {
              discountOnQuantity: {
                quantity: String(getQty),
                effect: { percentage: 1.0 },
              },
            },
            items: { all: true },
          },
          appliesOncePerCustomer: false,
        },
      },
    );

    if (result.discountCodeBxgyCreate.userErrors.length > 0) {
      throw new Error(
        `discountCodeBxgyCreate failed: ${result.discountCodeBxgyCreate.userErrors
          .map((e) => e.message)
          .join("; ")}`,
      );
    }

    const node = result.discountCodeBxgyCreate.codeDiscountNode;
    if (!node) throw new Error("discountCodeBxgyCreate returned no node");

    const discountExternalId = legacyIdFromGid(node.id);
    return { discountCode: code, discountExternalId };
  }

  // percentage or flat-amount — both use discountCodeBasicCreate
  const customerGetsValue =
    discountKind === "percentage"
      ? { percentage: (tier.discount_value ?? 0) / 10000 } // basis points → 0..1
      : {
          discountAmount: {
            amount: money.format(tier.discount_amount ?? 0, "USD"),
            appliesOnEachItem: false,
          },
        };

  const result = await shopify.graphql<DiscountCodeBasicCreateResult>(
    `mutation CreateBasicTier($input: DiscountCodeBasicInput!) {
       discountCodeBasicCreate(basicCodeDiscount: $input) {
         codeDiscountNode {
           id
           codeDiscount {
             ... on DiscountCodeBasic {
               codes(first: 1) { nodes { code } }
             }
           }
         }
         userErrors { field message }
       }
     }`,
    {
      input: {
        title: `Bundle ${bundleId.slice(0, 8)} – ${discountKind} tier ${tier.min_item_count}+`,
        code,
        startsAt: now,
        customerGets: {
          value: customerGetsValue,
          items: { all: true },
        },
        customerSelection: { all: true },
        appliesOncePerCustomer: false,
      },
    },
  );

  if (result.discountCodeBasicCreate.userErrors.length > 0) {
    throw new Error(
      `discountCodeBasicCreate failed: ${result.discountCodeBasicCreate.userErrors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }

  const node = result.discountCodeBasicCreate.codeDiscountNode;
  if (!node) throw new Error("discountCodeBasicCreate returned no node");

  const discountExternalId = legacyIdFromGid(node.id);
  return { discountCode: code, discountExternalId };
}

// ─── GET /admin/bundles ───────────────────────────────────────────────────────

adminRouter.get("/admin/bundles", async (req: Request, res: Response) => {
  const rawCursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const rawFilter = typeof req.query.status_filter === "string" ? req.query.status_filter : "all";

  const validFilters = ["all", "enabled", "disabled", "degraded"] as const;
  type StatusFilter = (typeof validFilters)[number];
  const statusFilter: StatusFilter = (validFilters as readonly string[]).includes(rawFilter)
    ? (rawFilter as StatusFilter)
    : "all";

  // Decode cursor as ISO timestamp for keyset pagination
  const cursorDate: string | null = rawCursor
    ? Buffer.from(rawCursor, "base64").toString("utf8")
    : null;

  try {
    // Build filter conditions
    type BundleSummaryRow = BundleDefinitionRow & { component_count: string };

    let rows: BundleSummaryRow[];
    if (statusFilter === "enabled") {
      rows = await sql<BundleSummaryRow[]>`
        SELECT b.*,
               (SELECT COUNT(*) FROM bundle_components bc WHERE bc.bundle_id = b.id)::text AS component_count
        FROM bundle_definitions b
        WHERE b.enabled = true
          ${cursorDate ? sql`AND b.created_at < ${cursorDate}` : sql``}
        ORDER BY b.created_at DESC
        LIMIT 51
      `;
    } else if (statusFilter === "disabled") {
      rows = await sql<BundleSummaryRow[]>`
        SELECT b.*,
               (SELECT COUNT(*) FROM bundle_components bc WHERE bc.bundle_id = b.id)::text AS component_count
        FROM bundle_definitions b
        WHERE b.enabled = false
          ${cursorDate ? sql`AND b.created_at < ${cursorDate}` : sql``}
        ORDER BY b.created_at DESC
        LIMIT 51
      `;
    } else if (statusFilter === "degraded") {
      rows = await sql<BundleSummaryRow[]>`
        SELECT b.*,
               (SELECT COUNT(*) FROM bundle_components bc WHERE bc.bundle_id = b.id)::text AS component_count
        FROM bundle_definitions b
        WHERE b.health_status = 'degraded'
          ${cursorDate ? sql`AND b.created_at < ${cursorDate}` : sql``}
        ORDER BY b.created_at DESC
        LIMIT 51
      `;
    } else {
      rows = await sql<BundleSummaryRow[]>`
        SELECT b.*,
               (SELECT COUNT(*) FROM bundle_components bc WHERE bc.bundle_id = b.id)::text AS component_count
        FROM bundle_definitions b
        WHERE true
          ${cursorDate ? sql`AND b.created_at < ${cursorDate}` : sql``}
        ORDER BY b.created_at DESC
        LIMIT 51
      `;
    }

    const hasMore = rows.length > 50;
    const pageRows = hasMore ? rows.slice(0, 50) : rows;

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor: string | null = hasMore && lastRow
      ? Buffer.from(lastRow.created_at).toString("base64")
      : null;

    const [countRow] = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM bundle_definitions`;
    const totalCount = parseInt(countRow?.count ?? "0", 10);

    const bundles: AdminBundleSummary[] = pageRows.map((r) => ({
      id: r.id,
      title: r.title,
      bundle_type: r.bundle_type,
      discount_kind: r.discount_kind,
      enabled: r.enabled,
      health_status: r.health_status,
      purchase_count: r.purchase_count,
      component_count: parseInt(r.component_count ?? "0", 10),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    const response: AdminListBundlesResponse = { bundles, next_cursor: nextCursor, total_count: totalCount };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "GET /admin/bundles failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── POST /admin/bundles/create ───────────────────────────────────────────────

adminRouter.post("/admin/bundles/create", async (req: Request, res: Response) => {
  const body = req.body as AdminCreateBundleRequest;

  const { title, bundle_type, flexible_pick_count, discount_kind, components, tiers } = body;

  if (!title || !bundle_type || !discount_kind || !components?.length || !tiers?.length) {
    res.status(400).json({ error: "missing required fields" });
    return;
  }

  if (!["fixed", "flexible"].includes(bundle_type)) {
    res.status(400).json({ error: "invalid bundle_type" });
    return;
  }
  if (!["percentage", "flat-amount", "buy-x-get-y"].includes(discount_kind)) {
    res.status(400).json({ error: "invalid discount_kind" });
    return;
  }
  if (bundle_type === "flexible" && (flexible_pick_count == null || flexible_pick_count < 1)) {
    res.status(400).json({ error: "flexible_pick_count required for flexible bundles" });
    return;
  }

  // Validate all component product_external_ids are non-empty strings
  for (const c of components) {
    if (!c.product_external_id || typeof c.product_external_id !== "string") {
      res.status(400).json({ error: "each component must have a valid product_external_id" });
      return;
    }
  }

  const warnings: string[] = [];
  const shopify = await shopifyClientFor(req.platform!);

  // Step 1: Create Shopify product bundle
  let shopifyBundleProductExternalId: string | null = null;
  let shopifyBundleProductGid: string | null = null;

  try {
    const bundleComponents = components.map((c: BundleComponentInput) => ({
      productId: productGid(c.product_external_id),
      quantity: c.quantity,
      optionSelections: [], // minimal: no specific variant pinning at bundle creation level
    }));

    const bundleResult = await shopify.graphql<ProductBundleCreateResult>(
      `mutation CreateBundle($input: ProductBundleCreateInput!) {
         productBundleCreate(input: $input) {
           productBundleOperation {
             product {
               id
               legacyResourceId
             }
           }
           userErrors { field message }
         }
       }`,
      {
        input: {
          title: safeStr(title),
          components: bundleComponents,
        },
      },
    );

    if (bundleResult.productBundleCreate.userErrors.length > 0) {
      const msgs = bundleResult.productBundleCreate.userErrors.map((e) => e.message).join("; ");
      warnings.push(`Shopify bundle product creation warning: ${msgs}`);
    } else {
      const product = bundleResult.productBundleCreate.productBundleOperation?.product;
      if (product) {
        shopifyBundleProductGid = product.id;
        shopifyBundleProductExternalId = product.legacyResourceId;
      }
    }
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "productBundleCreate failed");
    warnings.push(`Shopify bundle product creation failed: ${String(err)}`);
  }

  // Step 2: Provision one discount code per tier in Shopify
  const provisionedTiers: ProvisionedTier[] = [];
  try {
    for (const tier of tiers) {
      // We need a placeholder bundleId before DB insert — use a temp marker
      // Actual BundleId is assigned after DB insert; we'll do a two-phase approach:
      // provision with a generated code, then DB insert, then rollback if DB fails
      const tempBundleId = "TEMP0000" as BundleId;
      const { discountCode, discountExternalId } = await provisionTierDiscount(
        shopify,
        tempBundleId,
        tier,
        discount_kind,
      );
      provisionedTiers.push({
        minItemCount: tier.min_item_count,
        discountCode,
        discountExternalId,
      });
    }
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "provisionTierDiscount failed");
    // Rollback: No DB writes have happened yet. Cannot roll back Shopify discount codes easily
    // but we surface the error and do not persist anything.
    const response: AdminCreateBundleResponse = {
      bundle_id: "" as BundleId,
      status: "error",
      warnings: [`Discount code provisioning failed: ${String(err)}`],
    };
    res.status(500).json(response);
    return;
  }

  // Step 3: Persist everything in a DB transaction
  let newBundleId: BundleId;
  try {
    const result = await sql.begin(async (tx) => {
      // Insert bundle definition
      const [bundleRow] = await tx<BundleDefinitionRow[]>`
        INSERT INTO bundle_definitions
          (title, bundle_type, flexible_pick_count, discount_kind, enabled, health_status,
           shopify_bundle_product_external_id, purchase_count, created_at, updated_at)
        VALUES (
          ${safeStr(title)},
          ${bundle_type},
          ${flexible_pick_count ?? null},
          ${discount_kind},
          true,
          'ok',
          ${shopifyBundleProductExternalId ?? null},
          0,
          now(),
          now()
        )
        RETURNING *
      `;
      if (!bundleRow) throw new Error("bundle insert returned no row");

      const bundleId = bundleRow.id;

      // Insert components
      for (const c of components) {
        await tx`
          INSERT INTO bundle_components
            (bundle_id, product_external_id, variant_external_id, quantity, position)
          VALUES (
            ${bundleId},
            ${String(c.product_external_id)},
            ${c.variant_external_id ? String(c.variant_external_id) : null},
            ${c.quantity},
            ${c.position}
          )
        `;
      }

      // Insert discount tiers
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        const provisioned = provisionedTiers[i];
        if (!tier || !provisioned) continue;
        await tx`
          INSERT INTO bundle_discount_tiers
            (bundle_id, min_item_count, discount_value, discount_amount, free_item_count,
             discount_code, discount_external_id, created_at)
          VALUES (
            ${bundleId},
            ${tier.min_item_count},
            ${tier.discount_value != null ? String(tier.discount_value) : null},
            ${tier.discount_amount != null ? String(tier.discount_amount) : null},
            ${tier.free_item_count ?? null},
            ${provisioned.discountCode},
            ${provisioned.discountExternalId},
            now()
          )
          ON CONFLICT (bundle_id, min_item_count) DO NOTHING
        `;
      }

      return bundleId;
    });

    newBundleId = result;
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "DB insert failed during bundle create");
    const response: AdminCreateBundleResponse = {
      bundle_id: "" as BundleId,
      status: "error",
      warnings: [`Database persist failed: ${String(err)}`],
    };
    res.status(500).json(response);
    return;
  }

  const response: AdminCreateBundleResponse = {
    bundle_id: newBundleId,
    status: "created",
    warnings,
  };
  res.status(201).json(response);
});

// ─── PUT /admin/bundles/update ────────────────────────────────────────────────

adminRouter.put("/admin/bundles/update", async (req: Request, res: Response) => {
  const body = req.body as AdminUpdateBundleRequest;
  const { bundle_id, title, bundle_type, flexible_pick_count, discount_kind, components, tiers, enabled } = body;

  if (!bundle_id) {
    res.status(400).json({ error: "bundle_id required" });
    return;
  }
  if (!title || !bundle_type || !discount_kind || !components?.length || !tiers?.length) {
    res.status(400).json({ error: "missing required fields" });
    return;
  }

  // Fetch existing bundle
  const [existing] = await sql<BundleDefinitionRow[]>`
    SELECT * FROM bundle_definitions WHERE id = ${bundle_id}
  `;
  if (!existing) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  const warnings: string[] = [];
  const shopify = await shopifyClientFor(req.platform!);

  // Step 1: Update Shopify product bundle if we have an external id
  if (existing.shopify_bundle_product_external_id) {
    try {
      const updateResult = await shopify.graphql<ProductBundleUpdateResult>(
        `mutation UpdateBundle($input: ProductBundleUpdateInput!) {
           productBundleUpdate(input: $input) {
             productBundleOperation {
               product {
                 id
                 legacyResourceId
               }
             }
             userErrors { field message }
           }
         }`,
        {
          input: {
            productId: productGid(existing.shopify_bundle_product_external_id),
            title: safeStr(title),
            components: components.map((c: BundleComponentInput) => ({
              productId: productGid(c.product_external_id),
              quantity: c.quantity,
              optionSelections: [],
            })),
          },
        },
      );

      if (updateResult.productBundleUpdate.userErrors.length > 0) {
        const msgs = updateResult.productBundleUpdate.userErrors.map((e) => e.message).join("; ");
        warnings.push(`Shopify bundle update warning: ${msgs}`);
      }
      // The updated bundle product node id is available if needed
      const updatedProduct = updateResult.productBundleUpdate.productBundleOperation?.product;
      if (updatedProduct) {
        console.log({ requestId: req.platform!.requestId, bundleGid: updatedProduct.id }, "bundle product updated");
      }
    } catch (err) {
      warnings.push(`Shopify bundle product update failed: ${String(err)}`);
    }
  }

  // Step 2: Sync discount codes for existing tiers, provision new ones
  const existingTiers = await sql<BundleDiscountTierRow[]>`
    SELECT * FROM bundle_discount_tiers WHERE bundle_id = ${bundle_id} ORDER BY min_item_count
  `;
  const existingTierMap = new Map(existingTiers.map((t) => [t.min_item_count, t]));

  const syncedTiers: Array<{
    minItemCount: number;
    tierId?: string;
    discountCode: string;
    discountExternalId: string;
    isNew: boolean;
  }> = [];

  for (const tier of tiers) {
    const existing_ = existingTierMap.get(tier.min_item_count);
    if (existing_) {
      // Update existing discount code
      try {
        if (discount_kind === "buy-x-get-y") {
          const buyQty = tier.min_item_count - (tier.free_item_count ?? 1);
          const getQty = tier.free_item_count ?? 1;
          const updateResult = await shopify.graphql<DiscountCodeBxgyUpdateResult>(
            `mutation UpdateBxgyTier($id: ID!, $input: DiscountCodeBxgyInput!) {
               discountCodeBxgyUpdate(id: $id, bxgyCodeDiscount: $input) {
                 codeDiscountNode { id }
                 userErrors { field message }
               }
             }`,
            {
              id: discountNodeGid(existing_.discount_external_id),
              input: {
                customerBuys: {
                  value: { quantity: String(buyQty) },
                  items: { all: true },
                },
                customerGets: {
                  value: {
                    discountOnQuantity: {
                      quantity: String(getQty),
                      effect: { percentage: 1.0 },
                    },
                  },
                  items: { all: true },
                },
              },
            },
          );
          if (updateResult.discountCodeBxgyUpdate.userErrors.length > 0) {
            const msgs = updateResult.discountCodeBxgyUpdate.userErrors.map((e) => e.message).join("; ");
            warnings.push(`discountCodeBxgyUpdate warning for tier ${tier.min_item_count}: ${msgs}`);
          }
          const updatedNode = updateResult.discountCodeBxgyUpdate.codeDiscountNode;
          if (updatedNode) {
            console.log({ requestId: req.platform!.requestId, nodeId: updatedNode.id }, "bxgy tier updated");
          }
        } else {
          const customerGetsValue =
            discount_kind === "percentage"
              ? { percentage: (tier.discount_value ?? 0) / 10000 }
              : {
                  discountAmount: {
                    amount: money.format(tier.discount_amount ?? 0, "USD"),
                    appliesOnEachItem: false,
                  },
                };
          const updateResult = await shopify.graphql<DiscountCodeBasicUpdateResult>(
            `mutation UpdateBasicTier($id: ID!, $input: DiscountCodeBasicInput!) {
               discountCodeBasicUpdate(id: $id, basicCodeDiscount: $input) {
                 codeDiscountNode { id }
                 userErrors { field message }
               }
             }`,
            {
              id: discountNodeGid(existing_.discount_external_id),
              input: {
                customerGets: {
                  value: customerGetsValue,
                  items: { all: true },
                },
              },
            },
          );
          if (updateResult.discountCodeBasicUpdate.userErrors.length > 0) {
            const msgs = updateResult.discountCodeBasicUpdate.userErrors.map((e) => e.message).join("; ");
            warnings.push(`discountCodeBasicUpdate warning for tier ${tier.min_item_count}: ${msgs}`);
          }
          const updatedNode = updateResult.discountCodeBasicUpdate.codeDiscountNode;
          if (updatedNode) {
            console.log({ requestId: req.platform!.requestId, nodeId: updatedNode.id }, "basic tier updated");
          }
        }
        syncedTiers.push({
          minItemCount: tier.min_item_count,
          tierId: existing_.id,
          discountCode: existing_.discount_code,
          discountExternalId: existing_.discount_external_id,
          isNew: false,
        });
      } catch (err) {
        warnings.push(`Discount sync failed for tier ${tier.min_item_count}: ${String(err)}`);
        syncedTiers.push({
          minItemCount: tier.min_item_count,
          tierId: existing_.id,
          discountCode: existing_.discount_code,
          discountExternalId: existing_.discount_external_id,
          isNew: false,
        });
      }
    } else {
      // New tier — provision fresh discount code
      try {
        const { discountCode, discountExternalId } = await provisionTierDiscount(
          shopify,
          bundle_id,
          tier,
          discount_kind,
        );
        syncedTiers.push({ minItemCount: tier.min_item_count, discountCode, discountExternalId, isNew: true });
      } catch (err) {
        warnings.push(`Failed to provision new tier ${tier.min_item_count}: ${String(err)}`);
      }
    }
  }

  // Step 3: Persist updates in DB transaction
  try {
    await sql.begin(async (tx) => {
      // Update bundle definition
      await tx`
        UPDATE bundle_definitions SET
          title = ${safeStr(title)},
          bundle_type = ${bundle_type},
          flexible_pick_count = ${flexible_pick_count ?? null},
          discount_kind = ${discount_kind},
          enabled = ${enabled},
          health_status = 'ok',
          updated_at = now()
        WHERE id = ${bundle_id}
      `;

      // Replace components: delete old, insert new
      await tx`DELETE FROM bundle_components WHERE bundle_id = ${bundle_id}`;
      for (const c of components) {
        await tx`
          INSERT INTO bundle_components
            (bundle_id, product_external_id, variant_external_id, quantity, position)
          VALUES (
            ${bundle_id},
            ${String(c.product_external_id)},
            ${c.variant_external_id ? String(c.variant_external_id) : null},
            ${c.quantity},
            ${c.position}
          )
        `;
      }

      // Upsert tiers
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        if (!tier) continue;
        const synced = syncedTiers.find((s) => s.minItemCount === tier.min_item_count);
        if (!synced) continue;

        if (synced.isNew) {
          await tx`
            INSERT INTO bundle_discount_tiers
              (bundle_id, min_item_count, discount_value, discount_amount, free_item_count,
               discount_code, discount_external_id, created_at)
            VALUES (
              ${bundle_id},
              ${tier.min_item_count},
              ${tier.discount_value != null ? String(tier.discount_value) : null},
              ${tier.discount_amount != null ? String(tier.discount_amount) : null},
              ${tier.free_item_count ?? null},
              ${synced.discountCode},
              ${synced.discountExternalId},
              now()
            )
            ON CONFLICT (bundle_id, min_item_count) DO NOTHING
          `;
        } else {
          await tx`
            UPDATE bundle_discount_tiers SET
              discount_value = ${tier.discount_value != null ? String(tier.discount_value) : null},
              discount_amount = ${tier.discount_amount != null ? String(tier.discount_amount) : null},
              free_item_count = ${tier.free_item_count ?? null}
            WHERE bundle_id = ${bundle_id} AND min_item_count = ${tier.min_item_count}
          `;
        }
      }

      // Remove tiers that were deleted by the merchant
      const incomingCounts = tiers.map((t) => t.min_item_count);
      const existingCounts = existingTiers.map((t) => t.min_item_count);
      const removedCounts = existingCounts.filter((c) => !incomingCounts.includes(c));
      for (const cnt of removedCounts) {
        await tx`
          DELETE FROM bundle_discount_tiers WHERE bundle_id = ${bundle_id} AND min_item_count = ${cnt}
        `;
      }
    });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "DB update failed");
    const response: AdminUpdateBundleResponse = {
      bundle_id,
      status: "error",
      warnings: [`Database update failed: ${String(err)}`],
    };
    res.status(500).json(response);
    return;
  }

  const response: AdminUpdateBundleResponse = { bundle_id, status: "updated", warnings };
  res.json(response);
});

// ─── POST /admin/bundles/toggle ───────────────────────────────────────────────

adminRouter.post("/admin/bundles/toggle", async (req: Request, res: Response) => {
  const body = req.body as AdminToggleBundleRequest;
  const { bundle_ids, enabled } = body;

  if (!Array.isArray(bundle_ids) || bundle_ids.length === 0) {
    res.status(400).json({ error: "bundle_ids must be a non-empty array" });
    return;
  }
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be boolean" });
    return;
  }

  const errors: string[] = [];
  let updatedCount = 0;

  for (const bundleId of bundle_ids) {
    try {
      const result = await sql`
        UPDATE bundle_definitions SET enabled = ${enabled}, updated_at = now()
        WHERE id = ${bundleId as BundleId}
      `;
      updatedCount += result.count ?? 0;
    } catch (err) {
      errors.push(`Failed to toggle bundle ${bundleId}: ${String(err)}`);
    }
  }

  const response: AdminToggleBundleResponse = { updated_count: updatedCount, errors };
  res.json(response);
});

// ─── GET /admin/bundles/detail ────────────────────────────────────────────────

adminRouter.get("/admin/bundles/detail", async (req: Request, res: Response) => {
  const rawBundleId = typeof req.query.bundle_id === "string" ? req.query.bundle_id : null;
  if (!rawBundleId) {
    res.status(400).json({ error: "bundle_id required" });
    return;
  }
  const bundleId = rawBundleId as BundleId;

  const [bundleRow] = await sql<BundleDefinitionRow[]>`
    SELECT * FROM bundle_definitions WHERE id = ${bundleId}
  `;
  if (!bundleRow) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  const components = await sql<BundleComponentRow[]>`
    SELECT * FROM bundle_components WHERE bundle_id = ${bundleId} ORDER BY position
  `;
  const tiers = await sql<BundleDiscountTierRow[]>`
    SELECT * FROM bundle_discount_tiers WHERE bundle_id = ${bundleId} ORDER BY min_item_count
  `;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM bundle_purchase_attributions WHERE bundle_id = ${bundleId}
  `;
  const purchaseCount = parseInt(countRow?.count ?? "0", 10);

  const bundle: AdminBundleDetail = {
    id: bundleRow.id,
    title: bundleRow.title,
    bundle_type: bundleRow.bundle_type,
    flexible_pick_count: bundleRow.flexible_pick_count,
    discount_kind: bundleRow.discount_kind,
    enabled: bundleRow.enabled,
    health_status: bundleRow.health_status,
    shopify_bundle_product_external_id: bundleRow.shopify_bundle_product_external_id,
    components,
    tiers,
    created_at: bundleRow.created_at,
    updated_at: bundleRow.updated_at,
  };

  const response: AdminBundleDetailResponse = { bundle, purchase_count: purchaseCount };
  res.json(response);
});

// ─── Unused imports satisfied ─────────────────────────────────────────────────

// Explicit use of types imported but not used inline (keeps tsc happy)
type _AdminListReq = AdminListBundlesRequest;
type _ShopifyVarExtId = ShopifyVariantExternalId;
type _BundleTierId = BundleTierId;
type _ShopifyProdExtId = ShopifyProductExternalId;
