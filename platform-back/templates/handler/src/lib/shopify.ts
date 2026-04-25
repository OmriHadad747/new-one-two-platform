import { shopifyApi, LATEST_API_VERSION, Session } from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node";
import { callPlatformService } from "./platform-call.js";

/**
 * Thrown when the HTTP-level retry wrapper around a Shopify call (REST,
 * GraphQL, or storefront fetch) exhausts its attempt budget on
 * rate-limit / transient-5xx / network errors. Handlers should catch
 * this specifically when they want to surface a degraded outcome
 * (e.g. nack a queue job for later retry) instead of letting it land
 * in the generic 500 path.
 *
 * Cost-based GraphQL throttles (THROTTLED extension) come from the same
 * wrapper hierarchy — `requestWithThrottleRetry` raises this error when
 * its own budget exhausts, so callers don't have to differentiate.
 */
export class ShopifyRateLimitError extends Error {
  readonly attempts: number;
  readonly status: number | undefined;
  readonly totalWaitMs: number;
  readonly label: string;
  constructor(
    message: string,
    opts: { label: string; attempts: number; status?: number; totalWaitMs: number },
  ) {
    super(message);
    this.name = "ShopifyRateLimitError";
    this.label = opts.label;
    this.attempts = opts.attempts;
    this.status = opts.status;
    this.totalWaitMs = opts.totalWaitMs;
  }
}

// Per-request Shopify client helper.
//
// Generator call sites look like:
//   const shopify = await shopifyClientFor(req.platform!);
//   const data = await shopify.graphql(`{ ... }`);
//
// On cron paths (no req) the generator calls shopifyClientFor() with no
// argument; the helper fetches the access token via
// callPlatformService({path: "/services/shopify/access-token"}) on cache
// miss and keeps it in a module-level variable for the lifetime of the
// container. A 401 response from Shopify invalidates the cache and
// triggers one automatic refetch + retry.

