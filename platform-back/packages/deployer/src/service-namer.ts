// All naming for handler infrastructure: Cloud Run service, image tag,
// service-account local part. Keep this file the single source of truth
// — the SA name format is also baked into apps.handler_sa_email which
// platform-back's /services/* routes look up.

const GCP_PROJECT =
  process.env["GCP_PROJECT"] ??
  process.env["GOOGLE_CLOUD_PROJECT"] ??
  "local";
const GCP_REGION = process.env["GCP_REGION"] ?? "us-central1";
const DOCKER_REGISTRY =
  process.env["DOCKER_REGISTRY"] ?? `gcr.io/${GCP_PROJECT}`;

// ─── Cloud Run service ───────────────────────────────────────────────────────
//
// One service per (tenant, app). Name is based on appId so it's stable
// across redeploys (Cloud Run updates the same service, doesn't create
// a new one). Cloud Run names: lowercase letters/digits/hyphens, max 49.

export function cloudRunServiceName(appId: string): string {
  return `app-${appId.toLowerCase()}`;
}

export function cloudRunServicePath(appId: string): string {
  return `${cloudRunParent()}/services/${cloudRunServiceName(appId)}`;
}

export function cloudRunParent(): string {
  return `projects/${GCP_PROJECT}/locations/${GCP_REGION}`;
}

// ─── Container image ─────────────────────────────────────────────────────────

export function dockerImageName(appId: string, version: string): string {
  return `${DOCKER_REGISTRY}/handler-${appId.toLowerCase()}:${version}`;
}

// ─── Handler service account ─────────────────────────────────────────────────
//
// Format: `h-<shopPrefix>-<n>` — written into apps.handler_sa_email at
// deploy time so /services/* routes can map a verified ID-token email
// back to (tenantId, appId). GCP local-part limit is 30 chars; with
// `h-` prefix and `-<n>` suffix (n up to 9999), shop prefix can be up to
// 24 chars.

const SA_LOCAL_MAX = 30;
const SA_PREFIX = "h-";
const MAX_PER_SHOP_COUNTER_DIGITS = 4;
const MAX_SHOP_PREFIX_LEN =
  SA_LOCAL_MAX - SA_PREFIX.length - 1 /* dash */ - MAX_PER_SHOP_COUNTER_DIGITS;

/**
 * Sanitize a Shopify shop domain into the `<shopPrefix>` segment.
 * "acme-store.myshopify.com" → "acmestore"
 * Stripped of `.myshopify.com`, lowercased, non-alphanumerics removed,
 * truncated to MAX_SHOP_PREFIX_LEN.
 */
export function sanitizeShopPrefix(shopDomain: string): string {
  const stripped = shopDomain.toLowerCase().replace(/\.myshopify\.com$/, "");
  const compact = stripped.replace(/[^a-z0-9]/g, "");
  return compact.slice(0, MAX_SHOP_PREFIX_LEN);
}

/**
 * Build the SA local-part for a given shop + per-shop counter.
 * `n` is 1-based; provisioner picks the next available value by
 * counting existing handler SAs for the shop.
 */
export function handlerSaLocalPart(shopDomain: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`handlerSaLocalPart: n must be a positive integer, got ${n}`);
  }
  const prefix = sanitizeShopPrefix(shopDomain);
  if (prefix.length === 0) {
    throw new Error(
      `handlerSaLocalPart: shop "${shopDomain}" produced an empty prefix`,
    );
  }
  const local = `${SA_PREFIX}${prefix}-${n}`;
  if (local.length > SA_LOCAL_MAX) {
    throw new Error(
      `handlerSaLocalPart: name "${local}" exceeds ${SA_LOCAL_MAX} chars`,
    );
  }
  return local;
}

export function handlerSaEmail(shopDomain: string, n: number): string {
  return `${handlerSaLocalPart(shopDomain, n)}@${GCP_PROJECT}.iam.gserviceaccount.com`;
}

// ─── Exported config (for downstream modules) ────────────────────────────────

export const GCP_PROJECT_VALUE = GCP_PROJECT;
export const GCP_REGION_VALUE = GCP_REGION;
export const DOCKER_REGISTRY_VALUE = DOCKER_REGISTRY;
