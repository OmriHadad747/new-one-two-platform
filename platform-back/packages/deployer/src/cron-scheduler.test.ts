import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock() is hoisted — variables used inside the factory must be
// created with vi.hoisted() so they exist before the factory runs.
const { mockSqlEnd, mockSqlFn, mockPostgres } = vi.hoisted(() => {
  const mockSqlEnd = vi.fn().mockResolvedValue(undefined);
  const mockSqlFn = Object.assign(
    vi.fn().mockResolvedValue([{ unschedule: true }]),
    { end: mockSqlEnd },
  );
  const mockPostgres = vi.fn(() => mockSqlFn);
  return { mockSqlEnd, mockSqlFn, mockPostgres };
});

vi.mock("postgres", () => ({ default: mockPostgres }));

import {
  scheduleAppCron,
  unscheduleAppCron,
} from "./cron-scheduler.js";

const VALID_INPUT = {
  appId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  tenantSchema: "tenant_a1b2c3d4_e5f6_7890_abcd_ef1234567890",
  cronExpression: "*/5 * * * *",
  databaseUrl: "postgresql://user:pass@localhost/db",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSqlFn.mockResolvedValue([{ unschedule: true }]);
});

describe("scheduleAppCron — validation", () => {
  it("throws on malformed tenant schema (spaces)", async () => {
    await expect(
      scheduleAppCron({
        ...VALID_INPUT,
        tenantSchema: "tenant bad schema",
      }),
    ).rejects.toThrow(/refusing schema/);
  });

  it("throws on tenant schema that doesn't start with tenant_", async () => {
    await expect(
      scheduleAppCron({ ...VALID_INPUT, tenantSchema: "public" }),
    ).rejects.toThrow(/refusing schema/);
  });

  it("throws on cron expression with shell-injection chars", async () => {
    await expect(
      scheduleAppCron({
        ...VALID_INPUT,
        cronExpression: "* * * * *; DROP TABLE tenants; --",
      }),
    ).rejects.toThrow(/cron expression/);
  });

  it("throws on cron expression with backtick", async () => {
    await expect(
      scheduleAppCron({ ...VALID_INPUT, cronExpression: "`id`" }),
    ).rejects.toThrow(/cron expression/);
  });
});

describe("scheduleAppCron — success path", () => {
  it("opens a postgres connection and calls cron.schedule", async () => {
    await scheduleAppCron(VALID_INPUT);
    expect(mockPostgres).toHaveBeenCalledWith(
      VALID_INPUT.databaseUrl,
      expect.objectContaining({ max: 1, prepare: false }),
    );
    expect(mockSqlFn).toHaveBeenCalled();
  });

  it("closes the connection after scheduling", async () => {
    await scheduleAppCron(VALID_INPUT);
    expect(mockSqlEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("closes the connection even if cron.schedule throws", async () => {
    mockSqlFn.mockRejectedValueOnce(new Error("DB error"));
    await expect(scheduleAppCron(VALID_INPUT)).rejects.toThrow("DB error");
    expect(mockSqlEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("accepts a 6-field cron expression", async () => {
    await expect(
      scheduleAppCron({ ...VALID_INPUT, cronExpression: "0 */6 * * * *" }),
    ).resolves.not.toThrow();
  });
});

describe("unscheduleAppCron", () => {
  it("returns { removed: true } when pg_cron removes the job", async () => {
    mockSqlFn.mockResolvedValueOnce([{ unschedule: true }]);
    const result = await unscheduleAppCron({
      appId: VALID_INPUT.appId,
      databaseUrl: VALID_INPUT.databaseUrl,
    });
    expect(result).toEqual({ removed: true });
  });

  it("returns { removed: false } when no job exists", async () => {
    mockSqlFn.mockResolvedValueOnce([{ unschedule: false }]);
    const result = await unscheduleAppCron({
      appId: VALID_INPUT.appId,
      databaseUrl: VALID_INPUT.databaseUrl,
    });
    expect(result).toEqual({ removed: false });
  });

  it("closes the connection after unscheduling", async () => {
    await unscheduleAppCron({
      appId: VALID_INPUT.appId,
      databaseUrl: VALID_INPUT.databaseUrl,
    });
    expect(mockSqlEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("closes connection even on error", async () => {
    mockSqlFn.mockRejectedValueOnce(new Error("conn failed"));
    await expect(
      unscheduleAppCron({
        appId: VALID_INPUT.appId,
        databaseUrl: VALID_INPUT.databaseUrl,
      }),
    ).rejects.toThrow("conn failed");
    expect(mockSqlEnd).toHaveBeenCalledWith({ timeout: 5 });
  });
});
