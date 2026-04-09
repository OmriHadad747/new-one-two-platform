/**
 * Billing routes — plan management, subscription lifecycle, usage tracking.
 *
 * GET    /billing/plans                — List available plans + current plan + interval
 * GET    /billing/usage/:tenantId      — Current usage vs limits
 * POST   /billing/subscribe            — Create Shopify subscription (monthly or annual)
 * GET    /billing/callback             — Shopify redirects here after merchant approves/declines
 * POST   /billing/cancel/:tenantId     — Cancel current subscription (downgrade to free)
 * POST   /billing/webhook              — Shopify APP_SUBSCRIPTIONS_UPDATE webhook
 * GET    /billing/dashboard/:tenantId  — Comprehensive billing dashboard (usage, events, analytics)
 * GET    /billing/analytics/:tenantId  — Revision classification analytics
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "@new-one-two/logger";
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
} from "@new-one-two/db";
import type {
  BillingPlan,
  BillingInterval,
  SubscriptionStatus,
  SubscribeRequest,
  BillingUsageResponse,
  BillingPlansResponse,
  BillingDashboardResponse,
} from "@new-one-two/types";
import { getAllPlans, getPlanLimits, PLANS } from "../lib/plans.js";
import { createSubscription, cancelSubscription } from "../lib/shopify-billing.js";

const DASHBOARD_URL = process.env["DASHBOARD_URL"] ?? "http://localhost:3000";

export const billingRoute: FastifyPluginAsync = async (app) => {
  // ─── GET /billing/plans ─────────────────────────────────────────────────────

  app.get<{ Querystring: { tenantId?: string } }>(
    "/plans",
    async (
      req: FastifyRequest<{ Querystring: { tenantId?: string } }>,
      reply: FastifyReply
    ) => {
      const { tenantId } = req.query;
      let currentPlan: BillingPlan = "free";
      let currentInterval: BillingInterval = "monthly";

      if (tenantId) {
        const tenant = await getTenantById(tenantId);
        if (tenant) {
          currentPlan = tenant.billingPlan;
          currentInterval = tenant.billingInterval ?? "monthly";
        }
      }

      const response: BillingPlansResponse = {
        plans: getAllPlans(),
        currentPlan,
        currentInterval,
      };
      return reply.send(response);
    }
  );

  // ─── GET /billing/usage/:tenantId ───────────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/usage/:tenantId",
    async (
      req: FastifyRequest<{ Params: { tenantId: string } }>,
      reply: FastifyReply
    ) => {
      const { tenantId } = req.params;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }

      const usage = await getOrCreateUsageRecord(tenantId);
      const limits = getPlanLimits(tenant.billingPlan);

      const response: BillingUsageResponse = {
        plan: tenant.billingPlan,
        interval: tenant.billingInterval ?? "monthly",
        subscriptionStatus: tenant.subscriptionStatus,
        trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
        usage,
        limits,
      };
      return reply.send(response);
    }
  );

  // ─── POST /billing/subscribe ────────────────────────────────────────────────

  app.post<{ Body: SubscribeRequest }>(
    "/subscribe",
    async (
      req: FastifyRequest<{ Body: SubscribeRequest }>,
      reply: FastifyReply
    ) => {
      const { tenantId, plan, interval: rawInterval } = req.body;
      const interval: BillingInterval = rawInterval === "annual" ? "annual" : "monthly";

      if (!tenantId || !plan) {
        return reply.status(400).send({ error: "tenantId and plan are required" });
      }

      if (!(plan in PLANS)) {
        return reply.status(400).send({ error: `Invalid plan: ${plan}` });
      }

      // Annual billing not available for free plan
      if (plan === "free" && interval === "annual") {
        return reply.status(400).send({ error: "Annual billing is not available for the free plan" });
      }

      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }

      // Free plan — just update directly, no Shopify subscription needed
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

      // Paid plan — create Shopify subscription with chosen interval
      const { confirmationUrl, subscriptionId } = await createSubscription(tenant, plan, interval);

      // Mark as pending until Shopify confirms
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
    }
  );

  // ─── GET /billing/callback ──────────────────────────────────────────────────
  // Shopify redirects here after the merchant approves or declines the charge.

  app.get<{
    Querystring: { tenant_id?: string; plan?: string; charge_id?: string; interval?: string };
  }>(
    "/callback",
    async (
      req: FastifyRequest<{
        Querystring: { tenant_id?: string; plan?: string; charge_id?: string; interval?: string };
      }>,
      reply: FastifyReply
    ) => {
      const { tenant_id: tenantId, plan, interval: rawInterval } = req.query;
      const interval: BillingInterval = rawInterval === "annual" ? "annual" : "monthly";

      if (!tenantId || !plan) {
        return reply.redirect(`${DASHBOARD_URL}/settings?billing=error`);
      }

      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.redirect(`${DASHBOARD_URL}/settings?billing=error`);
      }

      const billingPlan = plan as BillingPlan;
      const planDef = PLANS[billingPlan];
      if (!planDef) {
        return reply.redirect(`${DASHBOARD_URL}/settings?billing=error`);
      }

      // Calculate trial end date
      const trialEndsAt =
        planDef.limits.trialDays > 0
          ? new Date(Date.now() + planDef.limits.trialDays * 86400000)
          : null;

      // Merchant approved — activate the plan with chosen interval
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
      return reply.redirect(`${DASHBOARD_URL}/merchants/${tenantId}?billing=success&plan=${plan}&interval=${interval}`);
    }
  );

  // ─── POST /billing/cancel/:tenantId ─────────────────────────────────────────

  app.post<{ Params: { tenantId: string } }>(
    "/cancel/:tenantId",
    async (
      req: FastifyRequest<{ Params: { tenantId: string } }>,
      reply: FastifyReply
    ) => {
      const { tenantId } = req.params;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
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
    }
  );

  // ─── POST /billing/webhook ────────────────────────────────────────────────
  // Handles APP_SUBSCRIPTIONS_UPDATE from Shopify.
  // This is critical — it's how we learn about payment failures (frozen),
  // cancellations, and trial expiry. Without it, billing state drifts.

  app.post(
    "/webhook",
    {
      config: { rawBody: true },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Verify HMAC signature
      const hmacHeader = req.headers["x-shopify-hmac-sha256"] as string | undefined;
      const shopifySecret = process.env["SHOPIFY_CLIENT_SECRET"] ?? "";

      if (!hmacHeader || !shopifySecret) {
        return reply.status(401).send({ error: "Missing HMAC or secret" });
      }

      const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
      const computed = createHmac("sha256", shopifySecret)
        .update(rawBody, "utf8")
        .digest("base64");

      try {
        if (!timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader))) {
          return reply.status(401).send({ error: "Invalid HMAC" });
        }
      } catch {
        return reply.status(401).send({ error: "Invalid HMAC" });
      }

      const payload = req.body as Record<string, any>;
      const subscriptionGid = payload.app_subscription?.admin_graphql_api_id as string | undefined;
      const shopifyStatus = payload.app_subscription?.status as string | undefined;
      const shopDomain = req.headers["x-shopify-shop-domain"] as string | undefined;

      if (!subscriptionGid || !shopifyStatus) {
        logger.warn({ payload }, "billing webhook: missing subscription data");
        return reply.status(200).send({ ok: true });
      }

      // Find tenant by subscription ID or shop domain
      let tenantRows = await sql<{ id: string; billingPlan: string }[]>`
        SELECT id, billing_plan FROM tenants
        WHERE shopify_subscription_id = ${subscriptionGid}
      `;
      if (tenantRows.length === 0 && shopDomain) {
        tenantRows = await sql<{ id: string; billingPlan: string }[]>`
          SELECT id, billing_plan FROM tenants
          WHERE shop_domain = ${shopDomain}
        `;
      }
      if (tenantRows.length === 0) {
        logger.warn({ subscriptionGid, shopDomain }, "billing webhook: tenant not found");
        return reply.status(200).send({ ok: true });
      }

      const tenant = tenantRows[0]!;

      // Map Shopify status → our subscription status
      const statusMap: Record<string, SubscriptionStatus> = {
        ACTIVE: "active",
        FROZEN: "frozen",
        CANCELLED: "cancelled",
        DECLINED: "cancelled",
        EXPIRED: "cancelled",
        PENDING: "pending",
      };

      const newStatus = statusMap[shopifyStatus.toUpperCase()] ?? "active";

      // If frozen or cancelled → downgrade to free
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
          fromPlan: tenant.billingPlan as BillingPlan,
          toPlan: "free",
          shopifySubscriptionId: subscriptionGid,
          metadata: { shopifyStatus, shopDomain },
        });
        logger.info(
          { tenantId: tenant.id, shopifyStatus, newStatus },
          "Billing webhook: subscription deactivated, downgraded to free"
        );
      } else {
        await updateTenantBilling(tenant.id, {
          subscriptionStatus: newStatus,
        });
        await logBillingEvent({
          tenantId: tenant.id,
          eventType: `shopify_status_${newStatus}`,
          shopifySubscriptionId: subscriptionGid,
          metadata: { shopifyStatus, shopDomain },
        });
        logger.info(
          { tenantId: tenant.id, shopifyStatus, newStatus },
          "Billing webhook: subscription status updated"
        );
      }

      return reply.status(200).send({ ok: true });
    }
  );

  // ─── GET /billing/dashboard/:tenantId ─────────────────────────────────────
  // Comprehensive billing dashboard — usage charts, events, plan info.

  app.get<{ Params: { tenantId: string } }>(
    "/dashboard/:tenantId",
    async (
      req: FastifyRequest<{ Params: { tenantId: string } }>,
      reply: FastifyReply
    ) => {
      const { tenantId } = req.params;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }

      // Fetch all dashboard data in parallel
      const [usage, usageHistory, billingEvents, revisionAnalytics, activeApps] =
        await Promise.all([
          getOrCreateUsageRecord(tenantId),
          getUsageHistory(tenantId, 6),
          getBillingEvents(tenantId, 50),
          getRevisionAnalytics(tenantId),
          getActiveAppCount(tenantId),
        ]);

      const limits = getPlanLimits(tenant.billingPlan);

      const response: BillingDashboardResponse = {
        subscription: {
          plan: tenant.billingPlan,
          interval: tenant.billingInterval ?? "monthly",
          status: tenant.subscriptionStatus,
          trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
          billingCycleAnchor: tenant.billingCycleAnchor.toISOString(),
          planUpdatedAt: tenant.planUpdatedAt.toISOString(),
        },
        currentUsage: {
          usage,
          limits,
        },
        usageHistory,
        billingEvents,
        revisionAnalytics,
        appCount: {
          active: activeApps,
          limit: limits.maxApps,
        },
      };

      return reply.send(response);
    }
  );

  // ─── GET /billing/analytics/:tenantId ───────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/analytics/:tenantId",
    async (
      req: FastifyRequest<{ Params: { tenantId: string } }>,
      reply: FastifyReply
    ) => {
      const { tenantId } = req.params;
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }

      const analytics = await getRevisionAnalytics(tenantId);
      return reply.send(analytics);
    }
  );
};
