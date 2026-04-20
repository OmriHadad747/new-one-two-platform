import { ServicesClient } from "@google-cloud/run";
import { GoogleAuth } from "google-auth-library";
import { logger } from "@platform-back/logger";
import {
  cloudRunServicePath,
  GCP_PROJECT_VALUE,
} from "./service-namer.js";

// Low-level IAM operations.
//
// SA management uses the IAM REST API (https://iam.googleapis.com/v1) —
// there's no first-party @google-cloud package for SA admin. We auth
// with ADC via google-auth-library and POST raw JSON. Tiny surface, no
// extra dep weight.
//
// Cloud Run IAM bindings use the @google-cloud/run SDK (already a dep
// of cloud-run-ops.ts).

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

const runClient = new ServicesClient();

// ─── Service Account create ──────────────────────────────────────────────────

export interface CreateServiceAccountInput {
  /** SA local-part: e.g. `h-acmestore-1`. */
  accountId: string;
  /** Human-readable name shown in the GCP console. */
  displayName: string;
  /** Optional description. */
  description?: string;
}

export interface CreateServiceAccountResult {
  email: string;
  uniqueId: string;
  /** True when the SA was newly created; false when it already existed. */
  created: boolean;
}

/**
 * Idempotent: if the SA already exists, returns its details with
 * `created: false`. Re-deploys hit this path and treat existing SAs as
 * a noop.
 */
export async function createServiceAccount(
  input: CreateServiceAccountInput,
): Promise<CreateServiceAccountResult> {
  const url = `https://iam.googleapis.com/v1/projects/${GCP_PROJECT_VALUE}/serviceAccounts`;
  const client = await auth.getClient();

  try {
    const res = await client.request<{
      email: string;
      uniqueId: string;
    }>({
      url,
      method: "POST",
      data: {
        accountId: input.accountId,
        serviceAccount: {
          displayName: input.displayName,
          description: input.description,
        },
      },
    });
    logger.info(
      { accountId: input.accountId, email: res.data.email },
      "Service account created",
    );
    return { email: res.data.email, uniqueId: res.data.uniqueId, created: true };
  } catch (err: unknown) {
    // 409 ALREADY_EXISTS — fetch the existing SA and return.
    const status = (err as { code?: number; status?: number }).code ??
      (err as { code?: number; status?: number }).status;
    if (status === 409) {
      const existing = await getServiceAccount(input.accountId);
      logger.debug(
        { accountId: input.accountId, email: existing.email },
        "Service account already exists",
      );
      return { ...existing, created: false };
    }
    throw err;
  }
}

async function getServiceAccount(accountId: string): Promise<{
  email: string;
  uniqueId: string;
}> {
  const email = `${accountId}@${GCP_PROJECT_VALUE}.iam.gserviceaccount.com`;
  const url =
    `https://iam.googleapis.com/v1/projects/${GCP_PROJECT_VALUE}/serviceAccounts/${encodeURIComponent(email)}`;
  const client = await auth.getClient();
  const res = await client.request<{ email: string; uniqueId: string }>({
    url,
    method: "GET",
  });
  return { email: res.data.email, uniqueId: res.data.uniqueId };
}

export async function deleteServiceAccount(accountId: string): Promise<void> {
  const email = `${accountId}@${GCP_PROJECT_VALUE}.iam.gserviceaccount.com`;
  const url =
    `https://iam.googleapis.com/v1/projects/${GCP_PROJECT_VALUE}/serviceAccounts/${encodeURIComponent(email)}`;
  const client = await auth.getClient();
  try {
    await client.request({ url, method: "DELETE" });
    logger.info({ accountId, email }, "Service account deleted");
  } catch (err: unknown) {
    const status = (err as { code?: number; status?: number }).code ??
      (err as { code?: number; status?: number }).status;
    if (status === 404) {
      logger.info({ accountId }, "Service account already gone");
      return;
    }
    throw err;
  }
}

// ─── Cloud Run IAM binding ───────────────────────────────────────────────────

/**
 * Grants `roles/run.invoker` on a Cloud Run service to the given member
 * (typically the platform-back SA). Idempotent — if the binding already
 * exists, this is a no-op.
 *
 * `member` format: `serviceAccount:foo@bar.iam.gserviceaccount.com`,
 * `user:alice@example.com`, etc.
 */
export async function grantCloudRunInvoker(
  appId: string,
  member: string,
): Promise<void> {
  const resource = cloudRunServicePath(appId);

  const [policy] = await runClient.getIamPolicy({ resource });

  const bindings = policy.bindings ?? [];
  let invokerBinding = bindings.find((b) => b.role === "roles/run.invoker");
  if (!invokerBinding) {
    invokerBinding = { role: "roles/run.invoker", members: [] };
    bindings.push(invokerBinding);
  }
  if (invokerBinding.members?.includes(member)) {
    logger.debug(
      { appId, member },
      "roles/run.invoker already bound — skipping",
    );
    return;
  }

  invokerBinding.members = [...(invokerBinding.members ?? []), member];
  await runClient.setIamPolicy({
    resource,
    policy: { ...policy, bindings },
  });
  logger.info({ appId, member }, "Granted roles/run.invoker on Cloud Run service");
}
