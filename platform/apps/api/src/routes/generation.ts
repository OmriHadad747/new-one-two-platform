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
import { z } from "zod";
import { logger } from "@new-one-two/logger";
import {
  publishGenerationRequest,
  registerProgressListener,
  registerCompletedListener,
  type FeatureBundleMessage,
} from "@new-one-two/pubsub-client";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { parseBody } from "../lib/validate-body.js";
import {
  createGenerationSession,
  updateGenerationSession,
  getSessionByJobId,
  storeBundleInSession,
  cancelGenerationSession,
  getLatestSessionForApp,
  getLatestCompletedSessionForApp,
  getSessionsForApp,
  saveChatMessages,
  updateAppStatus,
  updateAppArchetype,
  getAppByIdUnsafe,
  setAppUsesEmail,
  createAppEmailConfigFromStarter,
  isAppEmailConfigured,
  sql,
} from "@new-one-two/db";
import { deployFeatureBundle, deployAppVersion } from "@new-one-two/deployer";
import { getTenantById } from "@new-one-two/db";
import type {
  FeatureBundle,
  AppArchetype,
} from "@new-one-two/types";
import { canStartGeneration, isCategoryAllowed } from "../lib/plan-enforcement.js";
import { trackGeneration, trackRevision, storeRevisionClassification } from "@new-one-two/db";
import { requireTenant } from "../plugins/auth.js";

// ─── Request schemas ──────────────────────────────────────────────────────────
//
// preComputedIntent is the shape the Python product_agent emits (see
// generator/subagents/product_agent.py). Until batch-3 it was forwarded to the
// generator as an arbitrary `Record<string, unknown>` — which meant a client
// could smuggle fields past the intent-agent's guardrails by pre-seeding a
// shape the agent would never produce on its own.
//
// .strict() fails validation on any key the schema doesn't know about, so
// additions on the Python side require a matching update here. That drift
// pain is the point: silent drift was the bug we just closed.
const PreComputedIntentSchema = z
  .object({
    triggerTypes: z.array(z.string()).optional(),
    resources: z.array(z.string()).optional(),
    desiredOutcome: z.string().optional(),
    cronSchedule: z.string().nullable().optional(),
    appCategory: z.string().optional(),
    qualityBrief: z.string().optional(),
  })
  .strict();

const StartGenerationBodySchema = z.object({
  appId: z.string().uuid(),
  tenantId: z.string().uuid(),
  prompt: z.string().min(1).max(10_000),
  preComputedIntent: PreComputedIntentSchema.nullable().optional(),
});

const ReviseGenerationBodySchema = z.object({
  feedback: z.string().min(1).max(10_000),
});

// The chat-history persistence route stores whatever shape the frontend
// sends — we only gate on "is it an array of objects" here. The full
// ChatMessage shape is owned by the frontend and validating it at the
// boundary would force a contract lock-step that isn't needed for the
// stored-and-returned-as-is pattern this endpoint implements.
const ChatHistoryBodySchema = z.object({
  messages: z.array(z.record(z.unknown())),
});

const AnalyzeBodySchema = z.object({
  history: z.array(
    z.object({
      role: z.string().min(1),
      content: z.string(),
    })
  ),
});

/** Derive AppArchetype from a raw bundle object. */
function archetypeFromBundle(bundle: Record<string, unknown>): AppArchetype {
  const hasWidget = bundle["widgetModule"] != null;
  const hasAdmin  = bundle["adminUiModule"] != null;
  if (hasWidget && hasAdmin) return "storefront_backend_admin";
  if (hasAdmin)              return "backend_admin";
  if (hasWidget)             return "storefront_backend";
  return "backend";
}

/**
 * If the bundle uses email, persist the usesEmail flag + variable manifest on
 * `apps`, and seed `app_email_configs` with the AI-generated starter content
 * (configured_by_merchant = FALSE — deploy is blocked until the merchant
 * confirms in the Email tab).
 *
 * Re-running this on revisions is safe: ON CONFLICT in
 * createAppEmailConfigFromStarter updates the template. The
 * configured_by_merchant flag is preserved because it's not mentioned in the
 * UPDATE clause of the upsert — so a revision never silently un-confirms a
 * previously-approved email.
 */
