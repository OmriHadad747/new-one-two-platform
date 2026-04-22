import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizeShopPrefix,
  handlerSaLocalPart,
  handlerSaEmail,
  cloudRunServiceName,
  dockerImageName,
} from "../service-namer.js";

// MAX_SHOP_PREFIX_LEN = 30 - 2 (h-) - 1 (-) - 4 (digits) = 23

describe("sanitizeShopPrefix", () => {
  it("strips .myshopify.com suffix", () => {
    expect(sanitizeShopPrefix("acme.myshopify.com")).toBe("acme");
  });

  it("removes hyphens and non-alphanumeric chars", () => {
    expect(sanitizeShopPrefix("acme-store.myshopify.com")).toBe("acmestore");
  });

  it("lowercases the result", () => {
    expect(sanitizeShopPrefix("ACME.myshopify.com")).toBe("acme");
  });

  it("truncates to 23 chars", () => {
    const longShop = "a".repeat(30) + ".myshopify.com";
    const result = sanitizeShopPrefix(longShop);
    expect(result.length).toBeLessThanOrEqual(23);
    expect(result).toBe("a".repeat(23));
  });

  it("strips special chars leaving only alphanumeric", () => {
    expect(sanitizeShopPrefix("my--shop!!.myshopify.com")).toBe("myshop");
  });

  it("handles shop without .myshopify.com (falls through strip)", () => {
    expect(sanitizeShopPrefix("acme")).toBe("acme");
  });
});

describe("handlerSaLocalPart", () => {
  it("returns h-<prefix>-<n> format", () => {
    expect(handlerSaLocalPart("acme.myshopify.com", 1)).toBe("h-acme-1");
  });

  it("handles multi-digit counter", () => {
    expect(handlerSaLocalPart("acme.myshopify.com", 42)).toBe("h-acme-42");
  });

  it("strips hyphens from shop in prefix", () => {
    expect(handlerSaLocalPart("acme-store.myshopify.com", 1)).toBe(
      "h-acmestore-1",
    );
  });

  it("throws on zero", () => {
    expect(() => handlerSaLocalPart("acme.myshopify.com", 0)).toThrow(
      /positive integer/,
    );
  });

  it("throws on negative n", () => {
    expect(() => handlerSaLocalPart("acme.myshopify.com", -1)).toThrow();
  });

  it("throws on non-integer n", () => {
    expect(() => handlerSaLocalPart("acme.myshopify.com", 1.5)).toThrow(
      /positive integer/,
    );
  });

  it("throws when shop produces an empty prefix", () => {
    expect(() => handlerSaLocalPart("!!!.myshopify.com", 1)).toThrow(
      /empty prefix/,
    );
  });

  it("throws when the 5-digit counter would exceed the 30-char SA limit", () => {
    // Need a shop whose sanitized prefix hits the max (23 chars).
    // "a".repeat(30) + ".myshopify.com" → truncates to 23 'a's.
    // "h-" + 23 + "-" + "10000" (5 digits) = 2+23+1+5 = 31 > 30 → throws.
    const longShop = "a".repeat(30) + ".myshopify.com";
    expect(() => handlerSaLocalPart(longShop, 10000)).toThrow(/exceeds 30/);
  });

  it("succeeds at max 4-digit counter (9999)", () => {
    const result = handlerSaLocalPart("acme.myshopify.com", 9999);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toBe("h-acme-9999");
  });
});

describe("handlerSaEmail", () => {
  // GCP_PROJECT=test-project is set in test-setup.ts before module load.
  it("appends the GCP project domain from GCP_PROJECT env", () => {
    const email = handlerSaEmail("shop.myshopify.com", 1);
    // GCP_PROJECT is "test-project" (from test-setup.ts)
    expect(email).toMatch(/@test-project\.iam\.gserviceaccount\.com$/);
    expect(email).toMatch(/^h-shop-1@/);
  });
});

describe("cloudRunServiceName", () => {
  it("prefixes with app-", () => {
    expect(cloudRunServiceName("abc-123")).toBe("app-abc-123");
  });

  it("lowercases the appId", () => {
    expect(cloudRunServiceName("ABC")).toBe("app-abc");
  });
});

describe("dockerImageName", () => {
  it("contains appId and version", () => {
    const name = dockerImageName("abc123", "1.0.0");
    expect(name).toContain("abc123");
    expect(name).toContain("1.0.0");
  });

  it("includes handler- prefix", () => {
    const name = dockerImageName("my-app", "v2");
    expect(name).toContain("handler-my-app");
  });
});
