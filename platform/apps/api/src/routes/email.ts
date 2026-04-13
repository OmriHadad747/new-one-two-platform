/**
 * Email integration routes — per-app email config CRUD, test send, stats,
 * tenant brand CRUD, and public unsubscribe page.
 *
 * All merchant-facing routes:
 *   GET    /email/apps/:appId/config        — Load current email config + variables + brand
 *   PUT    /email/apps/:appId/config        — Save merchant-edited config (sets configured_by_merchant=TRUE)
 *   POST   /email/apps/:appId/test          — Send test email to merchant's own inbox
 *   GET    /email/apps/:appId/stats         — 30-day status counts
 *   GET    /email/tenants/:tenantId/brand   — Load tenant brand
 *   PUT    /email/tenants/:tenantId/brand   — Save tenant brand
 *
 * Public (unauthenticated) routes — exempted in the auth hook:
 *   GET    /email/u/:token                  — Unsubscribe landing page
 *   POST   /email/u/:token/confirm          — Commit unsubscribe (writes suppression row)
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "@new-one-two/logger";
import {
  getAppEmailConfig,
  updateAppEmailConfig,
  getTenantBrand,
  upsertTenantBrand,
  getAppEmailStats,
  insertEmailSuppression,
  insertEmailDelivery,
  updateEmailDeliveryStatus,
  getTenantById,
  getAppByIdOnly,
  sql,
} from "@new-one-two/db";
import type { EmailType } from "@new-one-two/types";
import {
  renderEmail,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "@new-one-two/harness";
import { Resend } from "resend";
import { requireTenant } from "../plugins/auth.js";

const RESEND_API_KEY = process.env["RESEND_API_KEY"] ?? "";
const RESEND_FROM_TRANSACTIONAL =
  process.env["RESEND_FROM_TRANSACTIONAL"] ?? "notifications@mail.ton-platform.com";

/**
 * Sample values for common variable names, used when rendering test emails.
 * Any variable not in this map renders its own name wrapped in brackets.
 */
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

function buildSampleVariables(variableNames: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of variableNames) {
    out[name] = SAMPLE_VARIABLES[name] ?? `[${name}]`;
  }
  return out;
}

