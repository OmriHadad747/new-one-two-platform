import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  getTenantBasics,
  insertEmailSuppression,
} from "@platform-back/db";
import { verifyUnsubscribeToken } from "@platform-back/email";
import { logger } from "@platform-back/logger";

// Public, unauthenticated. Customers click these links from their inbox —
// the only thing protecting these routes is the HMAC over the token
// payload (verifyUnsubscribeToken). Tokens never expire (rotation is
// deferred — see comment in unsubscribe-token.ts).
//
// Mounted under /email/u — the auth hook in plugins/auth.ts exempts that
// prefix, otherwise we'd 401 every customer who clicked a link.

export async function emailPublicRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /email/u/:token — landing page ─────────────────────────────────────
  app.get<{ Params: { token: string } }>(
    "/:token",
    async (
      req: FastifyRequest<{ Params: { token: string } }>,
      reply: FastifyReply,
    ) => {
      const parsed = verifyUnsubscribeToken(req.params.token);
      if (!parsed) {
        return reply
          .type("text/html")
          .code(400)
          .send(renderUnsubscribePage({ state: "invalid" }));
      }

      const tenant = await getTenantBasics(parsed.tenantId);
      const merchantName = tenant?.storeName ?? "this merchant";

      return reply.type("text/html").send(
        renderUnsubscribePage({
          state: "confirm",
          merchantName,
          email: parsed.email,
          token: req.params.token,
        }),
      );
    },
  );

  // ── POST /email/u/:token/confirm — commit suppression ──────────────────────
  app.post<{ Params: { token: string } }>(
    "/:token/confirm",
    async (req, reply) => {
      const parsed = verifyUnsubscribeToken(req.params.token);
      if (!parsed) {
        return reply
          .type("text/html")
          .code(400)
          .send(renderUnsubscribePage({ state: "invalid" }));
      }

      await insertEmailSuppression({
        tenantId: parsed.tenantId,
        email: parsed.email,
        reason: "unsubscribed",
      });

      const tenant = await getTenantBasics(parsed.tenantId);
      const merchantName = tenant?.storeName ?? "this merchant";

      logger.info(
        { tenantId: parsed.tenantId, email: parsed.email },
        "customer unsubscribed via public page",
      );

      return reply.type("text/html").send(
        renderUnsubscribePage({
          state: "done",
          merchantName,
          email: parsed.email,
        }),
      );
    },
  );
}

// ─── Static page renderer ────────────────────────────────────────────────────
// Inlined HTML — deliberately not a templating system. The page never
// shows merchant content beyond the merchant name + the customer's own
// email, so the templating surface is tiny. Keeping it inline makes it
// trivially auditable from a deliverability perspective: no external
// assets, no JS, no third-party fonts.

function renderUnsubscribePage(
  opts:
    | { state: "invalid" }
    | { state: "confirm"; merchantName: string; email: string; token: string }
    | { state: "done"; merchantName: string; email: string },
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
  .muted { color:#888; font-size:13px; }
</style>
</head><body><div class="card">`;

  const close = `</div></body></html>`;

  if (opts.state === "invalid") {
    return `${base}<h1>Invalid unsubscribe link</h1><p>This link is malformed or has been tampered with. Please reach out to the merchant directly if you'd like to unsubscribe.</p>${close}`;
  }

  if (opts.state === "done") {
    return `${base}<h1>You're unsubscribed</h1><p><strong>${escape(
      opts.email,
    )}</strong> will no longer receive emails from <strong>${escape(opts.merchantName)}</strong>.</p><p class="muted">It can take a few minutes for the change to take effect.</p>${close}`;
  }

  return `${base}<h1>Unsubscribe from ${escape(opts.merchantName)}</h1><p>You are about to stop receiving emails sent to <strong>${escape(
    opts.email,
  )}</strong> from <strong>${escape(opts.merchantName)}</strong>.</p>
  <form method="POST" action="/email/u/${encodeURIComponent(opts.token)}/confirm">
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
