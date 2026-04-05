/**
 * Tenant management routes.
 *
 * POST   /tenants                                  — Create a tenant
 * GET    /tenants/:tenantId                        — Get a tenant by ID
 * GET    /tenants/:tenantId/stats                  — Dashboard stats (app counts + exec metrics)
 * GET    /tenants/:tenantId/apps                   — List all apps for a tenant
 * POST   /tenants/:tenantId/apps                   — Create an app under a tenant
 * GET    /tenants/:tenantId/apps/:appId            — Get an app by ID
 * GET    /tenants/:tenantId/logs                   — Recent execution logs (all apps)
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
} from "@new-one-two/db";
import { teardownApp } from "@new-one-two/deployer";
import type { CreateTenantRequest, CreateAppRequest } from "@new-one-two/types";

export const tenantsRoute: FastifyPluginAsync = async (app) => {
  // ─── POST /tenants ──────────────────────────────────────────────────────────

  app.post<{ Body: CreateTenantRequest }>(
    "/",
    async (req: FastifyRequest<{ Body: CreateTenantRequest }>, reply: FastifyReply) => {
      const { id, slug, name, plan } = req.body;

      if (!slug || !name) {
        return reply.status(400).send({ error: "slug and name are required" });
      }

      const { id: tenantId } = await createTenant({
        ...(id !== undefined && { id }),
        ...(plan !== undefined && { plan }),
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
      if (status === "active" || status === "inactive") await updateAppStatus(appId, status);
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
