// ─── Email Service ───────────────────────────────────────────────────────────
//
// Platform implementation of `ctx.email.send()`. Sits between generated
// handler code and the Resend MTA. The handler passes only `{ to, data }`;
// everything else — subject, body, brand, layout, from address, DKIM,
// analytics — is owned by the platform.
//
// Per-call flow:
//   1.  Suppression check  → if recipient is blocked for this tenant, silently skip
//   2.  Plan quota check   → throw if tenant exceeded monthly email allowance
//   3.  Load app_email_config for this.appId (injected via closure)
//       → if missing, log error and return (shouldn't happen — deploy blocks it)
//   3b. Manifest-drift observation — warn-log when the `data` keys the handler
//       passed disagree with apps.email_variables (the generator-declared
//       manifest). Observational only; the send proceeds. Catches agent drift
//       where the handler's declared variable list and its actual code diverge.
//   4.  Load tenant_brand (falls back to platform defaults if null)
//   5.  Render blocks → MJML → HTML using the merchant-configured template
//   6.  Insert email_deliveries row (status='queued')
//   7.  Submit to Resend; update row to 'sent' or 'failed' on response
//   8.  Increment emails_sent counter
//
// Resend failures are logged and recorded but do NOT throw — the handler
// continues normally. Only missing config or quota exhaustion throws.

import { Resend } from "resend";
import type { EmailClient, EmailSendParams } from "@new-one-two/types";
import type { HandlerLogger } from "@new-one-two/types";
import {
  checkUsageQuota,
  incrementUsage,
  getAppEmailConfig,
  getAppEmailVariables,
  getTenantBrand,
  isEmailSuppressed,
  insertEmailDelivery,
  updateEmailDeliveryStatus,
} from "@new-one-two/db";
import { getPlanLimits } from "@new-one-two/types";
import type { BillingPlan } from "@new-one-two/types";
import { renderEmail, signUnsubscribeToken } from "./email-renderer.js";

// ─── Environment / config ────────────────────────────────────────────────────

const RESEND_API_KEY = process.env["RESEND_API_KEY"] ?? "";
const RESEND_FROM_TRANSACTIONAL =
  process.env["RESEND_FROM_TRANSACTIONAL"] ?? "notifications@mail.ton-platform.com";
const RESEND_FROM_MARKETING =
  process.env["RESEND_FROM_MARKETING"] ?? "marketing@mail.ton-platform.com";
const UNSUBSCRIBE_BASE_URL =
  process.env["UNSUBSCRIBE_BASE_URL"] ?? "https://ton-platform.com/u";

// A single shared Resend client. Instantiated lazily so tests / dev envs
// without a key can still import this module.
let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(RESEND_API_KEY || "dev_no_key");
  }
  return _resend;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface CreateEmailServiceOptions {
  tenantId: string;
  appId: string;
  storeName: string;          // display name used in the "From" field
  plan: BillingPlan;
  logger: HandlerLogger;
}

/**
 * Builds the `ctx.email` client for a specific app invocation. The returned
 * client captures tenantId + appId in its closure so handlers never need to
 * pass them — a handler just calls `ctx.email.send({ to, data })`.
 */
export function createEmailService(opts: CreateEmailServiceOptions): EmailClient {
  const { tenantId, appId, storeName, plan, logger } = opts;

  return {
    async send(params: EmailSendParams): Promise<void> {
      const recipient = params.to.trim().toLowerCase();
      const data = params.data ?? {};

      // 1. Suppression check — silent skip on match.
      const suppressed = await isEmailSuppressed(tenantId, recipient);
      if (suppressed) {
        logger.info(
          { event: "EMAIL_SUPPRESSED", tenantId, appId, recipient },
          "recipient is on the suppression list — skipping send"
        );
        return;
      }

      // 2. Plan quota — hard failure propagated to the handler.
      const emailLimit = getPlanLimits(plan).maxEmailsPerMonth;
      const quota = await checkUsageQuota(tenantId, "emails_sent", emailLimit);
      if (!quota.allowed) {
        logger.warn(
          { tenantId, current: quota.current, limit: quota.limit },
          "Email quota exceeded"
        );
        throw new Error(`Monthly email limit (${quota.limit.toLocaleString()}) reached.`);
      }

      // 3. Load merchant-owned template for this app.
      const config = await getAppEmailConfig(appId);
      if (!config) {
        logger.error(
          { event: "EMAIL_NO_CONFIG", tenantId, appId, recipient },
          "ctx.email.send() called but app_email_configs row is missing — deploy should have blocked this"
        );
        // Do not throw — the handler is mid-execution and may still need to finish
        // other work (DB writes, other integrations). Silent skip is the safer
        // default.
        return;
      }

      // 3b. Manifest-drift observation. Compare the keys the handler passed
      //     in `data` against the variable manifest the generator recorded
      //     at bundle-publish time. Mismatches mean the generator's
      //     declaration disagrees with what the handler code actually does —
      //     an agent-drift signal. Observational only: the send proceeds,
      //     unresolved {{tokens}} in the merchant's template simply render
      //     as empty. Manifest=[] means "check disabled" (legacy apps).
      try {
        const declared = await getAppEmailVariables(appId);
        if (declared.length > 0) {
          const provided = Object.keys(data);
          const missing = declared.filter((v: string) => !provided.includes(v));
          const extra = provided.filter((v: string) => !declared.includes(v));
          if (missing.length > 0 || extra.length > 0) {
            logger.warn(
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
              "ctx.email.send data keys do not match the declared emailVariables manifest — merchant's {{tokens}} may render empty"
            );
          }
        }
      } catch (err) {
        // Drift check must never break a send — swallow + log.
        logger.warn(
          { event: "EMAIL_DRIFT_CHECK_FAILED", tenantId, appId, err: String(err) },
          "manifest drift check failed; continuing with send"
        );
      }

      // 4. Tenant brand (may be null; renderer falls back to defaults).
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
      });

      // 7. Submit to Resend.
      const fromAddress =
        config.emailType === "marketing" ? RESEND_FROM_MARKETING : RESEND_FROM_TRANSACTIONAL;
      const from = `${storeName} <${fromAddress}>`;

      try {
        const result = await getResend().emails.send({
          from,
          to: recipient,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            "X-Ton-Tenant": tenantId,
            "X-Ton-App": appId,
            "X-Ton-Delivery-Id": deliveryId,
          },
        });

        const providerMsgId = (result as { data?: { id?: string } })?.data?.id ?? null;
        await updateEmailDeliveryStatus(deliveryId, {
          status: "sent",
          providerMsgId,
        });

        logger.info(
          { event: "EMAIL_SENT", tenantId, appId, recipient, providerMsgId, deliveryId },
          "email submitted to provider"
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updateEmailDeliveryStatus(deliveryId, {
          status: "failed",
          failureReason: message,
        });
        logger.error(
          { event: "EMAIL_FAILED", tenantId, appId, recipient, err: message },
          "email delivery failed — not rethrowing, handler will continue"
        );
        // Do NOT throw — Resend outages should not crash the handler.
      }

      // 8. Usage counter.
      await incrementUsage(tenantId, "emails_sent");
    },
  };
}
