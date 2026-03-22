/**
 * Deploys an App Block (Theme App Extension) to Shopify via the Partners API.
 *
 * Auth: Shopify Partners API token (stored in GCP Secret Manager).
 * Required env vars:
 *   SHOPIFY_PARTNERS_SECRET_NAME — Secret Manager resource name for the Partners API token
 *   SHOPIFY_PARTNER_ORG_ID      — Shopify partner organization ID (numeric string)
 *
 * The Partners API endpoint: POST https://partners.shopify.com/{org_id}/api/2026-01/graphql.json
 * Header: X-Shopify-Access-Token: <partners-api-token>
 *
 * Zip structure expected by Shopify extensionCreate:
 *   blocks/feature.liquid
 *   assets/feature.js
 *   config/settings_schema.json
 *   shopify.extension.toml
 */
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { logger } from "@new-one-two/logger";
import type { AppBlock } from "@new-one-two/types";
import archiver from "archiver";

function getPartnersApiUrl(): string {
  const orgId = process.env["SHOPIFY_PARTNER_ORG_ID"];
  if (!orgId) {
    throw new Error("SHOPIFY_PARTNER_ORG_ID must be set for App Block deployment");
  }
  return `https://partners.shopify.com/${orgId}/api/2026-01/graphql.json`;
}

// ─── Secret Manager ───────────────────────────────────────────────────────────

let _secretClient: SecretManagerServiceClient | null = null;

function getSecretClient(): SecretManagerServiceClient {
  if (!_secretClient) {
    _secretClient = new SecretManagerServiceClient();
  }
  return _secretClient;
}

async function getPartnersToken(): Promise<string> {
  // Dev mode: accept raw token via env var
  if (process.env["SHOPIFY_PARTNERS_TOKEN"]) {
    return process.env["SHOPIFY_PARTNERS_TOKEN"];
  }

  const secretName = process.env["SHOPIFY_PARTNERS_SECRET_NAME"];
  if (!secretName) {
    throw new Error(
      "SHOPIFY_PARTNERS_SECRET_NAME or SHOPIFY_PARTNERS_TOKEN must be set for App Block deployment"
    );
  }

  const client = getSecretClient();
  const [version] = await client.accessSecretVersion({ name: secretName });
  const token = version.payload?.data?.toString();
  if (!token) {
    throw new Error(`Secret ${secretName} is empty`);
  }
  return token;
}

// ─── Zip builder ─────────────────────────────────────────────────────────────

function buildExtensionToml(appId: string): string {
  return `[[extensions]]
type = "theme"
name = "AI Generated Feature"
handle = "ai-feature-${appId}"

[[extensions.blocks]]
name = "Feature Block"
target = "section"
`;
}

async function buildExtensionZip(
  appId: string,
  appBlock: AppBlock
): Promise<string> {
  const dir = join(tmpdir(), `ext-${appId}-${Date.now()}`);
  mkdirSync(join(dir, "blocks"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });

  writeFileSync(join(dir, "blocks", "feature.liquid"), appBlock.liquid);
  writeFileSync(join(dir, "assets", "feature.js"), appBlock.javascript);
  writeFileSync(
    join(dir, "config", "settings_schema.json"),
    JSON.stringify(appBlock.schema, null, 2)
  );
  writeFileSync(join(dir, "shopify.extension.toml"), buildExtensionToml(appId));

  const zipPath = join(tmpdir(), `ext-${appId}-${Date.now()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(dir, false);
    void archive.finalize();
  });

  return zipPath;
}

// ─── Partners API GraphQL ─────────────────────────────────────────────────────

const EXTENSION_CREATE_MUTATION = `
  mutation extensionCreate($input: ExtensionCreateInput!) {
    extensionCreate(input: $input) {
      extension {
        id
        latestVersion {
          status
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const EXTENSION_UPDATE_MUTATION = `
  mutation extensionUpdate($id: ID!, $input: ExtensionUpdateInput!) {
    extensionUpdate(id: $id, input: $input) {
      extension {
        id
        latestVersion {
          status
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function partnersGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(getPartnersApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `Partners API HTTP error ${response.status}: ${await response.text()}`
    );
  }

  const body = (await response.json()) as {
    data: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(
      `Partners API GraphQL errors: ${body.errors.map((e) => e.message).join(", ")}`
    );
  }

  return body.data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface AppBlockDeployResult {
  extensionId: string;
  extensionStatus: string;
}

/**
 * Deploys or updates the App Block for a given Shopify app.
 *
 * If SHOPIFY_PARTNERS_SECRET_NAME is not set (local dev), logs a warning and
 * returns a stub extensionId so the rest of the pipeline can continue.
 *
 * @param shopifyApiKey - The Shopify app's API key (from apps.shopify_api_key)
 * @param appId         - Internal app UUID (used to derive the extension handle)
 * @param appBlock      - The generated App Block artifacts
 * @param existingExtensionId - If provided, updates instead of creating
 */
export async function deployAppBlock(
  shopifyApiKey: string,
  appId: string,
  appBlock: AppBlock,
  existingExtensionId?: string
): Promise<AppBlockDeployResult> {
  const partnersSecretName = process.env["SHOPIFY_PARTNERS_SECRET_NAME"];
  const partnersToken = process.env["SHOPIFY_PARTNERS_TOKEN"];

  if (!partnersSecretName && !partnersToken) {
    logger.warn(
      { appId },
      "SHOPIFY_PARTNERS_SECRET_NAME not set — App Block deployment skipped (dev/stub mode). " +
        "Set SHOPIFY_PARTNERS_SECRET_NAME or SHOPIFY_PARTNERS_TOKEN to deploy to Shopify."
    );
    return { extensionId: `stub-${appId}`, extensionStatus: "stub" };
  }

  const token = await getPartnersToken();
  const zipPath = await buildExtensionZip(appId, appBlock);
  const zipData = await import("node:fs/promises").then((fs) =>
    fs.readFile(zipPath)
  );
  const contextBase64 = zipData.toString("base64");

  logger.info({ appId, shopifyApiKey, existingExtensionId }, "Deploying App Block to Shopify");

  if (existingExtensionId) {
    // Update existing extension
    const data = await partnersGraphql(token, EXTENSION_UPDATE_MUTATION, {
      id: existingExtensionId,
      input: { context: contextBase64 },
    });

    const result = (
      data["extensionUpdate"] as {
        extension: { id: string; latestVersion: { status: string } };
        userErrors: Array<{ field: string; message: string }>;
      }
    );

    if (result.userErrors.length > 0) {
      throw new Error(
        `Partners API extensionUpdate errors: ${JSON.stringify(result.userErrors)}`
      );
    }

    return {
      extensionId: result.extension.id,
      extensionStatus: result.extension.latestVersion.status,
    };
  }

  // Create new extension
  const data = await partnersGraphql(token, EXTENSION_CREATE_MUTATION, {
    input: {
      apiKey: shopifyApiKey,
      type: "THEME_APP_EXTENSION",
      title: "AI Generated Feature",
      context: contextBase64,
    },
  });

  const result = (
    data["extensionCreate"] as {
      extension: { id: string; latestVersion: { status: string } };
      userErrors: Array<{ field: string; message: string }>;
    }
  );

  if (result.userErrors.length > 0) {
    throw new Error(
      `Partners API extensionCreate errors: ${JSON.stringify(result.userErrors)}`
    );
  }

  logger.info(
    { appId, extensionId: result.extension.id },
    "App Block deployed to Shopify"
  );

  return {
    extensionId: result.extension.id,
    extensionStatus: result.extension.latestVersion.status,
  };
}
