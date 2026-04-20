import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getTenantBasics } from "@platform-back/db";
import { QuotaExceededError, sendEmail } from "@platform-back/email";
import { createRequestLogger } from "@platform-back/logger";
import type { EmailSendResult } from "@platform-back/types";
import { ErrorCode, errorResponse } from "../../lib/error-response.js";
import { resolveAppFromSaEmail } from "../../lib/sa-to-app.js";
import { verifyCallerIdToken } from "../../lib/verify-id-token.js";

// ─── Body schemas ────────────────────────────────────────────────────────────
// `to` and `data` come from the handler. tenantId / appId / storeName / plan
// are NEVER trusted from the body — derived from the verified ID token (per
// brief decision 5).

const SendBodySchema = z.object({
  to: z.string().email(),
  data: z.record(z.unknown()).default({}),
  isTest: z.boolean().optional(),
});

const BatchBodySchema = z.object({
  // Same item shape as /send — just a batch wrapper. Cap at 100 per call so
  // a single fanout doesn't tie up an instance for minutes.
  items: z.array(SendBodySchema).min(1).max(100),
});

// ─── Plugin ─────────────────────────────────────────────────────────────────

export async function emailServiceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/send", sendHandler);
  app.post("/send-batch", sendBatchHandler);
}

// ─── Per-request auth resolution ─────────────────────────────────────────────
// Both endpoints share the same caller-resolution pipeline; pulled out so the
// handler bodies stay focused on their own logic.

interface ResolvedCaller {
  tenantId: string;
  appId: string;
  storeName: string;
  plan: import("@platform-back/types").BillingPlan;
}

async function resolveCaller(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ResolvedCaller | null> {
  // 1. Verify the inbound Google OIDC ID token.
  const verified = await verifyCallerIdToken(request.headers.authorization);
  if (!verified.ok) {
    const status = verified.reason === "missing_token" ? 401 : 403;
    void reply
      .code(status)
      .send(errorResponse(ErrorCode.Unauthorized, verified.reason));
    return null;
  }

  // 2. Map SA email → (tenantId, appId) via DB lookup.
  const identity = await resolveAppFromSaEmail(verified.caller.email);
  if (!identity) {
    request.log.warn(
      { saEmail: verified.caller.email },
      "/services: SA email not bound to any active app",
    );
    void reply
      .code(403)
      .send(
        errorResponse(
          ErrorCode.Forbidden,
          "Caller service account is not bound to an active app",
        ),
      );
    return null;
  }

  // 3. Load tenant basics (storeName + plan). plan drives quota; storeName
  //    appears in the email From line.
  const tenant = await getTenantBasics(identity.tenantId);
  if (!tenant) {
    void reply
      .code(403)
      .send(
        errorResponse(ErrorCode.Forbidden, "Tenant is not active"),
      );
    return null;
  }

  return {
    tenantId: identity.tenantId,
    appId: identity.appId,
    storeName: tenant.storeName,
    plan: tenant.plan,
  };
}

// ─── POST /services/email/send ───────────────────────────────────────────────

async function sendHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const caller = await resolveCaller(request, reply);
  if (!caller) return;

  const log = createRequestLogger({ requestId: request.id });

  const parsed = SendBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Invalid request body",
          parsed.error.flatten(),
        ),
      );
  }
  const body = parsed.data;

  try {
    const result = await sendEmail({
      tenantId: caller.tenantId,
      appId: caller.appId,
      storeName: caller.storeName,
      plan: caller.plan,
      recipient: body.to,
      data: body.data,
      ...(body.isTest === undefined ? {} : { isTest: body.isTest }),
      log,
    });
    return reply.code(200).send(result satisfies EmailSendResult);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return reply.code(429).send({
        error: "quota_exceeded",
        limit: err.limit,
        current: err.current,
        resetsAt: err.resetsAt,
      });
    }
    log.error({ err }, "/services/email/send: unexpected failure");
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Send failed unexpectedly"));
  }
}

// ─── POST /services/email/send-batch ─────────────────────────────────────────
//
// Sequential per-item processing — keeps quota checks deterministic (a batch
// of 50 against a quota of 30 stops at item 30 and reports the rest as
// quota_exceeded). Parallel sends would race the quota counter and either
// over-send or require a transactional reservation we don't have today.

async function sendBatchHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const caller = await resolveCaller(request, reply);
  if (!caller) return;

  const log = createRequestLogger({ requestId: request.id });

  const parsed = BatchBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Invalid request body",
          parsed.error.flatten(),
        ),
      );
  }

  type BatchItemResult =
    | { index: number; status: 200; result: EmailSendResult }
    | {
        index: number;
        status: 429;
        error: "quota_exceeded";
        limit: number;
        current: number;
      }
    | { index: number; status: 500; error: "send_failed" };

  const results: BatchItemResult[] = [];
  // First QuotaExceededError observed in the batch — its limit/current
  // values get reused for every subsequent item so the caller can see
  // the real numbers, not zeros.
  let quotaHit: { limit: number; current: number } | null = null;

  for (let i = 0; i < parsed.data.items.length; i++) {
    const item = parsed.data.items[i]!;
    if (quotaHit) {
      results.push({
        index: i,
        status: 429,
        error: "quota_exceeded",
        limit: quotaHit.limit,
        current: quotaHit.current,
      });
      continue;
    }
    try {
      const result = await sendEmail({
        tenantId: caller.tenantId,
        appId: caller.appId,
        storeName: caller.storeName,
        plan: caller.plan,
        recipient: item.to,
        data: item.data,
        ...(item.isTest === undefined ? {} : { isTest: item.isTest }),
        log,
      });
      results.push({ index: i, status: 200, result });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        quotaHit = { limit: err.limit, current: err.current };
        results.push({
          index: i,
          status: 429,
          error: "quota_exceeded",
          limit: err.limit,
          current: err.current,
        });
      } else {
        log.error({ err, index: i }, "/services/email/send-batch: item failed");
        results.push({ index: i, status: 500, error: "send_failed" });
      }
    }
  }

  // 207 Multi-Status — some items may have succeeded while others were
  // throttled; the caller decides what to do per-item. 200 would mask
  // partial failure; 429 would mask any successes.
  return reply.code(207).send({ items: results });
}