export const emailRoute: FastifyPluginAsync = async (app) => {
  // ─── GET /email/apps/:appId/config ─────────────────────────────────────────

  app.get<{ Params: { appId: string } }>(
    "/apps/:appId/config",
    async (req: FastifyRequest<{ Params: { appId: string } }>, reply: FastifyReply) => {
      const { appId } = req.params;

      const config = await getAppEmailConfig(appId);
      if (!config) {
        return reply.status(404).send({ error: "Email config not found for this app" });
      }
      if (!requireTenant(req, reply, config.tenantId)) return;

      const brand = await getTenantBrand(config.tenantId);

      // Variable names are stored on the app row as an emailVariables JSON column
      // set by the deployer from the bundle metadata.
      const appRows = await sql<{ emailVariables: string[] | null }[]>`
        SELECT email_variables AS "emailVariables"
        FROM apps
        WHERE id = ${appId}
      `;
      const variables = appRows[0]?.emailVariables ?? [];

      return reply.send({ config, brand, variables });
    }
  );

  // ─── PUT /email/apps/:appId/config ─────────────────────────────────────────

  app.put<{
    Params: { appId: string };
    Body: {
      subjectTemplate: string;
      headingTemplate: string | null;
      bodyTemplate: string;
      ctaLabel: string | null;
      ctaUrlTemplate: string | null;
      emailType: EmailType;
    };
  }>(
    "/apps/:appId/config",
    async (req, reply) => {
      const { appId } = req.params;

      // Authorize: verify caller owns this app's tenant
      const appRecord = await getAppByIdOnly(appId);
      if (!appRecord) return reply.status(404).send({ error: "App not found" });
      if (!requireTenant(req, reply, appRecord.tenantId)) return;

      const body = req.body;

      if (!body.subjectTemplate?.trim()) {
        return reply.status(400).send({ error: "subjectTemplate is required" });
      }
      if (!body.bodyTemplate?.trim()) {
        return reply.status(400).send({ error: "bodyTemplate is required" });
      }
      if (body.emailType !== "transactional" && body.emailType !== "marketing") {
        return reply.status(400).send({ error: "emailType must be 'transactional' or 'marketing'" });
      }

      try {
        const config = await updateAppEmailConfig(appId, {
          subjectTemplate: body.subjectTemplate,
          headingTemplate: body.headingTemplate,
          bodyTemplate: body.bodyTemplate,
          ctaLabel: body.ctaLabel,
          ctaUrlTemplate: body.ctaUrlTemplate,
          emailType: body.emailType,
        });
        return reply.send({ config });
      } catch (err) {
        logger.error({ err, appId }, "failed to update app email config");
        return reply.status(404).send({ error: "Email config not found for this app" });
      }
    }
  );

  // ─── POST /email/apps/:appId/test ──────────────────────────────────────────
  //
  // Renders the current config with sample data and sends it to the merchant's
  // own Shopify account email. Does not count against the merchant's email
  // quota (stats filter `is_test = FALSE`).

  app.post<{ Params: { appId: string }; Body: { recipient?: string } }>(
    "/apps/:appId/test",
    async (req, reply) => {
      const { appId } = req.params;
      const { recipient: recipientOverride } = req.body ?? {};

      const config = await getAppEmailConfig(appId);
      if (!config) {
        return reply.status(404).send({ error: "Email config not found for this app" });
      }
      if (!requireTenant(req, reply, config.tenantId)) return;

      const tenant = await getTenantById(config.tenantId);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }

      // Test send requires a target address. The merchant provides one
      // explicitly in the POST body — we don't derive it from any other
      // source because tenants don't have a dedicated notifications email.
      if (!recipientOverride?.trim()) {
        return reply.status(400).send({
          error: "recipient is required",
          message: "Provide your email address to receive the test send.",
        });
      }
      const recipient = recipientOverride.trim();

      // Variables manifest from the bundle → sample values
      const variablesRow = await sql<{ emailVariables: string[] | null }[]>`
        SELECT email_variables AS "emailVariables" FROM apps WHERE id = ${appId}
      `;
      const variableNames = variablesRow[0]?.emailVariables ?? [];
      const sampleVars = buildSampleVariables(variableNames);

      const brand = await getTenantBrand(config.tenantId);

      // Render the email using the harness renderer for consistency.
      const unsubscribeUrl = `https://ton-platform.com/u/${signUnsubscribeToken(
        config.tenantId,
        recipient
      )}`;
      const rendered = renderEmail({
        config,
        brand,
        variables: sampleVars,
        unsubscribeUrl,
        storeName: tenant.name,
      });

      // Insert delivery row marked as test (excluded from stats).
      const { id: deliveryId } = await insertEmailDelivery({
        tenantId: config.tenantId,
        appId,
        recipient,
        subject: rendered.subject,
        isTest: true,
      });

      try {
        const resend = new Resend(RESEND_API_KEY || "dev_no_key");
        const result = await resend.emails.send({
          from: `${tenant.name} <${RESEND_FROM_TRANSACTIONAL}>`,
          to: recipient,
          subject: `[TEST] ${rendered.subject}`,
          html: rendered.html,
          text: rendered.text,
          headers: {
            "X-Ton-Test-Send": "1",
            "X-Ton-Delivery-Id": deliveryId,
          },
        });
        const providerMsgId = (result as { data?: { id?: string } })?.data?.id ?? null;
        await updateEmailDeliveryStatus(deliveryId, { status: "sent", providerMsgId });
        return reply.send({ success: true, deliveryId, recipient });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updateEmailDeliveryStatus(deliveryId, {
          status: "failed",
          failureReason: message,
        });
        logger.error({ err: message, appId, recipient }, "test send failed");
        return reply.status(502).send({ error: "Test send failed", message });
      }
    }
  );

  // ─── GET /email/apps/:appId/stats ──────────────────────────────────────────

  app.get<{ Params: { appId: string } }>(
    "/apps/:appId/stats",
    async (req, reply) => {
      const { appId } = req.params;
      const appRecord = await getAppByIdOnly(appId);
      if (!appRecord) return reply.status(404).send({ error: "App not found" });
      if (!requireTenant(req, reply, appRecord.tenantId)) return;

      const stats = await getAppEmailStats(appId);
      return reply.send(stats);
    }
  );

  // ─── GET /email/tenants/:tenantId/brand ────────────────────────────────────

  app.get<{ Params: { tenantId: string } }>(
    "/tenants/:tenantId/brand",
    async (req, reply) => {
      const tenantId = requireTenant(req, reply, req.params.tenantId);
      if (!tenantId) return;
      const brand = await getTenantBrand(tenantId);
      return reply.send({ brand });
    }
  );

  // ─── PUT /email/tenants/:tenantId/brand ────────────────────────────────────

  app.put<{
    Params: { tenantId: string };
    Body: {
      logoUrl?: string | null;
      primaryColor?: string | null;
      footerText?: string | null;
      supportEmail?: string | null;
    };
  }>(
    "/tenants/:tenantId/brand",
    async (req, reply) => {
      const tenantId = requireTenant(req, reply, req.params.tenantId);
      if (!tenantId) return;
      const brand = await upsertTenantBrand({ tenantId, ...req.body });
      return reply.send({ brand });
    }
  );

  // ─── GET /email/u/:token (PUBLIC) ──────────────────────────────────────────
  //
  // Unsubscribe landing page. Verifies the signed token and renders a simple
  // confirmation HTML page. The merchant cannot intercept or skin this page
  // in MVP — deliverability matters more than customization.

  app.get<{ Params: { token: string } }>(
    "/u/:token",
    async (req, reply) => {
      const parsed = verifyUnsubscribeToken(req.params.token);
      if (!parsed) {
        return reply
          .type("text/html")
          .status(400)
          .send(renderUnsubscribePage({ state: "invalid" }));
      }

      const tenant = await getTenantById(parsed.tenantId);
      const merchantName = tenant?.name ?? "this merchant";

      return reply
        .type("text/html")
        .send(
          renderUnsubscribePage({
            state: "confirm",
            merchantName,
            email: parsed.email,
            token: req.params.token,
          })
        );
    }
  );

  // ─── POST /email/u/:token/confirm (PUBLIC) ─────────────────────────────────

  app.post<{ Params: { token: string } }>(
    "/u/:token/confirm",
    async (req, reply) => {
      const parsed = verifyUnsubscribeToken(req.params.token);
      if (!parsed) {
        return reply
          .type("text/html")
          .status(400)
          .send(renderUnsubscribePage({ state: "invalid" }));
      }

      await insertEmailSuppression({
        tenantId: parsed.tenantId,
        email: parsed.email,
        reason: "unsubscribed",
      });

      const tenant = await getTenantById(parsed.tenantId);
      const merchantName = tenant?.name ?? "this merchant";

      logger.info(
        { tenantId: parsed.tenantId, email: parsed.email },
        "customer unsubscribed via public page"
      );

      return reply
        .type("text/html")
        .send(
          renderUnsubscribePage({
            state: "done",
            merchantName,
            email: parsed.email,
          })
        );
    }
  );
};

