/**
 * Generation lifecycle routes.
 *
 * POST   /generation              — Start generation (publishes GenerationRequest to Pub/Sub)
 * GET    /generation/:jobId/progress — SSE stream of ProgressEvents from generation.progress
 * GET    /generation/:jobId/result   — Return stored FeatureBundle (polls DB)
 * POST   /generation/:jobId/approve  — Deploy the FeatureBundle via deployer
 * POST   /generation/:jobId/revise   — Append merchant feedback, start new generation
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "@new-one-two/logger";
import {
  publishGenerationRequest,
  registerProgressListener,
  registerCompletedListener,
  type FeatureBundleMessage,
} from "@new-one-two/pubsub-client";
import {
  createGenerationSession,
  updateGenerationSession,
  getSessionByJobId,
  storeBundleInSession,
} from "@new-one-two/db";
import { deployFeatureBundle, deployAppVersion } from "@new-one-two/deployer";
import type {
  StartGenerationRequest,
  ReviseGenerationRequest,
  FeatureBundle,
} from "@new-one-two/types";

/**
 * Platform-owned widget API catalog.
 *
 * These are the only platform routes a generated widget may call via host.call().
 * The platform (not the caller) is the authoritative source — callers never supply this.
 *
 * Each path here must have a corresponding route handler on the platform API that
 * accepts POST with X-Shop-Domain + X-App-Id headers for tenant resolution.
 */

