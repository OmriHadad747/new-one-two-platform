// Email subsystem shared types. Mirrored from platform/packages/types
// (originally in harness.ts), narrowed to what platform-back actually uses.

export type EmailType = "transactional" | "marketing";

export interface EmailSendParams {
  /** Recipient email address. */
  to: string;
  /** Values bound to {{variable}} placeholders in the merchant template. */
  data?: Record<string, unknown>;
}

export interface AppEmailConfig {
  appId: string;
  tenantId: string;
  subjectTemplate: string;
  headingTemplate: string | null;
  bodyTemplate: string;
  ctaLabel: string | null;
  ctaUrlTemplate: string | null;
  emailType: EmailType;
  configuredByMerchant: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantBrand {
  tenantId: string;
  logoUrl: string | null;
  primaryColor: string | null;
  footerText: string | null;
  supportEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type EmailDeliveryStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed";

export interface EmailDelivery {
  id: string;
  tenantId: string;
  appId: string;
  recipient: string;
  subject: string;
  provider: string;
  providerMsgId: string | null;
  status: EmailDeliveryStatus;
  failureReason: string | null;
  isTest: boolean;
  sentAt: Date;
  deliveredAt: Date | null;
  bouncedAt: Date | null;
}

export type EmailSuppressionReason =
  | "unsubscribed"
  | "bounced"
  | "complained"
  | "manual";

export interface EmailSuppression {
  tenantId: string;
  email: string;
  reason: EmailSuppressionReason;
  sourceDeliveryId: string | null;
  createdAt: Date;
}

export interface EmailStatsSummary {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
}

export interface EmailStarterContent {
  subject: string;
  heading: string | null;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
}

// ─── /services/email/send response taxonomy (per brief decision 12) ──────────

export type EmailSendResult =
  | { ok: true; delivered: true; deliveryId: string }
  | {
      ok: true;
      delivered: false;
      reason: "suppressed" | "missing_config" | "provider_failed";
      deliveryId?: string;
    };
