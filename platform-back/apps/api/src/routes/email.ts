import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  getAppByIdUnsafe,
  getAppEmailConfig,
  getAppEmailStats,
  getAppEmailVariables,
  getTenantBasics,
  getTenantBrand,
  updateAppEmailConfig,
  upsertTenantBrand,
} from "@platform-back/db";
import { sendEmail } from "@platform-back/email";
import { createRequestLogger } from "@platform-back/logger";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { requireTenant } from "../plugins/auth.js";

// Sample values used to render test emails. Anything not in this map
// renders as the bracketed variable name so the merchant can see what's
// missing without us inventing fake values for unknown keys.
const SAMPLE_VARIABLES: Record<string, unknown> = {
  customerName: "Sample Customer",
  customerEmail: "sample@example.com",
  firstName: "Sample",
  cartTotal: "$47.30",
  currency: "USD",
  orderId: "#12345",
  orderNumber: "12345",
  productName: "Sample Product",
  productTitle: "Sample Product",
  recoveryUrl: "https://example.myshopify.com/checkout/recover",
  trackingNumber: "1Z999AA10123456789",
  couponCode: "SAVE10",
  storeName: "Sample Store",
};

function buildSampleVariables(
  variableNames: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of variableNames) {
    out[name] = SAMPLE_VARIABLES[name] ?? `[${name}]`;
  }
  return out;
}

// ─── Body schemas ────────────────────────────────────────────────────────────

const PutConfigBodySchema = z.object({
  subjectTemplate: z.string().min(1),
  headingTemplate: z.string().nullable(),
  bodyTemplate: z.string().min(1),
  ctaLabel: z.string().nullable(),
  ctaUrlTemplate: z.string().nullable(),
  emailType: z.enum(["transactional", "marketing"]),
});

const TestSendBodySchema = z.object({
  recipient: z.string().email(),
});

const PutBrandBodySchema = z.object({
  logoUrl: z.string().url().nullable().optional(),
  primaryColor: z.string().nullable().optional(),
  footerText: z.string().nullable().optional(),
  supportEmail: z.string().email().nullable().optional(),
});

// ─── Plugin ─────────────────────────────────────────────────────────────────

