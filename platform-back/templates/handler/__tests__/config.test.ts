import { describe, it, expect, vi, beforeEach } from "vitest";

const sqlMock = vi.fn();
// `sql.json(...)` is used inside config.set's tagged template; postgres.js
// exposes it on the sql instance, so the mock has to expose it too.
(sqlMock as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

vi.mock("../src/lib/db.js", () => ({ sql: sqlMock }));

const { config, ConfigKeyError } = await import("../src/lib/config.js");

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
  (sqlMock as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
});

describe("config — key validation", () => {
  it("rejects empty key", async () => {
    await expect(config.get("")).rejects.toBeInstanceOf(ConfigKeyError);
  });

  it("rejects key starting with digit", async () => {
    await expect(config.get("1foo")).rejects.toThrow(/invalid config key/);
  });

  it("rejects key starting with underscore", async () => {
    await expect(config.get("_foo")).rejects.toThrow(/invalid config key/);
  });

  it("rejects key with uppercase", async () => {
    await expect(config.get("Foo")).rejects.toThrow(/invalid config key/);
  });

  it("rejects key with hyphens", async () => {
    await expect(config.get("foo-bar")).rejects.toThrow(/invalid config key/);
  });

  it("rejects key longer than 63 chars", async () => {
    await expect(config.get("a".repeat(64))).rejects.toThrow(/invalid config key/);
  });

  it("accepts snake_case key at boundary length", async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(config.get("a".repeat(63))).resolves.toBeUndefined();
  });

  it("accepts typical key", async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(config.get("points_per_dollar")).resolves.toBeUndefined();
  });
});

describe("config.get — read with default", () => {
  it("returns default when key is missing", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await config.get("missing_key", 42);
    expect(result).toBe(42);
  });

  it("returns default when stored value is SQL NULL", async () => {
    sqlMock.mockResolvedValueOnce([{ value: null }]);
    const result = await config.get("nulled_key", "fallback");
    expect(result).toBe("fallback");
  });

  it("returns the stored value when present", async () => {
    sqlMock.mockResolvedValueOnce([{ value: 1.5 }]);
    const result = await config.get("points_per_dollar", 1);
    expect(result).toBe(1.5);
  });

  it("preserves complex JSON shapes", async () => {
    sqlMock.mockResolvedValueOnce([{ value: { tier: "gold", limit: 100 } }]);
    const result = await config.get("plan", null);
    expect(result).toEqual({ tier: "gold", limit: 100 });
  });

  it("returns undefined when no default and key missing", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await config.get("missing_key");
    expect(result).toBeUndefined();
  });

  it("does not write the default back to the table", async () => {
    sqlMock.mockResolvedValueOnce([]);
    await config.get("missing_key", 42);
    expect(sqlMock).toHaveBeenCalledOnce();
    const [strings] = (sqlMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string[]];
    expect(strings.join("?")).toMatch(/SELECT value FROM app_config/);
  });
});

describe("config.set — upsert", () => {
  it("emits INSERT … ON CONFLICT DO UPDATE", async () => {
    sqlMock.mockResolvedValueOnce([]);
    await config.set("notifications_enabled", true);
    expect(sqlMock).toHaveBeenCalledOnce();
    const [strings] = (sqlMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string[]];
    const composed = strings.join("?");
    expect(composed).toMatch(/INSERT INTO app_config/i);
    expect(composed).toMatch(/ON CONFLICT \(key\) DO UPDATE/i);
    expect(composed).toMatch(/updated_at = now\(\)/i);
  });

  it("rejects undefined as the explicit no-value sentinel", async () => {
    await expect(config.set("foo", undefined)).rejects.toThrow(/unset/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("propagates DB errors", async () => {
    sqlMock.mockRejectedValueOnce(new Error("pg: deadlock detected"));
    await expect(config.set("rate", 1)).rejects.toThrow(/deadlock/);
  });
});

describe("config.unset", () => {
  it("emits DELETE WHERE key = $1", async () => {
    sqlMock.mockResolvedValueOnce([]);
    await config.unset("deprecated_knob");
    expect(sqlMock).toHaveBeenCalledOnce();
    const [strings, ...values] = (sqlMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    expect(strings.join("?")).toMatch(/DELETE FROM app_config WHERE key/i);
    expect(values).toEqual(["deprecated_knob"]);
  });

  it("validates the key", async () => {
    await expect(config.unset("BAD KEY")).rejects.toThrow(/invalid config key/);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe("config.getMany", () => {
  it("returns empty map for empty input without hitting DB", async () => {
    const result = await config.getMany([]);
    expect(result).toEqual({});
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("validates every key", async () => {
    await expect(config.getMany(["good_key", "BAD KEY"])).rejects.toThrow(/invalid config key/);
  });

  it("maps rows to a key→value object", async () => {
    sqlMock.mockResolvedValueOnce([
      { key: "rate", value: 2 },
      { key: "thresholds", value: [10, 50] },
    ]);
    const result = await config.getMany(["rate", "thresholds", "missing"]);
    expect(result).toEqual({ rate: 2, thresholds: [10, 50] });
  });
});

describe("config.getAll", () => {
  it("returns empty map when no rows", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await config.getAll();
    expect(result).toEqual({});
  });

  it("preserves key→value pairs", async () => {
    sqlMock.mockResolvedValueOnce([
      { key: "alpha", value: 1 },
      { key: "beta", value: "x" },
    ]);
    const result = await config.getAll();
    expect(result).toEqual({ alpha: 1, beta: "x" });
  });

  it("warns once when row count exceeds soft cap", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bigPayload = Array.from({ length: 501 }, (_, i) => ({
      key: `k_${i}`,
      value: i,
    }));
    sqlMock.mockResolvedValueOnce(bigPayload);
    await config.getAll();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Second call same process — already-warned flag suppresses repeat.
    sqlMock.mockResolvedValueOnce(bigPayload);
    await config.getAll();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
