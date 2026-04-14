import { getAppVersionWithCode } from "@new-one-two/db";
import type { App, AppVersion, Tenant } from "@new-one-two/types";
import { validateNpmPackages } from "./npm-allowlist.js";

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
  npmPackages: string[];
} {
  const raw = generatedCode["_metadata.json"];
  if (!raw) {
    return { webhookTopics: [], npmPackages: [] };
  }
  let meta: { webhookTopics?: unknown; npmPackages?: unknown };
  try {
    meta = JSON.parse(raw) as typeof meta;
  } catch {
    throw new Error("generatedCode['_metadata.json'] is not valid JSON");
  }

  const webhookTopicsRaw = meta.webhookTopics ?? [];
  if (!Array.isArray(webhookTopicsRaw) || !webhookTopicsRaw.every((t) => typeof t === "string")) {
    throw new Error("generatedCode['_metadata.json'].webhookTopics must be a string[]");
  }

  const npmPackagesRaw = meta.npmPackages ?? [];
  if (!Array.isArray(npmPackagesRaw)) {
    throw new Error("generatedCode['_metadata.json'].npmPackages must be an array");
  }

  // Allowlist + pinned-semver enforcement at the deployer boundary. This is
  // the security gate between LLM output and `npm install` in our build
  // context — see packages/deployer/src/npm-allowlist.ts for the rules.
  const validation = validateNpmPackages(npmPackagesRaw);
  if (!validation.ok) {
    throw new Error(
      "generatedCode['_metadata.json'].npmPackages failed validation:\n  - " +
        validation.errors.join("\n  - ")
    );
  }

  return {
    webhookTopics: webhookTopicsRaw,
    npmPackages: npmPackagesRaw as string[],
  };
}
