import type { HarnessInvokeRequest, HarnessInvokeResponse } from "@new-one-two/types";
import { buildCtx, withTenantContext } from "./build-ctx.js";
import { loadModule } from "./module-loader.js";
import { withTimeout, HandlerTimeoutError } from "./timeout.js";

// Must be shorter than the Cloud Run request timeout (configured at 30s)
const HANDLER_TIMEOUT_MS = parseInt(process.env["HANDLER_TIMEOUT_MS"] ?? "25000", 10);

export async function handleInvoke(req: HarnessInvokeRequest): Promise<HarnessInvokeResponse> {
  const mod = loadModule();

  const t0 = performance.now();

  try {
    let shopifyCallCount = 0;

    await withTenantContext(req.tenantId, async (tx) => {
      const ctx = await buildCtx(req, tx);
      await withTimeout(mod.handler(ctx), HANDLER_TIMEOUT_MS);
      // Extract call count from the shopify client after handler completes
      shopifyCallCount = (ctx.shopify as unknown as { callCount: number }).callCount ?? 0;
    });

    const durationMs = Math.round(performance.now() - t0);
    return { status: "success", durationMs, shopifyApiCalls: shopifyCallCount };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - t0);

    if (err instanceof HandlerTimeoutError) {
      return {
        status: "timeout",
        durationMs,
        shopifyApiCalls: 0,
        error: err.message,
      };
    }

    return {
      status: "failed",
      durationMs,
      shopifyApiCalls: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
