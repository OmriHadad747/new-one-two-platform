import { describe, it, expect, vi } from "vitest";

const callMock = vi.fn();
vi.mock("../src/lib/platform-call.js", () => ({ callPlatformService: callMock }));

// fetch() is used by uploadLarge's PUT to GCS. Stub globally so these
// unit tests don't try to hit the network.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { platform, QuotaExceeded, PayloadTooLarge } = await import("../src/lib/platform.js");

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

describe("platform.files.upload — inline path", () => {
  it("throws PayloadTooLarge for a buffer at or above 25 MiB without hitting the network", async () => {
    callMock.mockClear();
    const buf = Buffer.alloc(25 * 1024 * 1024); // exactly the cap — SDK rejects
    await expect(
      platform.files.upload({ name: "too-big.pdf", contents: buf, mimeType: "application/pdf" }),
    ).rejects.toBeInstanceOf(PayloadTooLarge);
    expect(callMock).not.toHaveBeenCalled();
  });

  it("returns the upload result on 200", async () => {
    const buf = Buffer.from("short");
    callMock.mockResolvedValueOnce({
      status: 200,
      body: {
        fileId: "f-1",
        url: "https://gcs.example/signed",
        expiresAt: "2026-05-01",
        sizeBytes: buf.length,
      },
    });
    const result = await platform.files.upload({
      name: "small.pdf",
      contents: buf,
      mimeType: "application/pdf",
    });
    expect(result.fileId).toBe("f-1");
    expect(callMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/services/files/upload" }),
    );
  });

  it("throws QuotaExceeded on 429", async () => {
    callMock.mockResolvedValueOnce({
      status: 429,
      body: { error: "quota_exceeded", usedBytes: 10, limitBytes: 10 },
    });
    await expect(
      platform.files.upload({
        name: "x.pdf",
        contents: Buffer.from("x"),
        mimeType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(QuotaExceeded);
  });
});

describe("platform.files.uploadLarge — resumable path", () => {
  it("throws PayloadTooLarge for a buffer over 500 MiB before any network call", async () => {
    callMock.mockClear();
    fetchMock.mockClear();
    // Using Buffer.alloc of 500 MiB would pin CI for no reason; fake the
    // byte length by constructing an object the SDK reads as a Uint8Array.
    const fakeLarge = Object.create(Buffer.prototype);
    Object.defineProperty(fakeLarge, "length", {
      value: 501 * 1024 * 1024,
    });
    await expect(
      platform.files.uploadLarge({
        name: "huge.zip",
        contents: fakeLarge as Buffer,
        mimeType: "application/zip",
      }),
    ).rejects.toBeInstanceOf(PayloadTooLarge);
    expect(callMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs the create → PUT → finalize dance and returns the finalize result", async () => {
    const buf = Buffer.alloc(100 * 1024 * 1024); // 100 MiB — legal for uploadLarge
    callMock
      // 1) create-upload-url
      .mockResolvedValueOnce({
        status: 200,
        body: {
          fileId: "f-resume-1",
          uploadUrl: "https://gcs.example/put",
          requiredHeaders: {
            "Content-Type": "application/zip",
            "x-goog-content-length-range": "0,104857600",
          },
          expiresAt: "2026-05-01",
        },
      })
      // 2) finalize-upload
      .mockResolvedValueOnce({
        status: 200,
        body: {
          fileId: "f-resume-1",
          url: "https://gcs.example/read",
          expiresAt: "2026-05-01",
          sizeBytes: buf.length,
        },
      });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await platform.files.uploadLarge({
      name: "bulk.zip",
      contents: buf,
      mimeType: "application/zip",
    });

    expect(result.fileId).toBe("f-resume-1");
    expect(callMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path: "/services/files/create-upload-url" }),
    );
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path: "/services/files/finalize-upload" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gcs.example/put",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("throws QuotaExceeded when create-upload-url returns 429", async () => {
    callMock.mockResolvedValueOnce({
      status: 429,
      body: { usedBytes: 900, limitBytes: 1000 },
    });
    await expect(
      platform.files.uploadLarge({
        name: "x.zip",
        contents: Buffer.from("xx"),
        mimeType: "application/zip",
      }),
    ).rejects.toBeInstanceOf(QuotaExceeded);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
