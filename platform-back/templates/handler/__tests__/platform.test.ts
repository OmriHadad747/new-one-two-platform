import { describe, it, expect, vi } from "vitest";

const callMock = vi.fn();
vi.mock("../src/lib/platform-call.js", () => ({ callPlatformService: callMock }));

const { platform, QuotaExceeded } = await import("../src/lib/platform.js");

describe("platform.email.send", () => {
  it("returns delivered result on 200", async () => {
    callMock.mockResolvedValueOnce({
      status: 200,
      body: { ok: true, delivered: true, deliveryId: "d-abc" },
    });
    const result = await platform.email.send({ to: "a@b.com", data: {} });
    expect(result).toEqual({ ok: true, delivered: true, deliveryId: "d-abc" });
  });

  it("returns suppressed result on 200 with suppressed reason", async () => {
    callMock.mockResolvedValueOnce({
      status: 200,
      body: { ok: true, delivered: false, reason: "suppressed" },
    });
    const result = await platform.email.send({ to: "a@b.com", data: {} });
    expect(result).toEqual({ ok: true, delivered: false, reason: "suppressed" });
  });

  it("returns provider_failed on 5xx (soft fail)", async () => {
    callMock.mockResolvedValueOnce({ status: 500, body: {} });
    const result = await platform.email.send({ to: "a@b.com", data: {} });
    expect(result).toEqual({ ok: true, delivered: false, reason: "provider_failed" });
  });

  it("throws QuotaExceeded on 429", async () => {
    callMock.mockResolvedValueOnce({
      status: 429,
      body: { error: "quota_exceeded", limit: 100, current: 100, resetsAt: "2026-05-01" },
    });
    await expect(platform.email.send({ to: "a@b.com", data: {} })).rejects.toBeInstanceOf(
      QuotaExceeded,
    );
  });

  it("throws on 4xx programming error", async () => {
    callMock.mockResolvedValueOnce({ status: 400, body: { error: "bad_request" } });
    await expect(platform.email.send({ to: "a@b.com", data: {} })).rejects.toThrow(
      "unexpected status 400",
    );
  });
});

describe("platform.email.sendBatch", () => {
  it("parses 207 correctly", async () => {
    const items = [
      { index: 0, status: 200, result: { ok: true, delivered: true, deliveryId: "d-1" } },
    ];
    callMock.mockResolvedValueOnce({ status: 207, body: { items } });
    const result = await platform.email.sendBatch([{ to: "a@b.com", data: {} }]);
    expect(result).toEqual({ items });
  });

  it("throws on unexpected status", async () => {
    callMock.mockResolvedValueOnce({ status: 500, body: {} });
    await expect(platform.email.sendBatch([])).rejects.toThrow("unexpected status 500");
  });
});
