import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

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

export function useCreateApp(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { slug: string; name: string }) =>
      api.apps.create(tenantId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tenant", tenantId] });
    },
  });
}
