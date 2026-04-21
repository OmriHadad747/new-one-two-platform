/**
 * Dashboard-facing tenant + app CRUD + log-read routes.
 *
 * POST   /tenants                                           create tenant
 * GET    /tenants/:tenantId                                 fetch tenant
 * GET    /tenants/:tenantId/stats                           dashboard stats
 * GET    /tenants/:tenantId/logs                            tenant webhook log
 * GET    /tenants/:tenantId/apps                            list apps
 * POST   /tenants/:tenantId/apps                            create app
 * GET    /tenants/:tenantId/apps/:appId                     fetch app
 * PATCH  /tenants/:tenantId/apps/:appId                     rename / status flip
 * DELETE /tenants/:tenantId/apps/:appId                     permanent delete
 * GET    /tenants/:tenantId/apps/:appId/widget-logs         widget invocations
 * GET    /tenants/:tenantId/apps/:appId/admin-logs          admin invocations
 *
 * Status flips drive real infrastructure:
 *   status='active'   → reactivateApp  (redeploy existing image, re-register webhooks)
 *   status='inactive' → teardownApp    (stop Cloud Run, deactivate DB infra)
 *   status='deleted'  → teardownApp    (same — DELETE is the permanent path)
 *
 * Theme-injection routes (GET theme-templates, POST/DELETE inject-theme)
 * are deferred to a follow-up — Category A/B widget archetypes aren't
 * generated yet so the UI surface has no call sites. Tracked in
 * REFACTOR_GAPS Tier 2.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  createApp,
  createTenant,
  getAdminInvocationLogs,
  getAppById,
  getRecentWebhookInvocationLogs,
  getTenantById,
  getTenantStats,
  getWidgetInvocationLogs,
  hardDeleteApp,
  listAppsForTenant,
  updateAppName,
  updateAppStatus,
} from "@platform-back/db";
import {
  permanentDeleteApp,
  reactivateApp,
  teardownApp,
} from "@platform-back/deployer";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { requireTenant } from "../plugins/auth.js";

// ─── Shared schemas ──────────────────────────────────────────────────────────
// Stricter than the DB CHECK (`^[a-z0-9-]+$`) — leading-hyphen slugs clash
// with DNS labels, URL segments, and CLI args at the ingress. Matches the
// OLD tenants.ts convention.
const SlugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "slug must be lowercase alphanumerics + hyphens and cannot start with '-'",
  );

const CreateTenantBodySchema = z.object({
  id: z.string().uuid().optional(),
  slug: SlugSchema,
  name: z.string().min(1).max(200),
  shopDomain: z.string().min(1).max(200),
  kmsKeyName: z.string().min(1).max(500).optional(),
  shopifyAccessTokenSecretName: z.string().min(1).max(500),
  storefrontAccessTokenSecretName: z.string().min(1).max(500).optional(),
});

const CreateAppBodySchema = z.object({
  id: z.string().uuid().optional(),
  slug: SlugSchema,
  name: z.string().min(1).max(200),
});

const UpdateAppBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: z.enum(["active", "inactive", "deleted"]).optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: "name or status is required",
  });

// ─── Plugin ─────────────────────────────────────────────────────────────────

export async function tenantsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", createTenantHandler);

  app.get<{ Params: { tenantId: string } }>("/:tenantId", getTenantHandler);
  app.get<{ Params: { tenantId: string } }>(
    "/:tenantId/stats",
    getTenantStatsHandler,
  );
  app.get<{
    Params: { tenantId: string };
    Querystring: { limit?: string };
  }>("/:tenantId/logs", getTenantLogsHandler);

  app.get<{ Params: { tenantId: string } }>(
    "/:tenantId/apps",
    listAppsHandler,
  );
  app.post<{ Params: { tenantId: string } }>(
    "/:tenantId/apps",
    createAppHandler,
  );

  app.get<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId",
    getAppHandler,
  );
  app.patch<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId",
    updateAppHandler,
  );
  app.delete<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId",
    deleteAppHandler,
  );

  app.get<{
    Params: { tenantId: string; appId: string };
    Querystring: { limit?: string };
  }>("/:tenantId/apps/:appId/widget-logs", getWidgetLogsHandler);
  app.get<{
    Params: { tenantId: string; appId: string };
    Querystring: { limit?: string };
  }>("/:tenantId/apps/:appId/admin-logs", getAdminLogsHandler);
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function createTenantHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const parsed = CreateTenantBodySchema.safeParse(req.body);
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
  const b = parsed.data;
  const { id } = await createTenant({
    slug: b.slug,
    name: b.name,
    shopDomain: b.shopDomain,
    shopifyAccessTokenSecretName: b.shopifyAccessTokenSecretName,
    ...(b.storefrontAccessTokenSecretName !== undefined && {
      storefrontAccessTokenSecretName: b.storefrontAccessTokenSecretName,
    }),
    ...(b.kmsKeyName !== undefined && { kmsKeyName: b.kmsKeyName }),
  });
  const tenant = await getTenantById(id);
  return reply.code(201).send(tenant);
}

async function getTenantHandler(
  req: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
  }
  return reply.send(tenant);
}

async function getTenantStatsHandler(
  req: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
  }
  const stats = await getTenantStats(tenantId);
  return reply.send(stats);
}

async function getTenantLogsHandler(
  req: FastifyRequest<{
    Params: { tenantId: string };
    Querystring: { limit?: string };
  }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const limit = Math.min(parseInt(req.query.limit ?? "20", 10) || 20, 100);
  const logs = await getRecentWebhookInvocationLogs(tenantId, limit);
  return reply.send(logs);
}

async function listAppsHandler(
  req: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const apps = await listAppsForTenant(tenantId);
  return reply.send(apps);
}

async function createAppHandler(
  req: FastifyRequest<{ Params: { tenantId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const parsed = CreateAppBodySchema.safeParse(req.body);
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

  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
  }
  if (!tenant.shopDomain) {
    return reply
      .code(409)
      .send(
        errorResponse(
          ErrorCode.Conflict,
          "Tenant has no shop domain — complete OAuth installation first",
        ),
      );
  }

  const b = parsed.data;
  const { id: appId } = await createApp({
    ...(b.id !== undefined && { id: b.id }),
    tenantId,
    slug: b.slug,
    name: b.name,
    shopDomain: tenant.shopDomain,
    ...(process.env["SHOPIFY_CLIENT_ID"] !== undefined && {
      shopifyClientId: process.env["SHOPIFY_CLIENT_ID"],
    }),
    ...(process.env["SHOPIFY_SECRET_NAME"] !== undefined && {
      shopifySecretName: process.env["SHOPIFY_SECRET_NAME"],
    }),
  });
  const created = await getAppById(tenantId, appId);
  return reply.code(201).send(created);
}

async function getAppHandler(
  req: FastifyRequest<{ Params: { tenantId: string; appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const app = await getAppById(tenantId, req.params.appId);
  if (!app) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }
  return reply.send(app);
}

async function updateAppHandler(
  req: FastifyRequest<{ Params: { tenantId: string; appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const { appId } = req.params;

  const parsed = UpdateAppBodySchema.safeParse(req.body);
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

  const app = await getAppById(tenantId, appId);
  if (!app) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }

  const { name, status } = parsed.data;
  if (name?.trim()) await updateAppName(tenantId, appId, name.trim());

  // Status transitions drive real infra. Fire-and-forget so the response
  // doesn't block on Cloud Run / Shopify round-trips; errors land in the
  // structured log for the ops team to chase.
  if (status === "active") {
    await updateAppStatus(appId, "active");
    reactivateApp({ tenantId, appId }).catch((err: unknown) => {
      req.log.error({ err, tenantId, appId }, "reactivateApp failed");
    });
  } else if (status === "inactive") {
    await updateAppStatus(appId, "inactive");
    teardownApp({ tenantId, appId }).catch((err: unknown) => {
      req.log.error({ err, tenantId, appId }, "teardownApp (inactive) failed");
    });
  } else if (status === "deleted") {
    await updateAppStatus(appId, "deleted");
    teardownApp({ tenantId, appId }).catch((err: unknown) => {
      req.log.error({ err, tenantId, appId }, "teardownApp (deleted) failed");
    });
  }

  return reply.send(await getAppById(tenantId, appId));
}

async function deleteAppHandler(
  req: FastifyRequest<{ Params: { tenantId: string; appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const { appId } = req.params;

  const app = await getAppById(tenantId, appId);
  if (!app) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }

  // Run permanentDeleteApp synchronously — the dashboard wants a real
  // commit signal before refreshing the list. Best-effort internals
  // handle partial failures without leaving a half-deleted state.
  try {
    await permanentDeleteApp({ tenantId, appId });
  } catch (err) {
    req.log.error({ err, tenantId, appId }, "permanentDeleteApp failed");
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Delete failed"));
  }
  // If permanentDeleteApp's hardDeleteApp at the end threw but somehow
  // didn't bubble, fall back to a direct row delete so the UI isn't
  // stuck on a ghost app.
  await hardDeleteApp(appId).catch(() => {});
  return reply.code(200).send({ deleted: true });
}

async function getWidgetLogsHandler(
  req: FastifyRequest<{
    Params: { tenantId: string; appId: string };
    Querystring: { limit?: string };
  }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const app = await getAppById(tenantId, req.params.appId);
  if (!app) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }
  const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
  const logs = await getWidgetInvocationLogs(req.params.appId, limit);
  return reply.send(logs);
}

async function getAdminLogsHandler(
  req: FastifyRequest<{
    Params: { tenantId: string; appId: string };
    Querystring: { limit?: string };
  }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const app = await getAppById(tenantId, req.params.appId);
  if (!app) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }
  const limit = Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200);
  const logs = await getAdminInvocationLogs(req.params.appId, limit);
  return reply.send(logs);
}
