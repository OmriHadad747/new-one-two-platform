import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// Module mocks must precede the route import — vitest hoists them.
// We stub every external dependency so the tests exercise the HTTP
// contract (status codes, body shapes, auth wiring) without touching
// Postgres or GCS.

vi.mock("@platform-back/db", () => ({
  insertActiveFileAtomic: vi.fn(),
  insertPendingFile: vi.fn(),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
  finalizeFile: vi.fn(),
  deleteFileRow: vi.fn(),
  getFileForApp: vi.fn(),
  getFinalizableFileForApp: vi.fn(),
  getTenantStorageUsage: vi.fn(),
  getTenantBillingPlan: vi.fn(),
}));

vi.mock("@platform-back/files", () => ({
  SKIP_GCS: false,
  buildObjectKey: (t: string, a: string, f: string) => `tenants/${t}/apps/${a}/${f}`,
  storeFile: vi.fn(),
  signReadUrl: vi.fn(),
  createResumableUploadUrl: vi.fn(),
  getObjectSize: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("../lib/sa-to-app.js", () => ({
  resolveAppFromSaEmail: vi.fn(),
}));
vi.mock("../lib/verify-id-token.js", () => ({
  verifyCallerIdToken: vi.fn(),
}));
vi.mock("@platform-back/logger", () => ({
  createRequestLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  insertActiveFileAtomic,
  insertPendingFile,
  finalizeFile,
  deleteFileRow,
  getFileForApp,
  getFinalizableFileForApp,
  getTenantStorageUsage,
  getTenantBillingPlan,
} from "@platform-back/db";
import {
  storeFile,
  signReadUrl,
  createResumableUploadUrl,
  getObjectSize,
} from "@platform-back/files";
import { resolveAppFromSaEmail } from "../lib/sa-to-app.js";
import { verifyCallerIdToken } from "../lib/verify-id-token.js";
import { filesServiceRoutes } from "../routes/services/files.js";

const mockVerify = vi.mocked(verifyCallerIdToken);
const mockResolveApp = vi.mocked(resolveAppFromSaEmail);
const mockInsertActive = vi.mocked(insertActiveFileAtomic);
const mockInsertPending = vi.mocked(insertPendingFile);
const mockFinalize = vi.mocked(finalizeFile);
const mockDeleteRow = vi.mocked(deleteFileRow);
const mockGetFile = vi.mocked(getFileForApp);
const mockGetFinalizable = vi.mocked(getFinalizableFileForApp);
const mockUsage = vi.mocked(getTenantStorageUsage);
const mockPlan = vi.mocked(getTenantBillingPlan);
const mockStore = vi.mocked(storeFile);
const mockSign = vi.mocked(signReadUrl);
const mockCreateUploadUrl = vi.mocked(createResumableUploadUrl);
const mockGetSize = vi.mocked(getObjectSize);

const SA_EMAIL = "h-acme-1@test.iam.gserviceaccount.com";
const IDENTITY = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  appId: "22222222-2222-2222-2222-222222222222",
};
const FILE_ID = "33333333-3333-3333-3333-333333333333";

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(filesServiceRoutes, { prefix: "/services/files" });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ ok: true, caller: { email: SA_EMAIL } } as never);
  mockResolveApp.mockResolvedValue(IDENTITY);
  // Default the tenant to 'starter' plan = 1 GiB cap (PLANS.starter.limits.maxStorageBytes).
  // Individual tests override mockPlan when they need a different cap.
  mockPlan.mockResolvedValue("starter");
  mockUsage.mockResolvedValue(0);
  mockSign.mockResolvedValue({ url: "https://storage.example/signed" });
  // Ensure void-returning mocks produce a resolved promise so the route's
  // `.catch(...)` attachments don't throw on undefined.
  mockDeleteRow.mockResolvedValue(undefined);
  mockStore.mockResolvedValue(undefined);
});

// ─── Auth edge cases (shared across all endpoints) ──────────────────────────

