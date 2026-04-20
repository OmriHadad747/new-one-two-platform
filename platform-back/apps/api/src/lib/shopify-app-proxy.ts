import { createHmac, timingSafeEqual } from "node:crypto";

// Shopify App Proxy request signing.
// https://shopify.dev/docs/apps/build/online-store/display-dynamic-data#calculate-a-digital-signature
//
// Storefront widget traffic traverses Shopify's App Proxy. Shopify
// HMAC-signs the outbound query string with the app's client secret,
// then appends `signature=<hex>`. We recompute the same HMAC over every
// query param except `signature`, alphabetically sorted, concatenated
// as `key=value` pairs with NO separator (Shopify's spec — unusual,
// but that's the format).
//
// Once the signature verifies, every other query param is trusted:
// `shop`, `logged_in_customer_id`, `timestamp`, `path_prefix`, etc. The
// caller reads these from the returned claims — never from the raw
// request — so we don't accidentally trust attacker-controlled values
// when a signature check is skipped.

export interface ShopifyAppProxyClaims {
  /** Verified shop domain, e.g. "acme.myshopify.com". */
  shop: string;
  /** Shopify customer id of the signed-in visitor, or null for guests. */
  loggedInCustomerId: string | null;
  /** App Proxy path prefix (`/apps/<your-slug>`) Shopify is forwarding from. */
  pathPrefix: string | null;
  /** Unix seconds when Shopify signed the request. */
  timestamp: number;
}

// App Proxy requests are replay-capable — Shopify will happily resign and
// re-send the same URL if the storefront retries. A strict window caps
// the replay surface without breaking normal retries.
const MAX_TIMESTAMP_SKEW_SEC = 5 * 60;

const SHOP_DOMAIN_RE = /^[a-z0-9-]+\.myshopify\.com$/;

export function verifyShopifyAppProxy(
  query: Record<string, string | string[] | undefined>,
  clientSecret: string,
): ShopifyAppProxyClaims | null {
  if (!clientSecret) return null;

  const sigRaw = query["signature"];
  const signature = typeof sigRaw === "string" ? sigRaw : null;
  if (!signature) return null;

  // Canonical string: sort keys (excluding `signature`), concatenate as
  // `key=value` with NO separator. Array values are comma-joined.
  const keys = Object.keys(query)
    .filter((k) => k !== "signature" && query[k] !== undefined)
    .sort();
  const canonical = keys
    .map((k) => {
      const v = query[k];
      const joined = Array.isArray(v) ? v.join(",") : (v ?? "");
      return `${k}=${joined}`;
    })
    .join("");

  const expectedHex = createHmac("sha256", clientSecret)
    .update(canonical)
    .digest("hex");

  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex, "hex");
    actualBuf = Buffer.from(signature, "hex");
  } catch {
    return null;
  }
  if (expectedBuf.length === 0) return null;
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return null;

  // Signature verified — the rest of the query is now trusted.
  const shopRaw =
    typeof query["shop"] === "string" ? query["shop"].toLowerCase() : "";
  if (!SHOP_DOMAIN_RE.test(shopRaw)) return null;

  const tsRaw = typeof query["timestamp"] === "string" ? query["timestamp"] : "";
  const timestamp = parseInt(tsRaw, 10);
  if (!Number.isFinite(timestamp)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_SKEW_SEC) return null;

  const loggedInRaw = query["logged_in_customer_id"];
  const loggedInCustomerId =
    typeof loggedInRaw === "string" && loggedInRaw.length > 0
      ? loggedInRaw
      : null;

  const pathPrefixRaw = query["path_prefix"];
  const pathPrefix =
    typeof pathPrefixRaw === "string" && pathPrefixRaw.length > 0
      ? pathPrefixRaw
      : null;

  return {
    shop: shopRaw,
    loggedInCustomerId,
    pathPrefix,
    timestamp,
  };
}
