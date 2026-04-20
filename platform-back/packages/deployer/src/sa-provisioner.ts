import { sql } from "@platform-back/db";
import { logger } from "@platform-back/logger";
import { createServiceAccount, grantCloudRunInvoker } from "./iam-ops.js";
import {
  handlerSaEmail,
  handlerSaLocalPart,
  GCP_PROJECT_VALUE,
} from "./service-namer.js";
import { writeHandlerSaEmail } from "./db-writer.js";

// High-level SA provisioning. Two entry points, both idempotent:
//
//   1. provisionHandlerSa  — pre-deploy. Picks the next per-shop counter,
//      creates (or finds) the SA in GCP, writes apps.handler_sa_email.
//      Must complete BEFORE cloud-run-ops deploys (Cloud Run needs the
//      SA to exist to bind it as the service identity).
//
//   2. grantPlatformBackInvokerOnHandler — post-deploy. Adds platform-back's
//      own SA to the Cloud Run service's roles/run.invoker binding so
//      `/admin/*` and `/webhook/*` proxy calls can authenticate.

const DEPLOY_MODE = process.env["DEPLOY_MODE"] ?? "cloudrun";

/**
 * Counts existing handler SAs for the given shop and returns the next
 * 1-based counter. Two apps belonging to the same shop get distinct
 * names: `h-acme-1`, `h-acme-2`, …
 *
 * The DB index on apps.handler_sa_email makes this O(log n) lookup +
 * filter; the count is bounded by app count per shop (small).
 */
export async function nextHandlerSaCounter(
  shopDomain: string,
): Promise<number> {
  // Match on the SA local-part prefix so we count by the canonical shop
  // segment, not by arbitrary substring.
  const prefix = handlerSaLocalPart(shopDomain, 1).replace(/-1$/, "-");
  const escaped = prefix.replace(/_/g, "\\_").replace(/%/g, "\\%");
  const pattern = `${escaped}%`;

  const rows = await sql<Array<{ handlerSaEmail: string }>>`
    SELECT handler_sa_email AS "handlerSaEmail"
      FROM apps
     WHERE handler_sa_email LIKE ${pattern}
  `;

  let max = 0;
  for (const row of rows) {
    const localPart = row.handlerSaEmail.split("@")[0];
    if (!localPart) continue;
    const tail = localPart.slice(prefix.length);
    const n = Number.parseInt(tail, 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

export interface ProvisionHandlerSaInput {
  shopDomain: string;
  appId: string;
  appName: string;
  /** When provided, reuses the existing email instead of allocating a new counter. */
  existingEmail?: string | null;
}

export interface ProvisionHandlerSaResult {
  email: string;
  /** New (created) vs reused (already on the apps row or already existed in GCP). */
  created: boolean;
}

/**
 * Provisions the SA + writes `apps.handler_sa_email`. Idempotent:
 *   - If `existingEmail` is set, no GCP call, just confirms it's stored.
 *   - If GCP returns 409 ALREADY_EXISTS, treats it as success.
 *   - Re-deploys of the same app reuse the same SA — no orphaned
 *     identities accumulating per-redeploy.
 */
export async function provisionHandlerSa(
  input: ProvisionHandlerSaInput,
): Promise<ProvisionHandlerSaResult> {
  if (input.existingEmail) {
    await writeHandlerSaEmail(input.appId, input.existingEmail);
    return { email: input.existingEmail, created: false };
  }

  const n = await nextHandlerSaCounter(input.shopDomain);
  const email = handlerSaEmail(input.shopDomain, n);
  const accountId = handlerSaEmail(input.shopDomain, n).split("@")[0]!;

  if (DEPLOY_MODE === "local") {
    // Skip the IAM API call entirely — local handlers run on docker
    // compose with CLOUD_RUN_SKIP_AUTH=true and never present a real
    // ID token. The DB write is still performed so /services/* routes
    // can resolve the SA-to-app mapping by the placeholder email.
    logger.info(
      { appId: input.appId, email },
      "[local] Skipping GCP SA create; writing placeholder handler_sa_email",
    );
    await writeHandlerSaEmail(input.appId, email);
    return { email, created: true };
  }

  const result = await createServiceAccount({
    accountId,
    displayName: `Handler SA — ${input.appName}`,
    description: `Per-app handler identity for app ${input.appId} (shop ${input.shopDomain})`,
  });

  await writeHandlerSaEmail(input.appId, result.email);

  // Sanity: confirm the email GCP returned matches what we computed.
  // A mismatch would mean GCP_PROJECT drift between deployer and
  // service-namer — we want to fail loud rather than silently bind
  // the wrong identity.
  if (result.email !== email) {
    throw new Error(
      `SA email mismatch: computed ${email}, GCP returned ${result.email}. ` +
        `Check GCP_PROJECT consistency.`,
    );
  }

  return { email: result.email, created: result.created };
}

/**
 * Grants platform-back's own SA roles/run.invoker on the freshly
 * deployed handler Cloud Run service. Called by the orchestrator after
 * deployToCloudRun returns.
 *
 * Source of platform-back's SA email:
 *   - Env: PLATFORM_SA_EMAIL (set in prod via Cloud Run service
 *     account metadata, or explicitly in deploy/api.yaml)
 *   - In dev (DEPLOY_MODE=local): no-op, since local platform-back
 *     calls handlers without minting a real ID token.
 */
export async function grantPlatformBackInvokerOnHandler(
  appId: string,
): Promise<void> {
  if (DEPLOY_MODE === "local") {
    logger.info(
      { appId },
      "[local] Skipping roles/run.invoker grant — local handlers don't enforce IAM",
    );
    return;
  }

  const platformSa = process.env["PLATFORM_SA_EMAIL"];
  if (!platformSa) {
    throw new Error(
      "PLATFORM_SA_EMAIL is not set — cannot grant Cloud Run invoker " +
        "to platform-back. In prod this is required so /admin/* and /webhook/* " +
        "proxy calls can authenticate to the handler.",
    );
  }

  await grantCloudRunInvoker(appId, `serviceAccount:${platformSa}`);
  logger.info(
    { appId, platformSa, project: GCP_PROJECT_VALUE },
    "Bound platform-back SA as roles/run.invoker on handler",
  );
}
