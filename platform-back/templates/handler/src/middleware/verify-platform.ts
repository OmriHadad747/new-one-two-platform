import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Inbound auth: platform-back calls us with a Google-signed OIDC ID token
// in `Authorization: Bearer <token>`. Cloud Run normally validates this
// at the proxy layer before traffic ever reaches us — but we re-verify
// here for two reasons:
//   1. Local dev: there's no Cloud Run proxy; the handler is the only
//      thing in the chain that can refuse unauthenticated callers.
//   2. Defense in depth: a misconfigured `--allow-unauthenticated` (or
//      the wrong IAM grant) would otherwise let anyone hit the handler.
//
// We also enforce that the token's `email` claim matches the configured
// platform SA — a valid Google-issued token from any GCP project would
// otherwise pass the signature check.

const SKIP_AUTH = process.env["CLOUD_RUN_SKIP_AUTH"] === "true";
const EXPECTED_AUDIENCE = process.env["EXPECTED_AUDIENCE"] ?? "";
const PLATFORM_SA_EMAIL = process.env["PLATFORM_SA_EMAIL"] ?? "";

if (!SKIP_AUTH) {
  if (!EXPECTED_AUDIENCE) {
    throw new Error(
      "FATAL: EXPECTED_AUDIENCE must be set when CLOUD_RUN_SKIP_AUTH != true",
    );
  }
  if (!PLATFORM_SA_EMAIL) {
    throw new Error(
      "FATAL: PLATFORM_SA_EMAIL must be set when CLOUD_RUN_SKIP_AUTH != true",
    );
  }
}

// Google's OIDC JWKS endpoint. `jose` caches keys and refreshes on
// signature failures, so this is allocated once per process.
const GOOGLE_JWKS = SKIP_AUTH
  ? null
  : createRemoteJWKSet(
      new URL("https://www.googleapis.com/oauth2/v3/certs"),
    );

export interface PlatformContext {
  tenantId: string;
  appId: string;
  shopDomain: string;
  requestId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      platform?: PlatformContext;
    }
  }
}

export async function verifyPlatform(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 1. Verify caller identity (Cloud Run ID token).
  if (!SKIP_AUTH && GOOGLE_JWKS) {
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_id_token" });
      return;
    }
    try {
      const { payload } = await jwtVerify(auth.slice(7), GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: EXPECTED_AUDIENCE,
      });
      if (payload["email"] !== PLATFORM_SA_EMAIL) {
        res.status(403).json({ error: "untrusted_caller" });
        return;
      }
      if (payload["email_verified"] !== true) {
        res.status(403).json({ error: "email_not_verified" });
        return;
      }
    } catch {
      res.status(401).json({ error: "invalid_id_token" });
      return;
    }
  }

  // 2. Read signed-by-platform context headers. These are trustworthy
  //    only because step 1 proved the caller IS platform-back.
  const tenantId = req.header("x-tenant-id");
  const appId = req.header("x-app-id");
  const shopDomain = req.header("x-shop-domain");
  const requestId = req.header("x-request-id") ?? crypto.randomUUID();

  if (!tenantId || !appId || !shopDomain) {
    res.status(400).json({ error: "missing_platform_headers" });
    return;
  }

  req.platform = { tenantId, appId, shopDomain, requestId };
  next();
}
