import { getAppVersionWithCode } from "@new-one-two/db";
import type { App, AppVersion, Tenant } from "@new-one-two/types";

export async function fetchDeploymentContext(appVersionId: string): Promise<{
  version: AppVersion;
  app: App;
  tenant: Pick<Tenant, "id" | "slug" | "kmsKeyName" | "shopifyAccessTokenSecretName" | "storefrontAccessTokenSecretName">;
}> {
  const result = await getAppVersionWithCode(appVersionId);
  if (!result) {
    throw new Error(`AppVersion not found: ${appVersionId}`);
  }
  if (result.version.status === "ready" || result.version.status === "building") {
    throw new Error(
      `AppVersion ${appVersionId} is in status '${result.version.status}' — cannot deploy`
    );
  }
  return result;
}

export function parseMetadata(generatedCode: Record<string, string>): {
  webhookTopics: string[];
} {
  const raw = generatedCode["_metadata.json"];
  if (!raw) {
    // Default: no webhook topics (deployer will still create the function, just no subscriptions)
    return { webhookTopics: [] };
  }
  try {
    const meta = JSON.parse(raw) as { webhookTopics?: string[] };
    return { webhookTopics: meta.webhookTopics ?? [] };
  } catch {
    throw new Error("generatedCode['_metadata.json'] is not valid JSON");
  }
}
