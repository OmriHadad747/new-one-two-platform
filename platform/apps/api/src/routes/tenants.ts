/**
 * Tenant management routes.
 *
 * POST   /tenants                                              — Create a tenant
 * GET    /tenants/:tenantId                                    — Get a tenant by ID
 * GET    /tenants/:tenantId/stats                              — Dashboard stats
 * GET    /tenants/:tenantId/apps                               — List all apps for a tenant
 * POST   /tenants/:tenantId/apps                               — Create an app under a tenant
 * GET    /tenants/:tenantId/apps/:appId                        — Get an app by ID
 * GET    /tenants/:tenantId/apps/:appId/theme-templates        — List injectable theme templates
 * POST   /tenants/:tenantId/apps/:appId/inject-theme           — Duplicate + inject widget block
 * DELETE /tenants/:tenantId/apps/:appId/inject-theme           — Delete duplicate test theme
 * GET    /tenants/:tenantId/logs                               — Recent execution logs (all apps)
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import {
  createTenant,
  getTenantById,
  createApp,
  getAppById,
  getAppsByTenantId,
  getRecentWebhookInvocationLogs,
  getTenantStats,
  updateAppName,
  updateAppStatus,
  getWidgetInvocationLogs,
  getAdminInvocationLogs,
  setThemeInjection,
  clearThemeInjection,
} from "@new-one-two/db";
import { teardownApp, permanentDeleteApp, reactivateApp } from "@new-one-two/deployer";
import { getSecret } from "@new-one-two/crypto";
import {
  getActiveTheme,
  getThemeTemplates,
  duplicateTheme,
  injectAppBlock,
  themePreviewUrl,
  themeEditorUrl,
} from "../lib/theme-injector.js";
import type { CreateTenantRequest, CreateAppRequest } from "@new-one-two/types";
import type { InjectionTarget } from "../lib/theme-injector.js";
import { canActivateApp } from "../lib/plan-enforcement.js";

export const tenantsRoute: FastifyPluginAsync = async (app) => {
  // ─── POST /tenants ──────────────────────────────────────────────────────────

  app.post<{ Body: CreateTenantRequest }>(
    "/",
    async (req: FastifyRequest<{ Body: CreateTenantRequest }>, reply: FastifyReply) => {
      const { id, slug, name } = req.body;

      if (!slug || !name) {
        return reply.status(400).send({ error: "slug and name are required" });
      }

      const { id: tenantId } = await createTenant({
        ...(id !== undefined && { id }),
        slug,
        name,
      });
      const tenant = await getTenantById(tenantId);
      return reply.status(201).send(tenant);
    }
  );

  // ─── GET /tenants/:tenantId ─────────────────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/:tenantId",
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply: FastifyReply) => {
      const tenant = await getTenantById(req.params.tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }
      return reply.send(tenant);
    }
  );

  // ─── GET /tenants/:tenantId/stats ───────────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/:tenantId/stats",
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply: FastifyReply) => {
      const { tenantId } = req.params;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }
      const stats = await getTenantStats(tenantId);
      return reply.send(stats);
    }
  );

  // ─── GET /tenants/:tenantId/apps ────────────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/:tenantId/apps",
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply: FastifyReply) => {
      const { tenantId } = req.params;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }
      const apps = await getAppsByTenantId(tenantId);
      return reply.send(apps);
    }
  );

  // ─── POST /tenants/:tenantId/apps ───────────────────────────────────────────

  app.post<{ Params: { tenantId: string }; Body: CreateAppRequest }>(
    "/:tenantId/apps",
    async (
      req: FastifyRequest<{ Params: { tenantId: string }; Body: CreateAppRequest }>,
      reply: FastifyReply
    ) => {
      const { tenantId } = req.params;
      const { id, slug, name } = req.body;

      if (!slug || !name) {
        return reply.status(400).send({ error: "slug and name are required" });
      }

      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }

      if (!tenant.shopDomain) {
        return reply
          .status(409)
          .send({ error: "Tenant has no shop domain — complete OAuth installation first" });
      }

      const shopifyClientId = process.env["SHOPIFY_CLIENT_ID"];
      const shopifySecretName = process.env["SHOPIFY_SECRET_NAME"];
      const { id: appId } = await createApp({
        ...(id !== undefined && { id }),
        ...(shopifyClientId !== undefined && { shopifyClientId }),
        ...(shopifySecretName !== undefined && { shopifySecretName }),
        tenantId,
        slug,
        name,
        shopDomain: tenant.shopDomain,
      });
      const createdApp = await getAppById(tenantId, appId);
      return reply.status(201).send(createdApp);
    }
  );

  // ─── GET /tenants/:tenantId/apps/:appId ─────────────────────────────────────

  app.get<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId",
    async (
      req: FastifyRequest<{ Params: { tenantId: string; appId: string } }>,
      reply: FastifyReply
    ) => {
      const { tenantId, appId } = req.params;
      const foundApp = await getAppById(tenantId, appId);
      if (!foundApp) {
        return reply.status(404).send({ error: "App not found" });
      }
      return reply.send(foundApp);
    }
  );

  // ─── PATCH /tenants/:tenantId/apps/:appId ──────────────────────────────────

  app.patch<{ Params: { tenantId: string; appId: string }; Body: { name?: string; status?: string } }>(
    "/:tenantId/apps/:appId",
    async (
      req: FastifyRequest<{ Params: { tenantId: string; appId: string }; Body: { name?: string; status?: string } }>,
      reply: FastifyReply
    ) => {
      const { tenantId, appId } = req.params;
      const { name, status } = req.body;

      if (!name?.trim() && !status) {
        return reply.status(400).send({ error: "name or status is required" });
      }

      const foundApp = await getAppById(tenantId, appId);
      if (!foundApp) {
        return reply.status(404).send({ error: "App not found" });
      }

      if (name?.trim()) await updateAppName(tenantId, appId, name.trim());
      if (status === "active") {
        // ── Plan enforcement: check active app limit before activating ──
        const tenant = await getTenantById(tenantId);
        if (tenant) {
          const activateCheck = await canActivateApp(tenant);
          if (!activateCheck.allowed) {
            return reply.status(403).send({
              error: activateCheck.reason,
              upgradeHint: activateCheck.upgradeHint,
              code: "app_limit_reached",
            });
          }
        }
        await updateAppStatus(appId, "active");
        // Fire-and-forget — restart container + re-register webhooks without blocking response
        reactivateApp(appId).catch((err: unknown) => {
          app.log.error({ err, appId }, "Background reactivation failed");
        });
      }
      if (status === "inactive") {
        await updateAppStatus(appId, "inactive");
        // Fire-and-forget — stop container + unregister webhooks without blocking response
        teardownApp(appId).catch((err: unknown) => {
          app.log.error({ err, appId }, "Background teardown on deactivation failed");
        });
      }
      if (status === "deleted") {
        await updateAppStatus(appId, "deleted");
        // Fire-and-forget teardown — don't block the response
        teardownApp(appId).catch((err: unknown) => {
          app.log.error({ err, appId }, "Background teardown failed");
        });
      }

      const updated = await getAppById(tenantId, appId);
      return reply.send(updated);
    }
  );

  // ─── DELETE /tenants/:tenantId/apps/:appId ─────────────────────────────────

  app.delete<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId",
    async (req: FastifyRequest<{ Params: { tenantId: string; appId: string } }>, reply: FastifyReply) => {
      const { tenantId, appId } = req.params;
      const foundApp = await getAppById(tenantId, appId);
      if (!foundApp) return reply.status(404).send({ error: "App not found" });
      await permanentDeleteApp(appId);
      return reply.status(200).send({ deleted: true });
    }
  );

  // ─── GET /tenants/:tenantId/apps/:appId/widget-logs ────────────────────────

  app.get<{ Params: { tenantId: string; appId: string }; Querystring: { limit?: string } }>(
    "/:tenantId/apps/:appId/widget-logs",
    async (req, reply) => {
      const { tenantId, appId } = req.params;
      const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);
      const foundApp = await getAppById(tenantId, appId);
      if (!foundApp) return reply.status(404).send({ error: "App not found" });
      const logs = await getWidgetInvocationLogs(appId, limit);
      return reply.send(logs);
    }
  );

  // ─── GET /tenants/:tenantId/apps/:appId/admin-logs ─────────────────────────

  app.get<{ Params: { tenantId: string; appId: string }; Querystring: { limit?: string } }>(
    "/:tenantId/apps/:appId/admin-logs",
    async (req, reply) => {
      const { tenantId, appId } = req.params;
      const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);
      const foundApp = await getAppById(tenantId, appId);
      if (!foundApp) return reply.status(404).send({ error: "App not found" });
      const logs = await getAdminInvocationLogs(appId, limit);
      return reply.send(logs);
    }
  );

  // ─── GET /tenants/:tenantId/apps/:appId/theme-templates ────────────────────
  // Returns the injectable JSON templates + their sections from the active theme.

  app.get<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId/theme-templates",
    async (req, reply) => {
      const { tenantId, appId } = req.params;
      const foundApp = await getAppById(tenantId, appId);
      if (!foundApp) return reply.status(404).send({ error: "App not found" });

      const tenant = await getTenantById(tenantId);
      if (!tenant?.shopDomain || !tenant.shopifyAccessTokenSecretName) {
        return reply.status(409).send({ error: "Shop not connected" });
      }

      const token = await getSecret(tenant.shopifyAccessTokenSecretName);
      const activeTheme = await getActiveTheme(tenant.shopDomain, token);
      const templates = await getThemeTemplates(tenant.shopDomain, token, activeTheme.id);

      return reply.send({ activeTheme, templates });
    }
  );

  // ─── POST /tenants/:tenantId/apps/:appId/inject-theme ──────────────────────
  // Duplicates the active theme and injects the widget app block.

  app.post<{
    Params: { tenantId: string; appId: string };
    Body: { targets: InjectionTarget[] };
  }>(
    "/:tenantId/apps/:appId/inject-theme",
    async (req, reply) => {
      const { tenantId, appId } = req.params;
      const { targets } = req.body;

      if (!targets?.length) {
        return reply.status(400).send({ error: "targets array is required" });
      }

      const foundApp = await getAppById(tenantId, appId);
      if (!foundApp) return reply.status(404).send({ error: "App not found" });

      const tenant = await getTenantById(tenantId);
      if (!tenant?.shopDomain || !tenant.shopifyAccessTokenSecretName) {
        return reply.status(409).send({ error: "Shop not connected" });
      }

      const token = await getSecret(tenant.shopifyAccessTokenSecretName);
      const shop = tenant.shopDomain;

      const activeTheme = await getActiveTheme(shop, token);
      const newThemeName = `${activeTheme.name} — Widget Test (${foundApp.name})`;
      const duplicated = await duplicateTheme(shop, token, activeTheme.id, newThemeName);

      for (const target of targets) {
        await injectAppBlock(shop, token, duplicated.id, appId, target);
      }

      await setThemeInjection(appId, String(duplicated.id));

      return reply.send({
        themeId: duplicated.id,
        themeName: duplicated.name,
        previewUrl: themePreviewUrl(shop, duplicated.id),
        editorUrl: themeEditorUrl(shop, duplicated.id),
      });
    }
  );

  // ─── DELETE /tenants/:tenantId/apps/:appId/inject-theme ────────────────────
  // Deletes the duplicate test theme and clears the injection state.

  app.delete<{ Params: { tenantId: string; appId: string } }>(
    "/:tenantId/apps/:appId/inject-theme",
    async (req, reply) => {
      const { tenantId, appId } = req.params;
      const foundApp = await getAppById(tenantId, appId);
      if (!foundApp) return reply.status(404).send({ error: "App not found" });
      if (foundApp.themeInjectionStatus !== "injected" || !foundApp.themeInjectionThemeId) {
        return reply.status(409).send({ error: "No injected theme to delete" });
      }

      const tenant = await getTenantById(tenantId);
      if (!tenant?.shopDomain || !tenant.shopifyAccessTokenSecretName) {
        return reply.status(409).send({ error: "Shop not connected" });
      }

      const token = await getSecret(tenant.shopifyAccessTokenSecretName);
      await fetch(
        `https://${tenant.shopDomain}/admin/api/2026-01/themes/${foundApp.themeInjectionThemeId}.json`,
        { method: "DELETE", headers: { "X-Shopify-Access-Token": token } }
      );

      await clearThemeInjection(appId);
      return reply.send({ deleted: true });
    }
  );

  // ─── GET /tenants/:tenantId/logs ────────────────────────────────────────────

  app.get<{ Params: { tenantId: string }; Querystring: { limit?: string } }>(
    "/:tenantId/logs",
    async (
      req: FastifyRequest<{
        Params: { tenantId: string };
        Querystring: { limit?: string };
      }>,
      reply: FastifyReply
    ) => {
      const { tenantId } = req.params;
      const limit = Math.min(parseInt(req.query.limit ?? "20", 10), 100);

      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }

      const logs = await getRecentWebhookInvocationLogs(tenantId, limit);
      return reply.send(logs);
    }
  );
};
