/**
 * Dashboard JWT authentication plugin for platform-back.
 *
 * The merchant dashboard (platform-front) calls platform-back with a
 * Bearer token issued by this service after Shopify OAuth. The token is
 * an HS256 JWT with `{ tenantId, shopDomain }`; verifyJwt below validates
 * signature + expiry and attaches the decoded context to the request.
 *
 * The auth hook is GLOBAL but exempts:
 *   - /health              (Cloud Run probes)
 *   - /admin/*             (Shopify App Bridge JWT — verified by routes/admin.ts)
 *   - /widget/*            (Shopify App Proxy HMAC — verified by routes/widget.ts)
 *   - /services/*          (Cloud Run SA ID token — verified by routes/services/*)
 *   - /webhook/*           (provider HMAC — verified by per-route logic)
 *   - /email/u/*           (public unsubscribe pages)
 *   - /oauth/*             (Shopify install/callback — no token yet)
 *   - /billing/callback    (Shopify cross-origin redirect; carries charge_id,
 *                           verified against shopify_subscription_id in the
 *                           handler)
 *   - /billing/webhook     (Shopify APP_SUBSCRIPTIONS_UPDATE; X-Shopify-HMAC-
 *                           SHA256 verified by the handler)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "@platform-back/logger";
import { ErrorCode, errorResponse } from "../lib/error-response.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TenantAuth {
  tenantId: string;
  shopDomain: string;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantAuth?: TenantAuth;
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env["JWT_SECRET"] || process.env["SHOPIFY_CLIENT_SECRET"] || "";
const AUTH_REQUIRED = process.env["NODE_ENV"] !== "development";
const TOKEN_EXPIRY_SEC = 60 * 60 * 24 * 7; // 7 days

if (AUTH_REQUIRED && !JWT_SECRET) {
  throw new Error("FATAL: JWT_SECRET (or SHOPIFY_CLIENT_SECRET) must be set outside local dev");
}

// ─── JWT helpers (HS256) ──────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

export function signJwt(payload: Record<string, unknown>): string {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET or SHOPIFY_CLIENT_SECRET must be set");
  }
  const header = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(
    Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + TOKEN_EXPIRY_SEC })),
  );
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string): TenantAuth | null {
  if (!JWT_SECRET) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts as [string, string, string];

    const expected = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest();
    const actual = base64urlDecode(sig);
    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(base64urlDecode(body).toString("utf-8")) as {
      tenantId?: string;
      shopDomain?: string;
      exp?: number;
    };
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.tenantId) return null;
    return { tenantId: payload.tenantId, shopDomain: payload.shopDomain ?? "" };
  } catch {
    return null;
  }
}

// ─── Route exemption ──────────────────────────────────────────────────────────

const EXEMPT_PREFIXES = ["/health", "/admin", "/widget", "/services", "/webhook", "/oauth"];

// Routes that must be exempt exactly — a startsWith match would swallow
// merchant-authed siblings. /billing/callback is hit by a cross-origin
// browser redirect from Shopify (no JWT); /billing/webhook is an HMAC-
// signed POST from Shopify. Both verify themselves inside the handler.
const EXEMPT_EXACT = new Set<string>(["/billing/callback", "/billing/webhook"]);

function isExemptRoute(url: string): boolean {
  const path = url.split("?")[0]!;
  if (EXEMPT_EXACT.has(path)) return true;
  for (const prefix of EXEMPT_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  // Public unsubscribe pages.
  if (path.startsWith("/email/u/")) return true;
  return false;
}

function extractToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  // SSE / EventSource fallback (no custom-header support in the browser API).
  const query = request.query as Record<string, unknown>;
  if (typeof query["token"] === "string" && query["token"]) {
    return query["token"];
  }
  return undefined;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isExemptRoute(request.url)) return;

  const token = extractToken(request);
  if (token) {
    const auth = verifyJwt(token);
    if (auth) {
      request.tenantAuth = auth;
      return;
    }
    logger.warn({ url: request.url }, "Invalid or expired auth token");
    void reply
      .code(401)
      .send(errorResponse(ErrorCode.TokenInvalid, "Invalid or expired authentication token"));
    return;
  }

  if (AUTH_REQUIRED) {
    void reply.code(401).send(errorResponse(ErrorCode.Unauthorized, "Authentication required"));
    return;
  }
  // Dev mode: allow through without a token.
}

// ─── Per-route guards ─────────────────────────────────────────────────────────

/**
 * Confirms the authenticated tenant matches the tenantId in the URL/body.
 * Returns the validated id or sends 403 and returns null. In dev mode
 * (no auth required) acts as a pass-through so local development without
 * tokens keeps working.
 */
export function requireTenant(
  req: FastifyRequest,
  reply: FastifyReply,
  tenantId: string,
): string | null {
  if (!req.tenantAuth) return tenantId;
  if (req.tenantAuth.tenantId !== tenantId) {
    logger.warn(
      { authenticated: req.tenantAuth.tenantId, requested: tenantId },
      "Tenant authorization denied",
    );
    void reply.code(403).send(errorResponse(ErrorCode.Forbidden, "Access denied"));
    return null;
  }
  return tenantId;
}

/**
 * Returns the authenticated tenant id, or sends 401 and returns null.
 * Use on routes whose URL doesn't carry a tenantId but still need to
 * scope work to a single tenant.
 */
export function requireAuthedTenantId(req: FastifyRequest, reply: FastifyReply): string | null {
  const tenantId = req.tenantAuth?.tenantId;
  if (!tenantId) {
    void reply
      .code(401)
      .send(errorResponse(ErrorCode.Unauthorized, "This endpoint requires an authenticated token"));
    return null;
  }
  return tenantId;
}

export function registerAuthHook(app: FastifyInstance): void {
  app.addHook("onRequest", authHook);
}
