import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks so factories can reference them
const mockEmailsSend = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { id: "resend-msg-id" } }),
);

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockEmailsSend },
  })),
}));

vi.mock("@platform-back/db", () => ({
  isEmailSuppressed: vi.fn().mockResolvedValue(false),
  checkUsageQuota: vi
    .fn()
    .mockResolvedValue({ allowed: true, current: 0, limit: 1000 }),
  getAppEmailConfig: vi.fn().mockResolvedValue({
    subjectTemplate: "Hello {{name}}",
    headingTemplate: "Hi there",
    bodyTemplate: "Your order {{orderId}} is ready.",
    ctaLabel: null,
    ctaUrlTemplate: null,
    emailType: "transactional",
    configuredByMerchant: true,
  }),
  getAppEmailVariables: vi.fn().mockResolvedValue([]),
  getTenantBrand: vi.fn().mockResolvedValue(null),
  insertEmailDelivery: vi
    .fn()
    .mockResolvedValue({ id: "delivery-uuid-123" }),
  updateEmailDeliveryStatus: vi.fn().mockResolvedValue(undefined),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../renderer.js", () => ({
  renderEmail: vi.fn().mockReturnValue({
    subject: "Hello World",
    html: "<p>body</p>",
    text: "body",
  }),
}));

vi.mock("../unsubscribe-token.js", () => ({
  signUnsubscribeToken: vi.fn().mockReturnValue("test-unsub-token"),
}));

import * as db from "@platform-back/db";
import { sendEmail, QuotaExceededError } from "../sender.js";

const mockSuppressed = vi.mocked(db.isEmailSuppressed);
const mockQuota = vi.mocked(db.checkUsageQuota);
const mockConfig = vi.mocked(db.getAppEmailConfig);
const mockInsert = vi.mocked(db.insertEmailDelivery);
const mockUpdateStatus = vi.mocked(db.updateEmailDeliveryStatus);
const mockIncrement = vi.mocked(db.incrementUsage);

const BASE_INPUT = {
  tenantId: "tenant-1",
  appId: "app-1",
  storeName: "Acme Store",
  plan: "starter" as const,
  recipient: "customer@example.com",
  data: { name: "Alice", orderId: "ORD-123" },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEmailsSend.mockResolvedValue({ data: { id: "resend-msg-id" } });
  mockSuppressed.mockResolvedValue(false);
  mockQuota.mockResolvedValue({ allowed: true, current: 0, limit: 1000 });
  mockConfig.mockResolvedValue({
    subjectTemplate: "Hello",
    headingTemplate: null,
    bodyTemplate: "Body",
    ctaLabel: null,
    ctaUrlTemplate: null,
    emailType: "transactional" as const,
    configuredByMerchant: true,
  });
  mockInsert.mockResolvedValue({ id: "delivery-uuid-123" });
  mockUpdateStatus.mockResolvedValue(undefined);
  mockIncrement.mockResolvedValue(undefined);
});

describe("sendEmail — happy path", () => {
  it("returns ok+delivered=true on successful send", async () => {
    const result = await sendEmail(BASE_INPUT);
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.deliveryId).toBe("delivery-uuid-123");
  });

  it("calls Resend with correct recipient and subject", async () => {
    await sendEmail(BASE_INPUT);
    expect(mockEmailsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "customer@example.com",
      }),
    );
  });

  it("updates delivery status to sent after successful Resend call", async () => {
    await sendEmail(BASE_INPUT);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "delivery-uuid-123",
      expect.objectContaining({ status: "sent" }),
    );
  });

  it("increments usage counter for non-test sends", async () => {
    await sendEmail(BASE_INPUT);
    expect(mockIncrement).toHaveBeenCalledWith("tenant-1", "emails_sent");
  });

  it("trims and lowercases the recipient email", async () => {
    await sendEmail({ ...BASE_INPUT, recipient: "  ALICE@Example.COM  " });
    expect(mockEmailsSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: "alice@example.com" }),
    );
  });
});

describe("sendEmail — suppression", () => {
  it("skips send and returns delivered=false when suppressed", async () => {
    mockSuppressed.mockResolvedValue(true);
    const result = await sendEmail(BASE_INPUT);
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("suppressed");
    expect(mockEmailsSend).not.toHaveBeenCalled();
  });
});

describe("sendEmail — quota", () => {
  it("throws QuotaExceededError when quota is exhausted", async () => {
    mockQuota.mockResolvedValue({ allowed: false, current: 1000, limit: 1000 });
    await expect(sendEmail(BASE_INPUT)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("QuotaExceededError carries limit and current", async () => {
    mockQuota.mockResolvedValue({ allowed: false, current: 500, limit: 500 });
    try {
      await sendEmail(BASE_INPUT);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const qe = err as QuotaExceededError;
      expect(qe.limit).toBe(500);
      expect(qe.current).toBe(500);
    }
  });
});

describe("sendEmail — missing config", () => {
  it("returns delivered=false with missing_config when no app_email_config", async () => {
    mockConfig.mockResolvedValue(null);
    const result = await sendEmail(BASE_INPUT);
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("missing_config");
    expect(mockEmailsSend).not.toHaveBeenCalled();
  });
});

describe("sendEmail — provider failure", () => {
  it("returns delivered=false with provider_failed when Resend throws", async () => {
    mockEmailsSend.mockRejectedValueOnce(new Error("Resend API down"));
    const result = await sendEmail(BASE_INPUT);
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("provider_failed");
  });

  it("updates delivery status to failed on Resend error", async () => {
    mockEmailsSend.mockRejectedValueOnce(new Error("network timeout"));
    await sendEmail(BASE_INPUT);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "delivery-uuid-123",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("does NOT increment usage on provider failure", async () => {
    mockEmailsSend.mockRejectedValueOnce(new Error("500"));
    await sendEmail(BASE_INPUT);
    expect(mockIncrement).not.toHaveBeenCalled();
  });
});

describe("sendEmail — test sends (isTest=true)", () => {
  const testInput = { ...BASE_INPUT, isTest: true, subjectPrefix: "[TEST] " };

  it("bypasses suppression check for test sends", async () => {
    mockSuppressed.mockResolvedValue(true);
    const result = await sendEmail(testInput);
    expect(result.delivered).toBe(true);
    expect(mockSuppressed).not.toHaveBeenCalled();
  });

  it("bypasses quota check for test sends", async () => {
    mockQuota.mockResolvedValue({ allowed: false, current: 1000, limit: 1000 });
    const result = await sendEmail(testInput);
    expect(result.delivered).toBe(true);
    expect(mockQuota).not.toHaveBeenCalled();
  });

  it("does NOT increment usage for test sends", async () => {
    await sendEmail(testInput);
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it("prepends subjectPrefix to rendered subject", async () => {
    await sendEmail(testInput);
    expect(mockEmailsSend).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "[TEST] Hello World" }),
    );
  });
});
