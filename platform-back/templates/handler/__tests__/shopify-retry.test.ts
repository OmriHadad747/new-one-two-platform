import { describe, it, expect, vi, beforeEach } from "vitest";

// ── @shopify/shopify-api SDK mock ─────────────────────────────────────────────
//
// Same shape the existing shopify.test.ts uses. We drive `request` directly
// to simulate transient HTTP failures (429 / 502 / 503 / 504), network errors,
// and Retry-After negotiation, then assert the wrapper's policy:
//   - 4 attempts max (1 initial + 3 retries),
//   - 10 s total sleep budget,
//   - Retry-After honored on 429 (seconds OR HTTP-date),
//   - exponential-with-jitter on everything else,
//   - typed ShopifyRateLimitError thrown on give-up.

const graphqlRequestMock = vi.fn();
const GraphqlClassMock = vi.fn().mockImplementation(() => ({
  request: graphqlRequestMock,
}));

vi.mock("@shopify/shopify-api", () => ({
  shopifyApi: () => ({ clients: { Graphql: GraphqlClassMock } }),
  Session: class {
    constructor(opts: unknown) {
      Object.assign(this as object, opts as object);
    }
  },
  LATEST_API_VERSION: "2025-01",
}));

vi.mock("@shopify/shopify-api/adapters/node", () => ({}));

