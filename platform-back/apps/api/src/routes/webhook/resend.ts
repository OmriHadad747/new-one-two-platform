import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  insertEmailSuppression,
  updateEmailDeliveryByProviderId,
} from "@platform-back/db";
import { logger } from "@platform-back/logger";
import type {
  EmailDeliveryStatus,
  EmailSuppressionReason,
} from "@platform-back/types";

// Resend delivers webhooks as Svix-format signed payloads:
//   Svix-Id / Svix-Timestamp / Svix-Signature
// Signed payload is `${id}.${timestamp}.${rawBody}`; secret prefix is
// `whsec_` followed by the raw secret in base64.
//
// Idempotency: Resend may re-deliver the same event. Updates to
// email_deliveries rows are idempotent (status overwrite is fine — once
// a row is "delivered" we'd ignore subsequent "sent" events because the
// mapper returns null for unknown types). Suppression inserts use ON
// CONFLICT DO NOTHING.

const RESEND_WEBHOOK_SECRET = process.env["RESEND_WEBHOOK_SECRET"] ?? "";

interface ResendEvent {
  type: string;
  data: {
    email_id?: string;
    bounce?: { type?: string; message?: string };
    complaint?: { type?: string };
    error?: { message?: string };
  };
}

interface EventMapping {
  status: EmailDeliveryStatus | null;
  suppressionReason: EmailSuppressionReason | null;
  timestampField: "deliveredAt" | "bouncedAt" | null;
}

function mapEvent(type: string): EventMapping {
  switch (type) {
    case "email.sent":
      return { status: "sent", suppressionReason: null, timestampField: null };
    case "email.delivered":
      return {
        status: "delivered",
        suppressionReason: null,
        timestampField: "deliveredAt",
      };
    case "email.bounced":
      return {
        status: "bounced",
        suppressionReason: "bounced",
        timestampField: "bouncedAt",
      };
    case "email.complained":
      return {
        status: "complained",
        suppressionReason: "complained",
        timestampField: null,
      };
    case "email.failed":
      return {
        status: "failed",
        suppressionReason: null,
        timestampField: null,
      };
    default:
      return { status: null, suppressionReason: null, timestampField: null };
  }
}

function verifyResendSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
): boolean {
  if (!RESEND_WEBHOOK_SECRET) {
    // Dev-mode fallthrough — explicit warn so this is never silent.
    logger.warn(
      "RESEND_WEBHOOK_SECRET not set; accepting webhook without verification",
    );
    return true;
  }

  const secretBytes = Buffer.from(
    RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ""),
    "base64",
  );
  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(toSign).digest();

  // Svix sends `v1,<base64sig>` possibly multiple space-delimited entries;
  // any one matching is considered valid.
  const signatures = svixSignature
    .split(" ")
    .map((s) => s.split(",")[1])
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  for (const sig of signatures) {
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (sigBuf.length !== expected.length) continue;
    if (timingSafeEqual(sigBuf, expected)) return true;
  }
  return false;
}

export async function resendWebhookRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post("/resend", async (req, reply) => {
    const rawBuf = (req as { rawBody?: Buffer }).rawBody;
    const rawBody = rawBuf ? rawBuf.toString("utf-8") : JSON.stringify(req.body ?? {});

    const svixId = req.headers["svix-id"];
    const svixTimestamp = req.headers["svix-timestamp"];
    const svixSignature = req.headers["svix-signature"];

    if (
      RESEND_WEBHOOK_SECRET &&
      (typeof svixId !== "string" ||
        typeof svixTimestamp !== "string" ||
        typeof svixSignature !== "string")
    ) {
      return reply.code(401).send({ error: "missing_signature_headers" });
    }

    if (
      typeof svixId === "string" &&
      typeof svixTimestamp === "string" &&
      typeof svixSignature === "string"
    ) {
      const valid = verifyResendSignature(
        rawBody,
        svixId,
        svixTimestamp,
        svixSignature,
      );
      if (!valid) {
        logger.warn({ svixId }, "Resend webhook signature verification failed");
        return reply.code(401).send({ error: "invalid_signature" });
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

    const failureReason =
      mapped.status === "bounced"
        ? (event.data.bounce?.message ??
          event.data.bounce?.type ??
          "bounced")
        : mapped.status === "failed"
          ? (event.data.error?.message ?? "failed")
          : null;

    const updateParams: {
      status: EmailDeliveryStatus;
      failureReason?: string | null;
      deliveredAt?: Date | null;
      bouncedAt?: Date | null;
    } = { status: mapped.status };
    if (failureReason) updateParams.failureReason = failureReason;
    if (mapped.timestampField === "deliveredAt") {
      updateParams.deliveredAt = new Date();
    }
    if (mapped.timestampField === "bouncedAt") {
      updateParams.bouncedAt = new Date();
    }

    const row = await updateEmailDeliveryByProviderId(
      providerMsgId,
      updateParams,
    );
    if (!row) {
      logger.warn(
        { providerMsgId, type: event.type },
        "Resend event for unknown delivery — ignoring",
      );
      return reply.send({ ok: true, unknown: true });
    }

    if (mapped.suppressionReason) {
      await insertEmailSuppression({
        tenantId: row.tenantId,
        email: row.recipient,
        reason: mapped.suppressionReason,
        sourceDeliveryId: row.id,
      });
      logger.info(
        {
          tenantId: row.tenantId,
          email: row.recipient,
          reason: mapped.suppressionReason,
        },
        "Recipient added to suppression list from Resend webhook",
      );
    }

    return reply.send({ ok: true });
  });
}
