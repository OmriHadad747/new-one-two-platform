import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// Shopify admin iframes load from admin.shopify.com and *.myshopify.com.
// The browser sends an OPTIONS preflight before any cross-origin POST that
// carries an Authorization header — we need to answer it explicitly with
// the matched origin (never `*`, since `credentials: true` makes that
// invalid).

const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^https:\/\/admin\.shopify\.com$/,
  /^https:\/\/[a-z0-9-]+\.myshopify\.com$/,
];

function originAllowed(origin: string, extraExact: string[]): boolean {
  if (extraExact.includes(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function installCors(app: FastifyInstance, opts: { extraAllowedOrigins: string[] }): void {
  const extra = opts.extraAllowedOrigins;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin.length === 0) return;
    if (!originAllowed(origin, extra)) return;

    void reply.header("Access-Control-Allow-Origin", origin);
    void reply.header("Vary", "Origin");
    void reply.header("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      const reqHeaders =
        req.headers["access-control-request-headers"] ?? "authorization,content-type";
      void reply
        .header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        .header("Access-Control-Allow-Headers", reqHeaders)
        .header("Access-Control-Max-Age", "600")
        .code(204)
        .send();
    }
  });
}
