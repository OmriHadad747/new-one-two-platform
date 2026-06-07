import type { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { config } from "../lib/config.js";
import { paginate } from "../lib/paginate.js";
import { platform } from "../lib/platform.js";
import type {
  AdminDashboardRequest,
  AdminDashboardResponse,
  AdminSubscribersRequest,
  AdminSubscribersResponse,
  AdminSubscribersExportRequest,
  AdminSubscribersExportResponse,
  AdminSettingsResponse,
  AdminSettingsSaveRequest,
  AdminSettingsSaveResponse,
  AppSettings,
  WaitlistSignupRow,
} from "../types/contracts.js";

import { Router } from "express";
export const adminRouter = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

function safe(s: string): string {
  return s.replace(/\0/g, "");
}

// ─── GET /admin/dashboard ────────────────────────────────────────────────────

adminRouter.get("/admin/dashboard", async (req: Request, res: Response): Promise<void> => {
  const page =
    typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
  const pageSize =
    typeof req.query.page_size === "string"
      ? parseInt(req.query.page_size, 10)
      : 20;

  const rows = await paginate(
    sql,
    sql`SELECT id, item_external_id, item_type, product_external_id, product_title,
               variant_title, waitlist_count, total_signups, total_notified,
               total_conversions, last_refreshed_at
        FROM demand_stats_snapshots
        ORDER BY waitlist_count DESC, id DESC`,
    { page, page_size: pageSize },
  );

  res.json(rows);
});

// ─── GET /admin/products/subscribers ────────────────────────────────────────

adminRouter.get(
  "/admin/products/subscribers",
  async (req: Request, res: Response): Promise<void> => {
    const itemExternalId =
      typeof req.query.item_external_id === "string"
        ? req.query.item_external_id
        : null;

    if (!itemExternalId) {
      res.status(400).json({ error: "item_external_id is required" });
      return;
    }

    const page =
      typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
    const pageSize =
      typeof req.query.page_size === "string"
        ? parseInt(req.query.page_size, 10)
        : 20;

    const rows = await paginate(
      sql,
      sql`SELECT id, email, item_external_id, item_type, product_external_id,
                 unsubscribe_token, status, signed_up_at, deleted_at
          FROM waitlist_signups
          WHERE item_external_id = ${itemExternalId}
            AND deleted_at IS NULL
          ORDER BY signed_up_at ASC, id ASC`,
      { page, page_size: pageSize },
    );

    res.json(rows);
  },
);

// ─── GET /admin/products/subscribers/export ──────────────────────────────────

adminRouter.get(
  "/admin/products/subscribers/export",
  async (req: Request, res: Response): Promise<void> => {
    const itemExternalId =
      typeof req.query.item_external_id === "string"
        ? req.query.item_external_id
        : null;

    if (!itemExternalId) {
      res.status(400).json({ error: "item_external_id is required" });
      return;
    }

    // Fetch all subscribers for the item
    const rows = await sql<WaitlistSignupRow[]>`
      SELECT id, email, item_external_id, item_type, product_external_id,
             unsubscribe_token, status, signed_up_at, deleted_at
      FROM waitlist_signups
      WHERE item_external_id = ${itemExternalId}
        AND deleted_at IS NULL
      ORDER BY signed_up_at ASC
    `;

    // Build CSV content
    const header =
      "id,email,item_external_id,item_type,product_external_id,status,signed_up_at\n";
    const csvLines = rows.map((r) => {
      const escapedEmail = r.email.includes(",") ? `"${r.email}"` : r.email;
      return [
        r.id,
        escapedEmail,
        r.item_external_id,
        r.item_type,
        r.product_external_id,
        r.status,
        r.signed_up_at,
      ].join(",");
    });
    const csvContent = header + csvLines.join("\n");

    // Upload to platform files storage
    const csvBytes = Buffer.from(csvContent, "utf8");
    const filename = `subscribers-${itemExternalId}-${Date.now()}.csv`;
    const uploadResult = await platform.files.upload({
      name: filename,
      contents: csvBytes,
      mimeType: "text/csv",
    });

    const response: AdminSubscribersExportResponse = {
      csv_url: uploadResult.url,
    };

    res.json(response);
  },
);

// ─── GET /admin/settings ─────────────────────────────────────────────────────

adminRouter.get("/admin/settings", async (_req: Request, res: Response): Promise<void> => {
  const settings: AppSettings = {
    batch_size: await config.get("notification_batch_size", 50),
    quiet_hours_start: await config.get("notification_quiet_start", "22:00"),
    quiet_hours_end: await config.get("notification_quiet_end", "08:00"),
    conversion_attribution_window_days: await config.get(
      "conversion_attribution_window_days",
      7,
    ),
  };

  const response: AdminSettingsResponse = { settings };
  res.json(response);
});

// ─── PUT /admin/settings ──────────────────────────────────────────────────────

adminRouter.put("/admin/settings", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<AdminSettingsSaveRequest>;

  const batchSize = typeof body.batch_size === "number" ? body.batch_size : null;
  const quietStart =
    typeof body.quiet_hours_start === "string" ? body.quiet_hours_start : null;
  const quietEnd =
    typeof body.quiet_hours_end === "string" ? body.quiet_hours_end : null;
  const attributionDays =
    typeof body.conversion_attribution_window_days === "number"
      ? body.conversion_attribution_window_days
      : null;

  if (
    batchSize === null ||
    quietStart === null ||
    quietEnd === null ||
    attributionDays === null
  ) {
    res.status(400).json({
      error:
        "batch_size, quiet_hours_start, quiet_hours_end, and conversion_attribution_window_days are required",
    });
    return;
  }

  if (batchSize < 1 || batchSize > 10000) {
    res.status(400).json({ error: "batch_size must be between 1 and 10000" });
    return;
  }

  if (attributionDays < 1 || attributionDays > 90) {
    res.status(400).json({
      error: "conversion_attribution_window_days must be between 1 and 90",
    });
    return;
  }

  // Validate HH:MM format
  const timeRegex = /^\d{2}:\d{2}$/;
  if (!timeRegex.test(quietStart) || !timeRegex.test(quietEnd)) {
    res.status(400).json({
      error:
        "quiet_hours_start and quiet_hours_end must be in HH:MM format",
    });
    return;
  }

  await config.set("notification_batch_size", batchSize);
  await config.set("notification_quiet_start", quietStart);
  await config.set("notification_quiet_end", quietEnd);
  await config.set("conversion_attribution_window_days", attributionDays);

  const settings: AppSettings = {
    batch_size: batchSize,
    quiet_hours_start: quietStart,
    quiet_hours_end: quietEnd,
    conversion_attribution_window_days: attributionDays,
  };

  const response: AdminSettingsSaveResponse = { settings };
  res.json(response);
});
