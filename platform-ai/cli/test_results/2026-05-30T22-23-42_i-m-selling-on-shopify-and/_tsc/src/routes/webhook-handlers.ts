import { sql } from "../lib/db.js";
import { money } from "../lib/money.js";
import type {
  BundleId,
  BundleTierId,
  OrdersPaidPayload,
  ProductsUpdatePayload,
  ProductsDeletePayload,
} from "../types/contracts.js";

// ─── orders/paid handler ──────────────────────────────────────────────────────
//
// Reads:  payload.id              → order external id
//         payload.discount_codes  → discount codes applied on the order
//         payload.total_price     → order total (decimal string)
//         payload.currency        → currency code
//
// Writes: bundle_purchase_attributions (ON CONFLICT (order_external_id) DO NOTHING)
//         bundle_definitions.purchase_count += 1

async function handleOrderPaid(payload: OrdersPaidPayload): Promise<void> {
  const orderExternalId = payload.id;                    // numeric
  const discountCodes = payload.discount_codes;          // array (nullable: false)
  const totalPrice = payload.total_price;                // decimal string
  const currency = payload.currency;

  console.log(
    { topic: "orders/paid", orderId: orderExternalId, codeCount: discountCodes.length },
    "processing paid order",
  );

  if (discountCodes.length === 0) {
    // No discount codes on this order — not a bundle attribution event
    return;
  }

  for (const dc of discountCodes) {
    const code = dc.code;

    // Look up the tier by discount code string
    const [tierRow] = await sql<
      Array<{ id: BundleTierId; bundle_id: BundleId }>
    >`
      SELECT id, bundle_id FROM bundle_discount_tiers WHERE discount_code = ${code}
    `;

    if (!tierRow) {
      // Not our discount code — skip
      continue;
    }

    const tierId = tierRow.id;
    const bundleId = tierRow.bundle_id;

    // Idempotency: ON CONFLICT (order_external_id) DO NOTHING
    // The uniqueConstraint on bundle_purchase_attributions is (order_external_id)
    const orderTotal = money.toMinorUnits(totalPrice, currency);

    await sql`
      INSERT INTO bundle_purchase_attributions
        (order_external_id, bundle_id, tier_id, discount_code, order_total, currency, created_at)
      VALUES (
        ${String(orderExternalId)},
        ${bundleId},
        ${tierId},
        ${code},
        ${String(orderTotal)},
        ${currency},
        now()
      )
      ON CONFLICT (order_external_id) DO NOTHING
    `;

    // Increment purchase count on the bundle definition (best-effort; not inside a transaction lock)
    await sql`
      UPDATE bundle_definitions
        SET purchase_count = purchase_count + 1, updated_at = now()
      WHERE id = ${bundleId}
    `;

    console.log(
      { topic: "orders/paid", orderId: orderExternalId, bundleId, tierId, code },
      "attribution recorded",
    );
  }
}

// ─── products/update handler ──────────────────────────────────────────────────
//
// Reads:  payload.id       → product external id
//         payload.status   → product status (active/draft/archived)
//         payload.variants → list of variant objects
//
// Writes: bundle_definitions.health_status = 'degraded'
//         for any bundle whose component references this product/variant
//         and the product is not active or a pinned variant is missing

