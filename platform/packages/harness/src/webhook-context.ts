import { withTenantContext } from "@new-one-two/db";
import type {
  HandlerContext,
  HarnessInvokeRequest,
} from "@new-one-two/types";
import { createBaseContext } from "./context-factory.js";

export async function createWebhookContext(
  req: HarnessInvokeRequest,
  // tx is injected by webhook-handler inside the withTenantContext callback
  tx: unknown
): Promise<HandlerContext> {
  const payload = JSON.parse(
    Buffer.from(req.rawBodyBase64, "base64").toString("utf8")
  ) as Record<string, unknown>;

  const baseCtx = await createBaseContext({
    tenantId: req.tenantId,
    tx,
    loggerTopic: req.topic,
    appId: req.appId,
    executionLogId: req.executionLogId,
  });

  return {
    ...baseCtx,
    payload,
    trigger: "webhook" as const,
  };
}

// Re-export withTenantContext so webhook-handler can use it without extra imports
export { withTenantContext };
