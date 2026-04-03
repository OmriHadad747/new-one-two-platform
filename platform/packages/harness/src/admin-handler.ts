import { withTenantContext } from "@new-one-two/db";
import type { HandlerContext } from "@new-one-two/types";
import { loadModule } from "./module-loader.js";
import { createBaseContext } from "./context-factory.js";

const ENV_TENANT_ID = process.env["TENANT_ID"] ?? null;

export async function handleAdminInvoke(
  tenantIdFromHeader: string | undefined,
  adminPath: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  const tenantId = ENV_TENANT_ID ?? tenantIdFromHeader;

  if (!tenantId) {
    return { status: 400, data: { error: "missing_tenant_id" } };
  }

  const mod = loadModule();

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

    return { status: 200, data: result ?? {} };
  } catch (err: unknown) {
    return {
      status: 500,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
