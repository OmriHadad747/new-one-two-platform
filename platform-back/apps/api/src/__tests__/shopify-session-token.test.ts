import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifySessionToken } from "../lib/shopify-session-token.js";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";

function makeJwt(
  claims: Record<string, unknown>,
  secret: string = CLIENT_SECRET,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const VALID_CLAIMS = {
  iss: "https://acme.myshopify.com/admin",
  dest: "https://acme.myshopify.com",
  aud: CLIENT_ID,
  sub: "user-123",
  exp: nowSec() + 3600,
  nbf: nowSec() - 10,
  iat: nowSec() - 10,
  sid: "session-abc",
};

describe("verifyShopifySessionToken — valid tokens", () => {
  it("returns claims for a valid token", () => {
    const token = makeJwt(VALID_CLAIMS);
    const result = verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET);
    expect(result).not.toBeNull();
    expect(result?.shop).toBe("acme.myshopify.com");
    expect(result?.sub).toBe("user-123");
    expect(result?.sessionId).toBe("session-abc");
  });

  it("strips https:// scheme from dest to produce shop", () => {
    const token = makeJwt({
      ...VALID_CLAIMS,
      dest: "https://my-store.myshopify.com",
    });
    const result = verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET);
    expect(result?.shop).toBe("my-store.myshopify.com");
  });

  it("strips http:// scheme from dest", () => {
    const token = makeJwt({
      ...VALID_CLAIMS,
      dest: "http://acme.myshopify.com",
    });
    const result = verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET);
    expect(result?.shop).toBe("acme.myshopify.com");
  });

  it("accepts array aud containing clientId", () => {
    const token = makeJwt({ ...VALID_CLAIMS, aud: [CLIENT_ID, "other"] });
    const result = verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET);
    expect(result).not.toBeNull();
  });

  it("returns sessionId as undefined when sid claim absent", () => {
    const { sid: _sid, ...claimsWithoutSid } = VALID_CLAIMS;
    const token = makeJwt(claimsWithoutSid);
    const result = verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET);
    expect(result?.sessionId).toBeUndefined();
  });

  it("accepts token without nbf claim", () => {
    const { nbf: _nbf, ...claimsWithoutNbf } = VALID_CLAIMS;
    const token = makeJwt(claimsWithoutNbf);
    const result = verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET);
    expect(result).not.toBeNull();
  });

  it("accepts token without exp claim", () => {
    const { exp: _exp, ...claimsWithoutExp } = VALID_CLAIMS;
    const token = makeJwt(claimsWithoutExp);
    const result = verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET);
    expect(result).not.toBeNull();
  });
});

describe("verifyShopifySessionToken — invalid signature", () => {
  it("returns null for wrong signature", () => {
    const token = makeJwt(VALID_CLAIMS, "wrong-secret");
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("returns null for tampered payload", () => {
    const token = makeJwt(VALID_CLAIMS);
    const [h, _p, s] = token.split(".");
    const fakePayload = Buffer.from(
      JSON.stringify({ ...VALID_CLAIMS, sub: "attacker" }),
    ).toString("base64url");
    const tampered = `${h}.${fakePayload}.${s}`;
    expect(
      verifyShopifySessionToken(tampered, CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("returns null for missing parts", () => {
    expect(
      verifyShopifySessionToken("only.two", CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("returns null for empty token", () => {
    expect(verifyShopifySessionToken("", CLIENT_ID, CLIENT_SECRET)).toBeNull();
  });
});

describe("verifyShopifySessionToken — expired / not-yet-valid", () => {
  it("returns null for expired token (outside skew)", () => {
    const token = makeJwt({ ...VALID_CLAIMS, exp: nowSec() - 10 });
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("accepts token expired within the 5-second skew", () => {
    const token = makeJwt({ ...VALID_CLAIMS, exp: nowSec() - 3 });
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).not.toBeNull();
  });

  it("returns null for nbf in the future (outside skew)", () => {
    const token = makeJwt({ ...VALID_CLAIMS, nbf: nowSec() + 10 });
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("accepts token with nbf within the 5-second skew", () => {
    const token = makeJwt({ ...VALID_CLAIMS, nbf: nowSec() + 3 });
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).not.toBeNull();
  });
});

describe("verifyShopifySessionToken — invalid claims", () => {
  it("returns null when aud does not match clientId", () => {
    const token = makeJwt({ ...VALID_CLAIMS, aud: "wrong-client" });
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("returns null when aud array does not include clientId", () => {
    const token = makeJwt({ ...VALID_CLAIMS, aud: ["other-client"] });
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("returns null when dest is missing", () => {
    const { dest: _dest, ...claims } = VALID_CLAIMS;
    const token = makeJwt(claims);
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("returns null when sub is missing", () => {
    const { sub: _sub, ...claims } = VALID_CLAIMS;
    const token = makeJwt(claims);
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("returns null when dest is not a valid myshopify domain", () => {
    const token = makeJwt({
      ...VALID_CLAIMS,
      dest: "https://evil.example.com",
    });
    expect(
      verifyShopifySessionToken(token, CLIENT_ID, CLIENT_SECRET),
    ).toBeNull();
  });

  it("returns null when clientId or clientSecret are empty", () => {
    const token = makeJwt(VALID_CLAIMS);
    expect(verifyShopifySessionToken(token, "", CLIENT_SECRET)).toBeNull();
    expect(verifyShopifySessionToken(token, CLIENT_ID, "")).toBeNull();
  });
});