const api = shopifyApi({
  // The SDK requires apiKey/apiSecretKey at init even though we use
  // custom-app (access token) sessions — it only actually consumes them
  // for OAuth flows, which platform-back owns.
  apiKey: process.env["SHOPIFY_API_KEY"] ?? "unused-for-custom-app",
  apiSecretKey: process.env["SHOPIFY_API_SECRET"] ?? "unused-for-custom-app",
  scopes: [],
  hostName: "handler.internal",
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

// ─── Access-token cache (cron path only) ─────────────────────────────────────

let cachedAccessToken: string | null = null;

async function getAccessToken(hint?: string): Promise<string> {
  // HTTP path — platform-back stamped the token on the request header.
  if (hint) return hint;
  // Cron path — use the cache, refill from platform-back on miss.
  if (cachedAccessToken) return cachedAccessToken;
  const { status, body } = await callPlatformService<{ accessToken: string }>({
    path: "/services/shopify/access-token",
    body: {},
  });
  if (status !== 200 || !body?.accessToken) {
    throw new Error(
      `shopifyClientFor: failed to fetch access token from platform-back (status=${status})`,
    );
  }
  cachedAccessToken = body.accessToken;
  return cachedAccessToken;
}

function invalidateTokenCache(): void {
  cachedAccessToken = null;
}

function makeSession(shopDomain: string, accessToken: string): Session {
  return new Session({
    id: `${shopDomain}-handler`,
    shop: shopDomain,
    state: "",
    isOnline: false,
    accessToken,
  });
}

// ─── Public helper interface ─────────────────────────────────────────────────

export interface ShopifyHelper {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
  graphqlPaginate(
    query: string,
    variables: Record<string, unknown>,
    connectionPath: string,
  ): AsyncGenerator<unknown[], void, unknown>;
  /**
   * Async generator over a Shopify bulk operation result.
   * Starts the operation, polls until COMPLETED, downloads the JSONL, and
   * yields one parsed object per line. Use for large exports (100k+ rows)
   * or list reads where GraphQL query cost would be prohibitive.
   * Polling is bounded by `opts.maxPollMs` (default 15 min); on timeout
   * the operation is best-effort cancelled so the shop's bulk-op slot is
   * released.
   */
  bulkQuery(query: string, opts?: { maxPollMs?: number }): AsyncGenerator<unknown, void, unknown>;
  storefront(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Narrow structural type accepted by `shopifyClientFor`. `req.platform` from
 * the verify-platform middleware satisfies it (has `shopDomain` + `accessToken`
 * among other fields). Never construct this object by hand — either pass
 * `req.platform!` on HTTP paths or call `shopifyClientFor()` with no argument
 * on cron paths.
 */
export interface ShopifyClientContext {
  shopDomain: string;
  accessToken?: string;
}

export async function shopifyClientFor(platform?: ShopifyClientContext): Promise<ShopifyHelper> {
  const shopDomain = platform?.shopDomain ?? process.env["SHOP_DOMAIN"];
  if (!shopDomain) {
    throw new Error("shopifyClientFor: shopDomain not available");
  }
  const tokenHint = platform?.accessToken;

  // One-shot 401 retry: if the token we used is rejected, invalidate the
  // cache, refetch from platform-back, and run the operation once more.
  async function with401Retry<T>(op: (session: Session) => Promise<T>): Promise<T> {
    let token = await getAccessToken(tokenHint);
    try {
      return await op(makeSession(shopDomain!, token));
    } catch (err: unknown) {
      if (!is401(err)) throw err;
      invalidateTokenCache();
      // Even if the caller passed a hint, it's now known stale — fall through
      // to the service-backed refetch.
      token = await getAccessToken();
      return await op(makeSession(shopDomain!, token));
    }
  }

  // Hoisted so graphqlPaginate and bulkQuery can call it without wrestling
  // with method-this binding inside async generators. Three retry layers
  // stack here, each owning a distinct failure class:
  //   withRetry          — HTTP 429 + transient 5xx + network (TD-003)
  //   with401Retry       — one-shot token refresh on 401
  //   requestWithThrottleRetry — GraphQL cost-based THROTTLED extension
  // Callers see `data` on success or a thrown error after every layer
  // has exhausted its budget.
  async function graphqlImpl(query: string, variables?: Record<string, unknown>): Promise<unknown> {
    return withRetry("graphql", () =>
      with401Retry(async (session) => {
        const client = new api.clients.Graphql({ session });
        return requestWithThrottleRetry(client, query, variables);
      }),
    );
  }

  return {
    graphql: graphqlImpl,

    async *graphqlPaginate(
      query: string,
      variables: Record<string, unknown>,
      connectionPath: string,
    ): AsyncGenerator<unknown[], void, unknown> {
      let cursor: string | null = null;
      for (;;) {
        const data = (await graphqlImpl(query, {
          ...variables,
          cursor,
        })) as Record<string, unknown> | null;
        const conn = getByPath(data, connectionPath);
        if (!conn || typeof conn !== "object") {
          throw new Error(
            `shopifyClientFor.graphqlPaginate: connection not found at path "${connectionPath}"`,
          );
        }
        const edges = (conn as Record<string, unknown>)["edges"];
        const pageInfo = (conn as Record<string, unknown>)["pageInfo"] as
          | { hasNextPage?: boolean; endCursor?: string | null }
          | undefined;
        const nodes = Array.isArray(edges)
          ? edges.map((e) => (e as Record<string, unknown>)["node"])
          : [];
        yield nodes;
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        cursor = pageInfo.endCursor;
      }
    },

    async *bulkQuery(
      query: string,
      opts?: { maxPollMs?: number },
    ): AsyncGenerator<unknown, void, unknown> {
      const maxPollMs = opts?.maxPollMs ?? BULK_DEFAULT_MAX_POLL_MS;
      // Test/ops escape hatch — production uses BULK_POLL_INTERVAL_MS.
      const pollIntervalMs =
        Number(process.env["SHOPIFY_BULK_POLL_INTERVAL_MS"]) || BULK_POLL_INTERVAL_MS;

      // 1. Start the bulk operation and capture its id.
      const startResult = (await graphqlImpl(
        `mutation BulkOperationRun($query: String!) {
          bulkOperationRunQuery(query: $query) {
            bulkOperation { id status }
            userErrors { field message }
          }
        }`,
        { query },
      )) as Record<string, unknown> | null;

      const payload = (startResult?.["bulkOperationRunQuery"] ?? {}) as Record<string, unknown>;
      const userErrors = (payload["userErrors"] as unknown[]) ?? [];
      if (userErrors.length > 0) {
        throw new Error(
          `shopifyClientFor.bulkQuery: failed to start: ${JSON.stringify(userErrors)}`,
        );
      }
      const startedOp = (payload["bulkOperation"] as Record<string, unknown> | null) ?? null;
      const operationId = (startedOp?.["id"] as string | undefined) ?? null;
      if (!operationId) {
        throw new Error(
          "shopifyClientFor.bulkQuery: bulkOperationRunQuery returned no operation id",
        );
      }

      // 2. Poll the SPECIFIC operation by id until COMPLETED or FAILED.
      // Polling currentBulkOperation would race if the shop starts another
      // bulk op (admin action, parallel handler) between our start and our
      // first poll — we'd silently observe that other operation's status
      // and url. node(id:) scopes the poll to the op we actually started.
      const deadline = Date.now() + maxPollMs;
      let downloadUrl: string | null = null;

      for (;;) {
        if (Date.now() >= deadline) {
          // Best-effort cancel so the shop's "one bulk op at a time" slot
          // isn't held by our orphaned operation past this handler's life.
          void graphqlImpl(
            `mutation BulkCancel($id: ID!) {
              bulkOperationCancel(id: $id) { bulkOperation { id status } }
            }`,
            { id: operationId },
          ).catch(() => undefined);
          throw new Error(
            `shopifyClientFor.bulkQuery: timeout after ${maxPollMs}ms (operationId=${operationId})`,
          );
        }
        await sleepMs(pollIntervalMs);

        const statusResult = (await graphqlImpl(
          `query BulkOpStatus($id: ID!) {
            node(id: $id) {
              ... on BulkOperation { id status errorCode objectCount url }
            }
          }`,
          { id: operationId },
        )) as Record<string, unknown> | null;

        const op = (statusResult?.["node"] ?? null) as Record<string, unknown> | null;
        if (!op) {
          throw new Error(
            `shopifyClientFor.bulkQuery: operation ${operationId} not found while polling`,
          );
        }
        const status = op["status"] as string;
        if (status === "COMPLETED") {
          downloadUrl = (op["url"] as string | null) ?? null;
          break;
        }
        if (status === "FAILED" || status === "CANCELED") {
          throw new Error(
            `shopifyClientFor.bulkQuery: operation ${status} — errorCode: ${op["errorCode"]} (operationId=${operationId})`,
          );
        }
        // CREATED | RUNNING | CANCELING — keep polling
      }

      if (!downloadUrl) return; // zero results

      // 3. Download JSONL and yield one object per line. JSON.parse is
      // wrapped per line so a single corrupted line surfaces with line
      // number + excerpt instead of an opaque SyntaxError mid-stream.
      // The fetch itself is retried for HTTP 429 / 5xx / network — the
      // bulk-op URL is a Google Cloud Storage signed link with a finite
      // TTL, so we don't loop forever.
      const resp = await fetchWithRetry("bulkQuery.download", downloadUrl);
      if (!resp.ok || !resp.body) {
        throw new Error(
          `shopifyClientFor.bulkQuery: JSONL download failed (status=${resp.status})`,
        );
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lineNumber = 0;

      const parseLine = (raw: string): unknown => {
        lineNumber += 1;
        try {
          return JSON.parse(raw);
        } catch (err) {
          const excerpt = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
          throw new Error(
            `shopifyClientFor.bulkQuery: JSONL parse error at line ${lineNumber} ` +
              `(operationId=${operationId}): ${(err as Error).message} — ` +
              `line: ${JSON.stringify(excerpt)}`,
          );
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) yield parseLine(trimmed);
        }
      }
      const remaining = buffer.trim();
      if (remaining) yield parseLine(remaining);
    },

    async storefront(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      // Storefront uses a SEPARATE access token (public, scoped to unauthed
      // shopper context). platform-back mints it at OAuth time alongside the
      // admin access token and exposes it via a dedicated /services/ endpoint.
      const { status, body } = await callPlatformService<{
        storefrontAccessToken: string;
      }>({
        path: "/services/shopify/storefront-access-token",
        body: {},
      });
      if (status !== 200 || !body?.storefrontAccessToken) {
        throw new Error(
          `shopifyClientFor.storefront: failed to fetch storefront access token (status=${status})`,
        );
      }
      const url = `https://${shopDomain}/api/${LATEST_API_VERSION}/graphql.json`;
      const resp = await fetchWithRetry("storefront", url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": body.storefrontAccessToken,
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });
      if (!resp.ok) {
        throw new Error(`shopifyClientFor.storefront: fetch failed (status=${resp.status})`);
      }
      const json = (await resp.json()) as {
        data?: unknown;
        errors?: unknown[];
      };
      if (json.errors && json.errors.length > 0) {
        throw new Error(
          `shopifyClientFor.storefront: graphql errors: ${JSON.stringify(json.errors)}`,
        );
      }
      return json.data;
    },
  };
}

// ─── Bulk-operation polling ──────────────────────────────────────────────────

const BULK_POLL_INTERVAL_MS = 3_000;
// Bulk operations are bounded server-side at 24h, but a handler is a
// short-lived request — block it for at most 15 min by default so a stuck
// RUNNING op doesn't pin the container forever. Override per-call via
// `bulkQuery(query, { maxPollMs })` for deliberately long exports.
const BULK_DEFAULT_MAX_POLL_MS = 15 * 60_000;

// ─── HTTP-level retry: 429 / 5xx / network ──────────────────────────────────
//
// Sits ABOVE with401Retry and ABOVE the GraphQL cost-throttle wrapper. Every
// upstream Shopify call (graphql, storefront fetch, bulk JSONL download) goes
// through this — generated handler code MUST NOT roll its own setTimeout
// retry loop around shopify.* calls.
//
// Policy (uniform, not configurable):
//   - 4 attempts total (1 initial + 3 retries).
//   - Retry on: HTTP 429; HTTP 502/503/504; network errors (ECONNRESET,
//     ETIMEDOUT, ENOTFOUND, EAI_AGAIN, ECONNREFUSED, EPIPE, ENETUNREACH).
//   - 429 delay: Retry-After header (seconds OR HTTP-date, RFC 7231) when
//     present and parseable. Otherwise full-jitter exponential.
//   - 5xx / network delay: full-jitter exponential — random_between(0, cap)
//     where cap follows 500ms · 1s · 2s · 4s.
//   - Total sleep budget: 10 s across all retries. Past the cap, throw.
//   - Anything else (4xx other than 429, MAX_COST_EXCEEDED, THROTTLED that
//     escaped the inner cost-throttle wrapper) bubbles unmodified — those
//     are caller bugs or "rate-limited beyond what an additional retry can
//     fix" terminals.
//
// On give-up the wrapper raises ShopifyRateLimitError — handlers can catch
// that specifically without distinguishing 429 from a transient 503.

const RETRY_MAX_ATTEMPTS = 4;
const RETRY_TOTAL_BUDGET_MS = 10_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_BACKOFF_CAP_MS = 4_000;
const RETRY_RETRYABLE_HTTP_STATUSES = new Set<number>([429, 502, 503, 504]);
const RETRY_NETWORK_ERROR_CODES = new Set<string>([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

interface TransientInfo {
  status?: number;
  networkError: boolean;
  retryAfterMs?: number;
}

function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  // Integer / decimal seconds (the common form Shopify emits).
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  // HTTP-date — clamp negative deltas to 0 so a clock-skewed past timestamp
  // doesn't make us spin without sleeping.
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    const delta = ts - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (typeof (headers as { get?: unknown }).get === "function") {
    const val = (headers as { get: (k: string) => string | null }).get(name);
    return typeof val === "string" ? val : null;
  }
  if (typeof headers === "object") {
    const obj = headers as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() === lower) {
        const v = obj[key];
        return typeof v === "string" ? v : null;
      }
    }
  }
  return null;
}

function isCostThrottledError(err: unknown): boolean {
  // GraphQL THROTTLED extension — the cost-throttle wrapper owns this. If
  // it bubbles up here, the inner wrapper already exhausted its budget and
  // an additional retry at this layer adds latency without fixing
  // anything; better to surface immediately.
  if (!err || typeof err !== "object") return false;
  const anyErr = err as {
    response?: { errors?: unknown };
    body?: { errors?: unknown };
    errors?: unknown;
  };
  const responseLike = anyErr.response ?? anyErr.body ?? anyErr;
  const errors = (responseLike as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    if (!e || typeof e !== "object") return false;
    return (e as { extensions?: { code?: string } }).extensions?.code === "THROTTLED";
  });
}

function classifyTransient(err: unknown): TransientInfo | null {
  if (err instanceof ShopifyRateLimitError) return null; // already terminal
  if (!err || typeof err !== "object") return null;
  if (isCostThrottledError(err)) return null;
  if (extractMaxCostExceeded(err)) return null;

  const anyErr = err as {
    response?: { code?: number; statusCode?: number; status?: number; headers?: unknown };
    code?: unknown;
    status?: number;
    statusCode?: number;
    cause?: unknown;
  };
  const responseObj = anyErr.response;
  const status =
    responseObj?.code ??
    responseObj?.statusCode ??
    responseObj?.status ??
    (typeof anyErr.status === "number" ? anyErr.status : undefined) ??
    (typeof anyErr.statusCode === "number" ? anyErr.statusCode : undefined);

  if (typeof status === "number" && RETRY_RETRYABLE_HTTP_STATUSES.has(status)) {
    let retryAfterMs: number | undefined;
    if (status === 429) {
      const parsed = parseRetryAfter(readHeader(responseObj?.headers, "retry-after"));
      if (parsed != null) retryAfterMs = parsed;
    }
    const out: TransientInfo = { status, networkError: false };
    if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
    return out;
  }

  // Network error codes can live on the error itself (legacy) or in `.cause`
  // (Node 20 fetch wraps the underlying socket error there).
  const directCode = typeof anyErr.code === "string" ? anyErr.code : null;
  if (directCode && RETRY_NETWORK_ERROR_CODES.has(directCode)) {
    return { networkError: true };
  }
  const cause = anyErr.cause;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string" && RETRY_NETWORK_ERROR_CODES.has(causeCode)) {
      return { networkError: true };
    }
  }

  return null;
}

