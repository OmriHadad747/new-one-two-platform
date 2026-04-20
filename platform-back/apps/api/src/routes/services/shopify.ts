import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getTenantAccessTokenSecretName } from "@platform-back/db";
import { getSecret } from "@platform-back/crypto";
import { ErrorCode, errorResponse } from "../../lib/error-response.js";
import { resolveAppFromSaEmail } from "../../lib/sa-to-app.js";
import { verifyCallerIdToken } from "../../lib/verify-id-token.js";

// /services/shopify/* — handler-facing Shopify token exchange.
//
// Called by the handler's src/lib/shopify.ts helper on cron paths (no
// inbound request, so no x-shopify-access-token header to read). Result
// is cached in the handler's memory for the container's lifetime; we're
// hit once per container boot, not once per Shopify call.
//
// Auth: same pattern as /services/email — verify the caller's Google
// OIDC ID token, resolve SA email → (tenantId, appId). Nothing from the
// request body influences tenant identity.

// ─── Plugin ─────────────────────────────────────────────────────────────────

export async function shopifyServiceRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post("/access-token", accessTokenHandler);
}

// ─── POST /services/shopify/access-token ────────────────────────────────────

async function accessTokenHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  // 1. Verify the inbound Google OIDC ID token.
  const verified = await verifyCallerIdToken(request.headers.authorization);
  if (!verified.ok) {
    const status = verified.reason === "missing_token" ? 401 : 403;
    return reply
      .code(status)
      .send(errorResponse(ErrorCode.Unauthorized, verified.reason));
  }

  // 2. Map SA email → (tenantId, appId).
  const identity = await resolveAppFromSaEmail(verified.caller.email);
  if (!identity) {
    request.log.warn(
      { saEmail: verified.caller.email },
      "/services/shopify/access-token: SA email not bound to any active app",
    );
    return reply
      .code(403)
      .send(
        errorResponse(
          ErrorCode.Forbidden,
          "Caller service account is not bound to an active app",
        ),
      );
  }

  // 3. Look up the Secret Manager reference for this tenant.
  const secretName = await getTenantAccessTokenSecretName(identity.tenantId);
  if (!secretName) {
    request.log.warn(
      { tenantId: identity.tenantId },
      "/services/shopify/access-token: tenant has no Shopify access token on file",
    );
    return reply
      .code(404)
      .send(
        errorResponse(
          ErrorCode.NotFound,
          "No Shopify access token registered for this tenant",
        ),
      );
  }

  // 4. Fetch from Secret Manager. In production this hits GCP; in local
  //    dev the crypto package reads from the LOCAL_SECRETS env (see
  //    packages/crypto/src/index.ts). Either way the token never lands
  //    in the DB in plaintext — only the secret *reference* does.
  try {
    const accessToken = await getSecret(secretName);
    return reply.code(200).send({ accessToken });
  } catch (err) {
    request.log.error(
      { err, tenantId: identity.tenantId, secretName },
      "/services/shopify/access-token: secret fetch failed",
    );
    return reply
      .code(500)
      .send(
        errorResponse(
          ErrorCode.Internal,
          "Failed to fetch access token from secret store",
        ),
      );
  }
}
