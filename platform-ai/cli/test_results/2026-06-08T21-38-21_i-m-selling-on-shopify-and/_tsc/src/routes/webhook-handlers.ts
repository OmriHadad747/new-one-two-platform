import { sql } from "../lib/db.js";
import type { Request } from "express";
import type {
  OrdersCreatePayload,
  ProductsUpdatePayload,
  ProductsDeletePayload,
  BundleRow,
} from "../types/contracts.js";

// Webhook handlers: keyed by topic, dispatched by the template webhook router.
// IMPORTANT: req.platform is NOT available in webhook handlers.

export const webhookHandlers: Record<
  string,
  (payload: unknown, req: Request) => Promise<void>
> = {
  // ─── orders/create ─────────────────────────────────────────────────────────
  // Increment purchase_count exactly once per order per bundle when the order
  // contains the bundle's discount code.
  "orders/create": async (
    rawPayload: unknown,
    _req: Request
  ): Promise<void> => {
    const payload = rawPayload as OrdersCreatePayload;
    // Signal fields from payloadBindings:
    //   order external id  ← payload.id
    //   applied discount code strings ← payload.discount_codes[].code
    const orderExternalId = payload.id;
    const discountCodes: string[] = (payload.discount_codes ?? []).map(
      (d) => d.code
    );

    console.log(
      { topic: "orders/create", orderId: orderExternalId, codeCount: discountCodes.length },
      "Processing order for bundle purchase count"
    );

    if (discountCodes.length === 0) {
      // No discount codes on this order — nothing to attribute
      return;
    }

    // Find bundles whose discount_code_string matches any code on the order.
    // Case-insensitive match.
    const upperCodes = discountCodes.map((c) => c.toUpperCase());

    const matchingBundles = await sql<BundleRow[]>`
      SELECT id, discount_code_string
      FROM bundles
      WHERE UPPER(discount_code_string) = ANY(${upperCodes})
    `;

    for (const bundle of matchingBundles) {
      // Atomically: insert dedup row (ON CONFLICT DO NOTHING) and
      // increment purchase_count only when the dedup row is newly inserted.
      // We do this in a transaction:
      //   1. Try to insert the dedup row.
      //   2. If inserted (count = 1 unique row), update purchase_count.
      //   3. If conflict (already existed), skip the update.
      await sql.begin(async (tx) => {
        const insertResult = await tx`
          INSERT INTO bundle_order_increments (bundle_id, order_external_id)
          VALUES (${bundle.id}, ${orderExternalId})
          ON CONFLICT (bundle_id, order_external_id) DO NOTHING
        ` as unknown as { count: number };

        // postgres.js returns a Result with .count for non-SELECT statements
        // when rows are affected. If count === 0, this was a duplicate — skip.
        const affectedRows = (insertResult as unknown as { count: string }).count;
        if (String(affectedRows) === "0") {
          return; // Duplicate — already incremented for this order+bundle
        }

        await tx`
          UPDATE bundles
          SET purchase_count = purchase_count + 1,
              updated_at = now()
          WHERE id = ${bundle.id}
        `;
      });

      console.log(
        { topic: "orders/create", bundleId: bundle.id, orderId: orderExternalId },
        "Bundle purchase count incremented"
      );
    }
  },

  // ─── products/update ───────────────────────────────────────────────────────
  // Refresh availability flags on bundle_items when a product's status or
  // variant availability changes.
  "products/update": async (
    rawPayload: unknown,
    _req: Request
  ): Promise<void> => {
    const payload = rawPayload as ProductsUpdatePayload;
    // Signal fields from payloadBindings:
    //   product external id ← payload.id
    //   product status ← payload.status
    //   variant availability list ← payload.variants
    const productExternalId = payload.id;
    const productStatus = payload.status;
    const variants = payload.variants ?? [];

    console.log(
      { topic: "products/update", productId: productExternalId, status: productStatus },
      "Refreshing bundle item availability"
    );

    // A product is considered available when status === "active".
    const isProductActive = productStatus === "active";

    // Additionally check if any variant has inventory available.
    const anyVariantAvailable = variants.some(
      (v) =>
        v.inventory_quantity > 0 || v.inventory_policy === "continue"
    );

    // Available = product is active AND at least one variant is available
    const itemAvailable =
      isProductActive && (variants.length === 0 || anyVariantAvailable);

    // Update all bundle_items matching this product external id.
    // Idempotent: always overwrite with the latest state.
    await sql`
      UPDATE bundle_items
      SET available = ${itemAvailable}
      WHERE product_external_id = ${productExternalId}
    `;

    console.log(
      {
        topic: "products/update",
        productId: productExternalId,
        available: itemAvailable,
      },
      "Bundle item availability updated"
    );
  },

  // ─── products/delete ───────────────────────────────────────────────────────
  // Mark all bundle items for the deleted product as unavailable.
  "products/delete": async (
    rawPayload: unknown,
    _req: Request
  ): Promise<void> => {
    const payload = rawPayload as ProductsDeletePayload;
    // Signal field from payloadBindings:
    //   product external id ← payload.id
    const productExternalId = payload.id;

    console.log(
      { topic: "products/delete", productId: productExternalId },
      "Marking bundle items unavailable due to product deletion"
    );

    // Idempotent: marking already-unavailable items unavailable is a no-op.
    await sql`
      UPDATE bundle_items
      SET available = false
      WHERE product_external_id = ${productExternalId}
    `;

    console.log(
      { topic: "products/delete", productId: productExternalId },
      "Bundle items marked unavailable"
    );
  },
};