function computeBackoffDelay(attempt: number): number {
  // Full jitter — random_between(0, cap_for_attempt).
  // Cap doubles each attempt, clamped at RETRY_BACKOFF_CAP_MS.
  const cap = Math.min(
    RETRY_BACKOFF_CAP_MS,
    RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
  );
  return Math.floor(Math.random() * (cap + 1));
}

async function withRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
  let totalWaitMs = 0;
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (err) {
      const transient = classifyTransient(err);
      if (!transient) throw err;
      lastStatus = transient.status;

      const isFinalAttempt = attempt === RETRY_MAX_ATTEMPTS;
      const delay = transient.retryAfterMs ?? computeBackoffDelay(attempt);
      const overBudget = totalWaitMs + delay > RETRY_TOTAL_BUDGET_MS;

      console.warn(
        {
          event: "shopify_retry",
          label,
          attempt,
          delayMs: delay,
          status: transient.status,
          networkError: transient.networkError,
          retryAfter: transient.retryAfterMs,
          totalWaitMs,
          giveUp: isFinalAttempt || overBudget,
        },
        "Shopify call hit a transient failure",
      );

      if (isFinalAttempt || overBudget) break;

      await sleepMs(delay);
      totalWaitMs += delay;
    }
  }
  const opts: { label: string; attempts: number; status?: number; totalWaitMs: number } = {
    label,
    attempts: RETRY_MAX_ATTEMPTS,
    totalWaitMs,
  };
  if (lastStatus !== undefined) opts.status = lastStatus;
  throw new ShopifyRateLimitError(
    `shopifyClientFor.${label}: gave up after ${RETRY_MAX_ATTEMPTS} attempts ` +
      `(totalWaitMs=${totalWaitMs}, lastStatus=${lastStatus ?? "n/a"})`,
    opts,
  );
}