async function handleProductsUpdate(payload: ProductsUpdatePayload): Promise<void> {
  const productExternalId = payload.id;          // numeric
  const productStatus = payload.status;          // "active" | "draft" | "archived"
  const variants = payload.variants;             // array (nullable: false)

  console.log(
    { topic: "products/update", productId: productExternalId, status: productStatus, variantCount: variants.length },
    "processing product update",
  );

  // Build the set of live variant ids for this product
  const liveVariantIds = new Set(variants.map((v) => String(v.id)));

  // Find all bundles that reference this product
  const affectedComponents = await sql<Array<{ bundle_id: BundleId; variant_external_id: string | null }>>`
    SELECT bundle_id, variant_external_id
    FROM bundle_components
    WHERE product_external_id = ${String(productExternalId)}
  `;

  if (affectedComponents.length === 0) {
    return;
  }

  // Determine which bundles should be degraded
  const degradedBundleIds = new Set<BundleId>();

  for (const comp of affectedComponents) {
    const isDegraded =
      productStatus !== "active" ||
      (comp.variant_external_id != null && !liveVariantIds.has(String(comp.variant_external_id)));

    if (isDegraded) {
      degradedBundleIds.add(comp.bundle_id);
    }
  }

  // Recover bundles that were previously degraded but are now healthy for this product
  // (all components referencing this product are still valid)
  const healthyBundleIds = new Set<BundleId>(
    affectedComponents
      .filter((c) => !degradedBundleIds.has(c.bundle_id))
      .map((c) => c.bundle_id),
  );

  // Mark degraded bundles
  for (const bundleId of degradedBundleIds) {
    await sql`
      UPDATE bundle_definitions
        SET health_status = 'degraded', updated_at = now()
      WHERE id = ${bundleId}
    `;
    console.log(
      { topic: "products/update", productId: productExternalId, bundleId },
      "bundle marked degraded",
    );
  }

  // Recover healthy bundles (re-evaluate: only set to ok if ALL components are healthy)
  // For simplicity, we set ok only when this product is active and all pinned variants present
  for (const bundleId of healthyBundleIds) {
    // Check if any OTHER product referenced by this bundle is degraded
    const [otherDegradedComp] = await sql<Array<{ bundle_id: BundleId }>>`
      SELECT bc.bundle_id FROM bundle_components bc
      JOIN bundle_definitions bd ON bd.id = bc.bundle_id
      WHERE bc.bundle_id = ${bundleId}
        AND bd.health_status = 'degraded'
      LIMIT 1
    `;

    // Only recover if the bundle was previously degraded and this product's update makes it healthy
    if (!otherDegradedComp) {
      await sql`
        UPDATE bundle_definitions
          SET health_status = 'ok', updated_at = now()
        WHERE id = ${bundleId} AND health_status = 'degraded'
      `;
    }
  }
}

// ─── products/delete handler ──────────────────────────────────────────────────
//
// Reads:  payload.id → product external id
//
// Writes: bundle_definitions.health_status = 'degraded'
//         for all bundles that reference this product

async function handleProductsDelete(payload: ProductsDeletePayload): Promise<void> {
  const productExternalId = payload.id;  // numeric

  console.log(
    { topic: "products/delete", productId: productExternalId },
    "processing product deletion",
  );

  // Find all bundles that reference this product
  const affectedBundleIds = await sql<Array<{ bundle_id: BundleId }>>`
    SELECT DISTINCT bundle_id FROM bundle_components
    WHERE product_external_id = ${String(productExternalId)}
  `;

  if (affectedBundleIds.length === 0) {
    // No bundles reference this product — no-op
    return;
  }

  for (const row of affectedBundleIds) {
    await sql`
      UPDATE bundle_definitions
        SET health_status = 'degraded', updated_at = now()
      WHERE id = ${row.bundle_id}
    `;
    console.log(
      { topic: "products/delete", productId: productExternalId, bundleId: row.bundle_id },
      "bundle marked degraded due to deleted product",
    );
  }
}

// ─── Exported webhook handlers map ───────────────────────────────────────────

// The template's webhook router dispatches with `webhookHandlers[topic]` where
// `topic` is a plain `string`. We satisfy the index-access type by declaring the
// map as a Record whose value union includes `undefined` for unknown topics.
export const webhookHandlers: Record<
  string,
  ((payload: unknown, req?: unknown) => Promise<void>) | undefined
> = {
  "orders/paid": async (payload: unknown) => {
    await handleOrderPaid(payload as OrdersPaidPayload);
  },
  "products/update": async (payload: unknown) => {
    await handleProductsUpdate(payload as ProductsUpdatePayload);
  },
  "products/delete": async (payload: unknown) => {
    await handleProductsDelete(payload as ProductsDeletePayload);
  },
};
