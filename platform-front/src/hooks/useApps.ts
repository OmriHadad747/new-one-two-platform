import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useBillingUsage(tenantId: string | null) {
  return useQuery({
    queryKey: ["billing-usage", tenantId],
    queryFn: () => api.billing.usage(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });
}

export function useApps(tenantId: string | null) {
  return useQuery({
    queryKey: ["apps", tenantId],
    queryFn: () => api.apps.list(tenantId!),
    enabled: !!tenantId,
    staleTime: 30_000,
  });
}

export function useApp(tenantId: string | null, appId: string | null) {
  return useQuery({
    queryKey: ["app", tenantId, appId],
    queryFn: () => api.apps.get(tenantId!, appId!),
    enabled: !!tenantId && !!appId,
    staleTime: 30_000,
  });
}

export function useTenant(tenantId: string | null) {
  return useQuery({
    queryKey: ["tenant", tenantId],
    queryFn: () => api.tenants.get(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });
}

export function useTenantStats(tenantId: string | null) {
  return useQuery({
    queryKey: ["stats", tenantId],
    queryFn: () => api.tenants.stats(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/**
 * Polls execution logs filtered to a single app every 5 seconds.
 * Used by the AppTestingPanel to show live backend activity.
 */
export function useWebhookAppLogs(tenantId: string | null, appId: string | null, enabled = false) {
  return useQuery({
    queryKey: ["app-logs", tenantId, appId],
    queryFn: async () => {
      const all = await api.tenants.logs(tenantId!, 50);
      return all.filter((l) => l.appId === appId);
    },
    enabled: !!tenantId && !!appId && enabled,
    staleTime: 0,
    refetchInterval: 5_000,
  });
}

export function useWidgetLogs(tenantId: string | null, appId: string | null, enabled = false) {
  return useQuery({
    queryKey: ["widget-logs", tenantId, appId],
    queryFn: () => api.apps.widgetLogs(tenantId!, appId!),
    enabled: !!tenantId && !!appId && enabled,
    staleTime: 0,
    refetchInterval: 10_000,
  });
}

export function useAdminLogs(tenantId: string | null, appId: string | null, enabled = false) {
  return useQuery({
    queryKey: ["admin-logs", tenantId, appId],
    queryFn: () => api.apps.adminLogs(tenantId!, appId!),
    enabled: !!tenantId && !!appId && enabled,
    staleTime: 0,
    refetchInterval: 10_000,
  });
}

