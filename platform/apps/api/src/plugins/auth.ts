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
 * Exempt routes (always skip auth):
 *   /health/*, /oauth/*, /widgets/*, /admin-ui/*, POST /billing/webhook
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
  for (const prefix of EXEMPT_PREFIXES) {
    if (url.startsWith(prefix)) return true;
  }
  // Billing webhook from Shopify (POST /billing/webhook)
  if (method === "POST" && url === "/billing/webhook") return true;
  return false;
}

// ─── Plugin ────────────────────────────────────────────────────────────────────

export async function authPlugin(app: FastifyInstance) {
  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Always skip exempt routes
      if (isExemptRoute(request.url, request.method)) return;

      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
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
  );
}