export const generationRoute: FastifyPluginAsync = async (app) => {
  // ─── POST /generation ──────────────────────────────────────────────────────

  app.post<{ Body: StartGenerationRequest }>(
    "/",
    async (req: FastifyRequest<{ Body: StartGenerationRequest }>, reply: FastifyReply) => {
      const { appId, tenantId, prompt } = req.body;

      if (!appId || !tenantId || !prompt) {
        return reply
          .status(400)
          .send({ error: "appId, tenantId, and prompt are required" });
      }

      const jobId = crypto.randomUUID();

      // Create session before publishing — so the SSE subscriber can look it up
      const { id: sessionId } = await createGenerationSession({
        appId,
        tenantId,
        prompt,
      });

      await updateGenerationSession(sessionId, { jobId, status: "running" });

      await publishGenerationRequest({ jobId, tenantId, appId, prompt });

      // Register a persistent completed listener that writes the bundle to DB.
      // This runs regardless of whether any SSE client is connected.
      const unsubCompleted = registerCompletedListener(
        jobId,
        async (bundleMsg: FeatureBundleMessage) => {
          unsubCompleted(); // self-cleanup
          if (bundleMsg.status === "success" && bundleMsg.bundle) {
            await storeBundleInSession(
              jobId,
              bundleMsg.bundle as unknown as Record<string, unknown>,
              "completed"
            );
          } else {
            await storeBundleInSession(
              jobId,
              {},
              "failed",
              bundleMsg.error ?? "Generation failed"
            );
          }
          logger.info({ jobId, status: bundleMsg.status }, "Bundle stored in DB");
        }
      );

      logger.info({ jobId, sessionId, appId }, "GenerationRequest published");
      return reply.status(202).send({ jobId, sessionId });
    }
  );

  // ─── GET /generation/:jobId/progress (SSE) ─────────────────────────────────

  app.get<{ Params: { jobId: string } }>(
    "/:jobId/progress",
    async (req: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
      const { jobId } = req.params;

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
      reply.raw.flushHeaders();

      const sendEvent = (data: Record<string, unknown>) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Keep-alive ping every 15s to prevent proxy timeouts
      const pingInterval = setInterval(() => {
        reply.raw.write(": ping\n\n");
      }, 15_000);

      const unsubProgress = registerProgressListener(jobId, (event) => {
        sendEvent({
          type: "progress",
          agent: event.agent,
          status: event.status,
          message: event.message,
          timestampMs: event.timestampMs,
        });
      });

      const unsubCompleted = registerCompletedListener(
        jobId,
        (bundleMsg: FeatureBundleMessage) => {
          sendEvent({
            type: "completed",
            status: bundleMsg.status,
            error: bundleMsg.error,
            meta: bundleMsg.meta,
          });
          cleanup();
          reply.raw.end();
        }
      );

      const cleanup = () => {
        clearInterval(pingInterval);
        unsubProgress();
        unsubCompleted();
      };

      req.raw.on("close", cleanup);
    }
  );

  // ─── GET /generation/:jobId/result ─────────────────────────────────────────

  app.get<{ Params: { jobId: string } }>(
    "/:jobId/result",
    async (req: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
      const { jobId } = req.params;

      const session = await getSessionByJobId(jobId);
      if (!session) {
        return reply.status(404).send({ error: "Job not found" });
      }

      if (session.status === "failed") {
        return reply
          .status(422)
          .send({ status: "failed", error: session.errorMessage });
      }

      if (session.bundle && Object.keys(session.bundle as Record<string, unknown>).length > 0) {
        return reply.send({ status: "success", bundle: session.bundle });
      }

      // Still running
      return reply.status(202).send({ status: session.status });
    }
  );

  // ─── POST /generation/:jobId/approve ───────────────────────────────────────

  app.post<{ Params: { jobId: string } }>(
    "/:jobId/approve",
    async (req: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
      const { jobId } = req.params;

      const session = await getSessionByJobId(jobId);
      if (!session) {
        return reply.status(404).send({ error: "Job not found" });
      }

      if (session.bundle && session.appId && session.tenantId) {
        // New path: Python-generated FeatureBundle
        const bundle = session.bundle as unknown as FeatureBundle;
        const result = await deployFeatureBundle({
          sessionId: session.id,
          appId: session.appId,
          tenantId: session.tenantId,
          bundle,
        });
        logger.info({ jobId, sessionId: session.id }, "FeatureBundle deployed");
        return reply.send({ deployed: true, ...result });
      }

      if (session.appVersionId) {
        // Legacy path: TypeScript-generated handler (app_version exists)
        const result = await deployAppVersion(session.appVersionId);
        logger.info(
          { jobId, appVersionId: session.appVersionId },
          "Legacy app version deployed"
        );
        return reply.send({ deployed: true, ...result });
      }

      return reply.status(409).send({
        error: "Session has no bundle or app version — generation may not be complete",
      });
    }
  );

  // ─── POST /generation/:jobId/revise ────────────────────────────────────────

  app.post<{
    Params: { jobId: string };
    Body: ReviseGenerationRequest;
  }>(
    "/:jobId/revise",
    async (
      req: FastifyRequest<{
        Params: { jobId: string };
        Body: ReviseGenerationRequest;
      }>,
      reply: FastifyReply
    ) => {
      const { jobId } = req.params;
      const { feedback } = req.body;

      if (!feedback) {
        return reply.status(400).send({ error: "feedback is required" });
      }

      const session = await getSessionByJobId(jobId);
      if (!session) {
        return reply.status(404).send({ error: "Job not found" });
      }
      if (!session.appId || !session.tenantId) {
        return reply
          .status(409)
          .send({ error: "Session has no appId or tenantId" });
      }

      const newJobId = crypto.randomUUID();
      const revisedPrompt = `${session.prompt}\n\nMerchant feedback: ${feedback}`;

      const { id: newSessionId } = await createGenerationSession({
        appId: session.appId,
        tenantId: session.tenantId,
        prompt: revisedPrompt,
      });
      await updateGenerationSession(newSessionId, {
        jobId: newJobId,
        status: "running",
      });

      // Persist the new completed bundle to DB as well
      const unsubCompleted = registerCompletedListener(
        newJobId,
        async (bundleMsg: FeatureBundleMessage) => {
          unsubCompleted();
          if (bundleMsg.status === "success" && bundleMsg.bundle) {
            await storeBundleInSession(
              newJobId,
              bundleMsg.bundle as unknown as Record<string, unknown>,
              "completed"
            );
          } else {
            await storeBundleInSession(
              newJobId,
              {},
              "failed",
              bundleMsg.error ?? "Revision failed"
            );
          }
        }
      );

      // Infer archetype from prior bundle: widgetModule present → storefront_ui
      const priorBundle = session.bundle as Record<string, unknown> | null;

      await publishGenerationRequest({
        jobId: newJobId,
        tenantId: session.tenantId,
        appId: session.appId,
        prompt: revisedPrompt,
        priorBundle,
      });

      logger.info(
        { originalJobId: jobId, newJobId, feedback },
        "Revision GenerationRequest published"
      );
      return reply.status(202).send({ jobId: newJobId, sessionId: newSessionId });
    }
  );
};
