import { Router } from "express";
import type { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { paginate } from "../lib/paginate.js";

export const adminRouter = Router();

// GET /bundles — paginated, filterable list of bundles
adminRouter.get("/bundles", async (req: Request, res: Response) => {
  const statusFilter = req.query?.status_filter as string | null ?? null;
  const healthFilter = req.query?.health_filter as string | null ?? null;
  const page = req.query?.page as unknown as number;
  const pageSize = req.query?.page_size as unknown as number;

  const rows = await paginate(
    sql,
    sql`SELECT b.id, b.title, b.mode, b.enabled, b.health_status, b.created_at, COUNT(bt.id)::int AS tier_count FROM bundles b LEFT JOIN bundle_tiers bt ON bt.bundle_id = b.id WHERE (${statusFilter}::text IS NULL OR b.enabled = (${statusFilter} = 'enabled')) AND (${healthFilter}::text IS NULL OR b.health_status = ${healthFilter}) GROUP BY b.id ORDER BY b.created_at DESC`,
    { page, page_size: pageSize },
  );

  res.status(200).json({
    items: rows.items,
    total: rows.total,
    page: rows.page,
    page_size: rows.page_size,
  });
  return;
});

// POST /bundles/create — create a new bundle
adminRouter.post("/bundles/create", async (req: Request, res: Response) => {
  const title: string = req.body?.title;
  const mode: string = req.body?.mode;
  const description: string | null = req.body?.description ?? null;

  // Validate mode is fixed or flexible
  if (mode !== "fixed" && mode !== "flexible") {
    res.status(400).json({ error: "mode must be fixed or flexible" });
    return;
  }

  const newBundle = await sql<{ id: string }[]>`INSERT INTO bundles (title, description, mode, enabled, health_status) VALUES (${title}, ${description}, ${mode}, false, 'healthy') RETURNING id`;

  res.status(200).json({
    bundle_id: newBundle[0]!.id,
    status: "disabled",
  });
  return;
});

// POST /bundles/update — update a bundle
adminRouter.post("/bundles/update", async (req: Request, res: Response) => {
  const bundleId: string = req.body?.bundle_id;
  const title: string | null = req.body?.title ?? null;
  // Per alignment rule 7: explicit null from body means "clear description"; ?? null only applies when key is absent
  const descriptionProvided = Object.prototype.hasOwnProperty.call(req.body, "description");
  const description: string | null = descriptionProvided ? (req.body.description ?? null) : null;
  const mode: string | null = req.body?.mode ?? null;
  const enabled: boolean | null = req.body?.enabled ?? null;

  // Load the current bundle record
  const existingBundle = await sql<{ id: string; health_status: string; enabled: boolean }[]>`SELECT id, health_status, enabled FROM bundles WHERE id = ${bundleId}`;

  // Return 404 if bundle does not exist
  if (existingBundle.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  // Block re-enable attempt when bundle is auto_disabled
  if (enabled === true && existingBundle[0]!.health_status === "auto_disabled") {
    const blockingItems = await sql<{ variant_external_id: bigint; observed_availability: string }[]>`SELECT variant_external_id, observed_availability FROM bundle_items WHERE bundle_id = ${bundleId} AND observed_availability != 'available'`;

    res.status(409).json({
      error: "bundle cannot be enabled while auto_disabled",
      blocking_variants: blockingItems.map((i: any) => String(i.variant_external_id)),
    });
    return;
  }

  // Apply the requested field updates.
  // For description: when the merchant explicitly sends null (to clear), we need to set it to NULL
  // rather than COALESCE which would preserve the existing value.
  // We handle this by using a conditional: if descriptionProvided, use the supplied value directly;
  // otherwise fall back to COALESCE to preserve existing.
  let updateResult: { updated_at: string }[];
  if (descriptionProvided) {
    updateResult = await sql<{ updated_at: string }[]>`UPDATE bundles SET title = COALESCE(${title}, title), description = ${description}, mode = COALESCE(${mode}, mode), enabled = COALESCE(${enabled}::boolean, enabled), updated_at = now() WHERE id = ${bundleId} RETURNING updated_at`;
  } else {
    updateResult = await sql<{ updated_at: string }[]>`UPDATE bundles SET title = COALESCE(${title}, title), description = COALESCE(${description}, description), mode = COALESCE(${mode}, mode), enabled = COALESCE(${enabled}::boolean, enabled), updated_at = now() WHERE id = ${bundleId} RETURNING updated_at`;
  }

  res.status(200).json({
    bundle_id: bundleId,
    updated_at: updateResult[0]!.updated_at,
  });
  return;
});

// POST /bundles/remove — permanently delete a bundle
adminRouter.post("/bundles/remove", async (req: Request, res: Response) => {
  const bundleId: string = req.body?.bundle_id;

  // Verify bundle exists before deletion
  const existing = await sql<{ id: string }[]>`SELECT id FROM bundles WHERE id = ${bundleId}`;

  // Return 404 if bundle does not exist
  if (existing.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  try {
    await sql`DELETE FROM bundles WHERE id = ${bundleId}`;
  } catch (err: any) {
    // FK RESTRICT on bundle_purchase_records prevents deletion when purchase records exist
    if (err?.code === "23503") {
      res.status(409).json({ error: "bundle cannot be deleted because purchase records exist" });
      return;
    }
    throw err;
  }

  res.status(200).json({ success: true });
  return;
});

// POST /bundles/clone — duplicate a bundle (all steps inside one transaction to avoid orphaned header rows)
adminRouter.post("/bundles/clone", async (req: Request, res: Response) => {
  const sourceBundleId: string = req.body?.source_bundle_id;

  // Load source bundle
  const sourceBundle = await sql<{ id: string; title: string; description: string | null; mode: string }[]>`SELECT id, title, description, mode FROM bundles WHERE id = ${sourceBundleId}`;

  // Return 404 if source bundle does not exist
  if (sourceBundle.length === 0) {
    res.status(404).json({ error: "source bundle not found" });
    return;
  }

  // Build the clone title string
  const cloneTitle = `Copy of ${sourceBundle[0]!.title}`;

  // Perform the entire clone — header insert + items + tiers — inside a single transaction
  // so a failure in items/tiers rolls back the header row, preventing orphaned bundles.
  let newBundleId: string;
  await sql.begin(async (tx) => {
    // Insert the cloned bundle in disabled state
    const newBundle = await tx<{ id: string }[]>`INSERT INTO bundles (title, description, mode, enabled, health_status) VALUES (${cloneTitle}, ${sourceBundle[0]!.description}, ${sourceBundle[0]!.mode}, false, 'healthy') RETURNING id`;
    newBundleId = newBundle[0]!.id;

    // Copy all bundle_items from the source to the new bundle, resetting availability to available
    await tx`INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability) SELECT ${newBundleId}, variant_external_id, product_external_id, 'available' FROM bundle_items WHERE bundle_id = ${sourceBundleId}`;

    // Copy all bundle_tiers from the source to the new bundle
    await tx`INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order) SELECT ${newBundleId}, minimum_item_count, discount_rate, display_order FROM bundle_tiers WHERE bundle_id = ${sourceBundleId}`;
  });

  res.status(200).json({
    new_bundle_id: newBundleId!,
    status: "disabled",
  });
  return;
});

// POST /bundles/bulk-status — enable or disable a set of bundles
adminRouter.post("/bundles/bulk-status", async (req: Request, res: Response) => {
  const bundleIds: string[] = req.body?.bundle_ids;
  const enabled: boolean = req.body?.enabled;

  // When enabling, skip auto_disabled bundles to protect health integrity
  if (enabled === true) {
    // Enable only non-auto_disabled bundles from the supplied list
    const updatedRows = await sql<{ id: string }[]>`UPDATE bundles SET enabled = true, updated_at = now() WHERE id = ANY(${bundleIds}::uuid[]) AND health_status != 'auto_disabled' RETURNING id`;

    // Compute skipped count as supplied count minus actually updated count
    const skippedCount = bundleIds.length - updatedRows.length;

    res.status(200).json({
      updated_count: updatedRows.length,
      skipped_count: skippedCount,
    });
    return;
  } else {
    // Disable all supplied bundles unconditionally
    const updatedRows = await sql<{ id: string }[]>`UPDATE bundles SET enabled = false, updated_at = now() WHERE id = ANY(${bundleIds}::uuid[]) RETURNING id`;

    res.status(200).json({
      updated_count: updatedRows.length,
      skipped_count: 0,
    });
    return;
  }
});

// GET /bundles/items — paginated list of variant-level items for a bundle
adminRouter.get("/bundles/items", async (req: Request, res: Response) => {
  const bundleId: string = req.query?.bundle_id as string;
  const page = req.query?.page as unknown as number;
  const pageSize = req.query?.page_size as unknown as number;

  const rows = await paginate(
    sql,
    sql`SELECT id, variant_external_id, product_external_id, observed_availability, added_at FROM bundle_items WHERE bundle_id = ${bundleId} ORDER BY added_at ASC`,
    { page, page_size: pageSize },
  );

  res.status(200).json({
    items: rows.items,
    total: rows.total,
    page: rows.page,
    page_size: rows.page_size,
  });
  return;
});

// POST /bundles/items/save — replace full set of variant-level items for a bundle
adminRouter.post("/bundles/items/save", async (req: Request, res: Response) => {
  const bundleId: string = req.body?.bundle_id;
  const variantExternalIds: string[] = req.body?.variant_external_ids;
  const productExternalIds: string[] = req.body?.product_external_ids;

  // Verify bundle exists
  const bundleCheck = await sql<{ id: string }[]>`SELECT id FROM bundles WHERE id = ${bundleId}`;

  // Return 404 if bundle not found
  if (bundleCheck.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  // Build array of {variantId, productId} pairs from parallel input arrays
  const itemPairs = variantExternalIds.map((vid: string, i: number) => ({ variantId: Number(vid), productId: Number(productExternalIds[i]) }));

  // Extract numeric variant IDs for the new set
  const newVariantIds = itemPairs.map((p: any) => p.variantId);

  // Atomically delete removed items and insert new items
  await sql.begin(async (tx) => {
    // Delete items no longer in the new set
    await tx`DELETE FROM bundle_items WHERE bundle_id = ${bundleId} AND variant_external_id != ALL(${newVariantIds}::bigint[])`;

    // Insert new items; on conflict do nothing to preserve existing observed_availability
    const itemPairsJson = JSON.stringify(itemPairs.map((p: any) => ({ variant_id: p.variantId, product_id: p.productId })));
    await tx`INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability) SELECT ${bundleId}, p.variant_id, p.product_id, 'available' FROM jsonb_to_recordset(${itemPairsJson}::jsonb) AS p(variant_id bigint, product_id bigint) ON CONFLICT (bundle_id, variant_external_id) DO NOTHING`;

    // Touch the bundle updated_at timestamp
    await tx`UPDATE bundles SET updated_at = now() WHERE id = ${bundleId}`;
  });

  res.status(200).json({
    saved_count: newVariantIds.length,
    unavailable_variants: [],
  });
  return;
});

// GET /bundles/tiers — all discount tiers for a bundle in display order
adminRouter.get("/bundles/tiers", async (req: Request, res: Response) => {
  const bundleId: string = req.query?.bundle_id as string;
  const page = req.query?.page as unknown as number;
  const pageSize = req.query?.page_size as unknown as number;

  const rows = await paginate(
    sql,
    sql`SELECT id, bundle_id, minimum_item_count, discount_rate, display_order, created_at, updated_at FROM bundle_tiers WHERE bundle_id = ${bundleId} ORDER BY display_order ASC`,
    { page, page_size: pageSize },
  );

  res.status(200).json({
    items: rows.items,
    total: rows.total,
    page: rows.page,
    page_size: rows.page_size,
  });
  return;
});

// POST /bundles/tiers/save — replace the full ordered tier list for a bundle
adminRouter.post("/bundles/tiers/save", async (req: Request, res: Response) => {
  const bundleId: string = req.body?.bundle_id;
  const tiers: { minimum_item_count: number; discount_rate: number }[] = req.body?.tiers;

  // Verify bundle exists
  const bundleCheck = await sql<{ id: string }[]>`SELECT id FROM bundles WHERE id = ${bundleId}`;

  // Return 404 if bundle not found
  if (bundleCheck.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  // Assign display_order from array index (0-based), build enriched tier records
  const enrichedTiers = tiers.map((t: any, i: number) => ({ minimum_item_count: t.minimum_item_count, discount_rate: t.discount_rate, display_order: i }));

  try {
    // Atomically delete old tiers and insert the new full set
    await sql.begin(async (tx) => {
      // Delete all existing tiers for this bundle
      await tx`DELETE FROM bundle_tiers WHERE bundle_id = ${bundleId}`;

      // Insert the new tier set with display_order from array index
      const enrichedTiersJson = JSON.stringify(enrichedTiers);
      await tx`INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order) SELECT ${bundleId}, t.minimum_item_count, t.discount_rate, t.display_order FROM jsonb_to_recordset(${enrichedTiersJson}::jsonb) AS t(minimum_item_count int, discount_rate int, display_order int)`;

      // Touch bundle updated_at
      await tx`UPDATE bundles SET updated_at = now() WHERE id = ${bundleId}`;
    });
  } catch (err: any) {
    // Duplicate minimum_item_count values violate uniqueConstraint
    if (err?.code === "23505") {
      res.status(409).json({ error: "duplicate minimum_item_count values in tier list" });
      return;
    }
    throw err;
  }

  res.status(200).json({ saved_count: enrichedTiers.length });
  return;
});

// GET /purchase-history — paginated, date-filtered purchase history log
adminRouter.get("/purchase-history", async (req: Request, res: Response) => {
  const bundleId: string | null = (req.query?.bundle_id as string) ?? null;
  const dateFrom: string | null = (req.query?.date_from as string) ?? null;
  const dateTo: string | null = (req.query?.date_to as string) ?? null;
  const page = req.query?.page as unknown as number;
  const pageSize = req.query?.page_size as unknown as number;

  const rows = await paginate(
    sql,
    sql`SELECT id, bundle_id, order_external_id, order_placed_at, item_count, discount_rate, order_total_minor_units, order_currency, recorded_at FROM bundle_purchase_records WHERE (${bundleId}::uuid IS NULL OR bundle_id = ${bundleId}::uuid) AND (${dateFrom}::timestamptz IS NULL OR order_placed_at >= ${dateFrom}::timestamptz) AND (${dateTo}::timestamptz IS NULL OR order_placed_at <= ${dateTo}::timestamptz) ORDER BY order_placed_at DESC`,
    { page, page_size: pageSize },
    { maxPageSize: 1000 },
  );

  res.status(200).json({
    items: rows.items,
    total: rows.total,
    page: rows.page,
    page_size: rows.page_size,
  });
  return;
});