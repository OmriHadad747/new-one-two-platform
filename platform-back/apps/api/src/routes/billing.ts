/**
 * Billing routes — plan management, subscription lifecycle, usage tracking.
 *
 * GET    /billing/plans                — Available plans + current plan + interval
 * GET    /billing/usage/:tenantId      — Current-period usage vs plan limits
 * POST   /billing/subscribe            — Create Shopify subscription (monthly or annual)
 * GET    /billing/callback             — Shopify redirect after merchant approves/declines
 * POST   /billing/cancel/:tenantId     — Cancel subscription → downgrade to free
 * POST   /billing/webhook              — Shopify APP_SUBSCRIPTIONS_UPDATE (HMAC-verified)
 * GET    /billing/dashboard/:tenantId  — Aggregated billing dashboard
 * GET    /billing/analytics/:tenantId  — Revision classification analytics
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  getTenantById,
  getOrCreateUsageRecord,
  getActiveAppCount,
  updateTenantBilling,
  logBillingEvent,
  getRevisionAnalytics,
  getUsageHistory,
  getBillingEvents,
  sql,
} from "@platform-back/db";
import { PLANS, getPlanLimits } from "@platform-back/types";
import type { BillingPlan, BillingInterval, SubscriptionStatus } from "@platform-back/types";
import { logger } from "@platform-back/logger";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { requireTenant } from "../plugins/auth.js";
import {
  createSubscription,
  cancelSubscription,
} from "../lib/shopify-billing.js";

const DASHBOARD_URL = process.env["DASHBOARD_URL"] ?? "http://localhost:3000";
// Read per-request so tests can flip it between cases.
function isShopifyBillingEnabled(): boolean {
  return (process.env["SHOPIFY_BILLING_MODE"] ?? "disabled") !== "disabled";
}

// ─── Body schemas ────────────────────────────────────────────────────────────

const SubscribeBodySchema = z.object({
  tenantId: z.string().uuid(),
  plan: z.enum(["free", "starter", "growth", "pro", "internal"]),
  interval: z.enum(["monthly", "annual"]).optional(),
});

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET /billing/plans ───────────────────────────────────────────────────

  app.get<{ Querystring: { tenantId?: string } }>(
    "/plans",
    async (req, reply) => {
      let currentPlan: BillingPlan = "free";
      let currentInterval: BillingInterval = "monthly";
      const { tenantId } = req.query;
      if (tenantId) {
        const tenant = await getTenantById(tenantId);
        if (tenant) {
          currentPlan = tenant.billingPlan;
          currentInterval = tenant.billingInterval;
        }
      }
      return reply.send({
        plans: Object.values(PLANS).filter((p) => p.id !== "internal"),
        currentPlan,
        currentInterval,
      });
    },
  );

  // ─── GET /billing/usage/:tenantId ─────────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/usage/:tenantId",
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply: FastifyReply) => {
      const tenantId = requireTenant(req, reply, req.params.tenantId);
      if (!tenantId) return;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.code(404).send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
      }
      const usage = await getOrCreateUsageRecord(tenantId);
      const limits = getPlanLimits(tenant.billingPlan);
      return reply.send({
        plan: tenant.billingPlan,
        interval: tenant.billingInterval,
        subscriptionStatus: tenant.subscriptionStatus,
        trialEndsAt: tenant.trialEndsAt,
        usage,
        limits,
      });
    },
  );

  // ─── POST /billing/subscribe ──────────────────────────────────────────────

  app.post(
    "/subscribe",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = SubscribeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(
          errorResponse(ErrorCode.InvalidRequest, "Invalid subscribe body", parsed.error.flatten()),
        );
      }
      const { plan, tenantId: rawTenantId } = parsed.data;
      const interval: BillingInterval = parsed.data.interval ?? "monthly";

      const tenantId = requireTenant(req, reply, rawTenantId);
      if (!tenantId) return;

      if (plan === "free" && interval === "annual") {
        return reply.code(400).send(
          errorResponse(ErrorCode.InvalidRequest, "Annual billing is not available for the free plan"),
        );
      }

      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.code(404).send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
      }

      if (plan === "free") {
        if (tenant.shopifySubscriptionId) {
          await cancelSubscription(tenant);
        }
        await updateTenantBilling(tenantId, {
          billingPlan: "free",
          billingInterval: "monthly",
          subscriptionStatus: "none",
          shopifySubscriptionId: null,
          trialEndsAt: null,
        });
        await logBillingEvent({
          tenantId,
          eventType: "downgrade_to_free",
          fromPlan: tenant.billingPlan,
          toPlan: "free",
        });
        return reply.send({ confirmationUrl: null, plan: "free" });
      }

      if (!isShopifyBillingEnabled()) {
        const planDef = PLANS[plan];
        const trialEndsAt =
          planDef && planDef.limits.trialDays > 0
            ? new Date(Date.now() + planDef.limits.trialDays * 86400_000)
            : null;
        await updateTenantBilling(tenantId, {
          billingPlan: plan,
          billingInterval: interval,
          subscriptionStatus: "active",
          trialEndsAt,
        });
        await logBillingEvent({
          tenantId,
          eventType: "dev_plan_override",
          fromPlan: tenant.billingPlan,
          toPlan: plan,
          metadata: { interval, note: "SHOPIFY_BILLING_MODE=disabled" },
        });
        logger.info({ tenantId, plan, interval }, "Dev mode: plan applied directly");
        return reply.send({ confirmationUrl: null, plan });
      }

      const { confirmationUrl, subscriptionId } = await createSubscription(
        tenant,
        plan,
        interval,
      );
      await updateTenantBilling(tenantId, {
        subscriptionStatus: "pending",
        shopifySubscriptionId: subscriptionId,
      });
      await logBillingEvent({
        tenantId,
        eventType: "subscription_created",
        fromPlan: tenant.billingPlan,
        toPlan: plan,
        shopifySubscriptionId: subscriptionId,
        metadata: { interval },
      });
      logger.info({ tenantId, plan, interval, subscriptionId }, "Subscription created, awaiting confirmation");
      return reply.send({ confirmationUrl });
    },
  );

  // ─── GET /billing/callback ───────────────────────────────────────────────

  app.get<{
    Querystring: { tenant_id?: string; plan?: string; interval?: string };
  }>(
    "/callback",
    async (req, reply) => {
      const { tenant_id: tenantId, plan, interval: rawInterval } = req.query;
      const interval: BillingInterval = rawInterval === "annual" ? "annual" : "monthly";

      if (!tenantId || !plan || !(plan in PLANS)) {
        return reply.redirect(`${DASHBOARD_URL}/settings?billing=error`);
      }
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.redirect(`${DASHBOARD_URL}/settings?billing=error`);
      }
      const billingPlan = plan as BillingPlan;
      const planDef = PLANS[billingPlan];
      const trialEndsAt =
        planDef.limits.trialDays > 0
          ? new Date(Date.now() + planDef.limits.trialDays * 86400_000)
          : null;

      await updateTenantBilling(tenantId, {
        billingPlan,
        billingInterval: interval,
        subscriptionStatus: "active",
        trialEndsAt,
      });
      await logBillingEvent({
        tenantId,
        eventType: "subscription_activated",
        fromPlan: tenant.billingPlan,
        toPlan: billingPlan,
        shopifySubscriptionId: tenant.shopifySubscriptionId,
        metadata: { interval },
      });
      logger.info({ tenantId, plan: billingPlan, interval }, "Subscription activated");
      return reply.redirect(
        `${DASHBOARD_URL}/merchants/${tenantId}?billing=success&plan=${plan}&interval=${interval}`,
      );
    },
  );

  // ─── POST /billing/cancel/:tenantId ──────────────────────────────────────

  app.post<{ Params: { tenantId: string } }>(
    "/cancel/:tenantId",
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply: FastifyReply) => {
      const tenantId = requireTenant(req, reply, req.params.tenantId);
      if (!tenantId) return;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.code(404).send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
      }
      if (tenant.shopifySubscriptionId) {
        await cancelSubscription(tenant);
      }
      await updateTenantBilling(tenantId, {
        billingPlan: "free",
        billingInterval: "monthly",
        subscriptionStatus: "cancelled",
        trialEndsAt: null,
      });
      await logBillingEvent({
        tenantId,
        eventType: "subscription_cancelled",
        fromPlan: tenant.billingPlan,
        toPlan: "free",
        shopifySubscriptionId: tenant.shopifySubscriptionId,
      });
      logger.info({ tenantId }, "Subscription cancelled, downgraded to free");
      return reply.send({ plan: "free" });
    },
  );

  // ─── POST /billing/webhook ───────────────────────────────────────────────
  // Handles Shopify APP_SUBSCRIPTIONS_UPDATE events. HMAC-verified.
  // Critical: keeps subscription_status in sync with Shopify's billing state
  // (payment failures, cancellations, trial expiry). Without this, a frozen
  // tenant keeps full plan access indefinitely.

  app.post(
    "/webhook",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const hmacHeader = req.headers["x-shopify-hmac-sha256"] as string | undefined;
      const shopifySecret = process.env["SHOPIFY_CLIENT_SECRET"] ?? "";

      if (!hmacHeader || !shopifySecret) {
        return reply.code(401).send(errorResponse(ErrorCode.HmacInvalid, "Missing HMAC or secret"));
      }

      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
        ?? Buffer.from(JSON.stringify(req.body));
      const computed = createHmac("sha256", shopifySecret)
        .update(rawBody)
        .digest("base64");

      try {
        if (
          !timingSafeEqual(
            Buffer.from(computed, "utf8"),
            Buffer.from(hmacHeader, "utf8"),
          )
        ) {
          return reply.code(401).send(errorResponse(ErrorCode.HmacInvalid, "Invalid HMAC"));
        }
      } catch {
        return reply.code(401).send(errorResponse(ErrorCode.HmacInvalid, "Invalid HMAC"));
      }

      const payload = req.body as Record<string, unknown>;
      const sub = payload.app_subscription as Record<string, unknown> | undefined;
      const subscriptionGid = sub?.admin_graphql_api_id as string | undefined;
      const shopifyStatus = sub?.status as string | undefined;
      const shopDomain = req.headers["x-shopify-shop-domain"] as string | undefined;

      if (!subscriptionGid || !shopifyStatus) {
        logger.warn({ payload }, "billing/webhook: missing subscription data");
        return reply.code(200).send({ ok: true });
      }

      // Resolve tenant by subscription GID, falling back to shop domain.
      let rows = await sql<Array<{ id: string; billingPlan: BillingPlan }>>`
        SELECT id, billing_plan AS "billingPlan" FROM tenants
        WHERE shopify_subscription_id = ${subscriptionGid}
        LIMIT 1
      `;
      if (rows.length === 0 && shopDomain) {
        rows = await sql<Array<{ id: string; billingPlan: BillingPlan }>>`
          SELECT id, billing_plan AS "billingPlan" FROM tenants
          WHERE shop_domain = ${shopDomain}
          LIMIT 1
        `;
      }
      if (rows.length === 0) {
        logger.warn({ subscriptionGid, shopDomain }, "billing/webhook: tenant not found");
        return reply.code(200).send({ ok: true });
      }
      const tenant = rows[0]!;

      const statusMap: Record<string, SubscriptionStatus> = {
        ACTIVE: "active",
        FROZEN: "frozen",
        CANCELLED: "cancelled",
        DECLINED: "cancelled",
        EXPIRED: "cancelled",
        PENDING: "pending",
      };
      const newStatus = statusMap[shopifyStatus.toUpperCase()] ?? "active";

      if (newStatus === "frozen" || newStatus === "cancelled") {
        await updateTenantBilling(tenant.id, {
          billingPlan: "free",
          billingInterval: "monthly",
          subscriptionStatus: newStatus,
          trialEndsAt: null,
        });
        await logBillingEvent({
          tenantId: tenant.id,
          eventType: `shopify_${newStatus}`,
          fromPlan: tenant.billingPlan,
          toPlan: "free",
          shopifySubscriptionId: subscriptionGid,
          metadata: { shopifyStatus, shopDomain },
        });
        logger.info({ tenantId: tenant.id, shopifyStatus }, "billing/webhook: downgraded to free");
      } else {
        await updateTenantBilling(tenant.id, { subscriptionStatus: newStatus });
        await logBillingEvent({
          tenantId: tenant.id,
          eventType: `shopify_status_${newStatus}`,
          shopifySubscriptionId: subscriptionGid,
          metadata: { shopifyStatus, shopDomain },
        });
        logger.info({ tenantId: tenant.id, shopifyStatus, newStatus }, "billing/webhook: status updated");
      }

      return reply.code(200).send({ ok: true });
    },
  );

  // ─── GET /billing/dashboard/:tenantId ────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/dashboard/:tenantId",
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply: FastifyReply) => {
      const tenantId = requireTenant(req, reply, req.params.tenantId);
      if (!tenantId) return;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.code(404).send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
      }

      const [usage, usageHistory, billingEvents, revisionAnalytics, activeApps] =
        await Promise.all([
          getOrCreateUsageRecord(tenantId),
          getUsageHistory(tenantId, 6),
          getBillingEvents(tenantId, 50),
          getRevisionAnalytics(tenantId),
          getActiveAppCount(tenantId),
        ]);

      const limits = getPlanLimits(tenant.billingPlan);
      return reply.send({
        subscription: {
          plan: tenant.billingPlan,
          interval: tenant.billingInterval,
          status: tenant.subscriptionStatus,
          trialEndsAt: tenant.trialEndsAt,
          billingCycleAnchor: tenant.billingCycleAnchor,
          planUpdatedAt: tenant.planUpdatedAt,
        },
        currentUsage: { usage, limits },
        usageHistory,
        billingEvents,
        revisionAnalytics,
        appCount: { active: activeApps, limit: limits.maxApps },
      });
    },
  );

  // ─── GET /billing/analytics/:tenantId ────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/analytics/:tenantId",
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply: FastifyReply) => {
      const tenantId = requireTenant(req, reply, req.params.tenantId);
      if (!tenantId) return;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.code(404).send(errorResponse(ErrorCode.NotFound, "Tenant not found"));
      }
      const analytics = await getRevisionAnalytics(tenantId);
      return reply.send(analytics);
    },
  );
}
