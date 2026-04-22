/**
 * Dashboard-facing tenant + app CRUD + log-read + theme-inject routes.
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
 * GET    /tenants/:tenantId/apps/:appId/theme-templates     injectable theme templates
 * POST   /tenants/:tenantId/apps/:appId/inject-theme        duplicate + inject widget block
 * DELETE /tenants/:tenantId/apps/:appId/inject-theme        remove duplicate test theme
 *
 * Status flips drive real infrastructure (fire-and-forget so the
 * response doesn't block on Cloud Run / Shopify round-trips):
 *   status='active'   → canActivateApp plan-check → reactivateApp
 *   status='inactive' → teardownApp
 *   status='deleted'  → teardownApp   (DELETE is the permanent path)
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
import { getSecret } from "@platform-back/crypto";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { parseBody } from "../lib/validate-body.js";
import { canActivateApp } from "../lib/plan-enforcement.js";
import { requireTenant } from "../plugins/auth.js";
import {
  duplicateTheme,
  getActiveTheme,
  getThemeTemplates,
  injectAppBlock,
  themeEditorUrl,
  themePreviewUrl,
} from "../lib/theme-injector.js";

// ─── Shared schemas ──────────────────────────────────────────────────────────
//
// Stricter than the DB CHECK (`^[a-z0-9-]+$`): leading-hyphen slugs clash
// with DNS labels, URL segments after `/`, and CLI argument parsers, so we
// reject them at the ingress even though the DB would accept them.

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

const InjectionTargetSchema = z.object({
  templateKey: z.string().min(1).max(200),
  sectionId: z.string().min(1).max(200),
  position: z.number().int().min(0),
});

const InjectThemeBodySchema = z.object({
  targets: z.array(InjectionTargetSchema).min(1),
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

  app.get<{ Params: { tenantId: string } }>("/:tenantId/apps", listAppsHandler);
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

  app.get<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId/theme-templates",
    getThemeTemplatesHandler,
  );
  app.post<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId/inject-theme",
    injectThemeHandler,
  );
  app.delete<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId/inject-theme",
    deleteInjectedThemeHandler,
  );
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function createTenantHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const body = parseBody(CreateTenantBodySchema, req, reply);
  if (!body) return;
  const { id } = await createTenant({
    slug: body.slug,
    name: body.name,
    shopDomain: body.shopDomain,
    shopifyAccessTokenSecretName: body.shopifyAccessTokenSecretName,
    ...(body.storefrontAccessTokenSecretName !== undefined && {
      storefrontAccessTokenSecretName: body.storefrontAccessTokenSecretName,
    }),
    ...(body.kmsKeyName !== undefined && { kmsKeyName: body.kmsKeyName }),
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
  const body = parseBody(CreateAppBodySchema, req, reply);
  if (!body) return;

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

  const { id: appId } = await createApp({
    ...(body.id !== undefined && { id: body.id }),
    tenantId,
    slug: body.slug,
    name: body.name,
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

  const body = parseBody(UpdateAppBodySchema, req, reply);
  if (!body) return;

  const app = await getAppById(tenantId, appId);
  if (!app) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }

  const { name, status } = body;
  if (name?.trim()) await updateAppName(tenantId, appId, name.trim());

  if (status === "active") {
    // Plan gate — blocks activation when the merchant is already at
    // their plan's active-app cap. Creation was unlimited; the seat
    // check only fires at the activate transition.
    const tenant = await getTenantById(tenantId);
    if (tenant) {
      const gate = await canActivateApp(tenant);
      if (!gate.allowed) {
        const details =
          gate.upgradeHint !== undefined
            ? { upgradeHint: gate.upgradeHint }
            : undefined;
        return reply
          .code(403)
          .send(
            errorResponse(
              ErrorCode.AppLimitReached,
              gate.reason ?? "App activation limit reached",
              details,
            ),
          );
      }
    }
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

  // Run permanentDeleteApp synchronously — the dashboard expects a real
  // commit signal before refreshing. The helper is best-effort across
  // every side-effect step, so partial infra failures don't leave a
  // half-deleted state; hardDeleteApp at the tail is authoritative.
  try {
    await permanentDeleteApp({ tenantId, appId });
  } catch (err) {
    req.log.error({ err, tenantId, appId }, "permanentDeleteApp failed");
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Delete failed"));
  }
  // Belt-and-braces: if the lifecycle helper threw after partial cleanup
  // before reaching hardDeleteApp, this direct row-delete ensures the UI
  // isn't left staring at a ghost row.
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

// ─── Theme injection (Category A/B widget archetypes) ───────────────────────

async function getThemeTemplatesHandler(
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

  const tenant = await getTenantById(tenantId);
  if (!tenant?.shopDomain || !tenant.shopifyAccessTokenSecretName) {
    return reply
      .code(409)
      .send(errorResponse(ErrorCode.ShopNotConnected, "Shop not connected"));
  }

  const token = await getSecret(tenant.shopifyAccessTokenSecretName);
  const activeTheme = await getActiveTheme(tenant.shopDomain, token);
  const templates = await getThemeTemplates(
    tenant.shopDomain,
    token,
    activeTheme.id,
  );
  return reply.send({ activeTheme, templates });
}

async function injectThemeHandler(
  req: FastifyRequest<{ Params: { tenantId: string; appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const tenantId = requireTenant(req, reply, req.params.tenantId);
  if (!tenantId) return;
  const { appId } = req.params;

  const body = parseBody(InjectThemeBodySchema, req, reply);
  if (!body) return;

  const app = await getAppById(tenantId, appId);
  if (!app) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "App not found"));
  }

  const tenant = await getTenantById(tenantId);
  if (!tenant?.shopDomain || !tenant.shopifyAccessTokenSecretName) {
    return reply
      .code(409)
      .send(errorResponse(ErrorCode.ShopNotConnected, "Shop not connected"));
  }

  const token = await getSecret(tenant.shopifyAccessTokenSecretName);
  const shop = tenant.shopDomain;

  const activeTheme = await getActiveTheme(shop, token);
  const newThemeName = `${activeTheme.name} — Widget Test (${app.name})`;
  const duplicated = await duplicateTheme(
    shop,
    token,
    activeTheme.id,
    newThemeName,
  );

  for (const target of body.targets) {
    await injectAppBlock(shop, token, duplicated.id, appId, target);
  }

  const { setThemeInjection } = await import("@platform-back/db");
  await setThemeInjection(appId, String(duplicated.id));

  return reply.send({
    themeId: duplicated.id,
    themeName: duplicated.name,
    previewUrl: themePreviewUrl(shop, duplicated.id),
    editorUrl: themeEditorUrl(shop, duplicated.id),
  });
}

async function deleteInjectedThemeHandler(
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
  if (
    app.themeInjectionStatus !== "injected" ||
    !app.themeInjectionThemeId
  ) {
    return reply
      .code(409)
      .send(errorResponse(ErrorCode.Conflict, "No injected theme to delete"));
  }

  const tenant = await getTenantById(tenantId);
  if (!tenant?.shopDomain || !tenant.shopifyAccessTokenSecretName) {
    return reply
      .code(409)
      .send(errorResponse(ErrorCode.ShopNotConnected, "Shop not connected"));
  }

  const token = await getSecret(tenant.shopifyAccessTokenSecretName);
  await fetch(
    `https://${tenant.shopDomain}/admin/api/2026-01/themes/${app.themeInjectionThemeId}.json`,
    { method: "DELETE", headers: { "X-Shopify-Access-Token": token } },
  );

  const { clearThemeInjection } = await import("@platform-back/db");
  await clearThemeInjection(appId);
  return reply.send({ deleted: true });
}
