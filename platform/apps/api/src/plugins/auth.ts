/**
 * JWT authentication plugin for the platform API.
 *
 * Behaviour:
 *   - Production (API_AUTH_REQUIRED=true): rejects requests without a valid Bearer token.
 *   - Development (default): allows unauthenticated requests but still validates tokens
 *     when present, so the frontend can be tested end-to-end.
 *
 * Token lifecycle:
 *   1. After Shopify OAuth callback, the API issues a signed JWT with { tenantId, shopDomain }.
 *   2. The dashboard stores the token and sends it as `Authorization: Bearer <token>`.
 *   3. This plugin validates the signature, expiry, and attaches the decoded tenant context
 *      to the request so downstream route handlers can trust `request.tenantAuth`.
 *
 * Token sources (checked in order):
 *   1. `Authorization: Bearer <token>` header — used by all standard API requests.
 *   2. `?token=<token>` query parameter — used by EventSource/SSE connections
 *      (the browser EventSource API does not support custom headers).
 *
 * Exempt routes (always skip auth):
 *   /health/*, /oauth/*, /widgets/*, /admin-ui/*,
 *   GET /billing/callback (Shopify redirect), POST /billing/webhook (Shopify webhook)
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "@new-one-two/logger";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TenantAuth {
  tenantId: string;
  shopDomain: string;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantAuth?: TenantAuth;
  }
}

// ─── Config ────────────────────────────────────────────────────────────────────

const JWT_SECRET =
  process.env["JWT_SECRET"] ?? process.env["SHOPIFY_CLIENT_SECRET"] ?? "";
const AUTH_REQUIRED = process.env["API_AUTH_REQUIRED"] === "true";
const TOKEN_EXPIRY_SEC = 60 * 60 * 24 * 7; // 7 days

// Fail fast: if auth is required but no signing secret exists, the service
// cannot safely issue or verify tokens. Crash at startup rather than silently
// allowing unauthenticated traffic.
if (AUTH_REQUIRED && !JWT_SECRET) {
  throw new Error(
    "FATAL: API_AUTH_REQUIRED=true but neither JWT_SECRET nor SHOPIFY_CLIENT_SECRET is set. " +
    "Cannot start — all requests would bypass authentication."
  );
}

// ─── JWT Helpers (HS256 — no external dependency) ──────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

export function signJwt(payload: Record<string, unknown>): string {
  if (!JWT_SECRET) throw new Error("JWT_SECRET or SHOPIFY_CLIENT_SECRET must be set");
  const header = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(
    Buffer.from(
      JSON.stringify({
        ...payload,
        iat: now,
        exp: now + TOKEN_EXPIRY_SEC,
      })
    )
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

    // Verify signature (timing-safe)
    const expected = createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`)
      .digest();
    const actual = base64urlDecode(sig);

    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    // Decode and validate claims
    const payload = JSON.parse(base64urlDecode(body).toString("utf-8")) as {
      tenantId?: string;
      shopDomain?: string;
      exp?: number;
      iat?: number;
    };

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.tenantId) return null;

    return {
      tenantId: payload.tenantId,
      shopDomain: payload.shopDomain ?? "",
    };
  } catch {
    return null;
  }
}

// ─── Route Exemption ───────────────────────────────────────────────────────────

const EXEMPT_PREFIXES = ["/health", "/oauth", "/widgets", "/admin-ui"];

function isExemptRoute(url: string, method: string): boolean {
  // Strip query string for prefix matching
  const path = url.split("?")[0]!;

  for (const prefix of EXEMPT_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  // Billing webhook from Shopify (POST /billing/webhook)
  if (method === "POST" && path === "/billing/webhook") return true;
  // Billing callback — Shopify redirects here after charge approval (GET /billing/callback)
  if (method === "GET" && path === "/billing/callback") return true;
  // Email unsubscribe page — customers click these from their inbox (no auth).
  // Matches /email/u/:token and /email/u/:token/confirm.
  if (path.startsWith("/email/u/")) return true;
  return false;
}

// ─── Extract Token ─────────────────────────────────────────────────────────────
// Check Authorization header first, then ?token= query param (for EventSource/SSE
// which cannot send custom headers).

function extractToken(request: FastifyRequest): string | undefined {
  // 1. Authorization: Bearer <token>
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // 2. ?token=<token> query parameter (SSE / EventSource fallback)
  const query = request.query as Record<string, unknown>;
  if (typeof query?.["token"] === "string" && query["token"]) {
    return query["token"];
  }
  return undefined;
}

// ─── Auth Hook ─────────────────────────────────────────────────────────────────
// Exported as a raw hook function so it can be attached directly to the Fastify
// instance via app.addHook() — avoids encapsulation issues that would occur if
// registered as a plugin via app.register() without fastify-plugin.

export async function authHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Always skip exempt routes
  if (isExemptRoute(request.url, request.method)) return;

  const token = extractToken(request);
  if (token) {
    const auth = verifyJwt(token);
    if (auth) {
      request.tenantAuth = auth;
      return; // Authenticated
    }
    // Token present but invalid — always reject (even in dev)
    logger.warn({ url: request.url }, "Invalid or expired auth token");
    return reply
      .code(401)
      .send({ error: "Invalid or expired authentication token" });
  }

  // No token at all
  if (AUTH_REQUIRED) {
    return reply
      .code(401)
      .send({ error: "Authentication required" });
  }

  // Dev mode: allow through without token
}

// ─── Tenant Authorization Guard ──────────────────────────────────────────────
// Call from route handlers to verify the authenticated user owns the tenantId
// in the URL or request body. In dev mode (no auth required), this is a no-op
// so local development without tokens keeps working.

/**
 * Verifies the tenantId from the route matches the authenticated tenant.
 * Returns the validated tenantId, or sends 403 and returns null.
 *
 * Usage:
 *   const tenantId = requireTenant(req, reply, req.params.tenantId);
 *   if (!tenantId) return; // reply already sent
 */
export function requireTenant(
  req: FastifyRequest,
  reply: FastifyReply,
  tenantId: string
): string | null {
  // Dev mode without auth: trust the tenantId as-is
  if (!req.tenantAuth) return tenantId;

  if (req.tenantAuth.tenantId !== tenantId) {
    logger.warn(
      { authenticated: req.tenantAuth.tenantId, requested: tenantId },
      "Tenant authorization denied"
    );
    void reply.code(403).send({ error: "Access denied" });
    return null;
  }
  return tenantId;
}
