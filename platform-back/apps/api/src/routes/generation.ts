/**
 * Generation lifecycle routes (legacy-compatible URL shapes).
 *
 * The dashboard currently talks to platform/apps/api at these paths.
 * This file provides identical URL shapes in platform-back so the
 * dashboard can be flipped by changing VITE_API_URL (or equivalent)
 * alone — no frontend code changes needed.
 *
 * POST   /generation              — Start generation
 * POST   /generation/analyze      — Product-agent clarification chat (proxies platform-ai)
 * GET    /generation/:jobId/progress  — SSE stream of ProgressEvents
 * GET    /generation/:jobId/result    — Stored generation bundle
 * POST   /generation/:jobId/approve   — Deploy (alias for generations route)
 * POST   /generation/:jobId/revise    — Start a revision
 * POST   /generation/:jobId/cancel    — Cancel a pending generation
 * PATCH  /generation/:jobId/chat      — Persist frontend chat history
 * GET    /generation/app/:appId/latest         — Latest generation (any status)
 * GET    /generation/app/:appId/latest-completed — Latest success generation
 * GET    /generation/app/:appId/sessions       — Recent generations list
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  getAppByIdUnsafe,
  getAppSlugs,
  getTenantById,
  createPendingGeneration,
  getGenerationByJobId,
  getLatestGenerationForApp,
  getLatestCompletedGenerationForApp,
  listGenerationsForApp,
  markGenerationDeployed,
  saveGenerationChat,
  setGenerationAppVersionId,
  cancelPendingGeneration,
  type GenerationRow,
} from "@platform-back/db";
import { appSchemaName, startDeploy } from "@platform-back/deployer";
import { logger } from "@platform-back/logger";
import { publishGenerationRequest } from "../pubsub/publisher.js";
import { registerProgressListener } from "../pubsub/progress-subscriber.js";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { requireTenant } from "../plugins/auth.js";
import { getGenerationBundle } from "../lib/bundle-storage.js";
import {
  canStartGeneration,
  isCategoryAllowed,
} from "../lib/plan-enforcement.js";

// ─── Request schemas ──────────────────────────────────────────────────────────

const PreComputedIntentSchema = z
  .object({
    triggerTypes: z.array(z.string()).optional(),
    resources: z.array(z.string()).optional(),
    desiredOutcome: z.string().optional(),
    cronSchedule: z.string().nullable().optional(),
    appCategory: z.string().optional(),
    qualityBrief: z.string().optional(),
    widgetDescription: z.string().max(2000).optional(),
    adminDescription: z.string().max(2000).optional(),
  })
  .strip();

const StartBodySchema = z.object({
  appId: z.string().uuid(),
  tenantId: z.string().uuid(),
  prompt: z.string().min(1).max(10_000),
  preComputedIntent: PreComputedIntentSchema.nullable().optional(),
});

const ReviseBodySchema = z.object({
  feedback: z.string().min(1).max(10_000),
});

const AnalyzeBodySchema = z.object({
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(10_000),
      }),
    )
    .min(1)
    .max(40),
});

const ChatBodySchema = z.object({
  messages: z.array(z.record(z.unknown())).max(500),
});

// ─── Response shaping ─────────────────────────────────────────────────────────

/**
 * Flatten a GenerationRow into the shape the dashboard expects. Historical
 * field names preserved so the frontend doesn't need a rename. The frontend
 * reads both the new names (jobId, bundle, meta) and old aliases
 * (errorMessage, prompt, webhookTopics, cronSchedule, chatMessages,
 * appVersionId) on the same payload.
 */
