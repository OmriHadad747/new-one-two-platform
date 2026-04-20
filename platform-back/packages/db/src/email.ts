import type {
  AppEmailConfig,
  EmailDeliveryStatus,
  EmailStarterContent,
  EmailStatsSummary,
  EmailSuppressionReason,
  EmailType,
  TenantBrand,
} from "@platform-back/types";
import { sql } from "./connection.js";

// ─── Tenant brand ────────────────────────────────────────────────────────────

export async function getTenantBrand(
  tenantId: string,
): Promise<TenantBrand | null> {
  const rows = await sql<TenantBrand[]>`
    SELECT
      tenant_id     AS "tenantId",
      logo_url      AS "logoUrl",
      primary_color AS "primaryColor",
      footer_text   AS "footerText",
      support_email AS "supportEmail",
      created_at    AS "createdAt",
      updated_at    AS "updatedAt"
    FROM tenant_brands
    WHERE tenant_id = ${tenantId}
  `;
  return rows[0] ?? null;
}

export async function upsertTenantBrand(params: {
  tenantId: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  footerText?: string | null;
  supportEmail?: string | null;
}): Promise<TenantBrand> {
  const rows = await sql<TenantBrand[]>`
    INSERT INTO tenant_brands (
      tenant_id, logo_url, primary_color, footer_text, support_email
    ) VALUES (
      ${params.tenantId},
      ${params.logoUrl ?? null},
      ${params.primaryColor ?? null},
      ${params.footerText ?? null},
      ${params.supportEmail ?? null}
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      logo_url      = EXCLUDED.logo_url,
      primary_color = EXCLUDED.primary_color,
      footer_text   = EXCLUDED.footer_text,
      support_email = EXCLUDED.support_email,
      updated_at    = NOW()
    RETURNING
      tenant_id     AS "tenantId",
      logo_url      AS "logoUrl",
      primary_color AS "primaryColor",
      footer_text   AS "footerText",
      support_email AS "supportEmail",
      created_at    AS "createdAt",
      updated_at    AS "updatedAt"
  `;
  return rows[0]!;
}

// ─── App email config ────────────────────────────────────────────────────────

export async function getAppEmailConfig(
  appId: string,
): Promise<AppEmailConfig | null> {
  const rows = await sql<AppEmailConfig[]>`
    SELECT
      app_id                  AS "appId",
      tenant_id               AS "tenantId",
      subject_template        AS "subjectTemplate",
      heading_template        AS "headingTemplate",
      body_template           AS "bodyTemplate",
      cta_label               AS "ctaLabel",
      cta_url_template        AS "ctaUrlTemplate",
      email_type              AS "emailType",
      configured_by_merchant  AS "configuredByMerchant",
      created_at              AS "createdAt",
      updated_at              AS "updatedAt"
    FROM app_email_configs
    WHERE app_id = ${appId}
  `;
  return rows[0] ?? null;
}

/**
 * Generator-recorded variable manifest for the app. Read at send time to
 * detect drift between declared variables and what the handler actually
 * passes. Returns [] when no manifest exists (legacy / drift check off).
 */
export async function getAppEmailVariables(appId: string): Promise<string[]> {
  const rows = await sql<Array<{ emailVariables: string[] | null }>>`
    SELECT email_variables AS "emailVariables"
    FROM apps
    WHERE id = ${appId}
  `;
  return rows[0]?.emailVariables ?? [];
}

export async function createAppEmailConfigFromStarter(params: {
  appId: string;
  tenantId: string;
  starter: EmailStarterContent;
  emailType: EmailType;
}): Promise<AppEmailConfig> {
  const { appId, tenantId, starter, emailType } = params;
  const rows = await sql<AppEmailConfig[]>`
    INSERT INTO app_email_configs (
      app_id, tenant_id,
      subject_template, heading_template, body_template,
      cta_label, cta_url_template,
      email_type, configured_by_merchant
    ) VALUES (
      ${appId}, ${tenantId},
      ${starter.subject}, ${starter.heading ?? null}, ${starter.body},
      ${starter.ctaLabel ?? null}, ${starter.ctaUrl ?? null},
      ${emailType}, FALSE
    )
    ON CONFLICT (app_id) DO UPDATE SET
      subject_template = EXCLUDED.subject_template,
      heading_template = EXCLUDED.heading_template,
      body_template    = EXCLUDED.body_template,
      cta_label        = EXCLUDED.cta_label,
      cta_url_template = EXCLUDED.cta_url_template,
      email_type       = EXCLUDED.email_type,
      updated_at       = NOW()
    RETURNING
      app_id                  AS "appId",
      tenant_id               AS "tenantId",
      subject_template        AS "subjectTemplate",
      heading_template        AS "headingTemplate",
      body_template           AS "bodyTemplate",
      cta_label               AS "ctaLabel",
      cta_url_template        AS "ctaUrlTemplate",
      email_type              AS "emailType",
      configured_by_merchant  AS "configuredByMerchant",
      created_at              AS "createdAt",
      updated_at              AS "updatedAt"
  `;
  return rows[0]!;
}

/**
 * Updates merchant-editable fields and flips configured_by_merchant=TRUE,
 * which unblocks the deploy gate.
 */
