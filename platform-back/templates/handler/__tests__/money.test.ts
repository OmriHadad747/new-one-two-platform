import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  toMinorUnits,
  fromMinorUnits,
  format,
  sum,
  percentage,
  currency,
  MoneyError,
} from "../src/lib/money.js";

describe("toMinorUnits — two-decimal currencies (default)", () => {
  it("converts USD '9.99' to 999", () => {
    expect(toMinorUnits("9.99", "USD")).toBe(999);
  });

  it("converts USD '100' to 10000", () => {
    expect(toMinorUnits("100", "USD")).toBe(10000);
  });

  it("converts USD '1.99' to 199 (no float artefacts)", () => {
    expect(toMinorUnits("1.99", "USD")).toBe(199);
  });

  it("preserves sign on refunds", () => {
    expect(toMinorUnits("-9.99", "USD")).toBe(-999);
  });

  it("normalizes lowercase currency codes", () => {
    expect(toMinorUnits("1.00", "usd")).toBe(100);
  });

  it("accepts numeric input", () => {
    expect(toMinorUnits(9.99, "USD")).toBe(999);
  });
});

describe("toMinorUnits — zero-decimal currencies", () => {
  it("converts JPY '100' to 100 (no multiplier)", () => {
    expect(toMinorUnits("100", "JPY")).toBe(100);
  });

  it("converts KRW '50000' to 50000", () => {
    expect(toMinorUnits("50000", "KRW")).toBe(50000);
  });

  it("converts CLP '1500' to 1500", () => {
    expect(toMinorUnits("1500", "CLP")).toBe(1500);
  });

  it("rounds JPY '99.4' to 99 (Shopify shouldn't send fractions but be safe)", () => {
    expect(toMinorUnits("99.4", "JPY")).toBe(99);
  });
});

describe("toMinorUnits — three-decimal currencies", () => {
  it("converts BHD '1.234' to 1234 (does NOT lose the third decimal)", () => {
    expect(toMinorUnits("1.234", "BHD")).toBe(1234);
  });

  it("converts JOD '0.500' to 500", () => {
    expect(toMinorUnits("0.500", "JOD")).toBe(500);
  });

  it("converts KWD '10.000' to 10000", () => {
    expect(toMinorUnits("10.000", "KWD")).toBe(10000);
  });
});

describe("toMinorUnits — input validation", () => {
  it("throws on null", () => {
    // @ts-expect-error — runtime guard
    expect(() => toMinorUnits(null, "USD")).toThrow(MoneyError);
  });

  it("throws on undefined", () => {
    // @ts-expect-error — runtime guard
    expect(() => toMinorUnits(undefined, "USD")).toThrow(MoneyError);
  });

  it("throws on empty string", () => {
    expect(() => toMinorUnits("", "USD")).toThrow(/empty/);
  });

  it("throws on non-numeric string", () => {
    expect(() => toMinorUnits("abc", "USD")).toThrow(MoneyError);
  });

  it("throws on NaN", () => {
    expect(() => toMinorUnits(NaN, "USD")).toThrow(MoneyError);
  });

  it("throws on scientific notation", () => {
    expect(() => toMinorUnits("1e3", "USD")).toThrow(/scientific notation/);
  });

  it("throws on comma-separated", () => {
    expect(() => toMinorUnits("1,000.00", "USD")).toThrow(/separators/);
  });

  it("throws on whitespace", () => {
    expect(() => toMinorUnits("9.99 ", "USD")).toThrow(/separators/);
  });

  it("throws on invalid currency code (too short)", () => {
    expect(() => toMinorUnits("9.99", "US")).toThrow(/currency/);
  });

  it("throws on invalid currency code (too long)", () => {
    expect(() => toMinorUnits("9.99", "USDD")).toThrow(/currency/);
  });

  it("throws on non-letter currency code", () => {
    expect(() => toMinorUnits("9.99", "12 ")).toThrow(/currency/);
  });
});

