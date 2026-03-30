const GCP_PROJECT = process.env["GCP_PROJECT"] ?? process.env["GOOGLE_CLOUD_PROJECT"] ?? "local";
const GCP_REGION = process.env["GCP_REGION"] ?? "us-central1";
const DOCKER_REGISTRY = process.env["DOCKER_REGISTRY"] ?? `gcr.io/${GCP_PROJECT}`;

export function cloudRunServiceName(appId: string): string {
  // Cloud Run service names must be lowercase letters, digits, or hyphens, max 49 chars
  return `app-${appId.toLowerCase()}`;
}

export function dockerImageName(appId: string, semver: string): string {
  return `${DOCKER_REGISTRY}/harness-${appId.toLowerCase()}:${semver}`;
}

export function localContainerName(appId: string): string {
  return `harness-${appId.toLowerCase()}`;
}

export function cloudRunParent(): string {
  return `projects/${GCP_PROJECT}/locations/${GCP_REGION}`;
}

export function cloudRunServicePath(appId: string): string {
  return `${cloudRunParent()}/services/${cloudRunServiceName(appId)}`;
}

export function callbackUrl(tenantSlug: string, appSlug: string): string {
  const base = process.env["WEBHOOK_BASE_URL"] ?? "http://localhost:3001";
  return `${base}/webhook/${tenantSlug}/${appSlug}`;
}

export const GCP_REGION_VALUE = GCP_REGION;
export const GCP_PROJECT_VALUE = GCP_PROJECT;
