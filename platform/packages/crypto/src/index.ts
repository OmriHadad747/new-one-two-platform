import { KeyManagementServiceClient } from "@google-cloud/kms";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "crypto";

// ─── Secret Manager ────────────────────────────────────────────────────────────
// Stores Shopify webhook signing secrets (and future per-app credentials).
//
// In production: fetches from GCP Secret Manager via ADC.
// In local dev:  set SM_DEV_SECRETS to a JSON object mapping secret resource
//                names to their plaintext values, e.g.:
//                  SM_DEV_SECRETS='{"projects/dev/secrets/foo/versions/latest":"s3cr3t"}'

const DEV_SECRETS: Record<string, string> = process.env["SM_DEV_SECRETS"]
  ? (JSON.parse(process.env["SM_DEV_SECRETS"]) as Record<string, string>)
  : {};

let _secretManagerClient: SecretManagerServiceClient | null = null;
function secretManager(): SecretManagerServiceClient {
  if (!_secretManagerClient) _secretManagerClient = new SecretManagerServiceClient();
  return _secretManagerClient;
}

/**
 * Fetch the plaintext value of a GCP Secret Manager secret.
 * secretName format: "projects/{project}/secrets/{name}/versions/{version}"
 */
export async function getSecret(secretName: string): Promise<string> {
  if (DEV_SECRETS[secretName] !== undefined) {
    return DEV_SECRETS[secretName]!;
  }
  const [version] = await secretManager().accessSecretVersion({ name: secretName });
  const data = version.payload?.data;
  if (!data) throw new Error(`Secret ${secretName} returned empty payload`);
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as Uint8Array).toString("utf8");
}

// ─── KMS Client ────────────────────────────────────────────────────────────────
// In production: uses Application Default Credentials (ADC) automatically.
// In local dev:  set KMS_DEV_KEY to a base64-encoded 32-byte key to bypass GCP
//                KMS entirely — no emulator or GCP project required.

const DEV_KEY = process.env["KMS_DEV_KEY"]
  ? Buffer.from(process.env["KMS_DEV_KEY"], "base64")
  : null;

const kmsClient = DEV_KEY ? null : new KeyManagementServiceClient();

// ─── Envelope Encryption ───────────────────────────────────────────────────────
// Pattern:
//   1. Generate a random 256-bit Data Encryption Key (DEK)
//   2. Encrypt the DEK with Cloud KMS (or local dev key)
//   3. Encrypt the plaintext locally with the DEK using AES-256-GCM
//   4. Store { kmsKeyName, encryptedDek, iv, authTag, ciphertext }
//
// This keeps plaintext data off KMS (avoiding the 64KB limit) and minimises
// KMS API calls to 1 per encrypt + 1 per decrypt.

interface EnvelopeCiphertext {
  v: 1;
  kmsKeyName: string;   // GCP resource name — or "dev" when using DEV_KEY
  encryptedDek: string; // base64 — KMS-encrypted DEK
  iv: string;           // base64 — 12-byte GCM IV
  authTag: string;      // base64 — 16-byte GCM auth tag
  ciphertext: string;   // base64 — AES-256-GCM encrypted payload
}

/**
 * Encrypt a plaintext string with envelope encryption under the given KMS key.
 * kmsKeyName format: "projects/P/locations/L/keyRings/R/cryptoKeys/K"
 * Returns a Buffer suitable for storing in a BYTEA column.
 */
export async function encryptSecret(
  plaintext: string,
  kmsKeyName: string
): Promise<Buffer> {
  const dek = randomBytes(32);

  // Encrypt DEK with KMS (or local dev key)
  let encryptedDek: Buffer;
  if (DEV_KEY) {
    encryptedDek = encryptWithDevKey(dek);
  } else {
    const [result] = await kmsClient!.encrypt({
      name: kmsKeyName,
      plaintext: dek,
    });
    encryptedDek = Buffer.from(result.ciphertext as Uint8Array);
  }

  // Encrypt plaintext with DEK
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  dek.fill(0);

  const envelope: EnvelopeCiphertext = {
    v: 1,
    kmsKeyName: DEV_KEY ? "dev" : kmsKeyName,
    encryptedDek: encryptedDek.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };

  return Buffer.from(JSON.stringify(envelope), "utf8");
}

