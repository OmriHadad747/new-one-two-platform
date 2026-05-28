import { Request } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import type {
  BundleId,
  BundleRow,
  BundleComponentRow,
  OrdersPaidPayload,
  ProductsDeletePayload,
  ProductsUpdatePayload,
  DiscountAutomaticDeactivatePayload,
} from "../types/contracts.js";

// ─── Helper: re-evaluate and update bundle availability ──────────────────────

async function reEvaluateBundleAvailability(bundleId: BundleId): Promise<void> {
  const [bundle] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${bundleId}
  `;
  if (!bundle) return;

  const components = await sql<BundleComponentRow[]>`
    SELECT * FROM bundle_components WHERE bundle_id = ${bundleId}
  `;

  if (components.length === 0) return;

  const availableCount = components.filter((c) => c.is_available).length;
  const totalCount = components.length;

  let newStatus: "active" | "degraded" | "suspended";
  const requiredCount =
    bundle.bundle_type === "flexible"
      ? (bundle.required_count ?? totalCount)
      : totalCount;

  if (availableCount >= totalCount) {
    newStatus = "active";
  } else if (availableCount >= requiredCount) {
    newStatus = "degraded";
  } else {
    newStatus = "suspended";
  }

  if (newStatus === bundle.availability_status) return;

  await sql`
    UPDATE bundles
    SET availability_status = ${newStatus}, updated_at = now()
    WHERE id = ${bundleId}
  `;

  // Deactivate Shopify discount if bundle transitions to suspended
  if (newStatus === "suspended" && bundle.shopify_discount_gid) {
    const discountGid = bundle.shopify_discount_gid;
    try {
      const shopify = await shopifyClientFor();
      const result = await shopify.graphql<DiscountAutomaticDeactivatePayload>(
        `mutation discountAutomaticDeactivate($id: ID!) {
          discountAutomaticDeactivate(id: $id) {
            automaticDiscountNode { id }
            userErrors { field message }
          }
        }`,
        { id: discountGid }
      );
      if (result.discountAutomaticDeactivate.userErrors.length > 0) {
        console.warn(
          { bundleId, errors: result.discountAutomaticDeactivate.userErrors },
          "discountAutomaticDeactivate userErrors on suspension"
        );
      }
    } catch (err) {
      console.error({ bundleId, err: String(err) }, "Failed to deactivate discount on suspension");
    }
  }

  console.log(
    { bundleId, oldStatus: bundle.availability_status, newStatus },
    "bundle availability updated"
  );
}

// ─── Handler type ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebhookHandler = (payload: any, req: Request) => Promise<void>;

// ─── Webhook Handlers ─────────────────────────────────────────────────────────

export const webhookHandlers: Record<string, WebhookHandler> = {
  "orders/paid": async (payload: OrdersPaidPayload, _req: Request): Promise<void> => {
    const orderId = payload.id;

    console.log({ topic: "orders/paid", orderId }, "received");

    // Extract bundle_id from note_attributes
    const bundleAttr = (payload.note_attributes as Array<{ name: string; value: string }>).find(
      (attr) => attr.name === "bundle_id"
    );
    if (!bundleAttr || !bundleAttr.value) {
      console.log({ topic: "orders/paid", orderId }, "no bundle_id attribute, skipping");
      return;
    }

    const bundleId = bundleAttr.value as BundleId;

    const [bundle] = await sql<BundleRow[]>`
      SELECT id FROM bundles WHERE id = ${bundleId}
    `;
    if (!bundle) {
      console.warn({ topic: "orders/paid", orderId, bundleId }, "bundle not found, skipping");
      return;
    }

    const discountCodes = payload.discount_codes as Array<{ code: string; amount: string; type: string }>;
    const discountCodesApplied =
      discountCodes.length > 0
        ? discountCodes.map((dc) => dc.code).join(",")
        : null;

    // Idempotent insert — ON CONFLICT DO NOTHING
    await sql`
      INSERT INTO bundle_purchase_events (bundle_id, order_external_id, discount_codes_applied)
      VALUES (${bundleId}, ${orderId}, ${discountCodesApplied})
      ON CONFLICT (bundle_id, order_external_id) DO NOTHING
    `;

    // Re-count to keep purchase_count accurate and idempotent
    const [countRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM bundle_purchase_events WHERE bundle_id = ${bundleId}
    `;
    const total = parseInt(countRow?.count ?? "0", 10);

    await sql`
      UPDATE bundles SET purchase_count = ${total}, updated_at = now() WHERE id = ${bundleId}
    `;

    console.log({ topic: "orders/paid", orderId, bundleId, total }, "purchase event recorded");
  },

  "products/update": async (payload: ProductsUpdatePayload, _req: Request): Promise<void> => {
    const productId = payload.id;

    console.log({ topic: "products/update", productId }, "received");

    const productActive = payload.status === "active";
    const variants = (payload.variants ?? []) as Array<{ id: number; inventory_quantity: number; inventory_management: string | null }>;
    const hasInventory = variants.some(
      (v) => v.inventory_management === null || v.inventory_quantity > 0
    );
    const productAvailable = productActive && hasInventory;

    const affectedComponents = await sql<BundleComponentRow[]>`
      SELECT * FROM bundle_components
      WHERE product_external_id = ${productId}
    `;

    if (affectedComponents.length === 0) {
      console.log({ topic: "products/update", productId }, "no affected bundle components, skipping");
      return;
    }

    // Update whole-product components
    await sql`
      UPDATE bundle_components
      SET is_available = ${productAvailable}
      WHERE product_external_id = ${productId}
        AND variant_external_id IS NULL
    `;

    // Update variant-specific components
    for (const v of variants) {
      const variantAvailable =
        productActive &&
        (v.inventory_management === null || v.inventory_quantity > 0);
      await sql`
        UPDATE bundle_components
        SET is_available = ${variantAvailable}
        WHERE variant_external_id = ${v.id}
          AND product_external_id = ${productId}
      `;
    }

    // Re-evaluate affected bundles
    const affectedBundleIdSet = new Set<string>(affectedComponents.map((c) => String(c.bundle_id)));
    const affectedBundleIds = Array.from(affectedBundleIdSet) as BundleId[];

    for (const bundleId of affectedBundleIds) {
      await reEvaluateBundleAvailability(bundleId);
    }

    console.log(
      { topic: "products/update", productId, affectedBundles: affectedBundleIds.length },
      "product availability propagated"
    );
  },

  "products/delete": async (payload: ProductsDeletePayload, _req: Request): Promise<void> => {
    const productId = payload.id;

    console.log({ topic: "products/delete", productId }, "received");

    const affectedComponents = await sql<BundleComponentRow[]>`
      SELECT * FROM bundle_components
      WHERE product_external_id = ${productId}
    `;

    if (affectedComponents.length === 0) {
      console.log({ topic: "products/delete", productId }, "no affected bundle components, skipping");
      return;
    }

    await sql`
      UPDATE bundle_components
      SET is_available = false
      WHERE product_external_id = ${productId}
    `;

    const affectedBundleIdSet = new Set<string>(affectedComponents.map((c) => String(c.bundle_id)));
    const affectedBundleIds = Array.from(affectedBundleIdSet) as BundleId[];

    for (const bundleId of affectedBundleIds) {
      await reEvaluateBundleAvailability(bundleId);
    }

    console.log(
      { topic: "products/delete", productId, affectedBundles: affectedBundleIds.length },
      "product deletion propagated to bundles"
    );
  },
};
