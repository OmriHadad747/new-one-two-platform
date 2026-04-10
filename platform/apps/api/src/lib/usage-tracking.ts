/**
 * Usage tracking — increment counters for billable actions.
 *
 * Counters are stored in usage_records table (one row per tenant per billing period).
 * All increments are atomic (SQL SET col = col + 1).
 *
 * Revision classification is tracked separately in revision_classifications for
 * analytics — revisions are unlimited and free for all plans.
 */
import { logger } from "@new-one-two/logger";
import {
  incrementUsage,
  storeRevisionClassification,
} from "@new-one-two/db";
import type { RevisionClassification } from "@new-one-two/types";

// ─── Usage Increment Functions ────────────────────────────────────────────────

export async function trackGeneration(tenantId: string): Promise<void> {
  await incrementUsage(tenantId, "generations");
  logger.info({ tenantId }, "usage: generation tracked");
}

export async function trackRevision(tenantId: string): Promise<void> {
  await incrementUsage(tenantId, "revisions");
  logger.info({ tenantId }, "usage: revision tracked");
}

export async function trackAppExecution(tenantId: string): Promise<void> {
  await incrementUsage(tenantId, "app_executions");
}

export async function trackEmailSent(tenantId: string): Promise<void> {
  await incrementUsage(tenantId, "emails_sent");
}

export async function trackSmsSent(tenantId: string): Promise<void> {
  await incrementUsage(tenantId, "sms_sent");
}

export async function trackFileUploaded(tenantId: string): Promise<void> {
  await incrementUsage(tenantId, "files_uploaded");
}

// ─── Revision Classification (Analytics) ──────────────────────────────────────

export async function trackRevisionClassification(params: {
  tenantId: string;
  appId: string;
  sessionId?: string;
  jobId?: string;
  classification: RevisionClassification;
  confidence: string;
  merchantPrompt: string;
}): Promise<void> {
  await storeRevisionClassification(params);
  logger.info(
    { tenantId: params.tenantId, appId: params.appId, classification: params.classification },
    "revision classified for analytics"
  );
}