async function serializeGeneration(
  row: GenerationRow,
): Promise<Record<string, unknown>> {
  const bundle = row.bundleGcsPath
    ? await getGenerationBundle(row.bundleGcsPath).catch(() => null)
    : null;
  return {
    jobId: row.jobId,
    tenantId: row.tenantId,
    appId: row.appId,
    status: row.status,
    prompt: row.prompt ?? "",
    error: row.error,
    errorMessage: row.error,
    errorCode: row.errorCode,
    bundle,
    bundleGcsPath: row.bundleGcsPath,
    meta: row.meta,
    webhookTopics: row.webhookTopics,
    cronSchedule: row.cronSchedule,
    chatMessages: row.chatMessages,
    appVersionId: row.appVersionId,
    deployed: row.deployed,
    deployedAt: row.deployedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeSessionSummary(row: GenerationRow): Record<string, unknown> {
  return {
    id: row.jobId,
    jobId: row.jobId,
    status: row.status,
    prompt: row.prompt ?? "",
    errorMessage: row.error,
    appVersionId: row.appVersionId,
    createdAt: row.createdAt,
  };
}

// ─── Route registration ────────────────────────────────────────────────────────

export async function generationLifecycleRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post("/generation", startGenerationHandler);
  app.post("/generation/analyze", analyzeHandler);
  app.get<{ Params: { jobId: string } }>(
    "/generation/:jobId/progress",
    progressHandler,
  );
  app.get<{ Params: { jobId: string } }>(
    "/generation/:jobId/result",
    resultHandler,
  );
  app.post<{ Params: { jobId: string } }>(
    "/generation/:jobId/approve",
    approveHandler,
  );
  app.post<{ Params: { jobId: string } }>(
    "/generation/:jobId/revise",
    reviseHandler,
  );
  app.post<{ Params: { jobId: string } }>(
    "/generation/:jobId/cancel",
    cancelHandler,
  );
  app.patch<{ Params: { jobId: string } }>(
    "/generation/:jobId/chat",
    saveChatHandler,
  );
  app.get<{ Params: { appId: string } }>(
    "/generation/app/:appId/latest",
    latestHandler,
  );
  app.get<{ Params: { appId: string } }>(
    "/generation/app/:appId/latest-completed",
    latestCompletedHandler,
  );
  app.get<{ Params: { appId: string } }>(
    "/generation/app/:appId/sessions",
    sessionsHandler,
  );
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

async function startGenerationHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const parsed = StartBodySchema.safeParse(req.body);
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
  const { appId, tenantId, prompt, preComputedIntent } = parsed.data;

  if (!requireTenant(req, reply, tenantId)) return;

  const appRecord = await getAppByIdUnsafe(appId);
  if (!appRecord || appRecord.tenantId !== tenantId) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }

  // Plan gates — generations-per-month and category allow-list. Merchant
  // sees `error` + `details.upgradeHint` parsed by parseGenError in the
  // dashboard (NewAppPage.tsx).
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
  }

  const genGate = await canStartGeneration(tenant);
  if (!genGate.allowed) {
    return reply
      .code(402)
      .send(
        errorResponse(ErrorCode.PlanLimited, genGate.reason ?? "Plan limit reached", {
          upgradeHint: genGate.upgradeHint,
        }),
      );
  }
  const archetype = preComputedIntent?.appCategory;
  if (archetype) {
    const catGate = isCategoryAllowed(tenant.billingPlan, archetype);
    if (!catGate.allowed) {
      return reply
        .code(402)
        .send(
          errorResponse(ErrorCode.PlanLimited, catGate.reason ?? "Category not allowed", {
            upgradeHint: catGate.upgradeHint,
            archetype,
          }),
        );
    }
  }

  const jobId = crypto.randomUUID();

  // Persist a pending row so result / progress can look the generation up
  // before the generator finishes. Prompt is stored so the Sessions list
  // and chat rehydration can render without re-reading the GCS bundle.
  await createPendingGeneration({ jobId, tenantId, appId, prompt });

  await publishGenerationRequest({
    jobId,
    tenantId,
    appId,
    prompt,
    preComputedIntent: preComputedIntent ?? null,
  });

  logger.info({ jobId, appId, tenantId }, "Generation started");
  return reply.code(202).send({ jobId });
}

async function analyzeHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const parsed = AnalyzeBodySchema.safeParse(req.body);
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

  const generatorUrl = process.env["GENERATOR_URL"];
  if (!generatorUrl) {
    logger.error("GENERATOR_URL not configured — /generation/analyze disabled");
    return reply
      .code(503)
      .send(errorResponse(ErrorCode.Internal, "Analyzer unavailable"));
  }

  const target = `${generatorUrl.replace(/\/+$/, "")}/analyze`;
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
    const text = await upstream.text();
    reply.code(upstream.status).header("content-type", "application/json");
    return reply.send(text);
  } catch (err) {
    logger.error({ err, target }, "Analyze proxy failed");
    return reply
      .code(502)
      .send(errorResponse(ErrorCode.BadGateway, "Analyzer unreachable"));
  }
}