/**
 * Decrypt an envelope-encrypted secret. Accepts the Buffer stored in the DB.
 */
export async function decryptSecret(ciphertextBuf: Buffer): Promise<string> {
  const envelope = JSON.parse(
    ciphertextBuf.toString("utf8")
  ) as EnvelopeCiphertext;

  if (envelope.v !== 1) {
    throw new Error(`Unknown envelope version: ${envelope.v}`);
  }

  const encryptedDek = Buffer.from(envelope.encryptedDek, "base64");

  // Decrypt DEK
  let dek: Buffer;
  if (DEV_KEY || envelope.kmsKeyName === "dev") {
    if (!DEV_KEY) throw new Error("KMS_DEV_KEY not set but envelope was encrypted with dev key");
    dek = decryptWithDevKey(encryptedDek);
  } else {
    const [result] = await kmsClient!.decrypt({
      name: envelope.kmsKeyName,
      ciphertext: encryptedDek,
    });
    dek = Buffer.from(result.plaintext as Uint8Array);
  }

  // Decrypt payload
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dek,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));

  const plaintext =
    decipher.update(
      Buffer.from(envelope.ciphertext, "base64"),
      undefined,
      "utf8"
    ) + decipher.final("utf8");

  dek.fill(0);
  return plaintext;
}

// ─── Dev Key Helpers ───────────────────────────────────────────────────────────
// Encrypt/decrypt the DEK with the local dev key (AES-256-GCM).
// Format: [ 12-byte IV | 16-byte auth tag | ciphertext ]

function encryptWithDevKey(dek: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", DEV_KEY!, iv);
  const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function decryptWithDevKey(data: Buffer): Buffer {
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", DEV_KEY!, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// ─── Secret Manager Write ──────────────────────────────────────────────────────

/**
 * Creates or updates a GCP Secret Manager secret and adds a new version.
 * Creates the secret if it doesn't already exist.
 * Returns the full resource name pointing to the latest version:
 *   "projects/{project}/secrets/{secretId}/versions/latest"
 *
 * projectId defaults to GCP_PROJECT_ID env var.
 */
export async function storeSecret(
  secretId: string,
  value: string,
  projectId?: string
): Promise<string> {
  const project = projectId ?? process.env["GCP_PROJECT_ID"];
  if (!project) throw new Error("GCP_PROJECT_ID not set and no projectId provided");

  const client = secretManager();
  const parent = `projects/${project}`;
  const secretName = `${parent}/secrets/${secretId}`;

  // Create the secret if it doesn't exist
  try {
    await client.createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} } },
    });
  } catch (err: unknown) {
    // gRPC ALREADY_EXISTS = code 6
    if ((err as { code?: number }).code !== 6) throw err;
  }

  // Add a new version with the plaintext value
  await client.addSecretVersion({
    parent: secretName,
    payload: { data: Buffer.from(value, "utf8") },
  });

  return `${secretName}/versions/latest`;
}

// ─── HMAC Helpers ─────────────────────────────────────────────────────────────

/**
 * Validate Shopify's HMAC-SHA256 webhook signature.
 * Caller is responsible for fetching the plaintext secret from Secret Manager
 * via getSecret() before calling this function.
 */
export function validateShopifyHmac(
  rawBody: Buffer,
  hmacHeader: string,
  secret: string
): boolean {
  // Compute the expected HMAC as raw bytes
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  // Decode the base64 header to raw bytes for comparison
  const actual = Buffer.from(hmacHeader, "base64");

  if (expected.length !== actual.length) return false;

  // Constant-time comparison to prevent timing attacks
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected[i]! ^ actual[i]!;
  }
  return diff === 0;
}

/**
 * Compute SHA-256 hash of the raw body for idempotency / dedup logging.
 */
export function hashPayload(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}
