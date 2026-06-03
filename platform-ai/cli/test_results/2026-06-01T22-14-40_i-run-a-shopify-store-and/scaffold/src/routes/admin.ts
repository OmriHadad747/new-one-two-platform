import { Request, Response, Router } from "express";
import { sql } from "../lib/db.js";
import type {
  WaitlistSnapshotRow,
  WaitlistEntryRow,
  EmailTemplateRow,
  AppSettingsRow,
  AdminDashboardResponse,
  AdminDashboardProduct,
  AdminWaitlistResponse,
  AdminWaitlistEntry,
  AdminWaitlistExportResponse,
  AdminStatsResponse,
  AdminTemplateGetResponse,
  AdminTemplatePutRequest,
  AdminTemplatePutResponse,
  AdminSettingsGetResponse,
  AdminSettingsPutRequest,
  AdminSettingsPutResponse,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── GET /admin/dashboard ────────────────────────────────────────────────────
// Return a paginated list of products ranked by active waitlist size.

adminRouter.get("/admin/dashboard", async (req: Request, res: Response) => {
  const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const PAGE_SIZE = 20;

  // Decode cursor: last product_external_id seen
  let cursorProductId: string | null = null;
  if (cursorRaw) {
    try {
      cursorProductId = Buffer.from(cursorRaw, "base64").toString("utf-8");
    } catch {
      res.status(400).json({ error: "invalid cursor" });
      return;
    }
  }

  // Count total
  const countResult = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM waitlist_snapshots
  `;
  const totalCount = parseInt(countResult[0]?.count ?? "0", 10);

  // Keyset pagination on (active_entry_count DESC, product_external_id ASC)
  let rows: Pick<WaitlistSnapshotRow, "product_external_id" | "product_title" | "active_entry_count" | "total_notified_count" | "total_conversion_count">[];

  if (cursorProductId) {
    // Get the active_entry_count of the cursor row to paginate correctly
    const cursorRows = await sql<{ active_entry_count: number }[]>`
      SELECT active_entry_count FROM waitlist_snapshots
      WHERE product_external_id = ${cursorProductId}
    `;
    const cursorCount = cursorRows[0]?.active_entry_count ?? 0;

    rows = await sql<typeof rows>`
      SELECT
        product_external_id,
        product_title,
        active_entry_count,
        total_notified_count,
        total_conversion_count
      FROM waitlist_snapshots
      WHERE (active_entry_count < ${cursorCount})
         OR (active_entry_count = ${cursorCount} AND product_external_id > ${cursorProductId})
      ORDER BY active_entry_count DESC, product_external_id ASC
      LIMIT ${PAGE_SIZE}
    `;
  } else {
    rows = await sql<typeof rows>`
      SELECT
        product_external_id,
        product_title,
        active_entry_count,
        total_notified_count,
        total_conversion_count
      FROM waitlist_snapshots
      ORDER BY active_entry_count DESC, product_external_id ASC
      LIMIT ${PAGE_SIZE}
    `;
  }

  const products: AdminDashboardProduct[] = rows.map((r) => ({
    product_external_id: String(r.product_external_id),
    product_title: r.product_title,
    active_entry_count: r.active_entry_count,
    total_notified_count: r.total_notified_count,
    total_conversion_count: r.total_conversion_count,
  }));

  let nextCursor: string | null = null;
  if (rows.length === PAGE_SIZE) {
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      nextCursor = Buffer.from(String(lastRow.product_external_id)).toString("base64");
    }
  }

  const response: AdminDashboardResponse = {
    products,
    next_cursor: nextCursor,
    total_count: totalCount,
  };

  res.status(200).json(response);
});

// ─── GET /admin/waitlist ─────────────────────────────────────────────────────
// Return a paginated list of individual subscribers for a specific product/variant.

adminRouter.get("/admin/waitlist", async (req: Request, res: Response) => {
  const productExternalId = typeof req.query.product_external_id === "string"
    ? req.query.product_external_id
    : null;
  const variantExternalId = typeof req.query.variant_external_id === "string"
    ? req.query.variant_external_id
    : null;
  const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : null;

  if (!productExternalId) {
    res.status(400).json({ error: "product_external_id is required" });
    return;
  }
  if (!/^\d+$/.test(productExternalId)) {
    res.status(400).json({ error: "product_external_id must be numeric" });
    return;
  }

  const PAGE_SIZE = 50;

  // Decode cursor: signed_up_at ISO string + id
  let cursorSignedUpAt: string | null = null;
  let cursorId: string | null = null;
  if (cursorRaw) {
    try {
      const parts = Buffer.from(cursorRaw, "base64").toString("utf-8").split("|");
      cursorSignedUpAt = parts[0] ?? null;
      cursorId = parts[1] ?? null;
    } catch {
      res.status(400).json({ error: "invalid cursor" });
      return;
    }
  }

  // Count total matching entries
  let totalCount: number;
  if (variantExternalId) {
    const cr = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM waitlist_entries
      WHERE product_external_id = ${productExternalId}
        AND variant_external_id = ${variantExternalId}
        AND deleted_at IS NULL
    `;
    totalCount = parseInt(cr[0]?.count ?? "0", 10);
  } else {
    const cr = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM waitlist_entries
      WHERE product_external_id = ${productExternalId}
        AND variant_external_id IS NULL
        AND deleted_at IS NULL
    `;
    totalCount = parseInt(cr[0]?.count ?? "0", 10);
  }

  // Fetch page
  let rows: Pick<WaitlistEntryRow, "id" | "shopper_email" | "product_external_id" | "variant_external_id" | "scope" | "status" | "signed_up_at" | "deleted_at">[];

  if (variantExternalId) {
    if (cursorSignedUpAt && cursorId) {
      rows = await sql<typeof rows>`
        SELECT id, shopper_email, product_external_id, variant_external_id,
               scope, status, signed_up_at, deleted_at
        FROM waitlist_entries
        WHERE product_external_id = ${productExternalId}
          AND variant_external_id = ${variantExternalId}
          AND deleted_at IS NULL
          AND (signed_up_at > ${cursorSignedUpAt} OR (signed_up_at = ${cursorSignedUpAt} AND id > ${cursorId}))
        ORDER BY signed_up_at ASC, id ASC
        LIMIT ${PAGE_SIZE}
      `;
    } else {
      rows = await sql<typeof rows>`
        SELECT id, shopper_email, product_external_id, variant_external_id,
               scope, status, signed_up_at, deleted_at
        FROM waitlist_entries
        WHERE product_external_id = ${productExternalId}
          AND variant_external_id = ${variantExternalId}
          AND deleted_at IS NULL
        ORDER BY signed_up_at ASC, id ASC
        LIMIT ${PAGE_SIZE}
      `;
    }
  } else {
    if (cursorSignedUpAt && cursorId) {
      rows = await sql<typeof rows>`
        SELECT id, shopper_email, product_external_id, variant_external_id,
               scope, status, signed_up_at, deleted_at
        FROM waitlist_entries
        WHERE product_external_id = ${productExternalId}
          AND variant_external_id IS NULL
          AND deleted_at IS NULL
          AND (signed_up_at > ${cursorSignedUpAt} OR (signed_up_at = ${cursorSignedUpAt} AND id > ${cursorId}))
        ORDER BY signed_up_at ASC, id ASC
        LIMIT ${PAGE_SIZE}
      `;
    } else {
      rows = await sql<typeof rows>`
        SELECT id, shopper_email, product_external_id, variant_external_id,
               scope, status, signed_up_at, deleted_at
        FROM waitlist_entries
        WHERE product_external_id = ${productExternalId}
          AND variant_external_id IS NULL
          AND deleted_at IS NULL
        ORDER BY signed_up_at ASC, id ASC
        LIMIT ${PAGE_SIZE}
      `;
    }
  }

  const entries: AdminWaitlistEntry[] = rows.map((r) => ({
    id: String(r.id),
    shopper_email: r.shopper_email,
    product_external_id: String(r.product_external_id),
    variant_external_id: r.variant_external_id !== null ? String(r.variant_external_id) : null,
    scope: r.scope,
    status: r.status,
    signed_up_at: r.signed_up_at instanceof Date ? r.signed_up_at.toISOString() : String(r.signed_up_at),
    deleted_at: r.deleted_at instanceof Date ? r.deleted_at.toISOString() : r.deleted_at !== null ? String(r.deleted_at) : null,
  }));

  let nextCursor: string | null = null;
  if (rows.length === PAGE_SIZE) {
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      const signedUpAt = lastRow.signed_up_at instanceof Date
        ? lastRow.signed_up_at.toISOString()
        : String(lastRow.signed_up_at);
      nextCursor = Buffer.from(`${signedUpAt}|${lastRow.id}`).toString("base64");
    }
  }

  const response: AdminWaitlistResponse = {
    entries,
    next_cursor: nextCursor,
    total_count: totalCount,
  };

  res.status(200).json(response);
});

// ─── GET /admin/waitlist/export ───────────────────────────────────────────────
// Stream a CSV of all subscriber entries for a given product or variant.

adminRouter.get("/admin/waitlist/export", async (req: Request, res: Response) => {
  const productExternalId = typeof req.query.product_external_id === "string"
    ? req.query.product_external_id
    : null;
  const variantExternalId = typeof req.query.variant_external_id === "string"
    ? req.query.variant_external_id
    : null;

  if (!productExternalId) {
    res.status(400).json({ error: "product_external_id is required" });
    return;
  }
  if (!/^\d+$/.test(productExternalId)) {
    res.status(400).json({ error: "product_external_id must be numeric" });
    return;
  }

  let rows: Pick<WaitlistEntryRow, "id" | "shopper_email" | "product_external_id" | "variant_external_id" | "scope" | "status" | "signed_up_at" | "deleted_at">[];

  if (variantExternalId) {
    rows = await sql<typeof rows>`
      SELECT id, shopper_email, product_external_id, variant_external_id,
             scope, status, signed_up_at, deleted_at
      FROM waitlist_entries
      WHERE product_external_id = ${productExternalId}
        AND variant_external_id = ${variantExternalId}
      ORDER BY signed_up_at ASC
    `;
  } else {
    rows = await sql<typeof rows>`
      SELECT id, shopper_email, product_external_id, variant_external_id,
             scope, status, signed_up_at, deleted_at
      FROM waitlist_entries
      WHERE product_external_id = ${productExternalId}
      ORDER BY signed_up_at ASC
    `;
  }

  // Build CSV
  const csvLines: string[] = [
    "id,shopper_email,product_external_id,variant_external_id,scope,status,signed_up_at,deleted_at",
  ];

  for (const r of rows) {
    const cols = [
      r.id,
      r.shopper_email,
      String(r.product_external_id),
      r.variant_external_id !== null ? String(r.variant_external_id) : "",
      r.scope,
      r.status,
      r.signed_up_at instanceof Date ? r.signed_up_at.toISOString() : String(r.signed_up_at),
      r.deleted_at instanceof Date ? r.deleted_at.toISOString() : r.deleted_at !== null ? String(r.deleted_at) : "",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
    csvLines.push(cols.join(","));
  }

  const csvData = csvLines.join("\n");
  const response: AdminWaitlistExportResponse = { csv_data: csvData };
  res.status(200).json(response);
});

// ─── GET /admin/stats ─────────────────────────────────────────────────────────
// Return aggregated conversion funnel metrics.

adminRouter.get("/admin/stats", async (req: Request, res: Response) => {
  const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from : null;
  const dateTo = typeof req.query.date_to === "string" ? req.query.date_to : null;

  // Total signups in date range
  const signupsResult = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM waitlist_entries
    WHERE deleted_at IS NULL
      ${dateFrom ? sql`AND signed_up_at >= ${new Date(dateFrom)}` : sql``}
      ${dateTo ? sql`AND signed_up_at <= ${new Date(dateTo)}` : sql``}
  `;
  const totalSignups = parseInt(signupsResult[0]?.count ?? "0", 10);

  // Total notified (dispatched sends)
  const notifiedResult = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM notification_sends ns
    WHERE ns.status = 'dispatched'
      ${dateFrom ? sql`AND ns.dispatched_at >= ${new Date(dateFrom)}` : sql``}
      ${dateTo ? sql`AND ns.dispatched_at <= ${new Date(dateTo)}` : sql``}
  `;
  const totalNotified = parseInt(notifiedResult[0]?.count ?? "0", 10);

  // Total conversions
  const convertedResult = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM conversions c
    WHERE TRUE
      ${dateFrom ? sql`AND c.converted_at >= ${new Date(dateFrom)}` : sql``}
      ${dateTo ? sql`AND c.converted_at <= ${new Date(dateTo)}` : sql``}
  `;
  const totalConverted = parseInt(convertedResult[0]?.count ?? "0", 10);

  const response: AdminStatsResponse = {
    total_signups: totalSignups,
    total_notified: totalNotified,
    total_converted: totalConverted,
    next_cursor: null,
    total_count: 1,
  };

  res.status(200).json(response);
});

// ─── GET /admin/template ──────────────────────────────────────────────────────
// Return the current email subject and body template.

adminRouter.get("/admin/template", async (req: Request, res: Response) => {
  const rows = await sql<EmailTemplateRow[]>`
    SELECT id, subject_template, body_template, updated_at
    FROM email_template
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  if (!rows[0]) {
    // Return defaults if no template configured yet
    const response: AdminTemplateGetResponse = {
      subject_template: "{{product_name}} is back in stock!",
      body_template: `Hi,\n\n{{product_name}} ({{variant_label}}) is back in stock at {{product_url}}.\n\nTo unsubscribe from future alerts: {{unsubscribe_url}}\n\nThanks!`,
      updated_at: new Date(0).toISOString(),
    };
    res.status(200).json(response);
    return;
  }

  const row = rows[0];
  const response: AdminTemplateGetResponse = {
    subject_template: row.subject_template,
    body_template: row.body_template,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
  res.status(200).json(response);
});

// ─── PUT /admin/template ──────────────────────────────────────────────────────
// Save an updated email subject and body template.

adminRouter.put("/admin/template", async (req: Request, res: Response) => {
  const body = req.body as Partial<AdminTemplatePutRequest>;

  const subjectTemplate = typeof body.subject_template === "string" ? body.subject_template : null;
  const bodyTemplate = typeof body.body_template === "string" ? body.body_template : null;

  if (!subjectTemplate || !bodyTemplate) {
    res.status(400).json({ error: "subject_template and body_template are required" });
    return;
  }

  // Singleton: delete existing and insert fresh (or upsert pattern)
  await sql`DELETE FROM email_template`;
  const result = await sql<{ updated_at: Date }[]>`
    INSERT INTO email_template (subject_template, body_template, updated_at)
    VALUES (${subjectTemplate}, ${bodyTemplate}, now())
    RETURNING updated_at
  `;

  const updatedAt = result[0]?.updated_at;
  if (!updatedAt) {
    res.status(500).json({ error: "failed to save template" });
    return;
  }

  const response: AdminTemplatePutResponse = {
    success: true,
    updated_at: updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt),
  };

  console.log({ requestId: req.platform!.requestId }, "email template saved");
  res.status(200).json(response);
});

// ─── GET /admin/settings ──────────────────────────────────────────────────────
// Return the current quiet-hours window and per-restock notify cap.

adminRouter.get("/admin/settings", async (req: Request, res: Response) => {
  const rows = await sql<AppSettingsRow[]>`
    SELECT id, quiet_hours_start, quiet_hours_end, per_restock_notify_cap, updated_at
    FROM app_settings
    LIMIT 1
  `;

  if (!rows[0]) {
    // Return defaults
    const response: AdminSettingsGetResponse = {
      quiet_hours_start: 22,
      quiet_hours_end: 8,
      per_restock_notify_cap: 100,
      updated_at: new Date(0).toISOString(),
    };
    res.status(200).json(response);
    return;
  }

  const row = rows[0];
  const response: AdminSettingsGetResponse = {
    quiet_hours_start: row.quiet_hours_start,
    quiet_hours_end: row.quiet_hours_end,
    per_restock_notify_cap: row.per_restock_notify_cap,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
  res.status(200).json(response);
});

// ─── PUT /admin/settings ──────────────────────────────────────────────────────
// Save updated quiet-hours and notify-cap settings.

adminRouter.put("/admin/settings", async (req: Request, res: Response) => {
  const body = req.body as Partial<AdminSettingsPutRequest>;

  const quietHoursStart = typeof body.quiet_hours_start === "number" ? body.quiet_hours_start : null;
  const quietHoursEnd = typeof body.quiet_hours_end === "number" ? body.quiet_hours_end : null;
  const perRestockNotifyCap = typeof body.per_restock_notify_cap === "number" ? body.per_restock_notify_cap : null;

  if (quietHoursStart === null || quietHoursEnd === null || perRestockNotifyCap === null) {
    res.status(400).json({ error: "quiet_hours_start, quiet_hours_end, and per_restock_notify_cap are required" });
    return;
  }

  if (quietHoursStart < 0 || quietHoursStart > 23 || quietHoursEnd < 0 || quietHoursEnd > 23) {
    res.status(400).json({ error: "quiet hours must be between 0 and 23" });
    return;
  }

  if (perRestockNotifyCap < 1) {
    res.status(400).json({ error: "per_restock_notify_cap must be at least 1" });
    return;
  }

  // Singleton pattern: delete and re-insert
  await sql`DELETE FROM app_settings`;
  await sql`
    INSERT INTO app_settings (quiet_hours_start, quiet_hours_end, per_restock_notify_cap, updated_at)
    VALUES (${quietHoursStart}, ${quietHoursEnd}, ${perRestockNotifyCap}, now())
  `;

  console.log(
    {
      requestId: req.platform!.requestId,
      quiet_hours_start: quietHoursStart,
      quiet_hours_end: quietHoursEnd,
      per_restock_notify_cap: perRestockNotifyCap,
    },
    "settings saved",
  );

  const response: AdminSettingsPutResponse = { success: true };
  res.status(200).json(response);
});
