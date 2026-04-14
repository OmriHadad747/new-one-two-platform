/**
 * Explicit CORS middleware for the platform API.
 *
 * Replaces @fastify/cors because v9 of that plugin exposes no way to make
 * the origin policy aware of the request path — and we need exactly that.
 * The widget proxy endpoints under `/widgets/` are called from merchant
 * storefronts on arbitrary custom domains (`shop.mybrand.com`, etc.) which
 * can't be enumerated up front; every other route must be locked to an
 * explicit allowlist.
 *
 * Policy:
 *   - `/widgets/*`            → reflect any `Origin`, no credentials.
 *     (Storefronts use `credentials: "omit"` in widget-runtime.js; handlers
 *     identify the caller by path params + a server-to-server proxy fetch,
 *     not by cookies.)
 *   - Every other route       → reflect `Origin` only if it matches an
 *     entry in ALLOWED_ORIGINS. Credentials allowed. Origins not on the
 *     list get NO `Access-Control-Allow-Origin` header, so the browser
 *     rejects the response (same effect as @fastify/cors with a strict
 *     list, no 403 body from the server).
 *
 * Startup contract:
 *   - If NODE_ENV=production AND ALLOWED_ORIGINS is empty, the server
 *     refuses to start. The previous `@fastify/cors` config fell through
 *     to `origin: true` (wide open) in that case — a latent footgun.
 *
 * Security-sensitive follow-up tracked in docs/TECH_DEBT.md (TD-013):
 *   verify at the route layer that the storefront origin is actually owned
 *   by the shop in the URL, so that a malicious page on `evil.com` can't
 *   make the widget proxy call its own-app-ID widget handler. Today the
 *   handler endpoint is safe to expose to arbitrary origins because it
 *   receives no credentials and the data surface is app-specific, but as
 *   handlers grow that assumption may not hold.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const WIDGET_PREFIX = "/widgets/";

/** Explicit methods / headers the browser may request. */
const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Content-Type, Authorization, X-Request-Id";
const PREFLIGHT_MAX_AGE_SECONDS = 600;

export interface CorsOptions {
  allowedOrigins: readonly string[];
}

/**
 * Matches a single allowlist pattern against an incoming Origin header.
 *
 * Exact match:     `https://admin.shopify.com` matches `https://admin.shopify.com`.
 * Wildcard:        `https://*.myshopify.com` matches `https://acme.myshopify.com`
 *                  and `https://one.two.myshopify.com`, but NOT
 *                  `https://myshopify.com` (no subdomain) or
 *                  `https://evil.com/myshopify.com` (suffix trick).
 */
export function matchOrigin(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;

  // Wildcard form: https://*.<suffix>  or  http://*.<suffix>
  const wildcard = /^(https?:\/\/)\*\.(.+)$/.exec(pattern);
  if (!wildcard) return false;
  const [, scheme, suffix] = wildcard;
  if (scheme === undefined || suffix === undefined) return false;

  if (!origin.startsWith(scheme)) return false;

  // Strip the scheme from origin to compare host portions only.
  const host = origin.slice(scheme.length);
  // Must be a subdomain: require a literal `.` immediately before the suffix.
  return host.length > suffix.length + 1 && host.endsWith(`.${suffix}`);
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function assertProductionCorsConfig(
  nodeEnv: string | undefined,
  allowedOrigins: readonly string[]
): void {
  if (nodeEnv === "production" && allowedOrigins.length === 0) {
    throw new Error(
      "ALLOWED_ORIGINS must be set to a non-empty list in production " +
        "(comma-separated, e.g. `https://admin.shopify.com,https://*.myshopify.com`). " +
        "Refusing to start with wide-open CORS."
    );
  }
}

/**
 * Installs the CORS middleware as an `onRequest` hook. Must run before
 * route handlers and before any authentication hook (preflight OPTIONS
 * requests are typically unauthenticated and need to be answered without
 * a token).
 */
export function installCors(app: FastifyInstance, opts: CorsOptions): void {
  const { allowedOrigins } = opts;

  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done) => {
    const origin = req.headers.origin;
    // Non-browser clients (curl, server-to-server, same-origin fetches)
    // don't send Origin — nothing to do.
    if (!origin) {
      return done();
    }

    const isWidgetPath = req.url.startsWith(WIDGET_PREFIX);
    let allowed = false;

    if (isWidgetPath) {
      // Reflect any origin for the widget proxy. Storefronts on custom
      // domains need to work; credentials stay off so reflection is safe.
      allowed = true;
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      // No Access-Control-Allow-Credentials — storefront fetches use
      // credentials: "omit" and sending `true` with a reflected origin
      // would expand the trust boundary unnecessarily.
    } else if (allowedOrigins.some((pattern) => matchOrigin(pattern, origin))) {
      allowed = true;
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Credentials", "true");
    }

    // Preflight: reply immediately with the negotiated headers.
    if (req.method === "OPTIONS") {
      if (!allowed) {
        // No matching allowlist entry — respond 204 without CORS headers
        // and the browser will block the real request. Matches
        // @fastify/cors behaviour.
        void reply.code(204).send();
        return;
      }
      const requestedHeaders =
        (req.headers["access-control-request-headers"] as string | undefined) ??
        DEFAULT_ALLOWED_HEADERS;
      void reply
        .code(204)
        .header("Access-Control-Allow-Methods", ALLOWED_METHODS)
        .header("Access-Control-Allow-Headers", requestedHeaders)
        .header("Access-Control-Max-Age", String(PREFLIGHT_MAX_AGE_SECONDS))
        .send();
      return;
    }

    // For non-preflight, keep processing the request. If the origin wasn't
    // on the allowlist, no CORS headers are set and the browser will
    // reject the response after it arrives.
    done();
  });
}
