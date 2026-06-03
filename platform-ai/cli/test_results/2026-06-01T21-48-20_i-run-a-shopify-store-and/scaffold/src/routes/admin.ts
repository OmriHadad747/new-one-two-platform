import { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { adminRouter } from "../lib/router.js";
import {
  DemandSnapshotRow,
  WaitlistSignupRow,
  NotificationRunRow,
  EmailTemplateRow,
  AppSettingsRow,
  VariantExternalId,
  AdminDashboardResponse,
  AdminDashboardItem,
  AdminVariantSubscribersResponse,
  AdminSubscriberItem,
  AdminSubscribersExportResponse,
  AdminRunsResponse,
  AdminRunItem,
  AdminEmailTemplateResponse,
  AdminEmailTemplateSaveRequest,
  AdminEmailTemplateSaveResponse,
  AdminSettingsResponse,
  AdminSettingsSaveResponse,
} from "../types/contracts.js";

const PAGE_SIZE = 25;

// ─── GET /admin/dashboard ─────────────────────────────────────────────────────
adminRouter.get("/admin/dashboard", async (req: Request, res: Response) => {
  const cursor =
    typeof req.query.cursor === "string" ? req.query.cursor : null;

  // Cursor is the snapshot_updated_at + id for stable ordering
  // We use (active_signup_count DESC, id ASC) cursor pagination
  let rows: DemandSnapshotRow[];

  if (cursor) {
    // Decode cursor: base64-encoded JSON { count, id }
    let cursorData: { count: number; id: string };
    try {
      cursorData = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      res.status(400).json({ error: "invalid cursor" });
      return;
    }

    rows = await sql<DemandSnapshotRow[]>`
      SELECT *
      FROM demand_snapshots
      WHERE (active_signup_count, id::text) < (${cursorData.count}, ${cursorData.id})
      ORDER BY active_signup_count DESC, id ASC
      LIMIT ${PAGE_SIZE + 1}
    `;
  } else {
    rows = await sql<DemandSnapshotRow[]>`
      SELECT *
      FROM demand_snapshots
      ORDER BY active_signup_count DESC, id ASC
      LIMIT ${PAGE_SIZE + 1}
    `;
  }

  const hasMore = rows.length > PAGE_SIZE;
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  // Total count
  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM demand_snapshots
  `;
  const totalCount = parseInt(countRow?.count ?? "0", 10);

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = Buffer.from(
        JSON.stringify({ count: last.active_signup_count, id: last.id }),
        "utf8"
      ).toString("base64url");
    }
  }

  const responseItems: AdminDashboardItem[] = items.map((row) => ({
    variant_external_id: row.variant_external_id,
    product_external_id: row.product_external_id,
    product_title: row.product_title,
    variant_title: row.variant_title,
    active_signup_count: row.active_signup_count,
    total_notified: row.total_notified,
    total_converted: row.total_converted,
    last_restock_at: row.last_restock_at,
  }));

  const response: AdminDashboardResponse = {
    items: responseItems,
    next_cursor: nextCursor,
    total_count: totalCount,
  };

  res.json(response);
});

// ─── GET /admin/variants/subscribers ─────────────────────────────────────────
adminRouter.get("/admin/variants/subscribers", async (req: Request, res: Response) => {
  const variantExternalId =
    typeof req.query.variant_external_id === "string"
      ? (req.query.variant_external_id as VariantExternalId)
      : null;

  if (!variantExternalId) {
    res.status(400).json({ error: "variant_external_id is required" });
    return;
  }

  if (!/^\d+$/.test(variantExternalId)) {
    res.status(400).json({ error: "variant_external_id must be a numeric string" });
    return;
  }

  const cursor =
    typeof req.query.cursor === "string" ? req.query.cursor : null;

  let rows: WaitlistSignupRow[];

  if (cursor) {
    let cursorData: { signed_up_at: string; id: string };
    try {
      cursorData = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      res.status(400).json({ error: "invalid cursor" });
      return;
    }

    rows = await sql<WaitlistSignupRow[]>`
      SELECT *
      FROM waitlist_signups
      WHERE variant_external_id = ${variantExternalId}
        AND deleted_at IS NULL
        AND (signed_up_at, id::text) > (${cursorData.signed_up_at}, ${cursorData.id})
      ORDER BY signed_up_at ASC, id ASC
      LIMIT ${PAGE_SIZE + 1}
    `;
  } else {
    rows = await sql<WaitlistSignupRow[]>`
      SELECT *
      FROM waitlist_signups
      WHERE variant_external_id = ${variantExternalId}
        AND deleted_at IS NULL
      ORDER BY signed_up_at ASC, id ASC
      LIMIT ${PAGE_SIZE + 1}
    `;
  }

  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM waitlist_signups
    WHERE variant_external_id = ${variantExternalId}
      AND deleted_at IS NULL
  `;
  const totalCount = parseInt(countRow?.count ?? "0", 10);

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1];
    if (last) {
      nextCursor = Buffer.from(
        JSON.stringify({ signed_up_at: last.signed_up_at, id: last.id }),
        "utf8"
      ).toString("base64url");
    }
  }

  const subscribers: AdminSubscriberItem[] = pageRows.map((row) => ({
    id: row.id,
    shopper_email: row.shopper_email,
    variant_title: row.variant_title,
    status: row.status,
    signed_up_at: row.signed_up_at,
  }));

  const response: AdminVariantSubscribersResponse = {
    subscribers,
    next_cursor: nextCursor,
    total_count: totalCount,
  };

  res.json(response);
});

