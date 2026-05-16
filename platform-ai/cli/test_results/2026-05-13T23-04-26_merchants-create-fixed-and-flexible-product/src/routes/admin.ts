import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { paginate } from "../lib/paginate.js";

const adminRouter = Router();

// GET /bundles — paginated filterable list
adminRouter.get("/bundles", async (req: Request, res: Response): Promise<void> => {
  const statusFilter = req.query?.status_filter as string | undefined;
  const healthFilter = req.query?.health_filter as string | undefined;
  const page = req.query?.page;
  const pageSize = req.query?.page_size;

  const rows = await paginate(
    sql,
    sql`
      SELECT
        b.id,
        b.title,
        b.mode,
        b.enabled,
        b.health_status,
        b.created_at,
        COUNT(bt.id)::int AS tier_count
      FROM bundles b
      LEFT JOIN bundle_tiers bt ON bt.bundle_id = b.id
      WHERE
        (${statusFilter ?? null}::boolean IS NULL OR b.enabled = ${statusFilter ?? null}::boolean)
        AND (${healthFilter ?? null}::text IS NULL OR b.health_status = ${healthFilter ?? null}::text)
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `,
    { page: Number(page), page_size: Number(pageSize) },
  );

  res.status(200).json({
    items: rows.items,
    total: rows.total,
    page: rows.page,
    page_size: rows.page_size,
  });
  return;
});

// POST /bundles/create
adminRouter.post("/bundles/create", async (req: Request, res: Response): Promise<void> => {
  const title = req.body?.title;
  const mode = req.body?.mode;
  const description = req.body?.description ?? null;

  // Step: Validate required fields
  if (!title || !mode || !["fixed", "flexible"].includes(mode)) {
    res.status(400).json({ error: "title and mode (fixed|flexible) are required" });
    return;
  }

  // Step: Insert new bundle row
  const newBundle = await sql<{ id: string }[]>`
    INSERT INTO bundles (title, description, mode, enabled, health_status)
    VALUES (${title}, ${description}, ${mode}, false, 'healthy')
    RETURNING id
  `;

  res.status(201).json({
    bundle_id: newBundle[0]!.id,
    status: "created",
  });
  return;
});

// PUT /bundles/update
adminRouter.put("/bundles/update", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.body?.bundle_id;
  const title = req.body?.title ?? null;
  const description = req.body?.description ?? null;
  const descriptionProvided = req.body?.description_provided ?? null;
  const mode = req.body?.mode ?? null;
  const enabled = req.body?.enabled ?? null;

  // Step: Fetch current bundle state
  const existingBundle = await sql<
    { id: string; health_status: string; enabled: boolean }[]
  >`
    SELECT id, health_status, enabled FROM bundles WHERE id = ${bundleId}
  `;

  // Step: Return 404 if bundle not found
  if (existingBundle.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  // Step: Block re-enable when bundle is auto_disabled
  if (enabled === true && existingBundle[0]!.health_status === "auto_disabled") {
    const blockingVariants = await sql<
      { affected_variant_external_id: string }[]
    >`
      SELECT DISTINCT affected_variant_external_id
      FROM bundle_health_events
      WHERE bundle_id = ${bundleId}
        AND event_kind = 'auto_disabled'
      ORDER BY occurred_at DESC
      LIMIT 10
    `;

    res.status(409).json({
      error: "cannot enable bundle with health_status=auto_disabled",
      blocking_variants: blockingVariants.map((r) =>
        String(r.affected_variant_external_id),
      ),
    });
    return;
  }

  // Step: Build description clause value
  const descriptionValue = descriptionProvided === true ? description : undefined;

  // Step: Apply requested field updates
  const updatedBundle = await sql<{ updated_at: string }[]>`
    UPDATE bundles
    SET
      title = COALESCE(${title}, title),
      description = CASE WHEN ${descriptionProvided ?? null}::boolean IS TRUE THEN ${descriptionValue ?? null} ELSE description END,
      mode = COALESCE(${mode}, mode),
      enabled = COALESCE(${enabled}::boolean, enabled),
      updated_at = now()
    WHERE id = ${bundleId}
    RETURNING updated_at
  `;

  res.status(200).json({
    bundle_id: bundleId,
    updated_at: updatedBundle[0]!.updated_at,
  });
  return;
});