const callPlatformServiceMock = vi.fn();
vi.mock("../src/lib/platform-call.js", () => ({
  callPlatformService: callPlatformServiceMock,
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { shopifyClientFor, ShopifyRateLimitError } = await import("../src/lib/shopify.js");

beforeEach(() => {
  graphqlRequestMock.mockReset();
  callPlatformServiceMock.mockReset();
  fetchMock.mockReset();
  vi.useFakeTimers();
});

// ── helpers ─────────────────────────────────────────────────────────────────

/** Simulate an SDK HttpResponseError shape. */
function httpError(
  code: number,
  headers: Record<string, string> = {},
  message = `HTTP ${code}`,
): Error & { response: { code: number; headers: Record<string, string> } } {
  const err = new Error(message) as Error & {
    response: { code: number; headers: Record<string, string> };
  };
  err.response = { code, headers };
  return err;
}

/** Simulate a Node-fetch network error: TypeError with .cause.code. */
function networkError(code: string, message = "fetch failed"): Error & { cause: { code: string } } {
  const err = new Error(message) as Error & { cause: { code: string } };
  err.cause = { code };
  return err;
}

/**
 * Drive a vitest-fake-timers test: advance through every retry sleep so
 * pending awaits settle. We loop a few times because each `await` between
 * timer advances yields a microtask.
 */
async function flushTimers(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
}

const ctx = { shopDomain: "shop.myshopify.com", accessToken: "tok" };

// ── HTTP-level retry on graphql ────────────────────────────────────────────

describe("withRetry (HTTP) — graphql path", () => {
  it("retries once on 503 then returns data", async () => {
    graphqlRequestMock.mockRejectedValueOnce(httpError(503));
    graphqlRequestMock.mockResolvedValueOnce({ data: { ok: true } });

    const shopify = await shopifyClientFor(ctx);
    const promise = shopify.graphql("{ shop { name } }");
    await flushTimers();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(graphqlRequestMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 502 / 504 / network errors", async () => {
    graphqlRequestMock.mockRejectedValueOnce(httpError(502));
    graphqlRequestMock.mockRejectedValueOnce(httpError(504));
    graphqlRequestMock.mockRejectedValueOnce(networkError("ECONNRESET"));
    graphqlRequestMock.mockResolvedValueOnce({ data: { ok: true } });

    const shopify = await shopifyClientFor(ctx);
    const promise = shopify.graphql("{ x }");
    await flushTimers();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(graphqlRequestMock).toHaveBeenCalledTimes(4);
  });

  it("honors Retry-After (seconds) on 429", async () => {
    graphqlRequestMock.mockRejectedValueOnce(httpError(429, { "retry-after": "1" }));
    graphqlRequestMock.mockResolvedValueOnce({ data: { ok: true } });

    const shopify = await shopifyClientFor(ctx);
    const promise = shopify.graphql("{ x }");
    // Advance just under 1s — request must NOT have been re-issued yet.
    await vi.advanceTimersByTimeAsync(900);
    expect(graphqlRequestMock).toHaveBeenCalledTimes(1);
    // Cross the 1s threshold — retry fires.
    await vi.advanceTimersByTimeAsync(200);
    await flushTimers();
    await promise;
    expect(graphqlRequestMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After (HTTP-date) on 429", async () => {
    const future = new Date(Date.now() + 750).toUTCString();
    graphqlRequestMock.mockRejectedValueOnce(httpError(429, { "retry-after": future }));
    graphqlRequestMock.mockResolvedValueOnce({ data: { ok: true } });

    const shopify = await shopifyClientFor(ctx);
    const promise = shopify.graphql("{ x }");
    await flushTimers();
    await promise;
    expect(graphqlRequestMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry 4xx other than 429", async () => {
    const err = httpError(400);
    graphqlRequestMock.mockRejectedValueOnce(err);
    const shopify = await shopifyClientFor(ctx);
    await expect(shopify.graphql("{ x }")).rejects.toBe(err);
    expect(graphqlRequestMock).toHaveBeenCalledTimes(1);
  });

  it("throws ShopifyRateLimitError after 4 failed attempts", async () => {
    graphqlRequestMock.mockRejectedValue(httpError(503));

    const shopify = await shopifyClientFor(ctx);
    const assertion = expect(shopify.graphql("{ x }")).rejects.toMatchObject({
      name: "ShopifyRateLimitError",
      attempts: 4,
      status: 503,
    });
    await flushTimers();
    await assertion;
    expect(graphqlRequestMock).toHaveBeenCalledTimes(4);
  });

  it("stops early when the next sleep would exceed the 10s budget", async () => {
    // Retry-After: 9s on first attempt eats 9s; second 503 with Retry-After: 9s
    // would push total past 10s — wrapper bails to ShopifyRateLimitError before
    // burning the remaining attempts.
    graphqlRequestMock.mockRejectedValueOnce(httpError(429, { "retry-after": "9" }));
    graphqlRequestMock.mockRejectedValueOnce(httpError(429, { "retry-after": "9" }));
    graphqlRequestMock.mockRejectedValue(httpError(429, { "retry-after": "9" }));

    const shopify = await shopifyClientFor(ctx);
    const assertion = expect(shopify.graphql("{ x }")).rejects.toBeInstanceOf(
      ShopifyRateLimitError,
    );
    await flushTimers();
    await assertion;
    // Exactly 2 attempts: initial + 1 retry, then budget gate fires.
    expect(graphqlRequestMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry THROTTLED that escapes the cost-throttle wrapper", async () => {
    // Cost-throttle wrapper exhausts → throws ShopifyRateLimitError. The outer
    // HTTP wrapper sees ShopifyRateLimitError and re-throws as-is without
    // burning a fresh round of attempts.
    const throttled = {
      response: {
        errors: [{ extensions: { code: "THROTTLED" }, message: "Throttled" }],
        extensions: {
          cost: {
            requestedQueryCost: 100,
            actualQueryCost: null,
            throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 },
          },
        },
      },
    };
    graphqlRequestMock.mockRejectedValue(throttled);

    const shopify = await shopifyClientFor(ctx);
    const assertion = expect(shopify.graphql("{ x }")).rejects.toBeInstanceOf(
      ShopifyRateLimitError,
    );
    await flushTimers();
    await assertion;
    // 5 = MAX_THROTTLE_RETRIES from the cost-throttle wrapper. Outer wrapper
    // recognized the typed terminal and didn't multiply retries.
    expect(graphqlRequestMock).toHaveBeenCalledTimes(5);
  });
});

// ── Storefront fetch path ──────────────────────────────────────────────────

describe("withRetry (HTTP) — storefront path", () => {
  function makeResp(
    status: number,
    body: unknown = { data: { ok: true } },
    headers: Record<string, string> = {},
  ) {
    const h = new Headers(headers);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: h,
      json: async () => body,
    } as unknown as Response;
  }

  it("retries fetch 503 then returns data", async () => {
    callPlatformServiceMock.mockResolvedValue({
      status: 200,
      body: { storefrontAccessToken: "sf-tok" },
    });
    fetchMock.mockResolvedValueOnce(makeResp(503));
    fetchMock.mockResolvedValueOnce(makeResp(200, { data: { ok: true } }));

    const shopify = await shopifyClientFor(ctx);
    const promise = shopify.storefront("{ shop { name } }");
    await flushTimers();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on Node-fetch network error", async () => {
    callPlatformServiceMock.mockResolvedValue({
      status: 200,
      body: { storefrontAccessToken: "sf-tok" },
    });
    fetchMock.mockRejectedValueOnce(networkError("ETIMEDOUT"));
    fetchMock.mockResolvedValueOnce(makeResp(200));

    const shopify = await shopifyClientFor(ctx);
    const promise = shopify.storefront("{ x }");
    await flushTimers();
    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws ShopifyRateLimitError after exhausting on 429", async () => {
    callPlatformServiceMock.mockResolvedValue({
      status: 200,
      body: { storefrontAccessToken: "sf-tok" },
    });
    fetchMock.mockResolvedValue(makeResp(429, undefined, { "retry-after": "1" }));

    const shopify = await shopifyClientFor(ctx);
    const assertion = expect(shopify.storefront("{ x }")).rejects.toMatchObject({
      name: "ShopifyRateLimitError",
      label: "storefront",
    });
    await flushTimers();
    await assertion;
  });

  it("does NOT retry storefront 401 (caller bug, not transient)", async () => {
    callPlatformServiceMock.mockResolvedValue({
      status: 200,
      body: { storefrontAccessToken: "sf-tok" },
    });
    fetchMock.mockResolvedValueOnce(makeResp(401));

    const shopify = await shopifyClientFor(ctx);
    await expect(shopify.storefront("{ x }")).rejects.toThrow(/status=401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
