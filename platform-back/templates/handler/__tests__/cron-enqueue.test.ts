import { describe, it, expect, vi, beforeEach } from "vitest";

const sqlMock = vi.fn();
vi.mock("../src/lib/db.js", () => ({ sql: sqlMock }));

const { enqueueJob } = await import("../src/lib/cron-enqueue.js");

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

describe("enqueueJob — input validation", () => {
  it("throws TypeError on non-string jobName", async () => {
    // @ts-expect-error — runtime guard
    await expect(enqueueJob(42, {})).rejects.toBeInstanceOf(TypeError);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("throws on empty jobName", async () => {
    await expect(enqueueJob("", {})).rejects.toThrow(/non-empty/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("throws on whitespace-only jobName", async () => {
    await expect(enqueueJob("   ", {})).rejects.toThrow(/non-empty/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("throws when jobName exceeds 256 chars", async () => {
    await expect(enqueueJob("a".repeat(257), {})).rejects.toThrow(/≤256/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("throws when dedupKey is provided but empty", async () => {
    await expect(
      enqueueJob("main", {}, { dedupKey: "" }),
    ).rejects.toThrow(/dedupKey/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("throws when dedupKey exceeds 256 chars", async () => {
    await expect(
      enqueueJob("main", {}, { dedupKey: "a".repeat(257) }),
    ).rejects.toThrow(/dedupKey.*≤256/);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe("enqueueJob — SQL shape", () => {
  it("inserts with dedup_key=null when no dedupKey is given", async () => {
    await enqueueJob("main", { foo: 1 });
    expect(sqlMock).toHaveBeenCalledOnce();

    const [strings, ...values] = sqlMock.mock.calls[0] as [string[], ...unknown[]];
    expect(values).toEqual(["main", JSON.stringify({ foo: 1 }), null]);
    const composed = strings.join("?");
    expect(composed).toMatch(/INSERT INTO cron_queue/i);
    expect(composed).toMatch(/ON CONFLICT DO NOTHING/i);
    expect(composed).toMatch(/dedup_key/);
  });

  it("inserts with the provided dedupKey", async () => {
    await enqueueJob("reconcile", { orderId: "42" }, { dedupKey: "order-42" });
    expect(sqlMock).toHaveBeenCalledOnce();

    const [, ...values] = sqlMock.mock.calls[0] as [string[], ...unknown[]];
    expect(values).toEqual([
      "reconcile",
      JSON.stringify({ orderId: "42" }),
      "order-42",
    ]);
  });

  it("propagates DB errors to the caller", async () => {
    sqlMock.mockRejectedValueOnce(new Error("pg: connection refused"));
    await expect(enqueueJob("main")).rejects.toThrow(/connection refused/);
  });
});
