import { Router } from "express";
import type { Request, Response } from "express";
import { sql } from "../lib/db.js";
import type {
  AdminDashboardResponse,
  AdminSubscribersResponse,
  AdminSubscribersExportResponse,
  AdminSettingsResponse,
  AdminSaveTemplateRequest,
  AdminSaveTemplateResponse,
  AdminSaveQuietHoursRequest,
  AdminSaveQuietHoursResponse,
  DashboardItem,
  OverallMetrics,
  SubscriberItem,
  SignupLevel,
  WaitlistStatus,
  NotificationSettingsRow,
} from "../types/contracts.js";

export const adminRouter = Router();

const PAGE_SIZE = 20;

function encodeCursor(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function decodeCursor(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? `{{${key}}}`);
}

// ─── GET /admin/dashboard ──────────────────────────────────────────────────────

adminRouter.get("/admin/dashboard", async (req: Request, res: Response): Promise<void> => {
  const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : null;

  try {
    type SnapRow = {
      id: string;
      product_external_id: string;
      variant_external_id: string | null;
      item_display_name: string;
      active_waitlist_count: number;
      total_signups: number;
      total_notified: number;
      total_conversions: number;
      last_restock_at: Date | null;
    };

    let snapshots: SnapRow[];

    if (cursorRaw) {
      const cursorId = decodeCursor(cursorRaw);
      const [cursorRow] = await sql<{ active_waitlist_count: number }[]>`
        SELECT active_waitlist_count FROM dashboard_snapshots WHERE id = ${cursorId}
      `;
      if (!cursorRow) {
        res.status(400).json({ error: "invalid cursor" });
        return;
      }
      const cursorCount = cursorRow.active_waitlist_count;
      snapshots = await sql<SnapRow[]>`
        SELECT id,
               product_external_id::text,
               variant_external_id::text,
               item_display_name,
               active_waitlist_count,
               total_signups,
               total_notified,
               total_conversions,
               last_restock_at
        FROM dashboard_snapshots
        WHERE (active_waitlist_count, id::text) < (${cursorCount}, ${cursorId})
        ORDER BY active_waitlist_count DESC, id DESC
        LIMIT ${PAGE_SIZE + 1}
      `;
    } else {
      snapshots = await sql<SnapRow[]>`
        SELECT id,
               product_external_id::text,
               variant_external_id::text,
               item_display_name,
               active_waitlist_count,
               total_signups,
               total_notified,
               total_conversions,
               last_restock_at
        FROM dashboard_snapshots
        ORDER BY active_waitlist_count DESC, id DESC
        LIMIT ${PAGE_SIZE + 1}
      `;
    }

    const hasMore = snapshots.length > PAGE_SIZE;
    const page = snapshots.slice(0, PAGE_SIZE);
    const lastSnap = page[page.length - 1];
    const nextCursor = hasMore && lastSnap ? encodeCursor(lastSnap.id) : null;

    const [countRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM dashboard_snapshots
    `;
    const totalCount = parseInt(countRow?.count ?? "0", 10);

    const [metricsRow] = await sql<{
      total_signups: string;
      total_notified: string;
      total_conversions: string;
    }[]>`
      SELECT
        COALESCE(SUM(total_signups), 0)::text AS total_signups,
        COALESCE(SUM(total_notified), 0)::text AS total_notified,
        COALESCE(SUM(total_conversions), 0)::text AS total_conversions
      FROM dashboard_snapshots
    `;

    const totalSignups = parseInt(metricsRow?.total_signups ?? "0", 10);
    const totalNotified = parseInt(metricsRow?.total_notified ?? "0", 10);
    const totalConversions = parseInt(metricsRow?.total_conversions ?? "0", 10);

    const overallMetrics: OverallMetrics = {
      total_signups: totalSignups,
      total_notified: totalNotified,
      total_conversions: totalConversions,
      conversion_rate: totalNotified > 0
        ? Math.round((totalConversions / totalNotified) * 10000) / 100
        : 0,
    };

    const items: DashboardItem[] = page.map((s) => ({
      product_external_id: s.product_external_id,
      variant_external_id: s.variant_external_id,
      item_display_name: s.item_display_name,
      active_waitlist_count: s.active_waitlist_count,
      total_signups: s.total_signups,
      total_notified: s.total_notified,
      total_conversions: s.total_conversions,
      conversion_rate: s.total_notified > 0
        ? Math.round((s.total_conversions / s.total_notified) * 10000) / 100
        : 0,
      last_restock_at: s.last_restock_at ? s.last_restock_at.toISOString() : null,
    }));

    const response: AdminDashboardResponse = {
      items,
      next_cursor: nextCursor,
      total_count: totalCount,
      overall_metrics: overallMetrics,
    };

    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "dashboard failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── GET /admin/subscribers ────────────────────────────────────────────────────

adminRouter.get("/admin/subscribers", async (req: Request, res: Response): Promise<void> => {
  const productIdRaw = typeof req.query.product_id === "string" ? req.query.product_id : null;
  const variantIdRaw = typeof req.query.variant_id === "string" ? req.query.variant_id : null;
  const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : null;

  if (!productIdRaw) {
    res.status(400).json({ error: "product_id is required" });
    return;
  }

  if (!/^\d+$/.test(productIdRaw)) {
    res.status(400).json({ error: "product_id must be a numeric string" });
    return;
  }

  if (variantIdRaw !== null && !/^\d+$/.test(variantIdRaw)) {
    res.status(400).json({ error: "variant_id must be a numeric string" });
    return;
  }

  try {
    type EntryRow = {
      id: string;
      shopper_email: string;
      product_external_id: string;
      variant_external_id: string | null;
      item_display_name: string;
      signup_level: string;
      status: string;
      signed_up_at: Date;
      notified_at: Date | null;
      notification_batch_id: string | null;
    };

    let cursorDate: Date | null = null;
    let cursorId: string | null = null;
    if (cursorRaw) {
      const decoded = decodeCursor(cursorRaw);
      const parts = decoded.split("|");
      if (parts.length === 2 && parts[0] && parts[1]) {
        cursorDate = new Date(parts[0]);
        cursorId = parts[1];
      }
    }

    let entries: EntryRow[];
    let totalCountRows: { count: string }[];

    if (variantIdRaw !== null) {
      if (cursorDate !== null && cursorId !== null) {
        const cd = cursorDate;
        const ci = cursorId;
        entries = await sql<EntryRow[]>`
          SELECT id, shopper_email,
                 product_external_id::text, variant_external_id::text,
                 item_display_name, signup_level, status,
                 signed_up_at, notified_at, notification_batch_id
          FROM waitlist_entries
          WHERE product_external_id = ${productIdRaw}::bigint
          AND variant_external_id = ${variantIdRaw}::bigint
          AND (signed_up_at, id::text) > (${cd}, ${ci})
          ORDER BY signed_up_at ASC, id ASC
          LIMIT ${PAGE_SIZE + 1}
        `;
      } else {
        entries = await sql<EntryRow[]>`
          SELECT id, shopper_email,
                 product_external_id::text, variant_external_id::text,
                 item_display_name, signup_level, status,
                 signed_up_at, notified_at, notification_batch_id
          FROM waitlist_entries
          WHERE product_external_id = ${productIdRaw}::bigint
          AND variant_external_id = ${variantIdRaw}::bigint
          ORDER BY signed_up_at ASC, id ASC
          LIMIT ${PAGE_SIZE + 1}
        `;
      }
      totalCountRows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM waitlist_entries
        WHERE product_external_id = ${productIdRaw}::bigint
        AND variant_external_id = ${variantIdRaw}::bigint
      `;
    } else {
      if (cursorDate !== null && cursorId !== null) {
        const cd = cursorDate;
        const ci = cursorId;
        entries = await sql<EntryRow[]>`
          SELECT id, shopper_email,
                 product_external_id::text, variant_external_id::text,
                 item_display_name, signup_level, status,
                 signed_up_at, notified_at, notification_batch_id
          FROM waitlist_entries
          WHERE product_external_id = ${productIdRaw}::bigint
          AND variant_external_id IS NULL
          AND (signed_up_at, id::text) > (${cd}, ${ci})
          ORDER BY signed_up_at ASC, id ASC
          LIMIT ${PAGE_SIZE + 1}
        `;
      } else {
        entries = await sql<EntryRow[]>`
          SELECT id, shopper_email,
                 product_external_id::text, variant_external_id::text,
                 item_display_name, signup_level, status,
                 signed_up_at, notified_at, notification_batch_id
          FROM waitlist_entries
          WHERE product_external_id = ${productIdRaw}::bigint
          AND variant_external_id IS NULL
          ORDER BY signed_up_at ASC, id ASC
          LIMIT ${PAGE_SIZE + 1}
        `;
      }
      totalCountRows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM waitlist_entries
        WHERE product_external_id = ${productIdRaw}::bigint
        AND variant_external_id IS NULL
      `;
    }

    const hasMore = entries.length > PAGE_SIZE;
    const page = entries.slice(0, PAGE_SIZE);
    const lastEntry = page[page.length - 1];
    const nextCursor = hasMore && lastEntry
      ? encodeCursor(`${lastEntry.signed_up_at.toISOString()}|${lastEntry.id}`)
      : null;

    const totalCount = parseInt(totalCountRows[0]?.count ?? "0", 10);

    const subscribers: SubscriberItem[] = page.map((e) => ({
      id: e.id,
      shopper_email: e.shopper_email,
      product_external_id: e.product_external_id,
      variant_external_id: e.variant_external_id,
      item_display_name: e.item_display_name,
      signup_level: e.signup_level as SignupLevel,
      status: e.status as WaitlistStatus,
      signed_up_at: e.signed_up_at.toISOString(),
      notified_at: e.notified_at ? e.notified_at.toISOString() : null,
      notification_batch_id: e.notification_batch_id,
    }));

    const response: AdminSubscribersResponse = { subscribers, next_cursor: nextCursor, total_count: totalCount };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "subscribers list failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── GET /admin/subscribers/export ────────────────────────────────────────────

adminRouter.get("/admin/subscribers/export", async (req: Request, res: Response): Promise<void> => {
  const productIdRaw = typeof req.query.product_id === "string" ? req.query.product_id : null;
  const variantIdRaw = typeof req.query.variant_id === "string" ? req.query.variant_id : null;
  const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : null;

  if (!productIdRaw) {
    res.status(400).json({ error: "product_id is required" });
    return;
  }

  if (!/^\d+$/.test(productIdRaw)) {
    res.status(400).json({ error: "product_id must be a numeric string" });
    return;
  }

  if (variantIdRaw !== null && !/^\d+$/.test(variantIdRaw)) {
    res.status(400).json({ error: "variant_id must be a numeric string" });
    return;
  }

  const EXPORT_PAGE_SIZE = 500;

  try {
    type ExportRow = {
      id: string;
      shopper_email: string;
      product_external_id: string;
      variant_external_id: string | null;
      item_display_name: string;
      signup_level: string;
      status: string;
      signed_up_at: Date;
      notified_at: Date | null;
    };

    let cursorDate: Date | null = null;
    let cursorId: string | null = null;
    if (cursorRaw) {
      const decoded = decodeCursor(cursorRaw);
      const parts = decoded.split("|");
      if (parts.length === 2 && parts[0] && parts[1]) {
        cursorDate = new Date(parts[0]);
        cursorId = parts[1];
      }
    }

    let entries: ExportRow[];
    let totalCountRows: { count: string }[];

    if (variantIdRaw !== null) {
      if (cursorDate !== null && cursorId !== null) {
        const cd = cursorDate;
        const ci = cursorId;
        entries = await sql<ExportRow[]>`
          SELECT id, shopper_email, product_external_id::text, variant_external_id::text,
                 item_display_name, signup_level, status, signed_up_at, notified_at
          FROM waitlist_entries
          WHERE product_external_id = ${productIdRaw}::bigint
          AND variant_external_id = ${variantIdRaw}::bigint
          AND (signed_up_at, id::text) > (${cd}, ${ci})
          ORDER BY signed_up_at ASC, id ASC
          LIMIT ${EXPORT_PAGE_SIZE + 1}
        `;
      } else {
        entries = await sql<ExportRow[]>`
          SELECT id, shopper_email, product_external_id::text, variant_external_id::text,
                 item_display_name, signup_level, status, signed_up_at, notified_at
          FROM waitlist_entries
          WHERE product_external_id = ${productIdRaw}::bigint
          AND variant_external_id = ${variantIdRaw}::bigint
          ORDER BY signed_up_at ASC, id ASC
          LIMIT ${EXPORT_PAGE_SIZE + 1}
        `;
      }
      totalCountRows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM waitlist_entries
        WHERE product_external_id = ${productIdRaw}::bigint
        AND variant_external_id = ${variantIdRaw}::bigint
      `;
    } else {
      if (cursorDate !== null && cursorId !== null) {
        const cd = cursorDate;
        const ci = cursorId;
        entries = await sql<ExportRow[]>`
          SELECT id, shopper_email, product_external_id::text, variant_external_id::text,
                 item_display_name, signup_level, status, signed_up_at, notified_at
          FROM waitlist_entries
          WHERE product_external_id = ${productIdRaw}::bigint
          AND variant_external_id IS NULL
          AND (signed_up_at, id::text) > (${cd}, ${ci})
          ORDER BY signed_up_at ASC, id ASC
          LIMIT ${EXPORT_PAGE_SIZE + 1}
        `;
      } else {
        entries = await sql<ExportRow[]>`
          SELECT id, shopper_email, product_external_id::text, variant_external_id::text,
                 item_display_name, signup_level, status, signed_up_at, notified_at
          FROM waitlist_entries
          WHERE product_external_id = ${productIdRaw}::bigint
          AND variant_external_id IS NULL
          ORDER BY signed_up_at ASC, id ASC
          LIMIT ${EXPORT_PAGE_SIZE + 1}
        `;
      }
      totalCountRows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM waitlist_entries
        WHERE product_external_id = ${productIdRaw}::bigint
        AND variant_external_id IS NULL
      `;
    }

    const hasMore = entries.length > EXPORT_PAGE_SIZE;
    const page = entries.slice(0, EXPORT_PAGE_SIZE);
    const lastEntry = page[page.length - 1];
    const nextCursor = hasMore && lastEntry
      ? encodeCursor(`${lastEntry.signed_up_at.toISOString()}|${lastEntry.id}`)
      : null;

    const totalCount = parseInt(totalCountRows[0]?.count ?? "0", 10);

    // Validate that all returned rows match the requested product (and variant) IDs
    const validatedPage = page.filter((e) => {
      const productMatch = e.product_external_id === productIdRaw ||
        // DB returns text-cast bigint which may have same value but check string equality
        String(e.product_external_id) === productIdRaw;
      const variantMatch = variantIdRaw === null
        ? e.variant_external_id === null
        : String(e.variant_external_id) === variantIdRaw;
      return productMatch && variantMatch;
    });

    const csvEscape = (s: string): string => `"${s.replace(/"/g, '""')}"`;
    const csvRows = [
      "email,item,signup_level,status,signed_up_at,notified_at",
      ...validatedPage.map((e) => [
        csvEscape(e.shopper_email),
        csvEscape(e.item_display_name),
        csvEscape(e.signup_level),
        csvEscape(e.status),
        csvEscape(e.signed_up_at.toISOString()),
        csvEscape(e.notified_at ? e.notified_at.toISOString() : ""),
      ].join(",")),
    ];
    const csvData = csvRows.join("\n");

    const response: AdminSubscribersExportResponse = {
      csv_data: csvData,
      next_cursor: nextCursor,
      total_count: totalCount,
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "export failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── GET /admin/settings ───────────────────────────────────────────────────────

adminRouter.get("/admin/settings", async (req: Request, res: Response): Promise<void> => {
  try {
    const [settings] = await sql<Pick<NotificationSettingsRow,
      "notification_subject_template" | "notification_body_template" |
      "quiet_hours_start" | "quiet_hours_end" | "timezone">[]>`
      SELECT notification_subject_template, notification_body_template,
             quiet_hours_start, quiet_hours_end, timezone
      FROM notification_settings
      LIMIT 1
    `;

    if (!settings) {
      const response: AdminSettingsResponse = {
        notification_subject_template: "{{product_name}} is back in stock!",
        notification_body_template:
          "<p>Great news! {{item_detail}} is back in stock.</p><p><a href=\"{{item_url}}\">Shop now</a></p><p><a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>",
        quiet_hours_start: "22:00",
        quiet_hours_end: "08:00",
        timezone: "America/New_York",
      };
      res.json(response);
      return;
    }

    const response: AdminSettingsResponse = {
      notification_subject_template: settings.notification_subject_template,
      notification_body_template: settings.notification_body_template,
      quiet_hours_start: settings.quiet_hours_start,
      quiet_hours_end: settings.quiet_hours_end,
      timezone: settings.timezone,
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "settings fetch failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── PUT /admin/settings/template ─────────────────────────────────────────────

adminRouter.put("/admin/settings/template", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<AdminSaveTemplateRequest>;

  const subject = typeof body.notification_subject_template === "string"
    ? body.notification_subject_template.trim()
    : null;
  const bodyTemplate = typeof body.notification_body_template === "string"
    ? body.notification_body_template.trim()
    : null;

  if (!subject || !bodyTemplate) {
    res.status(400).json({ error: "notification_subject_template and notification_body_template are required" });
    return;
  }

  try {
    const safeSubject = subject.replace(/\0/g, "");
    const safeBody = bodyTemplate.replace(/\0/g, "");

    // Atomic singleton upsert: only update the template columns; preserve existing quiet-hours.
    // If no row exists yet, initialize with system defaults for quiet-hours.
    await sql`
      WITH existing AS (
        SELECT id, quiet_hours_start, quiet_hours_end, timezone FROM notification_settings LIMIT 1
      ),
      target_id AS (
        SELECT COALESCE((SELECT id FROM existing), gen_random_uuid()) AS id
      )
      INSERT INTO notification_settings (
        id, notification_subject_template, notification_body_template,
        quiet_hours_start, quiet_hours_end, timezone, updated_at
      )
      SELECT
        target_id.id, ${safeSubject}, ${safeBody},
        COALESCE((SELECT quiet_hours_start FROM existing), '22:00'),
        COALESCE((SELECT quiet_hours_end FROM existing), '08:00'),
        COALESCE((SELECT timezone FROM existing), 'America/New_York'),
        now()
      FROM target_id
      ON CONFLICT (id) DO UPDATE SET
        notification_subject_template = EXCLUDED.notification_subject_template,
        notification_body_template = EXCLUDED.notification_body_template,
        updated_at = now()
    `;

    const previewVars: Record<string, string> = {
      product_name: "Example Product",
      item_detail: "Example Product — Large / Blue",
      item_url: "https://yourstore.com/products/example-product",
      unsubscribe_url: "https://yourstore.com/apps/back-in-stock/unsubscribe?token=sample",
    };

    const response: AdminSaveTemplateResponse = {
      success: true,
      preview_subject: renderTemplate(safeSubject, previewVars),
      preview_body: renderTemplate(safeBody, previewVars),
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "save template failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── PUT /admin/settings/quiet-hours ──────────────────────────────────────────

adminRouter.put("/admin/settings/quiet-hours", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<AdminSaveQuietHoursRequest>;

  const quietStart = typeof body.quiet_hours_start === "string" ? body.quiet_hours_start.trim() : null;
  const quietEnd = typeof body.quiet_hours_end === "string" ? body.quiet_hours_end.trim() : null;
  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : null;

  if (!quietStart || !quietEnd || !timezone) {
    res.status(400).json({ error: "quiet_hours_start, quiet_hours_end, and timezone are required" });
    return;
  }

  if (!/^\d{2}:\d{2}$/.test(quietStart) || !/^\d{2}:\d{2}$/.test(quietEnd)) {
    res.status(400).json({ error: "quiet_hours_start and quiet_hours_end must be in HH:MM format" });
    return;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    res.status(400).json({ error: "invalid timezone" });
    return;
  }

  try {
    const safeStart = quietStart.replace(/\0/g, "");
    const safeEnd = quietEnd.replace(/\0/g, "");
    const safeTz = timezone.replace(/\0/g, "");

    // Atomic singleton upsert: only update the quiet-hours columns; preserve existing template.
    // If no row exists yet, initialize with system defaults for notification templates.
    await sql`
      WITH existing AS (
        SELECT id, notification_subject_template, notification_body_template FROM notification_settings LIMIT 1
      ),
      target_id AS (
        SELECT COALESCE((SELECT id FROM existing), gen_random_uuid()) AS id
      )
      INSERT INTO notification_settings (
        id, notification_subject_template, notification_body_template,
        quiet_hours_start, quiet_hours_end, timezone, updated_at
      )
      SELECT
        target_id.id,
        COALESCE((SELECT notification_subject_template FROM existing), '{{product_name}} is back in stock!'),
        COALESCE((SELECT notification_body_template FROM existing), '<p>Great news! {{item_detail}} is back in stock.</p><p><a href="{{item_url}}">Shop now</a></p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>'),
        ${safeStart}, ${safeEnd}, ${safeTz}, now()
      FROM target_id
      ON CONFLICT (id) DO UPDATE SET
        quiet_hours_start = EXCLUDED.quiet_hours_start,
        quiet_hours_end = EXCLUDED.quiet_hours_end,
        timezone = EXCLUDED.timezone,
        updated_at = now()
    `;

    const response: AdminSaveQuietHoursResponse = { success: true };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "save quiet hours failed");
    res.status(500).json({ error: "internal error" });
  }
});
