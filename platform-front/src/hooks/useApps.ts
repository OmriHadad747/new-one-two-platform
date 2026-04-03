import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

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

export function useExecutionLogs(tenantId: string | null, limit = 20) {
  return useQuery({
    queryKey: ["logs", tenantId, limit],
    queryFn: () => api.tenants.logs(tenantId!, limit),
    enabled: !!tenantId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/**
 * Polls execution logs filtered to a single app every 5 seconds.
 * Used by the AppTestingPanel to show live backend activity.
 */
export function useAppLogs(tenantId: string | null, appId: string | null, enabled = false) {
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

export function useCreateApp(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { slug: string; name: string }) =>
      api.apps.create(tenantId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["apps", tenantId] });
      void qc.invalidateQueries({ queryKey: ["stats", tenantId] });
    },
  });
}
