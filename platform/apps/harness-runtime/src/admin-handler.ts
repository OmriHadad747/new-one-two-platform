import { withTenantContext, createAdminInvocationLog, updateAdminInvocationLog } from "@new-one-two/db";
import type { HandlerContext } from "@new-one-two/types";
import { loadModule, createBaseContext } from "@new-one-two/harness";

const ENV_TENANT_ID = process.env["TENANT_ID"] ?? null;
const ENV_APP_ID = process.env["APP_ID"] ?? null;

export async function handleAdminInvoke(
  tenantIdFromHeader: string | undefined,
  adminPath: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  const tenantId = ENV_TENANT_ID ?? tenantIdFromHeader;

  if (!tenantId) {
    return { status: 400, data: { error: "missing_tenant_id" } };
  }

  const appId = ENV_APP_ID;
  const mod = loadModule();
  const t0 = performance.now();

  let logId: string | null = null;
  if (appId) {
    logId = await createAdminInvocationLog({ appId, tenantId, path: adminPath }).catch(() => null);
  }

  let result: unknown;

  try {
    await withTenantContext(tenantId, async (tx) => {
      const baseCtx = await createBaseContext({
        tenantId,
        tx,
        loggerTopic: `admin:${adminPath}`,
      });

      const ctx: HandlerContext = {
        ...baseCtx,
        payload: body,
        trigger: "admin",
        adminPath,
        adminBody: body,
      };

      result = await mod.handler(ctx);
    });

    const durationMs = Math.round(performance.now() - t0);
    if (logId) await updateAdminInvocationLog(logId, { status: "success", durationMs }).catch(() => null);

    return { status: 200, data: result ?? {} };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - t0);
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (logId) await updateAdminInvocationLog(logId, { status: "failed", durationMs, errorMessage }).catch(() => null);

    return { status: 500, data: { error: errorMessage } };
  }
}
