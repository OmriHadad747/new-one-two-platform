import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getAppById } from "@platform-back/db";
import {
  getDeployJob,
  startDeploy,
  subscribeDeployJob,
  type DeployJobEvent,
} from "@platform-back/deployer";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { requireTenant } from "../plugins/auth.js";

// Dashboard-facing deploy endpoints. The actual orchestration runs in
// `@platform-back/deployer` — these routes are a thin shell:
//   POST /apps/:appId/deploy      → register a job, return jobId
//   GET  /deploy/jobs/:jobId      → stream live progress as SSE
//
// SSE clients can't send custom headers (EventSource), so the GET route
// expects auth via `?token=` — handled transparently by plugins/auth.ts.

// ─── Body schema ─────────────────────────────────────────────────────────────
//
// Size caps are defence-in-depth. Fastify's per-route bodyLimit (set
// below in deployRoutes) rejects oversized requests before Zod even
// sees them; the per-file Zod cap protects against many-small-files
// payloads that slip under the body limit but still bloat the build
// context.

const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB per generated file
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB total request

const GeneratedFileSchema = z.object({
  path: z.string().min(1).max(512),
  contents: z.string().max(MAX_FILE_BYTES),
});

const DeployBodySchema = z.object({
  appVersionId: z.string().uuid(),
  appVersion: z.string().min(1).max(128),
  generatedFiles: z.array(GeneratedFileSchema).min(1).max(500),
  /** Optional handler env-var overrides (merged on top of orchestrator defaults). */
  handlerEnv: z.record(z.string()).optional(),
  /**
   * Cron expression from the architect plan (handlerModule.cronSchedule).
   * Orchestrator step 8 registers the pg_cron tick when set, unschedules
   * any stale registration when null / absent.
   */
  cronSchedule: z.string().min(1).max(80).nullable().optional(),
});

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { appId: string } }>(
    "/apps/:appId/deploy",
    {
      // Override the global 1 MiB bodyLimit — deploy bundles can carry
      // up to MAX_BODY_BYTES of generator-emitted files. Per-file size
      // is also capped in the Zod schema above.
      bodyLimit: MAX_BODY_BYTES,
    },
    deployHandler,
  );
  app.get<{ Params: { jobId: string } }>(
    "/deploy/jobs/:jobId",
    deployStreamHandler,
  );
}

// ─── POST /apps/:appId/deploy ────────────────────────────────────────────────

async function deployHandler(
  req: FastifyRequest<{ Params: { appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { appId } = req.params;

  const appRecord = await getAppById(appId);
  if (!appRecord) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }
  if (!requireTenant(req, reply, appRecord.tenantId)) return;

  const parsed = DeployBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Invalid deploy body",
          parsed.error.flatten(),
        ),
      );
  }

  // Tenant schema name is derived from the tenant id — UUIDs include
  // hyphens which are illegal in Postgres identifiers, so we substitute.
  const tenantSchema = `tenant_${appRecord.tenantId.replace(/-/g, "_")}`;

  try {
    const jobId = await startDeploy({
      appId,
      appName: `app ${appId}`,
      appVersionId: parsed.data.appVersionId,
      appVersion: parsed.data.appVersion,
      tenantId: appRecord.tenantId,
      shopDomain: appRecord.shopDomain,
      tenantSchema,
      generatedFiles: parsed.data.generatedFiles,
      ...(parsed.data.handlerEnv === undefined
        ? {}
        : { handlerEnv: parsed.data.handlerEnv }),
      cronSchedule: parsed.data.cronSchedule ?? null,
    });

    return reply.code(202).send({ jobId });
  } catch (err) {
    req.log.error({ err, appId }, "Failed to register deploy job");
    return reply
      .code(500)
      .send(
        errorResponse(ErrorCode.Internal, "Failed to start deploy"),
      );
  }
}

// ─── GET /deploy/jobs/:jobId ─ SSE progress stream ───────────────────────────

async function deployStreamHandler(
  req: FastifyRequest<{ Params: { jobId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { jobId } = req.params;
  const initial = getDeployJob(jobId);
  if (!initial) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Deploy job not found"));
  }
  if (!requireTenant(req, reply, initial.tenantId)) return;

  // Hijack so we can write SSE frames directly without Fastify
  // serializing or buffering. Once hijacked, Fastify won't touch the
  // socket — we own the lifecycle from here.
  reply.hijack();
  const raw = reply.raw;

  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Hint to proxies (NGINX/Cloud Run) that this is a stream, not a
    // buffered response.
    "X-Accel-Buffering": "no",
  });

  const send = (event: DeployJobEvent): void => {
    if (raw.destroyed || !raw.writable) return;
    raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Keep-alive comment every 25s keeps proxy idle timers from killing
  // the connection during a quiet build phase. Comment lines (`:`) are
  // ignored by the EventSource client.
  const keepAlive = setInterval(() => {
    if (!raw.destroyed && raw.writable) raw.write(`: keep-alive\n\n`);
  }, 25_000);

  const unsubscribe = subscribeDeployJob(jobId, (event) => {
    send(event);
    if (event.status === "succeeded" || event.status === "failed") {
      cleanup();
      raw.end();
    }
  });

  // subscribeDeployJob returns null only if the job was evicted between
  // the getDeployJob check and now — extremely unlikely, but if it
  // happens we just close cleanly with the snapshot we already have.
  if (!unsubscribe) {
    cleanup();
    raw.end();
    return;
  }

  // Client disconnect — release subscription + interval.
  req.raw.on("close", cleanup);
  req.raw.on("error", cleanup);

  function cleanup(): void {
    clearInterval(keepAlive);
    if (unsubscribe) unsubscribe();
  }
}
