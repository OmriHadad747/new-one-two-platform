import type { Logger } from "@platform-back/logger";
import { getHandlerAuthHeader } from "./id-token.js";

// Bytes the merchant browser sent us are forwarded verbatim to the handler;
// we never re-serialize. Re-encoding JSON would lose key order and silently
// "normalize" payloads in ways the handler might not expect — and the new
// architecture treats handlers as black boxes that own their own request
// shape.

export interface ForwardContext {
  /** Verified by the edge. Forwarded as `X-Tenant-Id`. */
  tenantId: string;
  /** From the Shopify session-token `dest` claim. Forwarded as `X-Shop-Domain`. */
  shopDomain: string;
  /** From the URL. Forwarded as `X-App-Id`. */
  appId: string;
  /** Set on the inbound request by Fastify. Propagated as `X-Request-Id`. */
  requestId: string;
}

export interface ForwardInput {
  targetUrl: string;
  method: string;
  body: Buffer | undefined;
  contentType: string | undefined;
  ctx: ForwardContext;
  log: Logger;
  /** Total budget for the upstream call (default 25s — under Cloud Run's 30s). */
  timeoutMs?: number;
  /**
   * Extra headers to forward to the handler on top of the standard set.
   * Used by widget edge to pass X-Customer-Id. Cannot override core
   * context headers or Authorization — those are set after this merge.
   */
  extraHeaders?: Record<string, string>;
}

export interface ForwardResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

export class ForwardError extends Error {
  public readonly kind: "timeout" | "fetch" | "auth";

  constructor(
    kind: "timeout" | "fetch" | "auth",
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ForwardError";
    this.kind = kind;
  }
}

const DEFAULT_TIMEOUT_MS = 25_000;

export async function forwardToHandler(
  input: ForwardInput,
): Promise<ForwardResult> {
  const { targetUrl, method, body, contentType, ctx, log } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Mint Cloud Run ID token (or skip in local dev). Auth failures are
  // surfaced to callers as a distinct kind so the route can map them to a
  // 502/503 with an actionable message instead of an opaque 500.
  let authHeader: string | null;
  try {
    authHeader = await getHandlerAuthHeader(targetUrl);
  } catch (err) {
    log.error({ err, targetUrl }, "Failed to mint Cloud Run ID token");
    throw new ForwardError(
      "auth",
      "Could not obtain Cloud Run ID token for handler",
      err,
    );
  }

  const headers: Record<string, string> = { ...(input.extraHeaders ?? {}) };
  // Core context headers are set AFTER the extraHeaders merge so callers
  // can't accidentally (or maliciously) override them via extraHeaders.
  headers["X-Tenant-Id"] = ctx.tenantId;
  headers["X-Shop-Domain"] = ctx.shopDomain;
  headers["X-App-Id"] = ctx.appId;
  headers["X-Request-Id"] = ctx.requestId;
  if (contentType) headers["Content-Type"] = contentType;
  if (authHeader) headers["Authorization"] = authHeader;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res: Response;
  try {
    const init: RequestInit = { method, headers, signal: ac.signal };
    if (body !== undefined) init.body = body;
    res = await fetch(targetUrl, init);
  } catch (err) {
    if (ac.signal.aborted) {
      throw new ForwardError(
        "timeout",
        `Handler did not respond within ${timeoutMs}ms`,
        err,
      );
    }
    throw new ForwardError("fetch", "Handler fetch failed", err);
  } finally {
    clearTimeout(timer);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: buf };
}
