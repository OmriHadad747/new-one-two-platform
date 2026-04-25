import { Resend } from "resend";
import {
  checkUsageQuota,
  getAppEmailConfig,
  getAppEmailVariables,
  getTenantBrand,
  incrementUsage,
  insertEmailDelivery,
  isEmailSuppressed,
  updateEmailDeliveryStatus,
} from "@platform-back/db";
import type { Logger } from "@platform-back/logger";
import { getPlanLimits, type BillingPlan, type EmailSendResult } from "@platform-back/types";
import { renderEmail } from "./renderer.js";
import { signUnsubscribeToken } from "./unsubscribe-token.js";

const RESEND_API_KEY = process.env["RESEND_API_KEY"] ?? "";
const RESEND_FROM_TRANSACTIONAL =
  process.env["RESEND_FROM_TRANSACTIONAL"] ?? "notifications@mail.ton-platform.com";
const RESEND_FROM_MARKETING =
  process.env["RESEND_FROM_MARKETING"] ?? "marketing@mail.ton-platform.com";
const UNSUBSCRIBE_BASE_URL = process.env["UNSUBSCRIBE_BASE_URL"] ?? "https://ton-platform.com/u";

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(RESEND_API_KEY || "dev_no_key");
  }
  return _resend;
}

export interface SendEmailInput {
  /** Verified by the route from the inbound ID token — never from request body. */
  tenantId: string;
  /** Verified by the route from the inbound ID token — never from request body. */
  appId: string;
  /** From the tenant row. Used in the From line; defaults to shop domain if null. */
  storeName: string;
  /** Tenant's billing plan — drives quota lookup. */
  plan: BillingPlan;
  /** Recipient address (from request body). */
  recipient: string;
  /** Variables bound to {{tokens}} in the merchant template. */
  data: Record<string, unknown>;
  /** When TRUE: skips the suppression+quota gates, prepends `subjectPrefix`,
   *  flags the delivery row is_test=true, and does NOT increment usage. */
  isTest?: boolean;
  /** Optional subject prefix applied to the rendered subject. Used for test sends ("[TEST] "). */
  subjectPrefix?: string;
  log: Logger;
}

export class QuotaExceededError extends Error {
  public readonly limit: number;
  public readonly current: number;
  public readonly resetsAt: Date | null;

  constructor(limit: number, current: number, resetsAt: Date | null) {
    super(`Monthly email limit (${limit.toLocaleString()}) reached`);
    this.name = "QuotaExceededError";
    this.limit = limit;
    this.current = current;
    this.resetsAt = resetsAt;
  }
}

/**
 * Core /services/email/send implementation. Returns the response taxonomy
 * directly (per brief decision 12). Throws only on quota exceeded; all
 * other "delivered=false" outcomes are returned as 200 results so the
 * route layer doesn't need to map exceptions.
 */
export async function sendEmail(input: SendEmailInput): Promise<EmailSendResult> {
  const { tenantId, appId, storeName, plan, log, isTest, subjectPrefix } = input;
  const recipient = input.recipient.trim().toLowerCase();
  const data = input.data ?? {};

  // Test sends bypass suppression + quota by design — they're a merchant
  // self-test against their own inbox and shouldn't be blocked by their
  // own historical unsubscribes or counted against their plan.
  if (!isTest) {
    // 1. Suppression check — silent skip on match.
    if (await isEmailSuppressed(tenantId, recipient)) {
      log.info(
        { event: "EMAIL_SUPPRESSED", tenantId, appId, recipient },
        "recipient is on the suppression list — skipping send",
      );
      return { ok: true, delivered: false, reason: "suppressed" };
    }

    // 2. Plan quota — throw so the route returns 429.
    const emailLimit = getPlanLimits(plan).maxEmailsPerMonth;
    const quota = await checkUsageQuota(tenantId, "emails_sent", emailLimit);
    if (!quota.allowed) {
      log.warn({ tenantId, current: quota.current, limit: quota.limit }, "Email quota exceeded");
      throw new QuotaExceededError(quota.limit, quota.current, null);
    }
  }

  // 3. Load merchant template.
  const config = await getAppEmailConfig(appId);
  if (!config) {
    log.error(
      { event: "EMAIL_NO_CONFIG", tenantId, appId, recipient },
      "send called but app_email_configs row is missing — deploy should have blocked this",
    );
    return { ok: true, delivered: false, reason: "missing_config" };
  }

  // 3b. Manifest-drift observation — observational only, never blocks send.
  try {
    const declared = await getAppEmailVariables(appId);
    if (declared.length > 0) {
      const provided = Object.keys(data);
      const missing = declared.filter((v) => !provided.includes(v));
      const extra = provided.filter((v) => !declared.includes(v));
      if (missing.length > 0 || extra.length > 0) {
        log.warn(
          {
            event: "EMAIL_DATA_MANIFEST_DRIFT",
            tenantId,
            appId,
            recipient,
            declared,
            provided,
            missing,
            extra,
          },
          "send data keys do not match the declared emailVariables manifest — merchant {{tokens}} may render empty",
        );
      }
    }
  } catch (err) {
    log.warn(
      { event: "EMAIL_DRIFT_CHECK_FAILED", tenantId, appId, err: String(err) },
      "manifest drift check failed; continuing with send",
    );
  }

  // 4. Tenant brand (renderer falls back to defaults if null).
  const brand = await getTenantBrand(tenantId);

  // 5. Sign unsubscribe token + render.
  const unsubscribeToken = signUnsubscribeToken(tenantId, recipient);
  const unsubscribeUrl = `${UNSUBSCRIBE_BASE_URL}/${unsubscribeToken}`;

  const rendered = renderEmail({
    config,
    brand,
    variables: data,
    unsubscribeUrl,
    storeName,
  });

  // 6. Insert delivery row pre-send.
  const { id: deliveryId } = await insertEmailDelivery({
    tenantId,
    appId,
    recipient,
    subject: rendered.subject,
    ...(isTest === undefined ? {} : { isTest }),
  });

  // 7. Submit to Resend.
  const fromAddress =
    config.emailType === "marketing" ? RESEND_FROM_MARKETING : RESEND_FROM_TRANSACTIONAL;
  const from = `${storeName} <${fromAddress}>`;

  const finalSubject = subjectPrefix ? `${subjectPrefix}${rendered.subject}` : rendered.subject;

  try {
    const result = await getResend().emails.send({
      from,
      to: recipient,
      subject: finalSubject,
      html: rendered.html,
      text: rendered.text,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Ton-Tenant": tenantId,
        "X-Ton-App": appId,
        "X-Ton-Delivery-Id": deliveryId,
        ...(isTest ? { "X-Ton-Test-Send": "1" } : {}),
      },
    });

    const providerMsgId = (result as { data?: { id?: string } })?.data?.id ?? null;
    await updateEmailDeliveryStatus(deliveryId, {
      status: "sent",
      providerMsgId,
    });

    log.info(
      {
        event: "EMAIL_SENT",
        tenantId,
        appId,
        recipient,
        providerMsgId,
        deliveryId,
      },
      "email submitted to provider",
    );

    // 8. Usage counter only on successful real (non-test) sends.
    if (!isTest) {
      await incrementUsage(tenantId, "emails_sent");
    }
    return { ok: true, delivered: true, deliveryId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateEmailDeliveryStatus(deliveryId, {
      status: "failed",
      failureReason: message,
    });
    log.error(
      { event: "EMAIL_FAILED", tenantId, appId, recipient, err: message },
      "email delivery failed at provider",
    );
    return {
      ok: true,
      delivered: false,
      reason: "provider_failed",
      deliveryId,
    };
  }
}