async function applyBundleEmailMetadata(
  appId: string,
  tenantId: string,
  bundle: Record<string, unknown>
): Promise<void> {
  const usesEmail = bundle["usesEmail"] === true;
  await setAppUsesEmail(appId, usesEmail);

  if (!usesEmail) return;

  const variables = Array.isArray(bundle["emailVariables"])
    ? (bundle["emailVariables"] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  await sql`
    UPDATE apps SET email_variables = ${JSON.stringify(variables)}::jsonb WHERE id = ${appId}
  `;

  const starter = bundle["emailStarterContent"] as
    | { subject?: string; heading?: string | null; body?: string; ctaLabel?: string | null; ctaUrl?: string | null }
    | undefined;
  if (!starter?.subject || !starter?.body) {
    logger.warn(
      { appId, tenantId },
      "bundle.usesEmail=true but emailStarterContent missing subject/body — skipping app_email_configs seed"
    );
    return;
  }

  const emailType = bundle["emailTypeSuggestion"] === "marketing" ? "marketing" : "transactional";

  await createAppEmailConfigFromStarter({
    appId,
    tenantId,
    starter: {
      subject: starter.subject,
      heading: starter.heading ?? null,
      body: starter.body,
      ctaLabel: starter.ctaLabel ?? null,
      ctaUrl: starter.ctaUrl ?? null,
    },
    emailType,
  });
}

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

  app.post(
    "/",
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Zod-validated: rejects unknown keys on preComputedIntent so a client
      // cannot smuggle fields past the Python intent agent's shape contract.
      const body = parseBody(StartGenerationBodySchema, req, reply);
      if (!body) return;
      const { appId, prompt, preComputedIntent } = body;

      const tenantId = requireTenant(req, reply, body.tenantId);
      if (!tenantId) return;

      // ── Plan enforcement: check generation quota ──
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply
          .status(404)
          .send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
      }
      const check = await canStartGeneration(tenant);
      if (!check.allowed) {
        return reply
          .status(403)
          .send(
            errorResponse(
              ErrorCode.GenerationLimitReached,
              check.reason ?? "Generation quota reached",
              { upgradeHint: check.upgradeHint }
            )
          );
      }

      // ── Plan enforcement: check category allowed ──
      // preComputedIntent contains appCategory from the analyze flow.
      // Zod narrowed this to a known-shape object or null/undefined so the
      // old `as Record<string, unknown>` cast is gone.
      const appCategory = preComputedIntent?.appCategory;
      if (appCategory) {
        const catCheck = isCategoryAllowed(tenant.billingPlan, appCategory);
        if (!catCheck.allowed) {
          return reply
            .status(403)
            .send(
              errorResponse(
                ErrorCode.CategoryNotAllowed,
                catCheck.reason ?? "This category is not available on your plan",
                { upgradeHint: catCheck.upgradeHint }
              )
            );
        }
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
            const bundle = bundleMsg.bundle as unknown as Record<string, unknown>;
            await storeBundleInSession(jobId, bundle, "completed");
            // Set archetype immediately so app detail shows correct type badges
            // before the merchant deploys.
            await updateAppArchetype(appId, archetypeFromBundle(bundle));
            // Persist email metadata (usesEmail flag, variables, seeded config)
            // so the Email tab can render and deploy can block correctly.
            await applyBundleEmailMetadata(appId, tenantId, bundle);
            // Transition app to "ready" — bundle stored, awaiting merchant deploy.
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

      // Track generation usage (counts toward monthly quota)
      await trackGeneration(tenantId);

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
        return reply
          .status(404)
          .send(errorResponse(ErrorCode.NotFound, "No session found for this app"));
      }
      return reply.send(session);
    }
  );

  // ─── GET /generation/app/:appId/latest-completed ───────────────────────────

  app.get<{ Params: { appId: string } }>(
    "/app/:appId/latest-completed",
    async (req: FastifyRequest<{ Params: { appId: string } }>, reply: FastifyReply) => {
      const { appId } = req.params;
      const session = await getLatestCompletedSessionForApp(appId);
      if (!session) {
        return reply
          .status(404)
          .send(errorResponse(ErrorCode.NotFound, "No completed session found for this app"));
      }
      return reply.send(session);
    }
  );

  // ─── GET /generation/app/:appId/sessions ────────────────────────────────────

  app.get<{ Params: { appId: string } }>(
    "/app/:appId/sessions",
    async (req: FastifyRequest<{ Params: { appId: string } }>, reply: FastifyReply) => {
      const { appId } = req.params;
      const sessions = await getSessionsForApp(appId);
      return reply.send(sessions);
    }
  );

  // ─── GET /generation/:jobId/result ─────────────────────────────────────────

  app.get<{ Params: { jobId: string } }>(
    "/:jobId/result",
    async (req: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
      const { jobId } = req.params;

      const session = await getSessionByJobId(jobId);
      if (!session) {
        return reply
          .status(404)
          .send(errorResponse(ErrorCode.NotFound, "Job not found"));
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

      const requestedSession = await getSessionByJobId(jobId);
      if (!requestedSession) {
        return reply
          .status(404)
          .send(errorResponse(ErrorCode.NotFound, "Job not found"));
      }

      // If the requested session failed, find the latest successful one for this app.
      // This handles the case where the merchant clicks Deploy after a failed revision —
      // we deploy the last working version rather than refusing outright.
      let session = requestedSession;
      let deployingFallback = false;
      if (session.status === "failed") {
        if (!session.appId) {
          return reply
            .status(422)
            .send(errorResponse(ErrorCode.Conflict, "Cannot deploy a failed generation"));
        }
        const fallback = await getLatestCompletedSessionForApp(session.appId);
        if (!fallback) {
          return reply
            .status(422)
            .send(
              errorResponse(
                ErrorCode.Conflict,
                "Generation failed and no prior successful version exists to deploy."
              )
            );
        }
        session = fallback;
        deployingFallback = true;
        logger.info(
          { requestedJobId: jobId, fallbackJobId: fallback.jobId },
          "Requested session failed — deploying latest completed session instead"
        );
      }

      // Verify the app is in "ready" state.
      if (session.appId) {
        const appRecord = await getAppByIdUnsafe(session.appId);
        if (!appRecord || appRecord.status !== "ready") {
          return reply
            .status(409)
            .send(
              errorResponse(
                ErrorCode.Conflict,
                `App must be in 'ready' state to deploy (current: ${appRecord?.status ?? "unknown"})`
              )
            );
        }

        // Block deploy if the bundle sends emails but the merchant hasn't
        // confirmed the email content yet. The Email tab in the dashboard
        // flips `configured_by_merchant` to TRUE on first save.
        const bundleUsesEmail = (session.bundle as Record<string, unknown> | null)?.["usesEmail"] === true;
        if (bundleUsesEmail) {
          const confirmed = await isAppEmailConfigured(session.appId);
          if (!confirmed) {
            return reply
              .status(409)
              .send(
                errorResponse(
                  ErrorCode.EmailNotConfirmed,
                  "This app sends emails. Please review and save the email content in the Email tab before deploying."
                )
              );
          }
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
        logger.info({ jobId, deployedJobId: session.jobId, deployingFallback }, "FeatureBundle deployed");
        return reply.send({ deployed: true, deployingFallback, deployedJobId: session.jobId, ...result });
      }

      if (session.appVersionId) {
        // Legacy path: TypeScript-generated handler (app_version exists)
        const result = await deployAppVersion(session.appVersionId);
        logger.info(
          { jobId, appVersionId: session.appVersionId, deployingFallback },
          "Legacy app version deployed"
        );
        return reply.send({ deployed: true, deployingFallback, deployedJobId: session.jobId, ...result });
      }

      return reply
        .status(409)
        .send(
          errorResponse(
            ErrorCode.Conflict,
            "Session has no bundle or app version — generation may not be complete"
          )
        );
    }
  );

  // ─── POST /generation/:jobId/revise ────────────────────────────────────────

  app.post<{ Params: { jobId: string } }>(
    "/:jobId/revise",
    async (
      req: FastifyRequest<{ Params: { jobId: string } }>,
      reply: FastifyReply
    ) => {
      const { jobId } = req.params;
      const body = parseBody(ReviseGenerationBodySchema, req, reply);
      if (!body) return;
      const { feedback } = body;

      const session = await getSessionByJobId(jobId);
      if (!session) {
        return reply
          .status(404)
          .send(errorResponse(ErrorCode.NotFound, "Job not found"));
      }
      if (!session.appId || !session.tenantId) {
        return reply
          .status(409)
          .send(errorResponse(ErrorCode.Conflict, "Session has no appId or tenantId"));
      }

      const newJobId = crypto.randomUUID();
      const revisedPrompt = `${session.prompt}\n\nMerchant feedback: ${feedback}`;

      // Track revision usage (unlimited — no enforcement, just counting)
      await trackRevision(session.tenantId);

      // Classify revision for analytics (fire-and-forget — don't block the revision)
      classifyRevisionAsync(session.tenantId, session.appId!, feedback, newJobId).catch(
        (err) => logger.warn({ err }, "Revision classification failed (non-fatal)")
      );

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
            const bundle = bundleMsg.bundle as unknown as Record<string, unknown>;
            await storeBundleInSession(newJobId, bundle, "completed");
            // Update archetype in case the revision changed the bundle shape.
            await updateAppArchetype(session.appId!, archetypeFromBundle(bundle));
            // Refresh email metadata from the revised bundle. configured_by_merchant
            // is intentionally preserved by the upsert's update clause.
            await applyBundleEmailMetadata(session.appId!, session.tenantId!, bundle);
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

  app.patch<{ Params: { jobId: string } }>(
    "/:jobId/chat",
    async (req: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
      const { jobId } = req.params;
      const body = parseBody(ChatHistoryBodySchema, req, reply);
      if (!body) return;

      const session = await getSessionByJobId(jobId);
      if (!session) {
        return reply
          .status(404)
          .send(errorResponse(ErrorCode.NotFound, "Job not found"));
      }

      await saveChatMessages(jobId, body.messages);
      return reply.status(204).send();
    }
  );

  // ─── POST /generation/analyze ──────────────────────────────────────────────

  app.post(
    "/analyze",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = parseBody(AnalyzeBodySchema, req, reply);
      if (!body) return;
      const generatorUrl = process.env.GENERATOR_URL ?? "http://localhost:8001";
      const upstream = await fetch(`${generatorUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!upstream.ok) {
        logger.error({ status: upstream.status }, "Generator /analyze failed");
        return reply
          .status(502)
          .send(errorResponse(ErrorCode.UpstreamFailure, "Analyze failed"));
      }
      const data = await upstream.json();
      return reply.send(data);
    }
  );
};

// ─── Revision Classification (fire-and-forget) ──────────────────────────────

async function classifyRevisionAsync(
  tenantId: string,
  appId: string,
  feedback: string,
  jobId: string
): Promise<void> {
  const generatorUrl = process.env.GENERATOR_URL ?? "http://localhost:8001";
  const response = await fetch(`${generatorUrl}/classify-revision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feedback }),
  });

  if (!response.ok) {
    logger.warn({ status: response.status }, "Revision classification endpoint failed");
    return;
  }

  const { classification, confidence } = (await response.json()) as {
    classification: string;
    confidence: string;
  };

  await storeRevisionClassification({
    tenantId,
    appId,
    jobId,
    classification: classification as import("@new-one-two/types").RevisionClassification,
    confidence,
    merchantPrompt: feedback,
  });
}
