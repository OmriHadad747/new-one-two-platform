import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

// Speed up bulkQuery polling for tests (the production constant is 3s).
beforeAll(() => {
  process.env["SHOPIFY_BULK_POLL_INTERVAL_MS"] = "1";
});
afterAll(() => {
  delete process.env["SHOPIFY_BULK_POLL_INTERVAL_MS"];
});

// ── @shopify/shopify-api SDK mock ─────────────────────────────────────────────
//
// We control the GraphQL client's `request` shape — every call from
// shopify.ts (graphql, graphqlPaginate, bulkQuery) ultimately hits this
// one mock, so we can drive throttle behavior, MAX_COST_EXCEEDED, and
// bulk-op polling end-to-end without touching the network.

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

const { shopifyClientFor } = await import("../src/lib/shopify.js");

beforeEach(() => {
  graphqlRequestMock.mockReset();
  callPlatformServiceMock.mockReset();
  fetchMock.mockReset();
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makeStream(body: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

function throttledError(currentlyAvailable = 0, requestedQueryCost = 100) {
  return {
    response: {
      errors: [
        { extensions: { code: "THROTTLED" }, message: "Throttled" },
      ],
      extensions: {
        cost: {
          requestedQueryCost,
          actualQueryCost: null,
          throttleStatus: {
            maximumAvailable: 1000,
            currentlyAvailable,
            restoreRate: 50,
          },
        },
      },
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("graphql throttle retry", () => {
  it("retries on THROTTLED then returns data", async () => {
    graphqlRequestMock.mockRejectedValueOnce(throttledError());
    graphqlRequestMock.mockResolvedValueOnce({ data: { ok: true } });

    const shopify = await shopifyClientFor({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
    });
    const result = await shopify.graphql("{ shop { name } }");

    expect(result).toEqual({ ok: true });
    expect(graphqlRequestMock).toHaveBeenCalledTimes(2);
  });

  it("throws clear MAX_COST_EXCEEDED error without retry", async () => {
    graphqlRequestMock.mockRejectedValue({
      response: {
        errors: [
          { extensions: { code: "MAX_COST_EXCEEDED" }, message: "Query cost too high" },
        ],
      },
    });
    const shopify = await shopifyClientFor({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
    });

    await expect(shopify.graphql("{ massive }")).rejects.toThrow(/MAX_COST_EXCEEDED/);
    expect(graphqlRequestMock).toHaveBeenCalledTimes(1);
  });

  it("re-throws non-throttle non-cost errors as-is", async () => {
    const err = new Error("network");
    graphqlRequestMock.mockRejectedValueOnce(err);
    const shopify = await shopifyClientFor({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
    });
    await expect(shopify.graphql("{ x }")).rejects.toBe(err);
    expect(graphqlRequestMock).toHaveBeenCalledTimes(1);
  });
});

describe("bulkQuery", () => {
  it("polls the SPECIFIC operationId returned by bulkOperationRunQuery", async () => {
    const opId = "gid://shopify/BulkOperation/12345";

    // Start mutation → return our operationId
    graphqlRequestMock.mockResolvedValueOnce({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: { id: opId, status: "CREATED" },
          userErrors: [],
        },
      },
    });
    // Status query → COMPLETED with no url (zero results)
    graphqlRequestMock.mockResolvedValueOnce({
      data: {
        node: {
          id: opId,
          status: "COMPLETED",
          errorCode: null,
          objectCount: "0",
          url: null,
        },
      },
    });

    const shopify = await shopifyClientFor({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
    });
    const collected: unknown[] = [];
    for await (const item of shopify.bulkQuery(
      "{ orders { edges { node { id } } } }",
    )) {
      collected.push(item);
    }
    expect(collected).toEqual([]);

    // Verify the second call (the status poll) targets node(id:$id), not
    // currentBulkOperation — this is the race fix the helper is designed to
    // deliver.
    const [secondQuery, secondOpts] = graphqlRequestMock.mock.calls[1] as [
      string,
      { variables?: { id?: string } } | undefined,
    ];
    expect(secondQuery).toContain("node(id: $id)");
    expect(secondQuery).not.toContain("currentBulkOperation");
    expect(secondOpts?.variables?.id).toBe(opId);
  });

  it("surfaces JSONL parse errors with line number + excerpt", async () => {
    const opId = "gid://shopify/BulkOperation/X";
    graphqlRequestMock.mockResolvedValueOnce({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: { id: opId, status: "CREATED" },
          userErrors: [],
        },
      },
    });
    graphqlRequestMock.mockResolvedValueOnce({
      data: {
        node: {
          id: opId,
          status: "COMPLETED",
          errorCode: null,
          objectCount: "2",
          url: "https://shopify-bulk.example/X.jsonl",
        },
      },
    });

    const body =
      '{"id":"gid://shopify/Order/1"}\nthis-is-not-json\n{"id":"gid://shopify/Order/2"}\n';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: makeStream(body),
    });

    const shopify = await shopifyClientFor({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
    });
    const collected: unknown[] = [];
    let caught: unknown = null;
    try {
      for await (const item of shopify.bulkQuery("{ }")) collected.push(item);
    } catch (e) {
      caught = e;
    }

    expect(collected).toHaveLength(1);
    expect(String(caught)).toMatch(/line 2/);
    expect(String(caught)).toMatch(/this-is-not-json/);
    expect(String(caught)).toMatch(opId);
  });

  it("times out and best-effort cancels when polling exceeds maxPollMs", async () => {
    const opId = "gid://shopify/BulkOperation/STUCK";
    graphqlRequestMock.mockResolvedValueOnce({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: { id: opId, status: "CREATED" },
          userErrors: [],
        },
      },
    });
    // Every status poll returns RUNNING — we never escape via COMPLETED.
    graphqlRequestMock.mockResolvedValue({
      data: {
        node: {
          id: opId,
          status: "RUNNING",
          errorCode: null,
          objectCount: "0",
          url: null,
        },
      },
    });

    const shopify = await shopifyClientFor({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
    });
    const promise = (async () => {
      for await (const _ of shopify.bulkQuery("{ }", { maxPollMs: 5 })) {
        // unreachable
      }
    })();
    await expect(promise).rejects.toThrow(/timeout after 5ms/);

    // Verify a cancel mutation was attempted (best-effort).
    const cancelCalled = graphqlRequestMock.mock.calls.some(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("bulkOperationCancel"),
    );
    expect(cancelCalled).toBe(true);
  });

  it("propagates userErrors from bulkOperationRunQuery", async () => {
    graphqlRequestMock.mockResolvedValueOnce({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ field: ["query"], message: "A bulk query operation is already in progress." }],
        },
      },
    });

    const shopify = await shopifyClientFor({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
    });
    const promise = (async () => {
      for await (const _ of shopify.bulkQuery("{ }")) { /* empty */ }
    })();
    await expect(promise).rejects.toThrow(/already in progress/);
  });
});
