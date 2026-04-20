import { GoogleAuth, type IdTokenClient } from "google-auth-library";
import { logger } from "@platform-back/logger";

// Cloud Run IAM auth: platform-back's service account holds
// `roles/run.invoker` on each handler service. We mint a Google-signed
// OIDC ID token with the handler's URL as the audience; Cloud Run
// validates the token at the proxy layer before the request reaches
// the handler container.
//
// Tokens are cached per audience. Google ID tokens are valid for 1 hour;
// the google-auth-library client caches and refreshes internally — we
// add a per-audience client cache because constructing one per request
// is wasteful (~50ms each).

const SKIP_AUTH = process.env["CLOUD_RUN_SKIP_AUTH"] === "true";

const auth = SKIP_AUTH ? null : new GoogleAuth();
const clientByAudience = new Map<string, Promise<IdTokenClient>>();

function audienceFor(targetUrl: string): string {
  // Audience must be the service's *root* URL — Cloud Run rejects tokens
  // whose `aud` claim includes path components.
  const u = new URL(targetUrl);
  return `${u.protocol}//${u.host}`;
}

async function getClient(audience: string): Promise<IdTokenClient> {
  if (!auth) {
    throw new Error("ID token client requested while CLOUD_RUN_SKIP_AUTH=true");
  }
  const existing = clientByAudience.get(audience);
  if (existing) return existing;

  const created = auth.getIdTokenClient(audience).catch((err: unknown) => {
    // Don't poison the cache with a failed promise.
    clientByAudience.delete(audience);
    throw err;
  });
  clientByAudience.set(audience, created);
  return created;
}

/**
 * Returns the value for an `Authorization` header to send to a Cloud Run
 * handler at `targetUrl`, or `null` when auth is skipped (local dev).
 *
 * Throws if minting fails in prod — callers should treat that as a 502
 * to the merchant, since the request cannot be safely forwarded without
 * proof of identity.
 */
export async function getHandlerAuthHeader(
  targetUrl: string,
): Promise<string | null> {
  if (SKIP_AUTH) return null;
  const audience = audienceFor(targetUrl);
  const client = await getClient(audience);
  const headers = await client.getRequestHeaders(targetUrl);
  const authHeader = headers["Authorization"] ?? headers["authorization"];
  if (typeof authHeader !== "string" || authHeader.length === 0) {
    throw new Error(
      `google-auth-library returned no Authorization header for ${audience}`,
    );
  }
  return authHeader;
}

/**
 * Eagerly invalidates the cached client for an audience. Useful if a
 * handler is redeployed at a new URL — the next request reconstructs.
 */
export function invalidateAudience(targetUrl: string): void {
  const audience = audienceFor(targetUrl);
  clientByAudience.delete(audience);
  logger.debug({ audience }, "ID-token client cache invalidated");
}