export async function updateAppEmailConfig(
  appId: string,
  params: {
    subjectTemplate: string;
    headingTemplate: string | null;
    bodyTemplate: string;
    ctaLabel: string | null;
    ctaUrlTemplate: string | null;
    emailType: EmailType;
  },
): Promise<AppEmailConfig> {
  const rows = await sql<AppEmailConfig[]>`
    UPDATE app_email_configs SET
      subject_template        = ${params.subjectTemplate},
      heading_template        = ${params.headingTemplate},
      body_template           = ${params.bodyTemplate},
      cta_label               = ${params.ctaLabel},
      cta_url_template        = ${params.ctaUrlTemplate},
      email_type              = ${params.emailType},
      configured_by_merchant  = TRUE,
      updated_at              = NOW()
    WHERE app_id = ${appId}
    RETURNING
      app_id                  AS "appId",
      tenant_id               AS "tenantId",
      subject_template        AS "subjectTemplate",
      heading_template        AS "headingTemplate",
      body_template           AS "bodyTemplate",
      cta_label               AS "ctaLabel",
      cta_url_template        AS "ctaUrlTemplate",
      email_type              AS "emailType",
      configured_by_merchant  AS "configuredByMerchant",
      created_at              AS "createdAt",
      updated_at              AS "updatedAt"
  `;
  if (rows.length === 0) {
    throw new Error(`app_email_configs row not found for app ${appId}`);
  }
  return rows[0]!;
}

// ─── Email deliveries ────────────────────────────────────────────────────────

export async function insertEmailDelivery(params: {
  tenantId: string;
  appId: string;
  recipient: string;
  subject: string;
  isTest?: boolean;
}): Promise<{ id: string }> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO email_deliveries (
      tenant_id, app_id, recipient, subject, status, is_test
    ) VALUES (
      ${params.tenantId},
      ${params.appId},
      ${params.recipient.toLowerCase()},
      ${params.subject},
      'queued',
      ${params.isTest ?? false}
    )
    RETURNING id
  `;
  return rows[0]!;
}

export async function updateEmailDeliveryStatus(
  id: string,
  params: {
    status: EmailDeliveryStatus;
    providerMsgId?: string | null;
    failureReason?: string | null;
    deliveredAt?: Date | null;
    bouncedAt?: Date | null;
  },
): Promise<void> {
  await sql`
    UPDATE email_deliveries SET
      status          = ${params.status},
      provider_msg_id = COALESCE(${params.providerMsgId ?? null}, provider_msg_id),
      failure_reason  = COALESCE(${params.failureReason ?? null}, failure_reason),
      delivered_at    = COALESCE(${params.deliveredAt ?? null}, delivered_at),
      bounced_at      = COALESCE(${params.bouncedAt ?? null}, bounced_at)
    WHERE id = ${id}
  `;
}

/**
 * Update keyed by provider message id — called from the Resend webhook
 * receiver, which only knows the provider's message id, not our row id.
 */
export async function updateEmailDeliveryByProviderId(
  providerMsgId: string,
  params: {
    status: EmailDeliveryStatus;
    failureReason?: string | null;
    deliveredAt?: Date | null;
    bouncedAt?: Date | null;
  },
): Promise<{ tenantId: string; recipient: string; id: string } | null> {
  const rows = await sql<
    Array<{ tenantId: string; recipient: string; id: string }>
  >`
    UPDATE email_deliveries SET
      status         = ${params.status},
      failure_reason = COALESCE(${params.failureReason ?? null}, failure_reason),
      delivered_at   = COALESCE(${params.deliveredAt ?? null}, delivered_at),
      bounced_at     = COALESCE(${params.bouncedAt ?? null}, bounced_at)
    WHERE provider_msg_id = ${providerMsgId}
    RETURNING
      id,
      tenant_id AS "tenantId",
      recipient
  `;
  return rows[0] ?? null;
}

/** 30-day stats for one app (test sends excluded). */
export async function getAppEmailStats(
  appId: string,
): Promise<EmailStatsSummary> {
  const rows = await sql<Array<{ status: string; count: string }>>`
    SELECT status::TEXT AS status, COUNT(*)::TEXT AS count
    FROM email_deliveries
    WHERE app_id = ${appId}
      AND is_test = FALSE
      AND sent_at > NOW() - INTERVAL '30 days'
    GROUP BY status
  `;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = parseInt(row.count, 10);
  }

  return {
    sent:
      (counts["sent"] ?? 0) +
      (counts["delivered"] ?? 0) +
      (counts["bounced"] ?? 0) +
      (counts["complained"] ?? 0) +
      (counts["failed"] ?? 0),
    delivered: counts["delivered"] ?? 0,
    bounced: counts["bounced"] ?? 0,
    complained: counts["complained"] ?? 0,
    failed: counts["failed"] ?? 0,
    suppressed: 0,
  };
}

// ─── Suppression list ────────────────────────────────────────────────────────

export async function isEmailSuppressed(
  tenantId: string,
  email: string,
): Promise<boolean> {
  const rows = await sql<Array<{ exists: boolean }>>`
    SELECT TRUE AS "exists"
    FROM email_suppressions
    WHERE tenant_id = ${tenantId}
      AND email = ${email.toLowerCase()}
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function insertEmailSuppression(params: {
  tenantId: string;
  email: string;
  reason: EmailSuppressionReason;
  sourceDeliveryId?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO email_suppressions (
      tenant_id, email, reason, source_delivery_id
    ) VALUES (
      ${params.tenantId},
      ${params.email.toLowerCase()},
      ${params.reason},
      ${params.sourceDeliveryId ?? null}
    )
    ON CONFLICT (tenant_id, email) DO NOTHING
  `;
}

// ─── Deploy-time flags ───────────────────────────────────────────────────────

export async function setAppUsesEmail(
  appId: string,
  usesEmail: boolean,
): Promise<void> {
  await sql`UPDATE apps SET uses_email = ${usesEmail} WHERE id = ${appId}`;
}

export async function isAppEmailConfigured(appId: string): Promise<boolean> {
  const rows = await sql<Array<{ configuredByMerchant: boolean }>>`
    SELECT configured_by_merchant AS "configuredByMerchant"
    FROM app_email_configs
    WHERE app_id = ${appId}
  `;
  return rows[0]?.configuredByMerchant ?? false;
}
