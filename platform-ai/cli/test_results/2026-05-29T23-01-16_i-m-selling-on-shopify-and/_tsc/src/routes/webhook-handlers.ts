import { Request } from "express";
import { sql } from "../lib/db.js";
import type {
  BundleId,
  OrderPaidPayload,
  ProductUpdatePayload,
  BundleMemberRow,
} from "../types/contracts.js";

type WebhookHandler = (payload: unknown, req: Request) => Promise<void>;

export const webhookHandlers: Record<string, WebhookHandler> = {
  "orders/paid": async (rawPayload: unknown, _req: Request): Promise<void> => {
    const payload = rawPayload as OrderPaidPayload;
    const orderId = payload.id;

    console.log({ topic: "orders/paid", orderId }, "processing paid order for bundle purchase count");

    // Collect all product ids from the order's line items
    const lineItemProductIds: string[] = [];
    for (const item of payload.line_items) {
      if (item.product_id != null) {
        lineItemProductIds.push(String(item.product_id));
      }
    }

    if (lineItemProductIds.length === 0) {
      console.log({ topic: "orders/paid", orderId }, "no product ids in line items, skipping");
      return;
    }

    // Find all bundle members that reference any of these products
    const matchingMembers = await sql<{ bundle_id: BundleId }[]>`
      SELECT DISTINCT bundle_id
      FROM bundle_members
      WHERE product_external_id = ANY(${lineItemProductIds}::BIGINT[])
    `;

    // Also check via variant ids
    const lineItemVariantIds: string[] = [];
    for (const item of payload.line_items) {
      if (item.variant_id != null) {
        lineItemVariantIds.push(String(item.variant_id));
      }
    }

    const variantMatchingMembers = lineItemVariantIds.length > 0
      ? await sql<{ bundle_id: BundleId }[]>`
          SELECT DISTINCT bundle_id
          FROM bundle_members
          WHERE variant_external_id = ANY(${lineItemVariantIds}::BIGINT[])
        `
      : [];

    // Merge all matched bundle ids
    const bundleIdSet = new Set<string>();
    for (const row of matchingMembers) {
      bundleIdSet.add(String(row.bundle_id));
    }
    for (const row of variantMatchingMembers) {
      bundleIdSet.add(String(row.bundle_id));
    }

    if (bundleIdSet.size === 0) {
      console.log({ topic: "orders/paid", orderId }, "no bundle members matched, skipping");
      return;
    }

    // Insert purchase count rows idempotently
    for (const bundleId of bundleIdSet) {
      try {
        await sql`
          INSERT INTO bundle_purchase_counts (bundle_id, order_external_id)
          VALUES (${bundleId}, ${String(orderId)})
          ON CONFLICT (bundle_id, order_external_id) DO NOTHING
        `;
        console.log({ topic: "orders/paid", orderId, bundleId }, "recorded bundle purchase");
      } catch (err) {
        console.error({ topic: "orders/paid", orderId, bundleId, err: String(err) }, "failed to record bundle purchase");
      }
    }
  },

  "products/update": async (rawPayload: unknown, _req: Request): Promise<void> => {
    const payload = rawPayload as ProductUpdatePayload;
    const productId = payload.id;
    const productStatus = payload.status;

    console.log({ topic: "products/update", productId, status: productStatus }, "processing product update");

    // Determine if the product itself is unavailable
    const productUnavailable = productStatus !== "active";

    // Collect variant ids that exist in the updated product
    const activeVariantIds = new Set<string>(
      payload.variants.map((v) => String(v.id))
    );

    // Find all bundle members referencing this product
    const productMembers = await sql<BundleMemberRow[]>`
      SELECT id, bundle_id, product_external_id, variant_external_id,
             available, position, created_at, updated_at
      FROM bundle_members
      WHERE product_external_id = ${String(productId)}
    `;

    if (productMembers.length === 0) {
      console.log({ topic: "products/update", productId }, "no bundle members reference this product, skipping");
      return;
    }

    // Update availability for each member
    for (const member of productMembers) {
      let available: boolean;

      if (productUnavailable) {
        // Product is archived or draft — mark all its members unavailable
        available = false;
      } else if (member.variant_external_id) {
        // Member is pinned to a specific variant — check if that variant still exists
        const variantStillActive = activeVariantIds.has(member.variant_external_id);
        if (!variantStillActive) {
          available = false;
        } else {
          // Check variant-level availability from payload
          const variantData = payload.variants.find(
            (v) => String(v.id) === member.variant_external_id
          );
          available = variantData ? variantData.available : false;
        }
      } else {
        // Product-level member — available if product is active and has at least one available variant
        available = payload.variants.some((v) => v.available);
      }

      if (available !== member.available) {
        await sql`
          UPDATE bundle_members
          SET available = ${available}, updated_at = now()
          WHERE id = ${member.id}
        `;
        console.log(
          { topic: "products/update", productId, memberId: member.id, available },
          "updated bundle member availability"
        );
      }
    }
  },
};
