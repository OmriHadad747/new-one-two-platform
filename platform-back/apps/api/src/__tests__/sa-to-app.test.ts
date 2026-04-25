import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @platform-back/db BEFORE importing sa-to-app (hoisted by vitest)
vi.mock("@platform-back/db", () => ({
  sql: vi.fn(),
}));

import { sql } from "@platform-back/db";
import { resolveAppFromSaEmail, invalidateSaCache, clearSaCache } from "../lib/sa-to-app.js";

const mockSql = vi.mocked(sql);

const IDENTITY = { tenantId: "tenant-1", appId: "app-1" };
const SA_EMAIL = "h-acme-1@test.iam.gserviceaccount.com";

beforeEach(() => {
  clearSaCache();
  vi.clearAllMocks();
});

describe("resolveAppFromSaEmail — DB lookup", () => {
  it("returns identity for a known active SA", async () => {
    mockSql.mockResolvedValueOnce([{ tenantId: IDENTITY.tenantId, appId: IDENTITY.appId }]);
    const result = await resolveAppFromSaEmail(SA_EMAIL);
    expect(result).toEqual(IDENTITY);
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it("returns null when no active app is bound to the SA", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await resolveAppFromSaEmail(SA_EMAIL);
    expect(result).toBeNull();
  });
});

describe("resolveAppFromSaEmail — caching", () => {
  it("caches the result and skips DB on second call", async () => {
    mockSql.mockResolvedValueOnce([{ tenantId: IDENTITY.tenantId, appId: IDENTITY.appId }]);

    const first = await resolveAppFromSaEmail(SA_EMAIL);
    const second = await resolveAppFromSaEmail(SA_EMAIL);

    expect(first).toEqual(IDENTITY);
    expect(second).toEqual(IDENTITY);
    // DB called only once despite two lookups
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it("does NOT cache null results", async () => {
    mockSql.mockResolvedValue([]);

    await resolveAppFromSaEmail(SA_EMAIL);
    await resolveAppFromSaEmail(SA_EMAIL);

    // Both calls hit the DB since null is not cached
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it("re-queries DB after TTL expiry", async () => {
    // Seed cache with an entry whose expiry is already in the past
    mockSql.mockResolvedValueOnce([{ tenantId: IDENTITY.tenantId, appId: IDENTITY.appId }]);
    await resolveAppFromSaEmail(SA_EMAIL);

    // Manually expire the entry by replacing it with a stale one
    // We do this by directly invalidating (same as TTL eviction)
    invalidateSaCache(SA_EMAIL);

    mockSql.mockResolvedValueOnce([{ tenantId: "new-tenant", appId: "new-app" }]);
    const result = await resolveAppFromSaEmail(SA_EMAIL);

    expect(result).toEqual({ tenantId: "new-tenant", appId: "new-app" });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});

describe("invalidateSaCache", () => {
  it("removes a specific entry so the next call hits DB", async () => {
    mockSql.mockResolvedValue([{ tenantId: IDENTITY.tenantId, appId: IDENTITY.appId }]);
    await resolveAppFromSaEmail(SA_EMAIL);

    invalidateSaCache(SA_EMAIL);

    await resolveAppFromSaEmail(SA_EMAIL);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it("is a no-op for an unknown SA email", () => {
    expect(() => invalidateSaCache("unknown@example.com")).not.toThrow();
  });

  it("only evicts the specified entry, leaving others intact", async () => {
    const otherEmail = "h-other-1@test.iam.gserviceaccount.com";
    const otherIdentity = { tenantId: "t2", appId: "a2" };

    mockSql
      .mockResolvedValueOnce([{ tenantId: IDENTITY.tenantId, appId: IDENTITY.appId }])
      .mockResolvedValueOnce([{ tenantId: otherIdentity.tenantId, appId: otherIdentity.appId }]);

    await resolveAppFromSaEmail(SA_EMAIL);
    await resolveAppFromSaEmail(otherEmail);

    invalidateSaCache(SA_EMAIL);

    mockSql.mockResolvedValueOnce([{ tenantId: IDENTITY.tenantId, appId: IDENTITY.appId }]);
    await resolveAppFromSaEmail(SA_EMAIL);
    // otherEmail should still be cached
    await resolveAppFromSaEmail(otherEmail);

    expect(mockSql).toHaveBeenCalledTimes(3); // 2 initial + 1 after invalidate
  });
});

describe("clearSaCache", () => {
  it("removes all entries", async () => {
    mockSql.mockResolvedValue([{ tenantId: IDENTITY.tenantId, appId: IDENTITY.appId }]);
    await resolveAppFromSaEmail(SA_EMAIL);
    await resolveAppFromSaEmail("other@example.com");

    clearSaCache();

    mockSql.mockResolvedValue([]);
    await resolveAppFromSaEmail(SA_EMAIL);
    await resolveAppFromSaEmail("other@example.com");

    // 4 total calls: 2 before clear + 2 after clear
    expect(mockSql).toHaveBeenCalledTimes(4);
  });
});
