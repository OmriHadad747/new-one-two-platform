import type {
  Tenant,
  App,
  StartGenerationRequest,
  StartGenerationResponse,
} from "@/types/dashboard";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── Tenants ─────────────────────────────────────────────────────────────────

export const api = {
  tenants: {
    get: (tenantId: string) => request<Tenant>(`/tenants/${tenantId}`),
    create: (body: { slug: string; name: string; plan?: string }) =>
      request<Tenant>("/tenants", { method: "POST", body: JSON.stringify(body) }),
  },

  apps: {
    get: (tenantId: string, appId: string) =>
      request<App>(`/tenants/${tenantId}/apps/${appId}`),
    create: (tenantId: string, body: { slug: string; name: string }) =>
      request<App>(`/tenants/${tenantId}/apps`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },

  generation: {
    start: (body: StartGenerationRequest) =>
      request<StartGenerationResponse>("/generation", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    result: (jobId: string) =>
      request<{ status: string; bundle?: unknown }>(`/generation/${jobId}/result`),
    approve: (jobId: string) =>
      request<{ deployed: boolean }>(`/generation/${jobId}/approve`, {
        method: "POST",
        body: "{}",
      }),
    revise: (jobId: string, feedback: string) =>
      request<StartGenerationResponse>(`/generation/${jobId}/revise`, {
        method: "POST",
        body: JSON.stringify({ feedback }),
      }),
    /** Returns an EventSource for SSE progress stream */
    progressStream: (jobId: string) =>
      new EventSource(`${BASE}/generation/${jobId}/progress`),
  },
} as const;