export async function emailRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /email/apps/:appId/config ────────────────────────────────────────
  app.get<{ Params: { appId: string } }>(
    "/apps/:appId/config",
    async (req, reply) => {
      const { appId } = req.params;
      const config = await getAppEmailConfig(appId);
      if (!config) {
        return reply
          .code(404)
          .send(
            errorResponse(
              ErrorCode.NotFound,
              "Email config not found for this app",
            ),
          );
      }
      if (!requireTenant(req, reply, config.tenantId)) return;

      const [brand, variables] = await Promise.all([
        getTenantBrand(config.tenantId),
        getAppEmailVariables(appId),
      ]);
      return reply.send({ config, brand, variables });
    },
  );

  // ── PUT /email/apps/:appId/config ────────────────────────────────────────
  app.put<{ Params: { appId: string } }>(
    "/apps/:appId/config",
    async (req, reply) => {
      const { appId } = req.params;

      const appRecord = await getAppByIdUnsafe(appId);
      if (!appRecord) {
        return reply
          .code(404)
          .send(errorResponse(ErrorCode.NotFound, "App not found"));
      }
      if (!requireTenant(req, reply, appRecord.tenantId)) return;

      const parsed = PutConfigBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            errorResponse(
              ErrorCode.InvalidRequest,
              "Invalid request body",
              parsed.error.flatten(),
            ),
          );
      }

      try {
        const config = await updateAppEmailConfig(appId, parsed.data);
        return reply.send({ config });
      } catch (err) {
        req.log.error({ err, appId }, "failed to update app email config");
        return reply
          .code(404)
          .send(
            errorResponse(
              ErrorCode.NotFound,
              "Email config not found for this app",
            ),
          );
      }
    },
  );

  // ── POST /email/apps/:appId/test ─────────────────────────────────────────
  // Sends a sample-data render to the merchant's chosen address. Bypasses
  // suppression + quota (test sends shouldn't drain the merchant's plan).
  app.post<{ Params: { appId: string } }>(
    "/apps/:appId/test",
    async (req, reply) => {
      const { appId } = req.params;
      const log = createRequestLogger({ requestId: req.id });

      const config = await getAppEmailConfig(appId);
      if (!config) {
        return reply
          .code(404)
          .send(
            errorResponse(
              ErrorCode.NotFound,
              "Email config not found for this app",
            ),
          );
      }
      if (!requireTenant(req, reply, config.tenantId)) return;

      const tenant = await getTenantBasics(config.tenantId);
      if (!tenant) {
        return reply
          .code(404)
          .send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
      }

      const parsed = TestSendBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            errorResponse(
              ErrorCode.InvalidRequest,
              "Provide a recipient address to receive the test send",
              parsed.error.flatten(),
            ),
          );
      }

      const declared = await getAppEmailVariables(appId);
      const sampleData = buildSampleVariables(declared);

      try {
        const result = await sendEmail({
          tenantId: config.tenantId,
          appId,
          storeName: tenant.storeName,
          plan: tenant.plan,
          recipient: parsed.data.recipient,
          data: sampleData,
          isTest: true,
          subjectPrefix: "[TEST] ",
          log,
        });
        return reply.send(result);
      } catch (err) {
        log.error({ err }, "/email/test: unexpected failure");
        return reply
          .code(500)
          .send(
            errorResponse(ErrorCode.Internal, "Test send failed unexpectedly"),
          );
      }
    },
  );

  // ── GET /email/apps/:appId/stats ─────────────────────────────────────────
  app.get<{ Params: { appId: string } }>(
    "/apps/:appId/stats",
    async (req, reply) => {
      const { appId } = req.params;
      const appRecord = await getAppByIdUnsafe(appId);
      if (!appRecord) {
        return reply
          .code(404)
          .send(errorResponse(ErrorCode.NotFound, "App not found"));
      }
      if (!requireTenant(req, reply, appRecord.tenantId)) return;

      const stats = await getAppEmailStats(appId);
      return reply.send(stats);
    },
  );

  // ── GET /email/tenants/:tenantId/brand ───────────────────────────────────
  app.get<{ Params: { tenantId: string } }>(
    "/tenants/:tenantId/brand",
    async (
      req: FastifyRequest<{ Params: { tenantId: string } }>,
      reply: FastifyReply,
    ) => {
      const tenantId = requireTenant(req, reply, req.params.tenantId);
      if (!tenantId) return;
      const brand = await getTenantBrand(tenantId);
      return reply.send({ brand });
    },
  );

  // ── PUT /email/tenants/:tenantId/brand ───────────────────────────────────
  app.put<{ Params: { tenantId: string } }>(
    "/tenants/:tenantId/brand",
    async (req, reply) => {
      const tenantId = requireTenant(req, reply, req.params.tenantId);
      if (!tenantId) return;

      const parsed = PutBrandBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            errorResponse(
              ErrorCode.InvalidRequest,
              "Invalid request body",
              parsed.error.flatten(),
            ),
          );
      }

      const update: Parameters<typeof upsertTenantBrand>[0] = { tenantId };
      if (parsed.data.logoUrl !== undefined) update.logoUrl = parsed.data.logoUrl;
      if (parsed.data.primaryColor !== undefined)
        update.primaryColor = parsed.data.primaryColor;
      if (parsed.data.footerText !== undefined)
        update.footerText = parsed.data.footerText;
      if (parsed.data.supportEmail !== undefined)
        update.supportEmail = parsed.data.supportEmail;
      const brand = await upsertTenantBrand(update);
      return reply.send({ brand });
    },
  );
}
