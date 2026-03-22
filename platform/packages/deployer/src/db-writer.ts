import {
  upsertDeployedFunction,
  upsertWebhookSubscription,
  updateVersionStatus,
  withTenantContext,
} from "@new-one-two/db";
import type { DeployedFunctionRuntime, VersionStatus } from "@new-one-two/types";

export async function writeDeployedFunction(params: {
  appVersionId: string;
  appId: string;
  tenantId: string;
  functionUrl: string;
  runtime: DeployedFunctionRuntime;
  memoryMb: number;
  timeoutSec: number;
}): Promise<{ id: string }> {
  return upsertDeployedFunction(params);
}

export async function writeWebhookSubscriptions(params: {
  appId: string;
  tenantId: string;
  deployedFunctionId: string;
  topics: string[];
  callbackUrl: string;
}): Promise<void> {
  // upsertWebhookSubscription uses RLS — must run within tenant context
  await withTenantContext(params.tenantId, async (_tx) => {
    for (const topic of params.topics) {
      await upsertWebhookSubscription({
        appId: params.appId,
        tenantId: params.tenantId,
        deployedFunctionId: params.deployedFunctionId,
        topic,
        // Placeholder — will be replaced with a real Shopify webhook ID when
        // Shopify confirms subscription registration (Phase 4+)
        shopifyWebhookId: `local-${params.appId}-${topic.replace("/", "-")}`,
        callbackUrl: params.callbackUrl,
      });
    }
  });
}

export async function setVersionStatus(
  appVersionId: string,
  status: VersionStatus,
  buildLogs?: string
): Promise<void> {
  return updateVersionStatus(appVersionId, status, buildLogs);
}