async function fetchWithRetry(
  label: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return withRetry(label, async () => {
    const resp = await fetch(url, init);
    if (RETRY_RETRYABLE_HTTP_STATUSES.has(resp.status)) {
      // Surface as a thrown error shaped like an SDK HttpResponseError so
      // classifyTransient can pull headers + status off the same shape.
      const err = new Error(`${label}: HTTP ${resp.status}`) as Error & {
        response?: { code: number; headers: Record<string, string> };
      };
      const headerObj: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headerObj[k.toLowerCase()] = v;
      });
      err.response = { code: resp.status, headers: headerObj };
      throw err;
    }
    return resp;
  });
}

// ─── Throttle-aware retry ────────────────────────────────────────────────────
//
// Shopify's GraphQL Admin API uses a cost-based rate limiter (default
// 1000 pt bucket, 50 pts/sec restore). Two scenarios handled here:
//
//   - Hard throttle: response contains errors[].extensions.code === "THROTTLED"
//     (the SDK surfaces this as a thrown error with the response attached).
//     Sleep proportionally to the restoreRate, then retry.
//   - Soft throttle: the call succeeded but currentlyAvailable is low
//     relative to what the caller just requested — preemptively sleep before
//     returning so the caller's next call has budget.
//
// Handler code never interacts with cost fields. The preemptive sleep costs
// latency in the rare bursty case and prevents cascading throttle errors
// under steady-state load.

