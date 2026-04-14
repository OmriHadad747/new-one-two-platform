import { describe, expect, it } from "vitest";
import {
  assertProductionCorsConfig,
  matchOrigin,
  parseAllowedOrigins,
} from "./cors.js";

describe("matchOrigin", () => {
  it("exact matches a literal origin", () => {
    expect(matchOrigin("https://admin.shopify.com", "https://admin.shopify.com")).toBe(true);
  });

  it("rejects a schema mismatch", () => {
    expect(matchOrigin("https://admin.shopify.com", "http://admin.shopify.com")).toBe(false);
  });

  it("wildcard matches a single subdomain", () => {
    expect(matchOrigin("https://*.myshopify.com", "https://acme.myshopify.com")).toBe(true);
  });

  it("wildcard matches nested subdomains", () => {
    expect(matchOrigin("https://*.myshopify.com", "https://one.two.myshopify.com")).toBe(true);
  });

  it("wildcard rejects the bare suffix (no subdomain)", () => {
    // `https://*.myshopify.com` must not match `https://myshopify.com` — the
    // wildcard requires at least one subdomain label.
    expect(matchOrigin("https://*.myshopify.com", "https://myshopify.com")).toBe(false);
  });

  it("wildcard does not fall for the suffix-trick attack", () => {
    // `https://*.myshopify.com` must not match `https://evil.com/myshopify.com`
    // or any origin whose host portion only SUFFIX-matches the suffix.
    expect(matchOrigin("https://*.myshopify.com", "https://evil.com")).toBe(false);
    expect(matchOrigin("https://*.myshopify.com", "https://evilmyshopify.com")).toBe(false);
  });

  it("wildcard requires matching scheme", () => {
    expect(matchOrigin("https://*.myshopify.com", "http://acme.myshopify.com")).toBe(false);
  });
});

describe("parseAllowedOrigins", () => {
  it("returns an empty array for undefined or empty", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(",,,")).toEqual([]);
  });

  it("splits on comma, trims each entry, drops empties", () => {
    expect(
      parseAllowedOrigins(
        "  https://admin.shopify.com , https://*.myshopify.com  , , https://dash.example.com "
      )
    ).toEqual([
      "https://admin.shopify.com",
      "https://*.myshopify.com",
      "https://dash.example.com",
    ]);
  });
});

describe("assertProductionCorsConfig", () => {
  it("throws in production when the list is empty", () => {
    expect(() => assertProductionCorsConfig("production", [])).toThrow(
      /ALLOWED_ORIGINS must be set/
    );
  });

  it("does not throw in production when the list has entries", () => {
    expect(() =>
      assertProductionCorsConfig("production", ["https://admin.shopify.com"])
    ).not.toThrow();
  });

  it("does not throw in development regardless of list", () => {
    expect(() => assertProductionCorsConfig("development", [])).not.toThrow();
    expect(() => assertProductionCorsConfig(undefined, [])).not.toThrow();
  });
});
