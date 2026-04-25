import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

// ─── Secret Manager ──────────────────────────────────────────────────────────
//
// Production: fetches/writes via GCP Secret Manager using ADC.
// Local dev:  set SM_DEV_SECRETS to a JSON object mapping secret resource
//             names to plaintext values, e.g.:
//   SM_DEV_SECRETS='{"projects/dev/secrets/foo/versions/latest":"s3cr3t"}'
//
// Envelope encryption / KMS is intentionally NOT ported here yet — the
// only consumer was env_vars_encrypted on deployed_functions, which the
// new architecture handles via direct env injection at Cloud Run deploy
// time. Add it back when a real consumer appears.

const DEV_SECRETS: Record<string, string> = process.env["SM_DEV_SECRETS"]
  ? (JSON.parse(process.env["SM_DEV_SECRETS"]) as Record<string, string>)
  : {};

let _secretManagerClient: SecretManagerServiceClient | null = null;
function secretManager(): SecretManagerServiceClient {
  if (!_secretManagerClient) {
    _secretManagerClient = new SecretManagerServiceClient();
  }
  return _secretManagerClient;
}

/**
 * Returns the plaintext value of a Secret Manager secret.
 * `secretName` format: `projects/{project}/secrets/{name}/versions/{version}`.
 */
export async function getSecret(secretName: string): Promise<string> {
  if (DEV_SECRETS[secretName] !== undefined) {
    return DEV_SECRETS[secretName]!;
  }
  const [version] = await secretManager().accessSecretVersion({
    name: secretName,
  });
  const data = version.payload?.data;
  if (!data) throw new Error(`Secret ${secretName} returned empty payload`);
  return Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Buffer.from(data as Uint8Array).toString("utf8");
}

/**
 * Creates the secret if missing, then writes a new version. Returns the
 * versioned resource name suitable for storing on the tenant row and
 * passing back to `getSecret`.
 *
 * `projectId` defaults to the GCP_PROJECT env var (or GOOGLE_CLOUD_PROJECT
 * as a fallback to match GCP SDK conventions).
 */
export async function storeSecret(
  secretId: string,
  value: string,
  projectId?: string,
): Promise<string> {
  const project = projectId ?? process.env["GCP_PROJECT"] ?? process.env["GOOGLE_CLOUD_PROJECT"];
  if (!project) {
    throw new Error("GCP_PROJECT (or GOOGLE_CLOUD_PROJECT) not set and no projectId provided");
  }

  const client = secretManager();
  const parent = `projects/${project}`;
  const secretName = `${parent}/secrets/${secretId}`;

  // gRPC ALREADY_EXISTS = code 6 — secret already exists, that's fine.
  try {
    await client.createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} } },
    });
  } catch (err: unknown) {
    if ((err as { code?: number }).code !== 6) throw err;
  }

  await client.addSecretVersion({
    parent: secretName,
    payload: { data: Buffer.from(value, "utf8") },
  });

  return `${secretName}/versions/latest`;
}

// ─── Shopify HMAC ────────────────────────────────────────────────────────────

/**
 * Validates a Shopify webhook HMAC. Caller fetches the plaintext secret
 * via `getSecret` first (Shopify's per-app webhook signing key is stored
 * in Secret Manager).
 */
export function validateShopifyHmac(
  rawBody: Buffer,
  hmacHeader: string | undefined,
  secret: string,
): boolean {
  if (!hmacHeader) return false;
  const computed = createHmac("sha256", secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }
  if (computed.length !== provided.length) return false;
  return timingSafeEqual(computed, provided);
}

/** SHA-256 hex hash of rawBody — used for webhook idempotency dedup. */
export function hashPayload(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}
