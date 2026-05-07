import { describe, it, expect, vi } from "vitest";
import { paginate } from "../src/lib/paginate.js";

type Call = { sql: string; values: unknown[] };

function makeFake(opts: { count?: number; rows?: Array<Record<string, unknown>> } = {}) {
  const calls: Call[] = [];
  const fn = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Array.from(strings).join("?");
    calls.push({ sql, values });
    if (sql.includes("COUNT(*)")) {
      return Promise.resolve([{ count: String(opts.count ?? 0) }]);
    }
    if (sql.includes("_page")) {
      return Promise.resolve(opts.rows ?? []);
    }
    return { __mock: "pending-query" };
  });
  return { fn, calls };
}

const baseQ = (fn: ReturnType<typeof makeFake>["fn"]): unknown =>
  (fn as unknown as (s: TemplateStringsArray) => unknown)`SELECT id FROM rules ORDER BY id DESC`;

describe("paginate — defaults", () => {
  it("uses page=1, page_size=20 when input is empty", async () => {
    const { fn } = makeFake({ count: 5, rows: [{ id: 1 }, { id: 2 }] });
    const result = await paginate(fn as never, baseQ(fn) as never, {});
    expect(result.page).toBe(1);
    expect(result.page_size).toBe(20);
    expect(result.total).toBe(5);
    expect(result.items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("returns empty items when no rows", async () => {
    const { fn } = makeFake({ count: 0, rows: [] });
    const result = await paginate(fn as never, baseQ(fn) as never, {});
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe("paginate — clamping", () => {
  it("clamps page < 1 to 1", async () => {
    const { fn } = makeFake();
    const result = await paginate(fn as never, baseQ(fn) as never, { page: 0 });
    expect(result.page).toBe(1);
  });

  it("clamps negative page to 1", async () => {
    const { fn } = makeFake();
    const result = await paginate(fn as never, baseQ(fn) as never, { page: -5 });
    expect(result.page).toBe(1);
  });

  it("clamps page_size > 100 to 100 by default", async () => {
    const { fn } = makeFake();
    const result = await paginate(fn as never, baseQ(fn) as never, { page_size: 999 });
    expect(result.page_size).toBe(100);
  });

  it("clamps page_size < 1 to 1", async () => {
    const { fn } = makeFake();
    const result = await paginate(fn as never, baseQ(fn) as never, { page_size: 0 });
    expect(result.page_size).toBe(1);
  });

  it("respects maxPageSize override", async () => {
    const { fn } = makeFake();
    const result = await paginate(
      fn as never,
      baseQ(fn) as never,
      { page_size: 5000 },
      { maxPageSize: 1000 },
    );
    expect(result.page_size).toBe(1000);
  });
});

describe("paginate — input coercion", () => {
  it("coerces string page and page_size to number", async () => {
    const { fn } = makeFake();
    const result = await paginate(fn as never, baseQ(fn) as never, {
      page: "3",
      page_size: "50",
    });
    expect(result.page).toBe(3);
    expect(result.page_size).toBe(50);
  });

  it("falls back to defaults on null inputs", async () => {
    const { fn } = makeFake();
    const result = await paginate(fn as never, baseQ(fn) as never, {
      page: null,
      page_size: null,
    });
    expect(result.page).toBe(1);
    expect(result.page_size).toBe(20);
  });

  it("falls back to defaults on non-numeric strings", async () => {
    const { fn } = makeFake();
    const result = await paginate(fn as never, baseQ(fn) as never, {
      page: "abc",
      page_size: "xyz",
    });
    expect(result.page).toBe(1);
    expect(result.page_size).toBe(20);
  });
});

describe("paginate — SQL shape", () => {
  it("issues COUNT subquery and paginated SELECT in parallel", async () => {
    const { fn, calls } = makeFake({ count: 42, rows: [{ id: 1 }] });
    await paginate(fn as never, baseQ(fn) as never, { page: 2, page_size: 10 });

    expect(fn).toHaveBeenCalledTimes(3);

    const countCall = calls.find((c) => c.sql.includes("COUNT(*)"));
    expect(countCall).toBeDefined();
    expect(countCall?.sql).toMatch(/SELECT COUNT\(\*\) AS count FROM \(\?\) AS _count/);

    const pageCall = calls.find((c) => c.sql.includes("_page"));
    expect(pageCall).toBeDefined();
    expect(pageCall?.sql).toMatch(/SELECT \* FROM \(\?\) AS _page LIMIT \? OFFSET \?/);

    const [, pageSize, offset] = pageCall?.values ?? [];
    expect(pageSize).toBe(10);
    expect(offset).toBe(10);
  });

  it("offset=0 on first page", async () => {
    const { fn, calls } = makeFake();
    await paginate(fn as never, baseQ(fn) as never, { page: 1, page_size: 25 });
    const pageCall = calls.find((c) => c.sql.includes("_page"));
    const [, , offset] = pageCall?.values ?? [];
    expect(offset).toBe(0);
  });
});

describe("paginate — total parsing", () => {
  it("parses COUNT result string into number", async () => {
    const { fn } = makeFake({ count: 12345 });
    const result = await paginate(fn as never, baseQ(fn) as never, {});
    expect(result.total).toBe(12345);
    expect(typeof result.total).toBe("number");
  });

  it("falls back to total=0 when COUNT returns no rows", async () => {
    const fn = vi.fn((strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join("?");
      if (sql.includes("COUNT(*)")) return Promise.resolve([]);
      if (sql.includes("_page")) return Promise.resolve([]);
      return { __mock: "pending-query" };
    });
    const result = await paginate(fn as never, baseQ(fn as never) as never, {});
    expect(result.total).toBe(0);
  });
});