const MAX_THROTTLE_RETRIES = 5;
const MAX_THROTTLE_TOTAL_WAIT_MS = 30_000;
const SOFT_THROTTLE_MULTIPLIER = 2; // sleep when currentlyAvailable < requested * this
const MIN_THROTTLE_WAIT_MS = 500;
const DEFAULT_HARD_THROTTLE_WAIT_MS = 2_000;
const HARD_THROTTLE_SAFETY_PAD_MS = 500;

interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface ShopifyCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ShopifyThrottleStatus;
}

async function requestWithThrottleRetry(
  client: InstanceType<typeof api.clients.Graphql>,
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  // Soft-throttle pre-sleeps and hard-throttle retry sleeps intentionally
  // share the same budget. A run that burns most of the budget on pre-emptive
  // soft-throttle waits will exhaust the hard-throttle retries sooner — the
  // combined cap bounds total wall-clock time regardless of which path fires.
  let totalWaitedMs = 0;

  for (let attempt = 1; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
    try {
      const resp = (await client.request<Record<string, unknown>>(query, {
        ...(variables ? { variables } : {}),
      })) as { data?: unknown; extensions?: { cost?: ShopifyCost } };

      // Soft throttle — sleep now so the next call has budget.
      const cost = resp.extensions?.cost;
      if (cost && isSoftThrottled(cost)) {
        const wait = computeSoftThrottleWait(cost);
        if (wait > 0 && totalWaitedMs + wait <= MAX_THROTTLE_TOTAL_WAIT_MS) {
          console.warn(
            {
              event: "shopify_graphql_soft_throttle",
              waitMs: wait,
              currentlyAvailable: cost.throttleStatus.currentlyAvailable,
              requestedQueryCost: cost.requestedQueryCost,
            },
            "Shopify GraphQL soft throttle — preemptive sleep",
          );
          await sleepMs(wait);
          totalWaitedMs += wait;
        }
      }

      return resp.data;
    } catch (err: unknown) {
      // MAX_COST_EXCEEDED is non-retryable — the query itself is over
      // Shopify's hard per-request cap. Surface it cleanly so the caller
      // can split the query (smaller `first:`, fewer nested connections,
      // or switch to bulkQuery) instead of looping until exhausted.
      if (extractMaxCostExceeded(err)) {
        throw new Error(
          "shopifyClientFor.graphql: MAX_COST_EXCEEDED — query cost " +
            "exceeds Shopify's per-request limit. Reduce nesting / page " +
            "size, or use shopify.bulkQuery for large reads.",
        );
      }
      const throttle = extractThrottleInfo(err);
      if (!throttle) throw err;

      const wait = computeHardThrottleWait(throttle.cost);
      const exhausted =
        attempt >= MAX_THROTTLE_RETRIES || totalWaitedMs + wait > MAX_THROTTLE_TOTAL_WAIT_MS;

      console.warn(
        {
          event: "shopify_graphql_throttled",
          attempt,
          waitMs: wait,
          exhausted,
        },
        "Shopify GraphQL throttled",
      );

      if (exhausted) {
        // Surface as ShopifyRateLimitError so callers see a single typed
        // terminal regardless of whether the cost-throttle wrapper or the
        // outer HTTP-level wrapper exhausted first. The original SDK error
        // is preserved as `cause` for diagnostics.
        const rateErr = new ShopifyRateLimitError(
          "shopifyClientFor.graphql: cost-based THROTTLED retries exhausted " +
            `(attempt=${attempt}, totalWaitedMs=${totalWaitedMs}, ` +
            `lastWaitMs=${wait})`,
          {
            label: "graphql.throttle",
            attempts: attempt,
            totalWaitMs: totalWaitedMs,
          },
        );
        (rateErr as Error & { cause?: unknown }).cause = err;
        throw rateErr;
      }

      await sleepMs(wait);
      totalWaitedMs += wait;
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error("shopifyClientFor.graphql: throttle retry loop exited unexpectedly");
}

function isSoftThrottled(cost: ShopifyCost): boolean {
  const target = cost.requestedQueryCost * SOFT_THROTTLE_MULTIPLIER;
  return cost.throttleStatus.currentlyAvailable < target;
}

function computeSoftThrottleWait(cost: ShopifyCost): number {
  const target = cost.requestedQueryCost * SOFT_THROTTLE_MULTIPLIER;
  const deficit = target - cost.throttleStatus.currentlyAvailable;
  if (deficit <= 0 || cost.throttleStatus.restoreRate <= 0) return 0;
  const waitMs = Math.ceil((deficit / cost.throttleStatus.restoreRate) * 1000);
  return Math.max(MIN_THROTTLE_WAIT_MS, waitMs);
}

function computeHardThrottleWait(cost?: ShopifyCost): number {
  if (!cost || cost.throttleStatus.restoreRate <= 0) {
    return DEFAULT_HARD_THROTTLE_WAIT_MS;
  }
  const deficit = Math.max(cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable, 1);
  const waitMs = Math.ceil((deficit / cost.throttleStatus.restoreRate) * 1000);
  return Math.max(MIN_THROTTLE_WAIT_MS, waitMs + HARD_THROTTLE_SAFETY_PAD_MS);
}

function extractThrottleInfo(err: unknown): { cost?: ShopifyCost } | null {
  if (!err || typeof err !== "object") return null;
  const anyErr = err as {
    response?: {
      errors?: unknown;
      extensions?: { cost?: ShopifyCost };
      code?: number;
      statusCode?: number;
    };
    body?: { errors?: unknown; extensions?: { cost?: ShopifyCost } };
    errors?: unknown;
    extensions?: { cost?: ShopifyCost };
    code?: number;
  };

  const responseLike = anyErr.response ?? anyErr.body ?? anyErr;
  const errors = (responseLike as { errors?: unknown }).errors;
  const cost = (responseLike as { extensions?: { cost?: ShopifyCost } }).extensions?.cost;

  if (Array.isArray(errors)) {
    const isThrottled = errors.some((e) => {
      if (!e || typeof e !== "object") return false;
      const entry = e as { extensions?: { code?: string }; message?: string };
      if (entry.extensions?.code === "THROTTLED") return true;
      if (typeof entry.message === "string" && entry.message.toLowerCase().includes("throttled"))
        return true;
      return false;
    });
    if (isThrottled) return cost ? { cost } : {};
  }

  // HTTP 429 is handled by the outer withRetry wrapper (TD-003) — it knows
  // how to honor Retry-After and counts attempts against the per-call
  // budget. Don't double-handle it here.

  return null;
}

function extractMaxCostExceeded(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as {
    response?: { errors?: unknown };
    body?: { errors?: unknown };
    errors?: unknown;
  };
  const responseLike = anyErr.response ?? anyErr.body ?? anyErr;
  const errors = (responseLike as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    if (!e || typeof e !== "object") return false;
    return (e as { extensions?: { code?: string } }).extensions?.code === "MAX_COST_EXCEEDED";
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Internals ───────────────────────────────────────────────────────────────

function is401(err: unknown): boolean {
  if (err && typeof err === "object") {
    const anyErr = err as { response?: { code?: number; statusCode?: number }; code?: number };
    if (anyErr.response?.code === 401) return true;
    if (anyErr.response?.statusCode === 401) return true;
    if (anyErr.code === 401) return true;
  }
  return false;
}

function getByPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}
