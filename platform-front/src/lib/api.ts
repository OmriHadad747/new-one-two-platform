import type {
  Tenant,
  App,
  TenantStats,
  BillingUsageResponse,
  WebhookInvocationLogEntry,
  InvocationLogEntry,
  StartGenerationRequest,
  StartGenerationResponse,
  GenerationResult,
  LatestSessionResult,
  SessionSummary,
  AnalyzeMessage,
  AnalyzeResult,
  ThemeTemplatesResponse,
  InjectionTarget,
  InjectThemeResponse,
  EmailConfigResponse,
  EmailConfigUpdateBody,
  EmailStatsSummary,
  AppEmailConfig,
  TenantBrand,
  TenantBrandUpdateBody,
} from "@/types/dashboard";

import { getAuthToken } from "./auth.js";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const token = getAuthToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
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
    permanentDelete: (tenantId: string, appId: string) =>
      request<{ deleted: boolean }>(`/tenants/${tenantId}/apps/${appId}`, {
        method: "DELETE",
      }),
    widgetLogs: (tenantId: string, appId: string, limit = 50) =>
      request<InvocationLogEntry[]>(`/tenants/${tenantId}/apps/${appId}/widget-logs?limit=${limit}`),
    adminLogs: (tenantId: string, appId: string, limit = 50) =>
      request<InvocationLogEntry[]>(`/tenants/${tenantId}/apps/${appId}/admin-logs?limit=${limit}`),
    getThemeTemplates: (tenantId: string, appId: string) =>
      request<ThemeTemplatesResponse>(`/tenants/${tenantId}/apps/${appId}/theme-templates`),
    injectTheme: (tenantId: string, appId: string, targets: InjectionTarget[]) =>
      request<InjectThemeResponse>(`/tenants/${tenantId}/apps/${appId}/inject-theme`, {
        method: "POST",
        body: JSON.stringify({ targets }),
      }),
    deleteInjectedTheme: (tenantId: string, appId: string) =>
      request<{ deleted: boolean }>(`/tenants/${tenantId}/apps/${appId}/inject-theme`, {
        method: "DELETE",
      }),
  },

  billing: {
    usage: (tenantId: string) =>
      request<BillingUsageResponse>(`/billing/usage/${tenantId}`),
    subscribe: (tenantId: string, plan: string, interval: "monthly" | "annual" = "monthly") =>
      request<{ confirmationUrl: string | null }>("/billing/subscribe", {
        method: "POST",
        body: JSON.stringify({ tenantId, plan, interval }),
      }),
    cancel: (tenantId: string) =>
      request<{ plan: string }>(`/billing/cancel/${tenantId}`, { method: "POST", body: "{}" }),
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
    latestCompletedSession: (appId: string) =>
      request<LatestSessionResult>(`/generation/app/${appId}/latest-completed`),
    sessions: (appId: string) =>
      request<SessionSummary[]>(`/generation/app/${appId}/sessions`),
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
    progressStream: (jobId: string) => {
      // EventSource does not support custom headers, so pass token via query param.
      const token = getAuthToken();
      const url = token
        ? `${BASE}/generation/${jobId}/progress?token=${encodeURIComponent(token)}`
        : `${BASE}/generation/${jobId}/progress`;
      return new EventSource(url);
    },
    analyze: (history: AnalyzeMessage[]) =>
      request<AnalyzeResult>("/generation/analyze", {
        method: "POST",
        body: JSON.stringify({ history }),
      }),
    cancel: (jobId: string) =>
      request<{ ok: boolean }>(`/generation/${jobId}/cancel`, { method: "POST", body: "{}" }),
    /**
     * Persists frontend chat history for a session.
     * Fire-and-forget — call errors are silently swallowed by the caller.
     * `messages` must have `actions` stripped (onClick closures are not serializable).
     */
    saveChat: (jobId: string, messages: Array<Record<string, unknown>>) =>
      request<void>(`/generation/${jobId}/chat`, {
        method: "PATCH",
        body: JSON.stringify({ messages }),
      }),
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

  email: {
    // Per-app email configuration
    getConfig: (appId: string) =>
      request<EmailConfigResponse>(`/email/apps/${appId}/config`),
    updateConfig: (appId: string, body: EmailConfigUpdateBody) =>
      request<{ config: AppEmailConfig }>(`/email/apps/${appId}/config`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    sendTest: (appId: string, recipient?: string) =>
      request<{ success: boolean; deliveryId: string; recipient: string }>(
        `/email/apps/${appId}/test`,
        {
          method: "POST",
          body: JSON.stringify({ recipient }),
        }
      ),
    getStats: (appId: string) =>
      request<EmailStatsSummary>(`/email/apps/${appId}/stats`),
    // Tenant brand
    getBrand: (tenantId: string) =>
      request<{ brand: TenantBrand | null }>(`/email/tenants/${tenantId}/brand`),
    updateBrand: (tenantId: string, body: TenantBrandUpdateBody) =>
      request<{ brand: TenantBrand }>(`/email/tenants/${tenantId}/brand`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
  },
} as const;
