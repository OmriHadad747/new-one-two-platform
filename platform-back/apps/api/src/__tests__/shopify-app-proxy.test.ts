import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifyAppProxy } from "../lib/shopify-app-proxy.js";

const SECRET = "test-proxy-secret";

function sign(params: Record<string, string>, secret: string = SECRET): Record<string, string> {
  const keys = Object.keys(params).sort();
  const canonical = keys.map((k) => `${k}=${params[k]}`).join("");
  const sig = createHmac("sha256", secret).update(canonical).digest("hex");
  return { ...params, signature: sig };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const VALID_PARAMS = {
  shop: "acme.myshopify.com",
  logged_in_customer_id: "123456",
  path_prefix: "/apps/my-app",
  timestamp: String(nowSec()),
};

describe("verifyShopifyAppProxy — valid requests", () => {
  it("returns claims for a valid signed request", () => {
    const query = sign(VALID_PARAMS);
    const result = verifyShopifyAppProxy(query, SECRET);
    expect(result).not.toBeNull();
    expect(result?.shop).toBe("acme.myshopify.com");
    expect(result?.loggedInCustomerId).toBe("123456");
    expect(result?.pathPrefix).toBe("/apps/my-app");
    expect(result?.timestamp).toBe(Number(VALID_PARAMS.timestamp));
  });

  it("returns null loggedInCustomerId when not signed in", () => {
    const { logged_in_customer_id: _id, ...params } = VALID_PARAMS;
    const query = sign(params);
    const result = verifyShopifyAppProxy(query, SECRET);
    expect(result?.loggedInCustomerId).toBeNull();
  });

  it("returns null pathPrefix when not provided", () => {
    const { path_prefix: _pp, ...params } = VALID_PARAMS;
    const query = sign(params);
    const result = verifyShopifyAppProxy(query, SECRET);
    expect(result?.pathPrefix).toBeNull();
  });

  it("is case-insensitive for shop domain (lowercases it)", () => {
    const query = sign({ ...VALID_PARAMS, shop: "ACME.myshopify.com" });
    const result = verifyShopifyAppProxy(query, SECRET);
    expect(result?.shop).toBe("acme.myshopify.com");
  });
});

describe("verifyShopifyAppProxy — invalid signature", () => {
  it("returns null for wrong signature", () => {
    const query = sign(VALID_PARAMS, "wrong-secret");
    expect(verifyShopifyAppProxy(query, SECRET)).toBeNull();
  });

  it("returns null when signature is missing", () => {
    const { signature: _sig, ...query } = sign(VALID_PARAMS);
    expect(verifyShopifyAppProxy(query, SECRET)).toBeNull();
  });

  it("returns null for empty clientSecret", () => {
    const query = sign(VALID_PARAMS);
    expect(verifyShopifyAppProxy(query, "")).toBeNull();
  });
});

describe("verifyShopifyAppProxy — timestamp replay protection", () => {
  it("returns null for timestamp older than 5 minutes", () => {
    const old = String(nowSec() - 5 * 60 - 1);
    const query = sign({ ...VALID_PARAMS, timestamp: old });
    expect(verifyShopifyAppProxy(query, SECRET)).toBeNull();
  });

  it("accepts timestamp within the 5-minute window (just inside)", () => {
    const recent = String(nowSec() - 4 * 60);
    const query = sign({ ...VALID_PARAMS, timestamp: recent });
    expect(verifyShopifyAppProxy(query, SECRET)).not.toBeNull();
  });

  it("accepts timestamp slightly in the future", () => {
    const future = String(nowSec() + 10);
    const query = sign({ ...VALID_PARAMS, timestamp: future });
    expect(verifyShopifyAppProxy(query, SECRET)).not.toBeNull();
  });

  it("returns null for non-numeric timestamp", () => {
    const query = sign({ ...VALID_PARAMS, timestamp: "not-a-number" });
    expect(verifyShopifyAppProxy(query, SECRET)).toBeNull();
  });
});

describe("verifyShopifyAppProxy — shop domain validation", () => {
  it("returns null for non-myshopify domain", () => {
    const query = sign({ ...VALID_PARAMS, shop: "evil.example.com" });
    expect(verifyShopifyAppProxy(query, SECRET)).toBeNull();
  });

  it("returns null for missing shop", () => {
    const { shop: _shop, ...params } = VALID_PARAMS;
    const query = sign(params as Record<string, string>);
    expect(verifyShopifyAppProxy(query, SECRET)).toBeNull();
  });
});

describe("verifyShopifyAppProxy — canonical string construction", () => {
  it("signature is not included in the canonical string", () => {
    // Signing with the signature param included would compute a different hash;
    // we verify this by checking we get the right result with our sign() helper
    // which excludes 'signature' from canonical string
    const query = sign(VALID_PARAMS);
    expect(verifyShopifyAppProxy(query, SECRET)).not.toBeNull();
  });

  it("params are sorted alphabetically for canonical string", () => {
    // Re-order params — result should still verify
    const { timestamp, shop, logged_in_customer_id, path_prefix } = VALID_PARAMS;
    const query = sign({
      path_prefix,
      logged_in_customer_id,
      timestamp,
      shop,
    });
    expect(verifyShopifyAppProxy(query, SECRET)).not.toBeNull();
  });
});