async function progressHandler(
  req: FastifyRequest<{ Params: { jobId: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { jobId } = req.params;

  // SSE — hijack the connection and write events directly.
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const keepAlive = setInterval(() => {
    if (!raw.destroyed && raw.writable) raw.write(": keep-alive\n\n");
  }, 25_000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
  };

  const writeEvent = (payload: Record<string, unknown>) => {
    if (!raw.destroyed && raw.writable) {
      raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  const emitTerminal = async (
    status: "success" | "failed",
    rawEvent: Record<string, unknown>,
  ) => {
    // Read meta + error details from the generations row so the
    // synthesized CompletedEvent carries the cost numbers the dashboard
    // displays. One PK lookup, fire-and-forget on error.
    let meta: unknown = null;
    let err: string | null = null;
    let errorCode: string | null = null;
    try {
      const row = await getGenerationByJobId(jobId);
      if (row) {
        meta = row.meta;
        err = row.error;
        errorCode = row.errorCode;
      }
    } catch (readErr) {
      logger.warn({ readErr, jobId }, "Failed to read generation for terminal SSE");
    }

    writeEvent({
      type: "completed",
      status: status === "success" ? "success" : "failed",
      ...(err ? { error: err } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(meta ? { meta } : {}),
      // Keep the underlying progress event around for debugging — frontend
      // ignores anything that isn't `type:"progress"|"completed"`.
      lastEvent: rawEvent,
    });
    cleanup();
    raw.end();
  };

  const unsubscribe = registerProgressListener(jobId, (event) => {
    // Every event goes on the wire as a ProgressEvent first.
    writeEvent({ ...event, type: "progress" });

    // Terminal detection mirrors the previous close logic: an
    // explanation-completed or any failed ends the generator run.
    if (event.status === "failed") {
      void emitTerminal("failed", event as unknown as Record<string, unknown>);
      return;
    }
    if (event.agent === "explanation" && event.status === "completed") {
      void emitTerminal("success", event as unknown as Record<string, unknown>);
    }
  });

  req.raw.on("close", cleanup);
  req.raw.on("error", cleanup);
}

async function resultHandler(
  req: FastifyRequest<{ Params: { jobId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { jobId } = req.params;
  const row = await getGenerationByJobId(jobId);
  if (!row) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Generation not found"));
  }
  if (!requireTenant(req, reply, row.tenantId)) return;
  return reply.send(await serializeGeneration(row));
}

async function approveHandler(
  req: FastifyRequest<{ Params: { jobId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { jobId } = req.params;
  const row = await getGenerationByJobId(jobId);
  if (!row) {
    return reply.code(404).send(errorResponse(ErrorCode.NotFound, "Generation not found"));
  }
  if (!requireTenant(req, reply, row.tenantId)) return;
  if (row.status !== "success" || !row.bundleGcsPath) {
    return reply.code(409).send(errorResponse(ErrorCode.Conflict, "Generation not complete or bundle missing"));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bundle = (await getGenerationBundle(row.bundleGcsPath)) as any;
  const handlerFiles: Array<{ path: string; contents: string }> = bundle?.handlerModule?.files ?? [];
  const migrationFile = bundle?.dbMigration ?? null;
  if (!handlerFiles.length || !migrationFile) {
    return reply.code(500).send(errorResponse(ErrorCode.Internal, "Bundle malformed"));
  }

  const [appRecord, slugs] = await Promise.all([
    getAppByIdUnsafe(row.appId),
    getAppSlugs(row.appId),
  ]);
  if (!appRecord || !slugs) return reply.code(404).send(errorResponse(ErrorCode.NotFound, "App not found"));

  const webhookTopics: string[] = Array.isArray(bundle?.handlerModule?.webhookTopics)
    ? (bundle.handlerModule.webhookTopics as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : [];

  const tenantSchema = appSchemaName(appRecord.tenantId, row.appId);
  const deployJobId = await startDeploy({
    appId: row.appId,
    appName: `app ${row.appId}`,
    appVersionId: jobId,
    appVersion: `gen-${jobId.slice(0, 8)}`,
    tenantId: appRecord.tenantId,
    shopDomain: appRecord.shopDomain,
    appSlug: slugs.appSlug,
    tenantSlug: slugs.tenantSlug,
    tenantSchema,
    generatedFiles: [...handlerFiles, migrationFile],
    webhookTopics,
  });

  await Promise.all([
    markGenerationDeployed(jobId).catch(() => {}),
    // Record the app_version_id so the Sessions list can flag this row as
    // "Live" on subsequent reads of getAppById.activeAppVersionId.
    setGenerationAppVersionId(jobId, jobId).catch(() => {}),
  ]);
  return reply.code(202).send({ jobId: deployJobId });
}

async function reviseHandler(
  req: FastifyRequest<{ Params: { jobId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { jobId } = req.params;

  const parsed = ReviseBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send(errorResponse(ErrorCode.InvalidRequest, "Invalid body", parsed.error.flatten()));
  }

  const priorRow = await getGenerationByJobId(jobId);
  if (!priorRow) {
    return reply.code(404).send(errorResponse(ErrorCode.NotFound, "Prior generation not found"));
  }
  if (!requireTenant(req, reply, priorRow.tenantId)) return;

  const newJobId = crypto.randomUUID();
  await createPendingGeneration({
    jobId: newJobId,
    tenantId: priorRow.tenantId,
    appId: priorRow.appId,
    prompt: parsed.data.feedback,
  });

  await publishGenerationRequest({
    jobId: newJobId,
    tenantId: priorRow.tenantId,
    appId: priorRow.appId,
    prompt: parsed.data.feedback,
    priorBundle: priorRow.bundleGcsPath
      ? (await getGenerationBundle(priorRow.bundleGcsPath) as Record<string, unknown>)
      : null,
  });

  logger.info({ newJobId, priorJobId: jobId }, "Revision started");
  return reply.code(202).send({ jobId: newJobId });
}

async function cancelHandler(
  req: FastifyRequest<{ Params: { jobId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { jobId } = req.params;
  const row = await getGenerationByJobId(jobId);
  if (!row) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Generation not found"));
  }
  if (!requireTenant(req, reply, row.tenantId)) return;

  const cancelled = await cancelPendingGeneration(jobId);
  // Not an error if the job already finished — the client closed the SSE
  // stream already; it just wants its navigation unblocked. Return ok.
  return reply.send({ ok: true, cancelled });
}

async function saveChatHandler(
  req: FastifyRequest<{ Params: { jobId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { jobId } = req.params;
  const parsed = ChatBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Invalid body",
          parsed.error.flatten(),
        ),
      );
  }

  const row = await getGenerationByJobId(jobId);
  if (!row) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Generation not found"));
  }
  if (!requireTenant(req, reply, row.tenantId)) return;

  await saveGenerationChat(jobId, parsed.data.messages);
  return reply.code(204).send();
}

async function latestHandler(
  req: FastifyRequest<{ Params: { appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { appId } = req.params;
  const appRecord = await getAppByIdUnsafe(appId);
  if (!appRecord) return reply.code(404).send(errorResponse(ErrorCode.NotFound, "App not found"));
  if (!requireTenant(req, reply, appRecord.tenantId)) return;
  const row = await getLatestGenerationForApp(appId);
  return reply.send(row ? await serializeGeneration(row) : null);
}

async function latestCompletedHandler(
  req: FastifyRequest<{ Params: { appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { appId } = req.params;
  const appRecord = await getAppByIdUnsafe(appId);
  if (!appRecord) return reply.code(404).send(errorResponse(ErrorCode.NotFound, "App not found"));
  if (!requireTenant(req, reply, appRecord.tenantId)) return;
  const row = await getLatestCompletedGenerationForApp(appId);
  return reply.send(row ? await serializeGeneration(row) : null);
}

async function sessionsHandler(
  req: FastifyRequest<{ Params: { appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { appId } = req.params;
  const appRecord = await getAppByIdUnsafe(appId);
  if (!appRecord) return reply.code(404).send(errorResponse(ErrorCode.NotFound, "App not found"));
  if (!requireTenant(req, reply, appRecord.tenantId)) return;
  const rows = await listGenerationsForApp(appId);
  return reply.send(rows.map(serializeSessionSummary));
}
