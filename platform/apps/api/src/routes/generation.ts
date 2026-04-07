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
  cancelGenerationSession,
  getLatestSessionForApp,
  saveChatMessages,
  updateAppStatus,
  getAppByIdOnly,
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

/** In-process registry so the cancel endpoint can push a close event to open SSE connections. */
const cancelCallbacks = new Map<string, (reason: string) => void>();

export const generationRoute: FastifyPluginAsync = async (app) => {
  // ─── POST /generation ──────────────────────────────────────────────────────

  app.post<{ Body: StartGenerationRequest }>(
    "/",
    async (req: FastifyRequest<{ Body: StartGenerationRequest }>, reply: FastifyReply) => {
      const { appId, tenantId, prompt, preComputedIntent } = req.body as StartGenerationRequest & { preComputedIntent?: Record<string, unknown> };

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

      // Register the completed listener BEFORE publishing — prevents the race
      // condition where a fast generator publishes the result before we listen.
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
            // Transition app to "ready" — bundle is stored, awaiting merchant deploy.
            await updateAppStatus(appId, "ready");
          } else {
            await storeBundleInSession(
              jobId,
              {},
              "failed",
              bundleMsg.error ?? "Generation failed"
            );
            // Failed generation: revert app to "draft" so it can be re-generated.
            await updateAppStatus(appId, "draft");
          }
          logger.info({ jobId, status: bundleMsg.status }, "Bundle stored in DB");
        }
      );

      await publishGenerationRequest({ jobId, tenantId, appId, prompt, preComputedIntent });

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
        cancelCallbacks.delete(jobId);
      };

      cancelCallbacks.set(jobId, (reason: string) => {
        sendEvent({ type: "completed", status: "cancelled", error: reason });
        cleanup();
        reply.raw.end();
      });

      req.raw.on("close", cleanup);
    }
  );

  // ─── GET /generation/app/:appId/latest ─────────────────────────────────────

  app.get<{ Params: { appId: string } }>(
    "/app/:appId/latest",
    async (req: FastifyRequest<{ Params: { appId: string } }>, reply: FastifyReply) => {
      const { appId } = req.params;
      const session = await getLatestSessionForApp(appId);
      if (!session) {
        return reply.status(404).send({ error: "No session found for this app" });
      }
      return reply.send(session);
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

      if (session.status === "failed") {
        return reply.status(422).send({ error: "Cannot deploy a failed generation" });
      }

      // Verify the app is in "ready" state — i.e. generation succeeded and
      // the merchant has not yet deployed this build.
      if (session.appId) {
        const appRecord = await getAppByIdOnly(session.appId);
        if (!appRecord || appRecord.status !== "ready") {
          return reply.status(409).send({
            error: `App must be in 'ready' state to deploy (current: ${appRecord?.status ?? "unknown"})`,
          });
        }
      }

      const bundleKeys = session.bundle ? Object.keys(session.bundle as Record<string, unknown>) : [];
      if (bundleKeys.length > 0 && session.appId && session.tenantId) {
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
            // Revision succeeded: move app back to "ready" for merchant to re-deploy.
            await updateAppStatus(session.appId!, "ready");
          } else {
            await storeBundleInSession(
              newJobId,
              {},
              "failed",
              bundleMsg.error ?? "Revision failed"
            );
            // Revision failed: keep app in current status (already active or ready).
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

  // ─── POST /generation/:jobId/cancel ────────────────────────────────────────

  app.post<{ Params: { jobId: string } }>(
    "/:jobId/cancel",
    async (req: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
      const { jobId } = req.params;
      await cancelGenerationSession(jobId);
      const cancel = cancelCallbacks.get(jobId);
      if (cancel) cancel("Generation cancelled by user");
      return reply.status(200).send({ ok: true });
    }
  );

  // ─── PATCH /generation/:jobId/chat ─────────────────────────────────────────
  // Persists the frontend chat message history for a session.
  // Called debounced from the UI after every message change.
  // Fire-and-forget: 204 on success, ignored on failure by the client.

  app.patch<{
    Params: { jobId: string };
    Body: { messages: Array<Record<string, unknown>> };
  }>(
    "/:jobId/chat",
    async (req: FastifyRequest<{ Params: { jobId: string }; Body: { messages: Array<Record<string, unknown>> } }>, reply: FastifyReply) => {
      const { jobId } = req.params;
      const { messages } = req.body;

      if (!Array.isArray(messages)) {
        return reply.status(400).send({ error: "messages must be an array" });
      }

      const session = await getSessionByJobId(jobId);
      if (!session) {
        return reply.status(404).send({ error: "Job not found" });
      }

      await saveChatMessages(jobId, messages);
      return reply.status(204).send();
    }
  );

  // ─── POST /generation/analyze ──────────────────────────────────────────────

  app.post<{ Body: { history: Array<{ role: string; content: string }> } }>(
    "/analyze",
    async (req: FastifyRequest<{ Body: { history: Array<{ role: string; content: string }> } }>, reply: FastifyReply) => {
      const generatorUrl = process.env.GENERATOR_URL ?? "http://localhost:8001";
      const upstream = await fetch(`${generatorUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      if (!upstream.ok) {
        logger.error({ status: upstream.status }, "Generator /analyze failed");
        return reply.status(502).send({ error: "Analyze failed" });
      }
      const data = await upstream.json();
      return reply.send(data);
    }
  );
};
