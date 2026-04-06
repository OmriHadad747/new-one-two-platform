// ─── API Request/Response DTOs ────────────────────────────────────────────────
// HTTP request bodies for apps/api endpoints.
// Consumed by: apps/api

/** POST /tenants request body. */
export interface CreateTenantRequest {
  /** Supply a fixed UUID for reproducible local dev/testing. Omit to auto-generate. */
  id?: string;
  slug: string;
  name: string;
  plan?: string; // default: "starter"
}

/** POST /tenants/:tenantId/apps request body. */
export interface CreateAppRequest {
  /** Supply a fixed UUID for reproducible local dev/testing. Omit to auto-generate. */
  id?: string;
  slug: string;
  name: string;
}

/** POST /generation request body (apps/api). */
export interface StartGenerationRequest {
  appId: string;
  tenantId: string;
  prompt: string;
}

/** POST /generation/:jobId/revise request body. */
export interface ReviseGenerationRequest {
  feedback: string;
}