describe("auth", () => {
  it("returns 401 when ID token is missing", async () => {
    mockVerify.mockResolvedValueOnce({ ok: false, reason: "missing_token" } as never);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/upload",
      payload: { name: "x.pdf", mimeType: "application/pdf", contents: "AAAA" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 403 when the SA email is not bound to an active app", async () => {
    mockResolveApp.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/upload",
      headers: { authorization: "Bearer token" },
      payload: { name: "x.pdf", mimeType: "application/pdf", contents: "AAAA" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// ─── Inline /upload ─────────────────────────────────────────────────────────

describe("POST /services/files/upload — inline", () => {
  it("stores + returns { fileId, url, expiresAt, sizeBytes } on happy path", async () => {
    const pdfBytes = Buffer.from("PDF-TEST-CONTENT");
    mockInsertActive.mockResolvedValue({
      id: FILE_ID,
      tenantId: IDENTITY.tenantId,
      appId: IDENTITY.appId,
      name: "test.pdf",
      mimeType: "application/pdf",
      sizeBytes: pdfBytes.length,
      gcsObject: `tenants/${IDENTITY.tenantId}/apps/${IDENTITY.appId}/${FILE_ID}`,
      status: "active",
      createdAt: new Date().toISOString(),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/upload",
      headers: { authorization: "Bearer token" },
      payload: {
        name: "test.pdf",
        mimeType: "application/pdf",
        contents: pdfBytes.toString("base64"),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fileId).toBe(FILE_ID);
    expect(body.url).toMatch(/^https:\/\//);
    expect(body.sizeBytes).toBe(pdfBytes.length);
    expect(mockStore).toHaveBeenCalledTimes(1);
    expect(mockInsertActive).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns 415 for a MIME type not in the allowlist", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/upload",
      headers: { authorization: "Bearer token" },
      payload: {
        name: "evil.exe",
        mimeType: "application/x-msdownload",
        contents: Buffer.from("MZ").toString("base64"),
      },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("unsupported_mime_type");
    expect(mockStore).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 413 when decoded bytes exceed the per-file cap", async () => {
    const tooBig = Buffer.alloc(26 * 1024 * 1024); // 26 MiB, over the 25 MiB cap
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/upload",
      headers: { authorization: "Bearer token" },
      payload: {
        name: "huge.pdf",
        mimeType: "application/pdf",
        contents: tooBig.toString("base64"),
      },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("payload_too_large");
    expect(mockStore).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 429 when tenant storage quota would be exceeded", async () => {
    // starter = 1 GiB cap; push usage right up to it
    mockUsage.mockResolvedValue(1024 * 1024 * 1024);
    mockPlan.mockResolvedValue("starter");
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/upload",
      headers: { authorization: "Bearer token" },
      payload: {
        name: "x.pdf",
        mimeType: "application/pdf",
        contents: Buffer.from("anything").toString("base64"),
      },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("quota_exceeded");
    expect(mockStore).not.toHaveBeenCalled();
    await app.close();
  });
});

// ─── /sign-read-url ─────────────────────────────────────────────────────────

describe("POST /services/files/sign-read-url", () => {
  it("returns 200 + fresh url when the file belongs to this (tenant, app)", async () => {
    mockGetFile.mockResolvedValue({
      id: FILE_ID,
      tenantId: IDENTITY.tenantId,
      appId: IDENTITY.appId,
      name: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      gcsObject: `tenants/${IDENTITY.tenantId}/apps/${IDENTITY.appId}/${FILE_ID}`,
      status: "active",
      createdAt: new Date().toISOString(),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/sign-read-url",
      headers: { authorization: "Bearer token" },
      payload: { fileId: FILE_ID, expiresInSec: 3600 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBeDefined();
    await app.close();
  });

  it("returns 404 for an unknown file id", async () => {
    mockGetFile.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/sign-read-url",
      headers: { authorization: "Bearer token" },
      payload: { fileId: FILE_ID },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 400 when expiresInSec exceeds the 7-day cap", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/sign-read-url",
      headers: { authorization: "Bearer token" },
      payload: { fileId: FILE_ID, expiresInSec: 8 * 86400 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_expires_in");
    await app.close();
  });
});

// ─── Resumable flow ─────────────────────────────────────────────────────────

describe("POST /services/files/create-upload-url", () => {
  it("reserves a pending row + returns { fileId, uploadUrl, requiredHeaders }", async () => {
    const expected = 100 * 1024 * 1024; // 100 MiB
    mockInsertPending.mockResolvedValue({
      id: FILE_ID,
      tenantId: IDENTITY.tenantId,
      appId: IDENTITY.appId,
      name: "big.zip",
      mimeType: "application/zip",
      sizeBytes: expected,
      gcsObject: `tenants/${IDENTITY.tenantId}/apps/${IDENTITY.appId}/${FILE_ID}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    mockCreateUploadUrl.mockResolvedValue({
      url: "https://storage.example/put",
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/create-upload-url",
      headers: { authorization: "Bearer token" },
      payload: {
        name: "big.zip",
        mimeType: "application/zip",
        expectedSizeBytes: expected,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fileId).toBe(FILE_ID);
    expect(body.uploadUrl).toMatch(/^https:\/\//);
    expect(body.requiredHeaders["x-goog-content-length-range"]).toBe(`0,${expected}`);
    expect(mockInsertPending).toHaveBeenCalledTimes(1);
    expect(mockDeleteRow).not.toHaveBeenCalled();
    await app.close();
  });

  it("rolls the pending row back when createResumableUploadUrl fails", async () => {
    mockInsertPending.mockResolvedValue({
      id: FILE_ID,
      tenantId: IDENTITY.tenantId,
      appId: IDENTITY.appId,
      name: "big.zip",
      mimeType: "application/zip",
      sizeBytes: 100_000,
      gcsObject: "anything",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    mockCreateUploadUrl.mockRejectedValue(new Error("GCS unreachable"));

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/create-upload-url",
      headers: { authorization: "Bearer token" },
      payload: {
        name: "big.zip",
        mimeType: "application/zip",
        expectedSizeBytes: 100_000,
      },
    });

    expect(res.statusCode).toBe(502);
    // Rolled back some pending row — the id is randomUUID()-generated,
    // so we only assert the rollback was called, not the specific id.
    expect(mockDeleteRow).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns 429 when expectedSizeBytes pushes tenant over storage cap", async () => {
    // starter = 1 GiB cap; 900 MiB used + 200 MiB request > 1 GiB
    mockUsage.mockResolvedValue(900 * 1024 * 1024);
    mockPlan.mockResolvedValue("starter");

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/create-upload-url",
      headers: { authorization: "Bearer token" },
      payload: {
        name: "big.zip",
        mimeType: "application/zip",
        expectedSizeBytes: 200 * 1024 * 1024,
      },
    });

    expect(res.statusCode).toBe(429);
    expect(mockInsertPending).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /services/files/finalize-upload", () => {
  it("flips pending → active and returns a read URL", async () => {
    const actualBytes = 80 * 1024 * 1024;
    mockGetFinalizable.mockResolvedValue({
      id: FILE_ID,
      tenantId: IDENTITY.tenantId,
      appId: IDENTITY.appId,
      name: "big.zip",
      mimeType: "application/zip",
      sizeBytes: 100 * 1024 * 1024, // declared (pending)
      gcsObject: `tenants/${IDENTITY.tenantId}/apps/${IDENTITY.appId}/${FILE_ID}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    mockGetSize.mockResolvedValue(actualBytes);
    mockFinalize.mockResolvedValue({
      id: FILE_ID,
      tenantId: IDENTITY.tenantId,
      appId: IDENTITY.appId,
      name: "big.zip",
      mimeType: "application/zip",
      sizeBytes: actualBytes,
      gcsObject: `tenants/${IDENTITY.tenantId}/apps/${IDENTITY.appId}/${FILE_ID}`,
      status: "active",
      createdAt: new Date().toISOString(),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/finalize-upload",
      headers: { authorization: "Bearer token" },
      payload: { fileId: FILE_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fileId).toBe(FILE_ID);
    expect(body.sizeBytes).toBe(actualBytes);
    expect(mockFinalize).toHaveBeenCalledWith(
      FILE_ID,
      IDENTITY.tenantId,
      IDENTITY.appId,
      actualBytes,
    );
    await app.close();
  });

  it("returns 409 when the object hasn't arrived in GCS yet", async () => {
    mockGetFinalizable.mockResolvedValue({
      id: FILE_ID,
      tenantId: IDENTITY.tenantId,
      appId: IDENTITY.appId,
      name: "big.zip",
      mimeType: "application/zip",
      sizeBytes: 100_000,
      gcsObject: "any",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    mockGetSize.mockResolvedValue(null); // not in GCS

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/finalize-upload",
      headers: { authorization: "Bearer token" },
      payload: { fileId: FILE_ID },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("upload_not_completed");
    expect(mockFinalize).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 404 when the file id doesn't belong to this app", async () => {
    mockGetFinalizable.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/files/finalize-upload",
      headers: { authorization: "Bearer token" },
      payload: { fileId: FILE_ID },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
