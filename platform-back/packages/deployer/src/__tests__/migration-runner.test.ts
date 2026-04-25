import { describe, it, expect, vi } from "vitest";

const { mockSqlEnd, mockSqlFn, mockPostgres } = vi.hoisted(() => {
  const mockSqlEnd = vi.fn().mockResolvedValue(undefined);
  const mockSqlFn = Object.assign(vi.fn().mockResolvedValue([{ exists: true }]), {
    end: mockSqlEnd,
    unsafe: vi.fn().mockResolvedValue(undefined),
  });
  const mockPostgres = vi.fn(() => mockSqlFn);
  return { mockSqlEnd, mockSqlFn, mockPostgres };
});

vi.mock("postgres", () => ({ default: mockPostgres }));

import { appSchemaName, dropAppSchema } from "../migration-runner.js";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ─── appSchemaName (pure function) ───────────────────────────────────────────

describe("appSchemaName", () => {
  it("produces the canonical tenant_<32hex>_app_<16hex> format", () => {
    const name = appSchemaName(TENANT_ID, APP_ID);
    expect(name).toMatch(/^tenant_[0-9a-f]{32}_app_[0-9a-f]{16}$/);
  });

  it("strips hyphens from both UUIDs", () => {
    const name = appSchemaName(TENANT_ID, APP_ID);
    expect(name).not.toContain("-");
  });

  it("uses only the first 16 hex chars of the appId", () => {
    const name = appSchemaName(TENANT_ID, APP_ID);
    const appHex = APP_ID.replace(/-/g, "").slice(0, 16);
    expect(name).toContain(`_app_${appHex}`);
  });

  it("stays within Postgres' 63-character identifier limit", () => {
    const name = appSchemaName(TENANT_ID, APP_ID);
    // 5 + 32 + 5 + 16 = 58 chars
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("is deterministic — same inputs always produce the same output", () => {
    expect(appSchemaName(TENANT_ID, APP_ID)).toBe(appSchemaName(TENANT_ID, APP_ID));
  });

  it("throws on a non-UUID tenantId", () => {
    expect(() => appSchemaName("not-a-uuid", APP_ID)).toThrow();
  });

  it("throws on a non-UUID appId", () => {
    expect(() => appSchemaName(TENANT_ID, "not-a-uuid")).toThrow();
  });

  it("throws on empty strings", () => {
    expect(() => appSchemaName("", APP_ID)).toThrow();
    expect(() => appSchemaName(TENANT_ID, "")).toThrow();
  });

  it("produces different names for different appIds under the same tenant", () => {
    const other = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
    expect(appSchemaName(TENANT_ID, APP_ID)).not.toBe(appSchemaName(TENANT_ID, other));
  });

  it("produces different names for different tenantIds with the same appId", () => {
    const other = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
    expect(appSchemaName(TENANT_ID, APP_ID)).not.toBe(appSchemaName(other, APP_ID));
  });
});

// ─── dropAppSchema ────────────────────────────────────────────────────────────

describe("dropAppSchema", () => {
  const VALID_SCHEMA = appSchemaName(TENANT_ID, APP_ID);

  it("returns { dropped: true } when the schema exists", async () => {
    mockSqlFn.mockResolvedValueOnce([{ exists: true }]); // pg_namespace check
    const result = await dropAppSchema({
      tenantSchema: VALID_SCHEMA,
      databaseUrl: "postgresql://user:pass@localhost/db",
    });
    expect(result.dropped).toBe(true);
  });

  it("issues DROP SCHEMA CASCADE when schema exists", async () => {
    mockSqlFn.mockResolvedValueOnce([{ exists: true }]);
    await dropAppSchema({
      tenantSchema: VALID_SCHEMA,
      databaseUrl: "postgresql://user:pass@localhost/db",
    });
    expect(mockSqlFn.unsafe).toHaveBeenCalledWith(expect.stringMatching(/DROP SCHEMA/i));
  });

  it("returns { dropped: false } when schema does not exist (idempotent)", async () => {
    mockSqlFn.mockResolvedValueOnce([{ exists: false }]);
    const result = await dropAppSchema({
      tenantSchema: VALID_SCHEMA,
      databaseUrl: "postgresql://user:pass@localhost/db",
    });
    expect(result.dropped).toBe(false);
    expect(mockSqlFn.unsafe).not.toHaveBeenCalledWith(expect.stringMatching(/DROP/i));
  });

  it("always closes the connection pool, even on error", async () => {
    mockSqlFn.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      dropAppSchema({ tenantSchema: VALID_SCHEMA, databaseUrl: "pg://bad" }),
    ).rejects.toThrow();
    expect(mockSqlEnd).toHaveBeenCalled();
  });

  it("throws when schema name does not match the canonical regex", async () => {
    await expect(
      dropAppSchema({ tenantSchema: "public", databaseUrl: "pg://localhost/db" }),
    ).rejects.toThrow();
    await expect(
      dropAppSchema({ tenantSchema: "tenant_bad_name", databaseUrl: "pg://localhost/db" }),
    ).rejects.toThrow();
  });
});