// POST /bundles/remove
adminRouter.post("/bundles/remove", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.body?.bundle_id;

  // Step: Check bundle exists
  const bundleExists = await sql<{ id: string }[]>`
    SELECT id FROM bundles WHERE id = ${bundleId}
  `;

  // Step: Return 404 if not found
  if (bundleExists.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  // Step: Delete the bundle (CASCADE removes items, tiers, health events)
  await sql`DELETE FROM bundles WHERE id = ${bundleId}`;

  res.status(200).json({ success: true });
  return;
});

// POST /bundles/clone
adminRouter.post("/bundles/clone", async (req: Request, res: Response): Promise<void> => {
  const sourceBundleId = req.body?.source_bundle_id;

  // Step: Fetch source bundle
  const sourceBundle = await sql<
    { title: string; description: string | null; mode: string }[]
  >`
    SELECT title, description, mode FROM bundles WHERE id = ${sourceBundleId}
  `;

  // Step: Return 404 if source not found
  if (sourceBundle.length === 0) {
    res.status(404).json({ error: "source bundle not found" });
    return;
  }

  let newBundle: { id: string }[] = [];

  // Step: Atomically insert new bundle, items, and tiers
  await sql.begin(async (tx) => {
    newBundle = await tx<{ id: string }[]>`
      INSERT INTO bundles (title, description, mode, enabled, health_status)
      VALUES (
        ${`Copy of ${sourceBundle[0]!.title}`},
        ${sourceBundle[0]!.description},
        ${sourceBundle[0]!.mode},
        false,
        'healthy'
      )
      RETURNING id
    `;

    await tx`
      INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
      SELECT ${newBundle[0]!.id}, variant_external_id, product_external_id, 'available'
      FROM bundle_items
      WHERE bundle_id = ${sourceBundleId}
    `;

    await tx`
      INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
      SELECT ${newBundle[0]!.id}, minimum_item_count, discount_rate, display_order
      FROM bundle_tiers
      WHERE bundle_id = ${sourceBundleId}
      ORDER BY display_order ASC
    `;
  });

  // Step: Read new bundle id
  const newBundleId = newBundle[0]!.id;

  res.status(201).json({
    new_bundle_id: newBundleId,
    status: "created",
  });
  return;
});

// POST /bundles/bulk-status
adminRouter.post("/bundles/bulk-status", async (req: Request, res: Response): Promise<void> => {
  const bundleIds = req.body?.bundle_ids;
  const enabled = req.body?.enabled;

  // Step: Validate input
  if (!Array.isArray(bundleIds) || bundleIds.length === 0) {
    res.status(400).json({ error: "bundle_ids must be a non-empty array" });
    return;
  }

  // Step: Update enabled flag for qualifying bundles
  const updatedRows = await sql<{ id: string }[]>`
    UPDATE bundles
    SET enabled = ${enabled}, updated_at = now()
    WHERE id = ANY(${bundleIds}::uuid[])
      AND (${enabled}::boolean = false OR health_status != 'auto_disabled')
    RETURNING id
  `;

  // Step: Compute skipped count
  const skippedCount = bundleIds.length - updatedRows.length;

  res.status(200).json({
    updated_count: updatedRows.length,
    skipped_count: skippedCount,
  });
  return;
});

// GET /bundles/items — paginated
adminRouter.get("/bundles/items", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.query?.bundle_id as string;
  const page = req.query?.page;
  const pageSize = req.query?.page_size;

  const rows = await paginate(
    sql,
    sql`
      SELECT id, bundle_id, variant_external_id, product_external_id, observed_availability, added_at
      FROM bundle_items
      WHERE bundle_id = ${bundleId}
      ORDER BY added_at ASC
    `,
    { page: Number(page), page_size: Number(pageSize) },
  );

  res.status(200).json({
    items: rows.items,
    total: rows.total,
    page: rows.page,
    page_size: rows.page_size,
  });
  return;
});

