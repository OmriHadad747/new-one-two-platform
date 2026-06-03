import { Request, Response, Router } from "express";
import { sql } from "../lib/db.js";
import type {
  ItemScope,
  WaitlistStatus,
  WaitlistEntryRow,
  NotificationSettingsRow,
  AdminDashboardResponse,
  AdminWaitlistResponse,
  AdminWaitlistExportResponse,
  AdminSettingsResponse,
  AdminSettingsSaveRequest,
  AdminSettingsSaveResponse,
  AdminStatsResponse,
  DashboardItem,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── GET /admin/dashboard ────────────────────────────────────────────────────
// Return products ranked by active waitlist size.
adminRouter.get("/admin/dashboard", async (req: Request, res: Response): Promise<void> => {
  const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const pageSize = 20;
  let offsetVal = 0;
  if (cursorRaw) {
    const parsed = parseInt(cursorRaw, 10);
    if (!isNaN(parsed)) offsetVal = parsed;
  }

  const [totalRow] = await sql<{ count: string }[]>`
    SELECT COUNT(DISTINCT item_external_id) AS count
    FROM waitlist_entries
  `;
  const totalCount = parseInt(totalRow?.count ?? "0", 10);

  const rows = await sql<{
    item_external_id: string;
    item_scope: string;
    product_external_id: string;
    active_count: string;
    total_count: string;
    notified_count: string;
    converted_count: string;
  }[]>`
    SELECT
      item_external_id::TEXT,
      item_scope,
      product_external_id::TEXT,
      COUNT(*) FILTER (WHERE status = 'active') AS active_count,
      COUNT(*) AS total_count,
      COUNT(*) FILTER (WHERE status IN ('notified', 'converted')) AS notified_count,
      COUNT(*) FILTER (WHERE status = 'converted') AS converted_count
    FROM waitlist_entries
    GROUP BY item_external_id, item_scope, product_external_id
    ORDER BY active_count DESC, item_external_id ASC
    LIMIT ${pageSize}
    OFFSET ${offsetVal}
  `;

  const items: DashboardItem[] = rows.map((r) => ({
    item_external_id: parseInt(r.item_external_id, 10),
    item_scope: r.item_scope as ItemScope,
    product_external_id: parseInt(r.product_external_id, 10),
    active_count: parseInt(r.active_count, 10),
    total_count: parseInt(r.total_count, 10),
    notified_count: parseInt(r.notified_count, 10),
    converted_count: parseInt(r.converted_count, 10),
  }));

  const nextOffset = offsetVal + pageSize;
  const nextCursor = nextOffset < totalCount ? String(nextOffset) : null;

  const response: AdminDashboardResponse = {
    items,
    next_cursor: nextCursor,
    total_count: totalCount,
  };
  res.json(response);
});

// ─── GET /admin/waitlist ─────────────────────────────────────────────────────
// Return paginated subscriber entries for a given product or variant.
adminRouter.get("/admin/waitlist", async (req: Request, res: Response): Promise<void> => {
  const itemExternalIdRaw = typeof req.query.item_external_id === "string"
    ? req.query.item_external_id
    : null;
  const itemScopeRaw = typeof req.query.item_scope === "string" ? req.query.item_scope : null;
  const statusFilterRaw = typeof req.query.status_filter === "string" ? req.query.status_filter : null;
  const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : null;

  if (!itemExternalIdRaw || !itemScopeRaw) {
    res.status(400).json({ error: "item_external_id and item_scope are required" });
    return;
  }

  const itemExternalId = parseInt(itemExternalIdRaw, 10);
  if (isNaN(itemExternalId)) {
    res.status(400).json({ error: "item_external_id must be a numeric id" });
    return;
  }

  if (itemScopeRaw !== "variant" && itemScopeRaw !== "product") {
    res.status(400).json({ error: "item_scope must be 'variant' or 'product'" });
    return;
  }

  const validStatuses: WaitlistStatus[] = ["active", "notified", "converted", "unsubscribed", "purged"];
  if (statusFilterRaw && !validStatuses.includes(statusFilterRaw as WaitlistStatus)) {
    res.status(400).json({ error: "Invalid status_filter" });
    return;
  }
  const statusFilter = statusFilterRaw as WaitlistStatus | null;

  const pageSize = 50;
  let offsetVal = 0;
  if (cursorRaw) {
    const parsed = parseInt(cursorRaw, 10);
    if (!isNaN(parsed)) offsetVal = parsed;
  }

  const [totalRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM waitlist_entries
    WHERE item_external_id = ${itemExternalId}
      AND (${statusFilter}::TEXT IS NULL OR status = ${statusFilter ?? null})
  `;
  const totalCount = parseInt(totalRow?.count ?? "0", 10);

  const entries = await sql<WaitlistEntryRow[]>`
    SELECT *
    FROM waitlist_entries
    WHERE item_external_id = ${itemExternalId}
      AND (${statusFilter}::TEXT IS NULL OR status = ${statusFilter ?? null})
    ORDER BY queue_position ASC
    LIMIT ${pageSize}
    OFFSET ${offsetVal}
  `;

  const nextOffset = offsetVal + pageSize;
  const nextCursor = nextOffset < totalCount ? String(nextOffset) : null;

  const response: AdminWaitlistResponse = {
    entries,
    next_cursor: nextCursor,
    total_count: totalCount,
  };
  res.json(response);
});

// ─── GET /admin/waitlist/export ──────────────────────────────────────────────
// Stream a CSV export of all subscriber entries for a given product or variant.
adminRouter.get("/admin/waitlist/export", async (req: Request, res: Response): Promise<void> => {
  const itemExternalIdRaw = typeof req.query.item_external_id === "string"
    ? req.query.item_external_id
    : null;
  const itemScopeRaw = typeof req.query.item_scope === "string" ? req.query.item_scope : null;

  if (!itemExternalIdRaw || !itemScopeRaw) {
    res.status(400).json({ error: "item_external_id and item_scope are required" });
    return;
  }

  const itemExternalId = parseInt(itemExternalIdRaw, 10);
  if (isNaN(itemExternalId)) {
    res.status(400).json({ error: "item_external_id must be a numeric id" });
    return;
  }

  if (itemScopeRaw !== "variant" && itemScopeRaw !== "product") {
    res.status(400).json({ error: "item_scope must be 'variant' or 'product'" });
    return;
  }

  const entries = await sql<WaitlistEntryRow[]>`
    SELECT *
    FROM waitlist_entries
    WHERE item_external_id = ${itemExternalId}
    ORDER BY queue_position ASC
  `;

  const header = "id,email,item_external_id,item_scope,product_external_id,queue_position,status,notified_at,converted_at,created_at\n";
  const csvRows = entries.map((e) =>
    [
      e.id,
      `"${e.email.replace(/"/g, '""')}"`,
      e.item_external_id,
      e.item_scope,
      e.product_external_id,
      e.queue_position,
      e.status,
      e.notified_at ? new Date(e.notified_at).toISOString() : "",
      e.converted_at ? new Date(e.converted_at).toISOString() : "",
      new Date(e.created_at).toISOString(),
    ].join(",")
  );

  const csv_data = header + csvRows.join("\n");

  const response: AdminWaitlistExportResponse = { csv_data };
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="waitlist-${itemExternalId}.csv"`);
  res.json(response);
});

// ─── GET /admin/settings ─────────────────────────────────────────────────────
// Retrieve the current notification template and quiet-hours configuration.
adminRouter.get("/admin/settings", async (req: Request, res: Response): Promise<void> => {
  const [settings] = await sql<NotificationSettingsRow[]>`
    SELECT *
    FROM notification_settings
    LIMIT 1
  `;

  const response: AdminSettingsResponse = {
    settings: settings ?? null,
  };
  res.json(response);
});

// ─── PUT /admin/settings ─────────────────────────────────────────────────────
// Save the notification template content and quiet-hours window.
adminRouter.put("/admin/settings", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<AdminSettingsSaveRequest>;

  if (!body.template_subject || typeof body.template_subject !== "string") {
    res.status(400).json({ error: "template_subject is required" });
    return;
  }
  if (!body.template_body || typeof body.template_body !== "string") {
    res.status(400).json({ error: "template_body is required" });
    return;
  }
  if (typeof body.quiet_hours_start !== "number" || body.quiet_hours_start < 0 || body.quiet_hours_start > 23) {
    res.status(400).json({ error: "quiet_hours_start must be a number between 0 and 23" });
    return;
  }
  if (typeof body.quiet_hours_end !== "number" || body.quiet_hours_end < 0 || body.quiet_hours_end > 23) {
    res.status(400).json({ error: "quiet_hours_end must be a number between 0 and 23" });
    return;
  }

  const subject = body.template_subject.replace(/\x00/g, "");
  const tmplBody = body.template_body.replace(/\x00/g, "");

  // Upsert singleton row — notification_settings has at most one row
  await sql`
    INSERT INTO notification_settings
      (template_subject, template_body, quiet_hours_start, quiet_hours_end, updated_at)
    VALUES
      (${subject}, ${tmplBody}, ${body.quiet_hours_start}, ${body.quiet_hours_end}, now())
    ON CONFLICT (id) DO UPDATE SET
      template_subject = EXCLUDED.template_subject,
      template_body = EXCLUDED.template_body,
      quiet_hours_start = EXCLUDED.quiet_hours_start,
      quiet_hours_end = EXCLUDED.quiet_hours_end,
      updated_at = now()
  `;

  const response: AdminSettingsSaveResponse = { success: true };
  res.json(response);
});

// ─── GET /admin/stats ────────────────────────────────────────────────────────
// Return aggregate recovered-demand metrics.
adminRouter.get("/admin/stats", async (req: Request, res: Response): Promise<void> => {
  // cursor unused for aggregate stats — included for API shape consistency
  const _cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  void _cursor;

  const [signupRow] = await sql<{ total: string }[]>`
    SELECT COUNT(*) AS total FROM waitlist_entries
  `;
  const [notifiedRow] = await sql<{ total: string }[]>`
    SELECT COUNT(*) AS total FROM waitlist_entries WHERE status IN ('notified', 'converted')
  `;
  const [convertedRow] = await sql<{ total: string }[]>`
    SELECT COUNT(*) AS total FROM conversion_records
  `;

  const totalSignups = parseInt(signupRow?.total ?? "0", 10);
  const totalNotified = parseInt(notifiedRow?.total ?? "0", 10);
  const totalConverted = parseInt(convertedRow?.total ?? "0", 10);
  const conversionRate = totalNotified > 0 ? totalConverted / totalNotified : 0;

  const response: AdminStatsResponse = {
    total_signups: totalSignups,
    total_notified: totalNotified,
    total_converted: totalConverted,
    conversion_rate: conversionRate,
    next_cursor: null,
    total_count: totalSignups,
  };
  res.json(response);
});