// ─── Static unsubscribe page renderer ────────────────────────────────────────

function renderUnsubscribePage(
  opts:
    | { state: "invalid" }
    | { state: "confirm"; merchantName: string; email: string; token: string }
    | { state: "done"; merchantName: string; email: string }
): string {
  const base = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Unsubscribe</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background:#f5f5f5; margin:0; padding:0; }
  .card { max-width:480px; margin:80px auto; background:#fff; padding:40px; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.06); }
  h1 { font-size:22px; margin:0 0 12px; color:#1a1a1a; }
  p  { font-size:15px; line-height:22px; color:#444; }
  form { margin-top:24px; }
  button { background:#1a73e8; color:#fff; border:0; padding:12px 20px; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; }
  button.secondary { background:transparent; color:#666; margin-left:8px; }
  .muted { color:#888; font-size:13px; }
</style>
</head><body><div class="card">`;

  const close = `</div></body></html>`;

  if (opts.state === "invalid") {
    return `${base}<h1>Invalid unsubscribe link</h1><p>This link is malformed or has been tampered with. Please reach out to the merchant directly if you'd like to unsubscribe.</p>${close}`;
  }

  if (opts.state === "done") {
    return `${base}<h1>You're unsubscribed</h1><p><strong>${escape(
      opts.email
    )}</strong> will no longer receive emails from <strong>${escape(opts.merchantName)}</strong>.</p><p class="muted">It can take a few minutes for the change to take effect.</p>${close}`;
  }

  return `${base}<h1>Unsubscribe from ${escape(opts.merchantName)}</h1><p>You are about to stop receiving emails sent to <strong>${escape(
    opts.email
  )}</strong> from <strong>${escape(opts.merchantName)}</strong>.</p>
  <form method="POST" action="/api/email/u/${encodeURIComponent(opts.token)}/confirm">
    <button type="submit">Confirm unsubscribe</button>
  </form>${close}`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
