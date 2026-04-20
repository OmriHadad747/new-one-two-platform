import { createHmac, timingSafeEqual } from "node:crypto";

// Shopify App Bridge session tokens are HS256 JWTs signed with the app's
// client secret. The token's `dest` claim identifies the shop the request
// is acting on behalf of; `aud` must equal our client_id.
//
// Spec: https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens/verify-session-tokens

export interface ShopifySessionTokenClaims {
  shop: string; // myshopify domain, e.g. "acme.myshopify.com" (no scheme)
  sub: string; // user id
  sessionId: string | undefined; // sid claim if present
}

interface RawClaims {
  iss?: string;
  dest?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  sid?: string;
}

const CLOCK_SKEW_SEC = 5;

export function verifyShopifySessionToken(
  token: string,
  clientId: string,
  clientSecret: string,
): ShopifySessionTokenClaims | null {
  if (!clientId || !clientSecret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Verify HS256 signature, timing-safe.
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = createHmac("sha256", clientSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    actual = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  // Decode claims.
  let claims: RawClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf-8"),
    ) as RawClaims;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp !== undefined && claims.exp + CLOCK_SKEW_SEC < now)
    return null;
  if (claims.nbf !== undefined && claims.nbf - CLOCK_SKEW_SEC > now)
    return null;

  // `aud` may be string or array per JWT spec; Shopify sends a string.
  const aud = claims.aud;
  const audValid =
    typeof aud === "string"
      ? aud === clientId
      : Array.isArray(aud)
        ? aud.includes(clientId)
        : false;
  if (!audValid) return null;

  if (typeof claims.dest !== "string" || claims.dest.length === 0) return null;
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;

  // dest is e.g. "https://acme.myshopify.com" — strip scheme.
  const shop = claims.dest.replace(/^https?:\/\//, "").toLowerCase();
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return null;

  return {
    shop,
    sub: claims.sub,
    sessionId: claims.sid,
  };
}
