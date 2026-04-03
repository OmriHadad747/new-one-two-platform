import { withTenantContext } from "@new-one-two/db";
import type { HandlerContext } from "@new-one-two/types";
import { loadModule, createBaseContext } from "@new-one-two/harness";

// The deployer injects TENANT_ID as an env var into every harness container.
// The X-Tenant-Id header is a fallback for local development.
const ENV_TENANT_ID = process.env["TENANT_ID"] ?? null;

export async function handleWidgetInvoke(
  tenantIdFromHeader: string | undefined,
  widgetPath: string,
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

    return { status: 200, data: result ?? {} };
  } catch (err: unknown) {
    return {
      status: 500,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
