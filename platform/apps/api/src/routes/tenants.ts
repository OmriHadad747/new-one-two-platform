/**
 * Tenant management routes.
 *
 * POST   /tenants                          — Create a tenant
 * GET    /tenants/:tenantId                — Get a tenant by ID
 * POST   /tenants/:tenantId/apps           — Create an app under a tenant
 * GET    /tenants/:tenantId/apps/:appId    — Get an app by ID
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { createTenant, getTenantById, createApp, getAppById } from "@new-one-two/db";
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
        return reply.status(409).send({ error: "Tenant has no shop domain — complete OAuth installation first" });
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
};