describe("fromMinorUnits", () => {
  it("USD 999 → 9.99", () => {
    expect(fromMinorUnits(999, "USD")).toBe(9.99);
  });

  it("JPY 100 → 100", () => {
    expect(fromMinorUnits(100, "JPY")).toBe(100);
  });

  it("BHD 1234 → 1.234", () => {
    expect(fromMinorUnits(1234, "BHD")).toBe(1.234);
  });

  it("throws on non-integer input", () => {
    expect(() => fromMinorUnits(1.5, "USD")).toThrow(/integer/);
  });

  it("preserves sign", () => {
    expect(fromMinorUnits(-999, "USD")).toBe(-9.99);
  });
});

describe("format", () => {
  it("USD 999 → '9.99'", () => {
    expect(format(999, "USD")).toBe("9.99");
  });

  it("USD 100 → '1.00' (pads trailing zeros)", () => {
    expect(format(100, "USD")).toBe("1.00");
  });

  it("USD 5 → '0.05' (pads leading zero in fractional)", () => {
    expect(format(5, "USD")).toBe("0.05");
  });

  it("JPY 100 → '100' (no decimal)", () => {
    expect(format(100, "JPY")).toBe("100");
  });

  it("BHD 1234 → '1.234'", () => {
    expect(format(1234, "BHD")).toBe("1.234");
  });

  it("BHD 5 → '0.005'", () => {
    expect(format(5, "BHD")).toBe("0.005");
  });

  it("preserves negative sign", () => {
    expect(format(-999, "USD")).toBe("-9.99");
  });

  it("throws on non-integer", () => {
    expect(() => format(1.5, "USD")).toThrow(/integer/);
  });
});

describe("sum", () => {
  it("adds integer amounts", () => {
    expect(sum([100, 200, 300])).toBe(600);
  });

  it("returns 0 for empty list", () => {
    expect(sum([])).toBe(0);
  });

  it("preserves sign on mixed inputs (e.g. order + refund)", () => {
    expect(sum([1000, -250])).toBe(750);
  });

  it("throws on non-integer entry", () => {
    expect(() => sum([100, 2.5, 300])).toThrow(/integer/);
  });
});

describe("percentage", () => {
  it("8.5% of $10.00 (1000 cents) → 85 cents", () => {
    expect(percentage(1000, 8.5)).toBe(85);
  });

  it("100% returns the same amount", () => {
    expect(percentage(1234, 100)).toBe(1234);
  });

  it("0% returns 0", () => {
    expect(percentage(1234, 0)).toBe(0);
  });

  it("rounds to nearest minor unit", () => {
    // 7.25% of 100 = 7.25 → rounds to 7
    expect(percentage(100, 7.25)).toBe(7);
  });

  it("throws on non-integer amount", () => {
    expect(() => percentage(1.5, 10)).toThrow(/integer/);
  });

  it("throws on non-finite pct", () => {
    expect(() => percentage(1000, NaN)).toThrow(/finite/);
  });
});

describe("currency metadata", () => {
  it("returns code + 2 decimals for USD", () => {
    expect(currency("USD")).toEqual({ code: "USD", decimalDigits: 2 });
  });

  it("returns 0 decimals for JPY", () => {
    expect(currency("JPY")).toEqual({ code: "JPY", decimalDigits: 0 });
  });

  it("returns 3 decimals for BHD", () => {
    expect(currency("BHD")).toEqual({ code: "BHD", decimalDigits: 3 });
  });

  it("normalizes case", () => {
    expect(currency("eur").code).toBe("EUR");
  });
});

describe("unknown currency — defaults to 2 + warns once", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("treats EUR (not explicitly listed) as 2-decimal and warns once", () => {
    // EUR is in our "default 2" bucket — first lookup warns.
    const code = "ZZZ"; // a guaranteed-unknown placeholder
    expect(toMinorUnits("1.23", code)).toBe(123);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Second call same currency → no additional warn.
    toMinorUnits("4.56", code);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
