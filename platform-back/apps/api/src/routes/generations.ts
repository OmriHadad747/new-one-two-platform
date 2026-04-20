import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getAppById,
  getGenerationByJobId,
  markGenerationDeployed,
} from "@platform-back/db";
import { startDeploy } from "@platform-back/deployer";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { requireTenant } from "../plugins/auth.js";

// /apps/:appId/generations/* — dashboard-facing read + deploy bridge for
// the persisted `generations` table.
//
// GET  /apps/:appId/generations/:jobId        — fetch the stored bundle
// POST /apps/:appId/generations/:jobId/deploy — stitch bundle into a
//                                               deploy job and kick it off
//
// Auth: standard dashboard JWT via requireTenant(req, reply, appRecord.tenantId).
// The dashboard hits these with its tenant JWT; the routes look up the
// app, verify the JWT's tenantId matches the app's, and reject otherwise.
//
// Phase 2 scope note: dashboard cutover is Phase 5. The frontend still
// talks to legacy platform/apps/api for the full /generation/* lifecycle;
// these routes exist so the smoke test (Step 15) can exercise the new
// path and so Phase 5 has a drop-in target when it migrates the dashboard.

interface GenerationsRouteParams {
  appId: string;
  jobId: string;
}

export async function generationsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: GenerationsRouteParams }>(
    "/apps/:appId/generations/:jobId",
    getGenerationHandler,
  );
  app.post<{ Params: GenerationsRouteParams }>(
    "/apps/:appId/generations/:jobId/deploy",
    deployGenerationHandler,
  );
}

// ─── GET /apps/:appId/generations/:jobId ────────────────────────────────────

async function getGenerationHandler(
  req: FastifyRequest<{ Params: GenerationsRouteParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { appId, jobId } = req.params;

  const appRecord = await getAppById(appId);
  if (!appRecord) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }
  if (!requireTenant(req, reply, appRecord.tenantId)) return;

  const row = await getGenerationByJobId(jobId);
  if (!row) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Generation not found"));
  }
  // Scope check — a jobId that exists but belongs to a different app in the
  // same tenant shouldn't leak through the app-scoped URL.
  if (row.appId !== appId) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Generation not found"));
  }

  return reply.send(row);
}

// ─── POST /apps/:appId/generations/:jobId/deploy ────────────────────────────

async function deployGenerationHandler(
  req: FastifyRequest<{ Params: GenerationsRouteParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { appId, jobId } = req.params;

  const appRecord = await getAppById(appId);
  if (!appRecord) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }
  if (!requireTenant(req, reply, appRecord.tenantId)) return;

  const row = await getGenerationByJobId(jobId);
  if (!row) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Generation not found"));
  }
  if (row.appId !== appId) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Generation not found"));
  }
  if (row.status !== "success") {
    return reply
      .code(409)
      .send(
        errorResponse(
          ErrorCode.Conflict,
          "Generation did not complete successfully; nothing to deploy",
        ),
      );
  }
  if (!row.bundle) {
    // Defensive: status='success' without bundle is a contract bug
    // somewhere upstream. Fail loudly so we notice rather than deploy
    // an empty handler.
    return reply
      .code(500)
      .send(
        errorResponse(
          ErrorCode.Internal,
          "Generation marked success but no bundle was persisted",
        ),
      );
  }

  // Stitch handlerModule.files + [dbMigration] into the deploy endpoint's
  // generatedFiles[]. Cast via `any` is the narrow boundary between the
  // unknown JSONB column and the known Bundle shape; the subscriber Zod-
  // validated it on the way in, so the shape is trusted here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bundle = row.bundle as any;
  const handlerFiles: Array<{ path: string; contents: string }> =
    bundle?.handlerModule?.files ?? [];
  const migrationFile = bundle?.dbMigration ?? null;
  if (handlerFiles.length === 0 || !migrationFile) {
    return reply
      .code(500)
      .send(
        errorResponse(
          ErrorCode.Internal,
          "Bundle is missing handlerModule.files or dbMigration",
        ),
      );
  }
  const generatedFiles = [...handlerFiles, migrationFile];

  // appVersionId — stable per generation (we re-use the jobId as the
  // version id so every re-deploy of the same generation hits the same
  // row in app_versions). Version label is a short hash of the jobId so
  // Cloud Run image tags stay legible.
  const appVersionId = jobId;
  const appVersion = `gen-${jobId.slice(0, 8)}`;

  // Derive tenant schema the same way platform-back's deploy route does.
  const tenantSchema = `tenant_${appRecord.tenantId.replace(/-/g, "_")}`;

  try {
    const deployJobId = await startDeploy({
      appId,
      appName: `app ${appId}`,
      appVersionId,
      appVersion,
      tenantId: appRecord.tenantId,
      shopDomain: appRecord.shopDomain,
      tenantSchema,
      generatedFiles,
    });

    // Mark the generation as deployed so the dashboard can grey the Deploy
    // button on subsequent loads. Not the source of truth — app_versions
    // is — but saves a cross-table query on render.
    await markGenerationDeployed(jobId).catch((err) => {
      // Non-fatal: deploy job is already registered; worst case the
      // button stays un-greyed until a manual refresh.
      req.log.warn(
        { err, jobId },
        "Failed to mark generation deployed (deploy job already registered)",
      );
    });

    return reply.code(202).send({ jobId: deployJobId });
  } catch (err) {
    req.log.error(
      { err, appId, jobId },
      "Failed to start deploy from generation",
    );
    return reply
      .code(500)
      .send(
        errorResponse(
          ErrorCode.Internal,
          "Failed to start deploy",
        ),
      );
  }
}
