import { callPlatformService } from "./platform-call.js";

export class QuotaExceeded extends Error {
  constructor(
    public readonly limit: number,
    public readonly current: number,
    public readonly resetsAt: string | null,
  ) {
    super(`Monthly quota exceeded (${limit})`);
    this.name = "QuotaExceeded";
  }
}

export type EmailSendResult =
  | { ok: true; delivered: true; deliveryId: string }
  | { ok: true; delivered: false; reason: "suppressed" | "missing_config" }
  | { ok: true; delivered: false; reason: "provider_failed" };

export interface EmailSendInput {
  to: string;
  data: Record<string, unknown>;
}

async function emailSend(input: EmailSendInput): Promise<EmailSendResult> {
  const { status, body } = await callPlatformService<
    EmailSendResult | { error: "quota_exceeded"; limit: number; current: number; resetsAt: string | null }
  >({ path: "/services/email/send", body: input });

  if (status === 200) return body as EmailSendResult;
  if (status === 429) {
    const e = body as { limit: number; current: number; resetsAt: string | null };
    throw new QuotaExceeded(e.limit, e.current, e.resetsAt);
  }
  if (status >= 500) {
    return { ok: true, delivered: false, reason: "provider_failed" };
  }
  // 400/401/403 — programming error
  throw new Error(`platform.email.send: unexpected status ${status} (${JSON.stringify(body)})`);
}

export type EmailBatchItemResult =
  | { index: number; status: 200; result: EmailSendResult }
  | { index: number; status: 429; error: "quota_exceeded"; limit: number; current: number }
  | { index: number; status: 500; error: "send_failed" };

async function emailSendBatch(items: EmailSendInput[]): Promise<{ items: EmailBatchItemResult[] }> {
  const { status, body } = await callPlatformService<{ items: EmailBatchItemResult[] }>({
    path: "/services/email/send-batch",
    body: { items },
  });
  if (status === 207) return body;
  throw new Error(`platform.email.sendBatch: unexpected status ${status} (${JSON.stringify(body)})`);
}

export const platform = {
  email: { send: emailSend, sendBatch: emailSendBatch },
  QuotaExceeded,
};