// POST /bundles/items/save
adminRouter.post("/bundles/items/save", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.body?.bundle_id;
  const variantExternalIds: string[] = req.body?.variant_external_ids ?? [];
  const productExternalIds: string[] = req.body?.product_external_ids ?? [];

  // Step: Validate equal length
  if (variantExternalIds.length !== productExternalIds.length) {
    res.status(400).json({
      error: "variant_external_ids and product_external_ids must have equal length",
    });
    return;
  }

  // Step: Check bundle exists
  const bundleExists = await sql<{ id: string }[]>`
    SELECT id FROM bundles WHERE id = ${bundleId}
  `;

  if (bundleExists.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  let insertedItems: { id: string }[] = [];

  // Step: Atomically delete old items and insert new set
  await sql.begin(async (tx) => {
    await tx`DELETE FROM bundle_items WHERE bundle_id = ${bundleId}`;

    insertedItems = await tx<{ id: string }[]>`
      INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
      SELECT ${bundleId}, v, p, 'available'
      FROM unnest(${variantExternalIds.map(Number)}::bigint[], ${productExternalIds.map(Number)}::bigint[]) AS t(v, p)
      ON CONFLICT (bundle_id, variant_external_id)
      DO UPDATE SET
        product_external_id = EXCLUDED.product_external_id,
        observed_availability = 'available'
      RETURNING id
    `;
  });

  // Step: Update bundle updated_at
  await sql`UPDATE bundles SET updated_at = now() WHERE id = ${bundleId}`;

  res.status(200).json({
    saved_count: insertedItems.length,
    unavailable_variants: [],
  });
  return;
});

// GET /bundles/tiers — paginated
adminRouter.get("/bundles/tiers", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.query?.bundle_id as string;
  const page = req.query?.page;
  const pageSize = req.query?.page_size;

  const rows = await paginate(
    sql,
    sql`
      SELECT id, bundle_id, minimum_item_count, discount_rate, display_order
      FROM bundle_tiers
      WHERE bundle_id = ${bundleId}
      ORDER BY display_order ASC
    `,
    { page: Number(page), page_size: Number(pageSize) },
  );

  res.status(200).json({
    items: rows.items,
    total: rows.total,
    page: rows.page,
    page_size: rows.page_size,
  });
  return;
});

// POST /bundles/tiers/save
adminRouter.post("/bundles/tiers/save", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.body?.bundle_id;
  const tiers: { minimum_item_count: number; discount_rate: number }[] =
    req.body?.tiers ?? [];

  // Step: Check bundle exists
  const bundleExists = await sql<{ id: string }[]>`
    SELECT id FROM bundles WHERE id = ${bundleId}
  `;

  if (bundleExists.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  // Step: Annotate each tier with display_order from array index
  const tiersWithOrder = (tiers ?? []).map((t, i) => ({
    minimum_item_count: t.minimum_item_count,
    discount_rate: Math.round(t.discount_rate),
    display_order: i + 1,
  }));

  let insertedTiers: { id: string }[] = [];

  // Step: Atomically delete old tiers and insert new ordered set
  await sql.begin(async (tx) => {
    await tx`DELETE FROM bundle_tiers WHERE bundle_id = ${bundleId}`;

    insertedTiers = await tx<{ id: string }[]>`
      INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
      SELECT ${bundleId}, mc, dr, do_
      FROM unnest(
        ${tiersWithOrder.map((t) => t.minimum_item_count)}::int[],
        ${tiersWithOrder.map((t) => t.discount_rate)}::int[],
        ${tiersWithOrder.map((t) => t.display_order)}::int[]
      ) AS t(mc, dr, do_)
      ON CONFLICT (bundle_id, minimum_item_count)
      DO UPDATE SET
        discount_rate = EXCLUDED.discount_rate,
        display_order = EXCLUDED.display_order,
        updated_at = now()
      RETURNING id
    `;
  });

  // Step: Update bundle updated_at
  await sql`UPDATE bundles SET updated_at = now() WHERE id = ${bundleId}`;

  res.status(200).json({ saved_count: insertedTiers.length });
  return;
});

// GET /purchase-history — paginated
adminRouter.get("/purchase-history", async (req: Request, res: Response): Promise<void> => {
  const bundleId = (req.query?.bundle_id as string) ?? null;
  const dateFrom = (req.query?.date_from as string) ?? null;
  const dateTo = (req.query?.date_to as string) ?? null;
  const page = req.query?.page;
  const pageSize = req.query?.page_size;

  const rows = await paginate(
    sql,
    sql`
      SELECT
        id,
        bundle_id,
        order_external_id,
        order_placed_at,
        item_count,
        discount_rate_applied,
        order_total_minor_units,
        order_currency,
        recorded_at
      FROM bundle_purchase_records
      WHERE
        (${bundleId}::uuid IS NULL OR bundle_id = ${bundleId}::uuid)
        AND (${dateFrom}::timestamptz IS NULL OR order_placed_at >= ${dateFrom}::timestamptz)
        AND (${dateTo}::timestamptz IS NULL OR order_placed_at <= ${dateTo}::timestamptz)
      ORDER BY order_placed_at DESC
    `,
    { page: Number(page), page_size: Number(pageSize) },
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

export { adminRouter };