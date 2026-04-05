import { withTenantContext, createWidgetInvocationLog, updateWidgetInvocationLog } from "@new-one-two/db";
import type { HandlerContext } from "@new-one-two/types";
import { loadModule, createBaseContext } from "@new-one-two/harness";

const ENV_TENANT_ID = process.env["TENANT_ID"] ?? null;
const ENV_APP_ID = process.env["APP_ID"] ?? null;

export async function handleWidgetInvoke(
  tenantIdFromHeader: string | undefined,
  widgetPath: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  const tenantId = ENV_TENANT_ID ?? tenantIdFromHeader;

  if (!tenantId) {
    return { status: 400, data: { error: "missing_tenant_id" } };
  }

  const appId = ENV_APP_ID;
  const mod = loadModule();
  const t0 = performance.now();

  // Create log entry before invocation (best-effort — never fail the request)
  let logId: string | null = null;
  if (appId) {
    logId = await createWidgetInvocationLog({ appId, tenantId, path: widgetPath }).catch(() => null);
  }

  let result: unknown;

  try {
    await withTenantContext(tenantId, async (tx) => {
      const baseCtx = await createBaseContext({
        tenantId,
        tx,
        loggerTopic: `widget:${widgetPath}`,
      });

      const ctx: HandlerContext = {
        ...baseCtx,
        payload: {},
        trigger: "widget",
        widgetPath,
        widgetBody: body,
        customerId: (body.customerId as string | null) ?? null,
      };

      result = await mod.handler(ctx);
    });

    const durationMs = Math.round(performance.now() - t0);
    if (logId) await updateWidgetInvocationLog(logId, { status: "success", durationMs }).catch(() => null);

    return { status: 200, data: result ?? {} };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - t0);
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (logId) await updateWidgetInvocationLog(logId, { status: "failed", durationMs, errorMessage }).catch(() => null);

    return { status: 500, data: { error: errorMessage } };
  }
}
