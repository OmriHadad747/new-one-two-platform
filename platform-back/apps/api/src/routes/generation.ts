/**
 * Generation lifecycle routes (legacy-compatible URL shapes).
 *
 * The dashboard currently talks to platform/apps/api at these paths.
 * This file provides identical URL shapes in platform-back so the
 * dashboard can be flipped by changing VITE_API_URL (or equivalent)
 * alone — no frontend code changes needed.
 *
 * POST   /generation              — Start generation
 * GET    /generation/:jobId/progress  — SSE stream of ProgressEvents
 * GET    /generation/:jobId/result    — Stored generation bundle
 * POST   /generation/:jobId/approve  — Deploy (alias for generations route)
 * POST   /generation/:jobId/revise   — Start a revision
 * GET    /generation/app/:appId/latest         — Latest generation (any status)
 * GET    /generation/app/:appId/latest-completed — Latest success generation
 * GET    /generation/app/:appId/sessions       — Recent generations list
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  getAppById,
  getAppSlugs,
  createPendingGeneration,
  getGenerationByJobId,
  getLatestGenerationForApp,
  getLatestCompletedGenerationForApp,
  listGenerationsForApp,
  markGenerationDeployed,
} from "@platform-back/db";
import { startDeploy } from "@platform-back/deployer";
import { logger } from "@platform-back/logger";
import { publishGenerationRequest } from "../pubsub/publisher.js";
import { registerProgressListener } from "../pubsub/progress-subscriber.js";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { requireTenant } from "../plugins/auth.js";

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

// ─── Route registration ────────────────────────────────────────────────────────

export async function generationLifecycleRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post("/generation", startGenerationHandler);
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

  const appRecord = await getAppById(appId);
  if (!appRecord || appRecord.tenantId !== tenantId) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }

  const jobId = crypto.randomUUID();

  // Persist a pending row so result / progress can look the generation up
  // before the generator finishes.
  await createPendingGeneration({ jobId, tenantId, appId });

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

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };

  const unsubscribe = registerProgressListener(jobId, (event) => {
    if (!raw.destroyed && raw.writable) {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    // Close on terminal events
    if (
      event.status === "completed" ||
      event.status === "failed"
    ) {
      if (event.agent === "explanation" || event.status === "failed") {
        cleanup();
        raw.end();
      }
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
  return reply.send(row);
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
  if (row.status !== "success" || !row.bundle) {
    return reply.code(409).send(errorResponse(ErrorCode.Conflict, "Generation not complete or bundle missing"));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bundle = row.bundle as any;
  const handlerFiles: Array<{ path: string; contents: string }> = bundle?.handlerModule?.files ?? [];
  const migrationFile = bundle?.dbMigration ?? null;
  if (!handlerFiles.length || !migrationFile) {
    return reply.code(500).send(errorResponse(ErrorCode.Internal, "Bundle malformed"));
  }

  const [appRecord, slugs] = await Promise.all([
    getAppById(row.appId),
    getAppSlugs(row.appId),
  ]);
  if (!appRecord || !slugs) return reply.code(404).send(errorResponse(ErrorCode.NotFound, "App not found"));

  const webhookTopics: string[] = Array.isArray(bundle?.handlerModule?.webhookTopics)
    ? (bundle.handlerModule.webhookTopics as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : [];

  const tenantSchema = `tenant_${appRecord.tenantId.replace(/-/g, "_")}`;
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

  await markGenerationDeployed(jobId).catch(() => {});
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
  await createPendingGeneration({ jobId: newJobId, tenantId: priorRow.tenantId, appId: priorRow.appId });

  await publishGenerationRequest({
    jobId: newJobId,
    tenantId: priorRow.tenantId,
    appId: priorRow.appId,
    prompt: parsed.data.feedback,
    priorBundle: (priorRow.bundle as Record<string, unknown>) ?? null,
  });

  logger.info({ newJobId, priorJobId: jobId }, "Revision started");
  return reply.code(202).send({ jobId: newJobId });
}

async function latestHandler(
  req: FastifyRequest<{ Params: { appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { appId } = req.params;
  const appRecord = await getAppById(appId);
  if (!appRecord) return reply.code(404).send(errorResponse(ErrorCode.NotFound, "App not found"));
  if (!requireTenant(req, reply, appRecord.tenantId)) return;
  const row = await getLatestGenerationForApp(appId);
  return reply.send(row ?? null);
}

async function latestCompletedHandler(
  req: FastifyRequest<{ Params: { appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { appId } = req.params;
  const appRecord = await getAppById(appId);
  if (!appRecord) return reply.code(404).send(errorResponse(ErrorCode.NotFound, "App not found"));
  if (!requireTenant(req, reply, appRecord.tenantId)) return;
  const row = await getLatestCompletedGenerationForApp(appId);
  return reply.send(row ?? null);
}

async function sessionsHandler(
  req: FastifyRequest<{ Params: { appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { appId } = req.params;
  const appRecord = await getAppById(appId);
  if (!appRecord) return reply.code(404).send(errorResponse(ErrorCode.NotFound, "App not found"));
  if (!requireTenant(req, reply, appRecord.tenantId)) return;
  const rows = await listGenerationsForApp(appId);
  return reply.send(rows);
}
