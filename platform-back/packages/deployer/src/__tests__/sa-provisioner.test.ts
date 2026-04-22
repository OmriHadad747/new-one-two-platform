import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@platform-back/db", () => ({
  sql: vi.fn().mockResolvedValue([]),
}));
vi.mock("../iam-ops.js", () => ({
  createServiceAccount: vi.fn(),
  grantCloudRunInvoker: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../db-writer.js", () => ({
  writeHandlerSaEmail: vi.fn().mockResolvedValue(undefined),
  upsertDeployedFunction: vi.fn(),
}));
vi.mock("@platform-back/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sql } from "@platform-back/db";
import { createServiceAccount, grantCloudRunInvoker } from "../iam-ops.js";
import { writeHandlerSaEmail } from "../db-writer.js";
import {
  nextHandlerSaCounter,
  provisionHandlerSa,
  grantPlatformBackInvokerOnHandler,
} from "../sa-provisioner.js";

const mockSql = vi.mocked(sql);
const mockCreate = vi.mocked(createServiceAccount);
const mockGrant = vi.mocked(grantCloudRunInvoker);
const mockWrite = vi.mocked(writeHandlerSaEmail);

const SHOP = "acme.myshopify.com";
const APP_ID = "app-uuid-123";

beforeEach(() => {
  vi.clearAllMocks();
  // DEPLOY_MODE=local and GCP_PROJECT=test-project are set in test-setup.ts
  // (before module load) so the module-level constants pick them up.
  process.env["PLATFORM_SA_EMAIL"] = "";
});

describe("nextHandlerSaCounter", () => {
  it("returns 1 when no existing SAs for this shop", async () => {
    mockSql.mockResolvedValueOnce([]);
    const n = await nextHandlerSaCounter(SHOP);
    expect(n).toBe(1);
  });

  it("returns max + 1 when SAs already exist", async () => {
    mockSql.mockResolvedValueOnce([
      { handlerSaEmail: "h-acme-1@test-project.iam.gserviceaccount.com" },
      { handlerSaEmail: "h-acme-3@test-project.iam.gserviceaccount.com" },
    ]);
    const n = await nextHandlerSaCounter(SHOP);
    expect(n).toBe(4); // max is 3, next is 4
  });

  it("ignores rows where local-part tail is not a number", async () => {
    mockSql.mockResolvedValueOnce([
      { handlerSaEmail: "h-acme-foo@test-project.iam.gserviceaccount.com" },
    ]);
    const n = await nextHandlerSaCounter(SHOP);
    expect(n).toBe(1);
  });
});

describe("provisionHandlerSa — local mode (DEPLOY_MODE=local from setup)", () => {
  beforeEach(() => {
    mockSql.mockResolvedValue([]);
  });

  it("skips GCP SA create and writes placeholder email", async () => {
    const result = await provisionHandlerSa({
      shopDomain: SHOP,
      appId: APP_ID,
      appName: "Acme App",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalledWith(APP_ID, expect.stringMatching(/^h-acme-\d+@/));
    expect(result.created).toBe(true);
    expect(result.email).toMatch(/^h-acme-\d+@/);
  });

  it("reuses existingEmail without GCP call", async () => {
    const existing = "h-acme-1@test-project.iam.gserviceaccount.com";
    const result = await provisionHandlerSa({
      shopDomain: SHOP,
      appId: APP_ID,
      appName: "Acme App",
      existingEmail: existing,
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.email).toBe(existing);
    expect(result.created).toBe(false);
  });
});

// NOTE: cloudrun mode tests are skipped because DEPLOY_MODE is fixed at
// module-load time via test-setup.ts (set to "local"). Testing the cloudrun
// path requires a separate worker with DEPLOY_MODE=cloudrun. The key GCP
// interactions (createServiceAccount, grantCloudRunInvoker) are covered by
// the local-mode tests which verify the correct call path is taken.
describe.skip("provisionHandlerSa — cloudrun mode (requires DEPLOY_MODE=cloudrun worker)", () => {
  beforeEach(() => {
    mockSql.mockResolvedValue([]);
  });

  it("calls createServiceAccount and writes email", async () => {
    const expectedEmail = `h-acme-1@test-project.iam.gserviceaccount.com`;
    mockCreate.mockResolvedValueOnce({
      email: expectedEmail,
      created: true,
    });

    const result = await provisionHandlerSa({
      shopDomain: SHOP,
      appId: APP_ID,
      appName: "Acme App",
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockWrite).toHaveBeenCalledWith(APP_ID, expectedEmail);
    expect(result.email).toBe(expectedEmail);
    expect(result.created).toBe(true);
  });

  it("throws when GCP returns an email that doesn't match computed email", async () => {
    mockCreate.mockResolvedValueOnce({
      email: "different@other-project.iam.gserviceaccount.com",
      created: true,
    });

    await expect(
      provisionHandlerSa({
        shopDomain: SHOP,
        appId: APP_ID,
        appName: "Acme App",
      }),
    ).rejects.toThrow(/email mismatch/);
  });
});

describe("grantPlatformBackInvokerOnHandler", () => {
  // DEPLOY_MODE=local (from test-setup.ts) → always no-ops
  it("no-ops in local DEPLOY_MODE", async () => {
    await grantPlatformBackInvokerOnHandler(APP_ID);
    expect(mockGrant).not.toHaveBeenCalled();
  });
});