// ─── GET /admin/variants/subscribers/export ───────────────────────────────────
adminRouter.get("/admin/variants/subscribers/export", async (req: Request, res: Response) => {
  const variantExternalId =
    typeof req.query.variant_external_id === "string"
      ? (req.query.variant_external_id as VariantExternalId)
      : null;

  if (!variantExternalId) {
    res.status(400).json({ error: "variant_external_id is required" });
    return;
  }

  if (!/^\d+$/.test(variantExternalId)) {
    res.status(400).json({ error: "variant_external_id must be a numeric string" });
    return;
  }

  const rows = await sql<WaitlistSignupRow[]>`
    SELECT *
    FROM waitlist_signups
    WHERE variant_external_id = ${variantExternalId}
      AND status = 'active'
      AND deleted_at IS NULL
    ORDER BY signed_up_at ASC
  `;

  // Build properly-escaped CSV
  const csvEscape = (val: string): string => {
    if (val.includes(",") || val.includes('"') || val.includes("\n") || val.includes("\r")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const header = ["email", "variant_title", "product_title", "signed_up_at", "status"];
  const csvLines: string[] = [header.join(",")];

  for (const row of rows) {
    const line = [
      csvEscape(row.shopper_email),
      csvEscape(row.variant_title),
      csvEscape(row.product_title),
      csvEscape(row.signed_up_at),
      csvEscape(row.status),
    ].join(",");
    csvLines.push(line);
  }

  const csvContent = csvLines.join("\r\n");

  const response: AdminSubscribersExportResponse = {
    csv_content: csvContent,
  };

  res.json(response);
});

// ─── GET /admin/runs ──────────────────────────────────────────────────────────
adminRouter.get("/admin/runs", async (req: Request, res: Response) => {
  const cursor =
    typeof req.query.cursor === "string" ? req.query.cursor : null;

  let rows: NotificationRunRow[];

  if (cursor) {
    let cursorData: { created_at: string; id: string };
    try {
      cursorData = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      res.status(400).json({ error: "invalid cursor" });
      return;
    }

    rows = await sql<NotificationRunRow[]>`
      SELECT *
      FROM notification_runs
      WHERE (created_at, id::text) < (${cursorData.created_at}, ${cursorData.id})
      ORDER BY created_at DESC, id DESC
      LIMIT ${PAGE_SIZE + 1}
    `;
  } else {
    rows = await sql<NotificationRunRow[]>`
      SELECT *
      FROM notification_runs
      ORDER BY created_at DESC, id DESC
      LIMIT ${PAGE_SIZE + 1}
    `;
  }

  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM notification_runs
  `;
  const totalCount = parseInt(countRow?.count ?? "0", 10);

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1];
    if (last) {
      nextCursor = Buffer.from(
        JSON.stringify({ created_at: last.created_at, id: last.id }),
        "utf8"
      ).toString("base64url");
    }
  }

  const runs: AdminRunItem[] = pageRows.map((row) => ({
    id: row.id,
    variant_external_id: row.variant_external_id,
    product_external_id: row.product_external_id,
    product_title: row.product_title,
    variant_title: row.variant_title,
    status: row.status,
    available_units: row.available_units,
    sends_enqueued: row.sends_enqueued,
    sends_dispatched: row.sends_dispatched,
    sends_failed: row.sends_failed,
    conversions: row.conversions,
    created_at: row.created_at,
  }));

  const response: AdminRunsResponse = {
    runs,
    next_cursor: nextCursor,
    total_count: totalCount,
  };

  res.json(response);
});

// ─── GET /admin/email-template ────────────────────────────────────────────────
adminRouter.get("/admin/email-template", async (_req: Request, res: Response) => {
  const [row] = await sql<EmailTemplateRow[]>`
    SELECT * FROM email_template ORDER BY updated_at DESC LIMIT 1
  `;

  if (!row) {
    // Return defaults if no template has been saved yet
    const defaults: AdminEmailTemplateResponse = {
      subject_template: "{{product_name}} is back in stock!",
      body_template:
        "Hi,\n\nGreat news! {{product_name}} ({{variant_title}}) is back in stock.\n\nShop now: {{product_url}}\n\nTo unsubscribe from back-in-stock alerts, click here: {{unsubscribe_url}}\n\nThanks!",
      updated_at: new Date(0).toISOString(),
    };
    res.json(defaults);
    return;
  }

  const response: AdminEmailTemplateResponse = {
    subject_template: row.subject_template,
    body_template: row.body_template,
    updated_at: row.updated_at,
  };

  res.json(response);
});

// ─── PUT /admin/email-template ────────────────────────────────────────────────
adminRouter.put("/admin/email-template", async (req: Request, res: Response) => {
  const body = req.body as Partial<AdminEmailTemplateSaveRequest>;

  const subjectTemplate =
    typeof body.subject_template === "string" ? body.subject_template.trim() : null;
  const bodyTemplate =
    typeof body.body_template === "string" ? body.body_template.trim() : null;

  if (!subjectTemplate || !bodyTemplate) {
    res.status(400).json({ error: "subject_template and body_template are required" });
    return;
  }

  // Singleton upsert: delete old and insert new, or UPDATE in place
  const now = new Date().toISOString();

  const [existing] = await sql<EmailTemplateRow[]>`
    SELECT id FROM email_template LIMIT 1
  `;

  let updatedAt: string;
  if (existing) {
    const [updated] = await sql<EmailTemplateRow[]>`
      UPDATE email_template
      SET subject_template = ${subjectTemplate},
          body_template = ${bodyTemplate},
          updated_at = ${now}
      WHERE id = ${existing.id}
      RETURNING updated_at
    `;
    updatedAt = updated?.updated_at ?? now;
  } else {
    const [inserted] = await sql<EmailTemplateRow[]>`
      INSERT INTO email_template (subject_template, body_template, updated_at)
      VALUES (${subjectTemplate}, ${bodyTemplate}, ${now})
      RETURNING updated_at
    `;
    updatedAt = inserted?.updated_at ?? now;
  }

  const response: AdminEmailTemplateSaveResponse = {
    success: true,
    updated_at: updatedAt,
  };

  res.json(response);
});

// ─── GET /admin/settings ──────────────────────────────────────────────────────
adminRouter.get("/admin/settings", async (_req: Request, res: Response) => {
  const [row] = await sql<AppSettingsRow[]>`
    SELECT * FROM app_settings ORDER BY updated_at DESC LIMIT 1
  `;

  if (!row) {
    // Return defaults
    const defaults: AdminSettingsResponse = {
      quiet_hours_start: 22,
      quiet_hours_end: 8,
      batch_size: 50,
      updated_at: new Date(0).toISOString(),
    };
    res.json(defaults);
    return;
  }

  const response: AdminSettingsResponse = {
    quiet_hours_start: row.quiet_hours_start,
    quiet_hours_end: row.quiet_hours_end,
    batch_size: row.batch_size,
    updated_at: row.updated_at,
  };

  res.json(response);
});

// ─── PUT /admin/settings ──────────────────────────────────────────────────────
adminRouter.put("/admin/settings", async (req: Request, res: Response) => {
  const quietHoursStart =
    typeof req.body.quiet_hours_start === "number" ? req.body.quiet_hours_start : null;
  const quietHoursEnd =
    typeof req.body.quiet_hours_end === "number" ? req.body.quiet_hours_end : null;
  const batchSize =
    typeof req.body.batch_size === "number" ? req.body.batch_size : null;

  if (quietHoursStart == null || quietHoursEnd == null || batchSize == null) {
    res.status(400).json({ error: "quiet_hours_start, quiet_hours_end, and batch_size are required" });
    return;
  }

  if (
    !Number.isInteger(quietHoursStart) ||
    quietHoursStart < 0 ||
    quietHoursStart > 23 ||
    !Number.isInteger(quietHoursEnd) ||
    quietHoursEnd < 0 ||
    quietHoursEnd > 23
  ) {
    res.status(400).json({ error: "quiet_hours_start and quiet_hours_end must be integers 0-23" });
    return;
  }

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    res.status(400).json({ error: "batch_size must be an integer between 1 and 1000" });
    return;
  }

  const now = new Date().toISOString();

  const [existing] = await sql<AppSettingsRow[]>`
    SELECT id FROM app_settings LIMIT 1
  `;

  let updatedAt: string;
  if (existing) {
    const [updated] = await sql<AppSettingsRow[]>`
      UPDATE app_settings
      SET quiet_hours_start = ${quietHoursStart},
          quiet_hours_end = ${quietHoursEnd},
          batch_size = ${batchSize},
          updated_at = ${now}
      WHERE id = ${existing.id}
      RETURNING updated_at
    `;
    updatedAt = updated?.updated_at ?? now;
  } else {
    const [inserted] = await sql<AppSettingsRow[]>`
      INSERT INTO app_settings (quiet_hours_start, quiet_hours_end, batch_size, updated_at)
      VALUES (${quietHoursStart}, ${quietHoursEnd}, ${batchSize}, ${now})
      RETURNING updated_at
    `;
    updatedAt = inserted?.updated_at ?? now;
  }

  const response: AdminSettingsSaveResponse = {
    success: true,
    updated_at: updatedAt,
  };

  res.json(response);
});
