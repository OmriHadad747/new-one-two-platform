import type {
  Tenant,
  App,
  TenantStats,
  WebhookInvocationLogEntry,
  InvocationLogEntry,
  StartGenerationRequest,
  StartGenerationResponse,
  GenerationResult,
  LatestSessionResult,
  AnalyzeMessage,
  AnalyzeResult,
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

export const api = {
  tenants: {
    get: (tenantId: string) =>
      request<Tenant>(`/tenants/${tenantId}`),
    create: (body: { slug: string; name: string; plan?: string }) =>
      request<Tenant>("/tenants", { method: "POST", body: JSON.stringify(body) }),
    stats: (tenantId: string) =>
      request<TenantStats>(`/tenants/${tenantId}/stats`),
    logs: (tenantId: string, limit = 20) =>
      request<WebhookInvocationLogEntry[]>(`/tenants/${tenantId}/logs?limit=${limit}`),
  },

  apps: {
    list: (tenantId: string) =>
      request<App[]>(`/tenants/${tenantId}/apps`),
    get: (tenantId: string, appId: string) =>
      request<App>(`/tenants/${tenantId}/apps/${appId}`),
    create: (tenantId: string, body: { slug: string; name: string }) =>
      request<App>(`/tenants/${tenantId}/apps`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    rename: (tenantId: string, appId: string, name: string) =>
      request<App>(`/tenants/${tenantId}/apps/${appId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    setStatus: (tenantId: string, appId: string, status: "active" | "inactive") =>
      request<App>(`/tenants/${tenantId}/apps/${appId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    delete: (tenantId: string, appId: string) =>
      request<App>(`/tenants/${tenantId}/apps/${appId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "deleted" }),
      }),
    widgetLogs: (tenantId: string, appId: string, limit = 50) =>
      request<InvocationLogEntry[]>(`/tenants/${tenantId}/apps/${appId}/widget-logs?limit=${limit}`),
    adminLogs: (tenantId: string, appId: string, limit = 50) =>
      request<InvocationLogEntry[]>(`/tenants/${tenantId}/apps/${appId}/admin-logs?limit=${limit}`),
  },

  generation: {
    start: (body: StartGenerationRequest) =>
      request<StartGenerationResponse>("/generation", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    result: (jobId: string) =>
      request<GenerationResult>(`/generation/${jobId}/result`),
    latestSession: (appId: string) =>
      request<LatestSessionResult>(`/generation/app/${appId}/latest`),
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
    progressStream: (jobId: string) =>
      new EventSource(`${BASE}/generation/${jobId}/progress`),
    analyze: (history: AnalyzeMessage[]) =>
      request<AnalyzeResult>("/generation/analyze", {
        method: "POST",
        body: JSON.stringify({ history }),
      }),
    cancel: (jobId: string) =>
      request<{ ok: boolean }>(`/generation/${jobId}/cancel`, { method: "POST", body: "{}" }),
  },
  widgets: {
    /**
     * Fire a manual test event against a deployed app handler.
     * Routes through the existing widget proxy → Cloud Run function.
     */
    trigger: (shopDomain: string, appId: string, payload: Record<string, unknown> = {}) =>
      request<Record<string, unknown>>(`/widgets/${encodeURIComponent(shopDomain)}/${appId}/widget/trigger`, {
        method: "POST",
        body: JSON.stringify({ test: true, ...payload }),
      }),
  },
} as const;
