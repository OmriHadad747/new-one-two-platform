import { sql } from "./connection.js";

// Read helpers for the three invocation-log tables.
// - widget_invocation_logs   — storefront widget hits via the /widget/* edge
// - admin_invocation_logs    — admin iframe hits via the /admin/* edge
// - webhook_invocation_logs  — Shopify webhooks via the gateway + worker
//
// All three are written elsewhere (forward/worker code paths). These
// helpers are the dashboard-facing read side: per-app drill-downs and
// the tenant-level aggregate view.

export interface WidgetInvocationLogRow {
  id: string;
  path: string;
  status: string;
  durationMs: number | null;
  errorMessage: string | null;
  invokedAt: string;
}

export async function getWidgetInvocationLogs(
  appId: string,
  limit: number,
): Promise<WidgetInvocationLogRow[]> {
  return sql<WidgetInvocationLogRow[]>`
    SELECT
      id,
      path,
      status,
      duration_ms   AS "durationMs",
      error_message AS "errorMessage",
      invoked_at    AS "invokedAt"
    FROM widget_invocation_logs
    WHERE app_id = ${appId}
    ORDER BY invoked_at DESC
    LIMIT ${limit}
  `;
}

export interface AdminInvocationLogRow {
  id: string;
  path: string;
  status: string;
  durationMs: number | null;
  errorMessage: string | null;
  invokedAt: string;
}

export async function getAdminInvocationLogs(
  appId: string,
  limit: number,
): Promise<AdminInvocationLogRow[]> {
  return sql<AdminInvocationLogRow[]>`
    SELECT
      id,
      path,
      status,
      duration_ms   AS "durationMs",
      error_message AS "errorMessage",
      invoked_at    AS "invokedAt"
    FROM admin_invocation_logs
    WHERE app_id = ${appId}
    ORDER BY invoked_at DESC
    LIMIT ${limit}
  `;
}

export interface WebhookInvocationLogRow {
  id: string;
  appId: string;
  topic: string;
  status: string;
  durationMs: number | null;
  errorMessage: string | null;
  queuedAt: string;
}

/**
 * Tenant-wide recent webhook invocations across ALL apps. Powers the
 * tenant-level audit log view.
 */
export async function getRecentWebhookInvocationLogs(
  tenantId: string,
  limit: number,
): Promise<WebhookInvocationLogRow[]> {
  return sql<WebhookInvocationLogRow[]>`
    SELECT
      id,
      app_id        AS "appId",
      topic,
      status,
      duration_ms   AS "durationMs",
      error_message AS "errorMessage",
      queued_at     AS "queuedAt"
    FROM webhook_invocation_logs
    WHERE tenant_id = ${tenantId}
    ORDER BY queued_at DESC
    LIMIT ${limit}
  `;
}
