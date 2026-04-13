/**
 * Resend delivery webhook ingest.
 *
 * Receives event callbacks from Resend after a message is processed:
 *   email.sent        → (informational, no status change)
 *   email.delivered   → status = 'delivered'
 *   email.bounced     → status = 'bounced', add to tenant suppression list
 *   email.complained  → status = 'complained', add to tenant suppression list
 *   email.failed      → status = 'failed'
 *
 * Signature verification uses `Svix-Signature` header with the secret from
 * RESEND_WEBHOOK_SECRET. See https://resend.com/docs/dashboard/webhooks
 *
 * Every delivery record is keyed by `provider_msg_id` (Resend's email ID)
 * stored when the email service first submitted the send.
 */
import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "@new-one-two/logger";
import {
  updateEmailDeliveryByProviderId,
  insertEmailSuppression,
} from "@new-one-two/db";
import type { EmailDeliveryStatus, EmailSuppressionReason } from "@new-one-two/types";

const RESEND_WEBHOOK_SECRET = process.env["RESEND_WEBHOOK_SECRET"] ?? "";

interface ResendEvent {
  type: string;
  data: {
    email_id?: string;
    created_at?: string;
    to?: string | string[];
    from?: string;
    subject?: string;
    // bounce/complaint-specific fields
    bounce?: { type?: string; message?: string };
    complaint?: { type?: string };
    // failure-specific
    error?: { message?: string };
  };
}

// ─── Event → status + suppression mapping ────────────────────────────────────

function mapEvent(type: string): {
  status: EmailDeliveryStatus | null;
  suppressionReason: EmailSuppressionReason | null;
  timestampField: "deliveredAt" | "bouncedAt" | null;
} {
  switch (type) {
    case "email.sent":
      return { status: "sent", suppressionReason: null, timestampField: null };
    case "email.delivered":
      return { status: "delivered", suppressionReason: null, timestampField: "deliveredAt" };
    case "email.bounced":
      return { status: "bounced", suppressionReason: "bounced", timestampField: "bouncedAt" };
    case "email.complained":
      return { status: "complained", suppressionReason: "complained", timestampField: null };
    case "email.failed":
      return { status: "failed", suppressionReason: null, timestampField: null };
    default:
      return { status: null, suppressionReason: null, timestampField: null };
  }
}

// ─── Signature verification (Svix-compatible HMAC SHA-256) ───────────────────

function verifyResendSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string
): boolean {
  if (!RESEND_WEBHOOK_SECRET) {
    // In dev without a secret, accept everything — but still log.
    logger.warn("RESEND_WEBHOOK_SECRET not set; accepting webhook without verification");
    return true;
  }

  // Resend uses Svix under the hood. Signed payload is `${id}.${timestamp}.${rawBody}`.
  const secretBytes = Buffer.from(
    RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ""),
    "base64"
  );
  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(toSign).digest("base64");

  // Svix signatures come as `v1,<base64>` possibly with multiple space-delimited entries.
  const signatures = svixSignature.split(" ").map((s) => s.split(",")[1]).filter(Boolean) as string[];
  const expectedBuf = Buffer.from(expected, "base64");

  for (const sig of signatures) {
    const sigBuf = Buffer.from(sig, "base64");
    if (sigBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(sigBuf, expectedBuf)) return true;
  }
  return false;
}

// ─── Route ───────────────────────────────────────────────────────────────────

export const resendWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.post("/resend", async (req, reply) => {
    const rawBody = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});

    const svixId = req.headers["svix-id"] as string | undefined;
    const svixTimestamp = req.headers["svix-timestamp"] as string | undefined;
    const svixSignature = req.headers["svix-signature"] as string | undefined;

    if (RESEND_WEBHOOK_SECRET && (!svixId || !svixTimestamp || !svixSignature)) {
      return reply.status(401).send({ error: "Missing signature headers" });
    }

    if (svixId && svixTimestamp && svixSignature) {
      const valid = verifyResendSignature(rawBody, svixId, svixTimestamp, svixSignature);
      if (!valid) {
        logger.warn({ svixId }, "Resend webhook signature verification failed");
        return reply.status(401).send({ error: "Invalid signature" });
      }
    }

    const event = req.body as ResendEvent;
    const mapped = mapEvent(event.type);
    if (!mapped.status) {
      logger.debug({ type: event.type }, "Ignoring unknown Resend event type");
      return reply.send({ ok: true, ignored: true });
    }

    const providerMsgId = event.data.email_id;
    if (!providerMsgId) {
      logger.warn({ event: event.type }, "Resend event missing email_id");
      return reply.send({ ok: true, skipped: true });
    }

    const now = new Date();
    const failureReason =
      mapped.status === "bounced"
        ? event.data.bounce?.message ?? event.data.bounce?.type ?? "bounced"
        : mapped.status === "failed"
        ? event.data.error?.message ?? "failed"
        : null;

    const updateParams: {
      status: EmailDeliveryStatus;
      failureReason?: string | null;
      deliveredAt?: Date | null;
      bouncedAt?: Date | null;
    } = { status: mapped.status };
    if (failureReason) updateParams.failureReason = failureReason;
    if (mapped.timestampField === "deliveredAt") updateParams.deliveredAt = now;
    if (mapped.timestampField === "bouncedAt") updateParams.bouncedAt = now;

    const row = await updateEmailDeliveryByProviderId(providerMsgId, updateParams);
    if (!row) {
      logger.warn({ providerMsgId, type: event.type }, "Resend event for unknown delivery — ignoring");
      return reply.send({ ok: true, unknown: true });
    }

    // Auto-suppress on hard bounce / complaint.
    if (mapped.suppressionReason) {
      await insertEmailSuppression({
        tenantId: row.tenantId,
        email: row.recipient,
        reason: mapped.suppressionReason,
        sourceDeliveryId: row.id,
      });
      logger.info(
        { tenantId: row.tenantId, email: row.recipient, reason: mapped.suppressionReason },
        "Recipient added to suppression list from Resend webhook"
      );
    }

    return reply.send({ ok: true });
  });
};
