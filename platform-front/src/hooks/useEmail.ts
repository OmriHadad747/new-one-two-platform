import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { EmailConfigUpdateBody, TenantBrandUpdateBody } from "@/types/dashboard";

// ─── Per-app email config ────────────────────────────────────────────────────

export function useEmailConfig(appId: string | null) {
  return useQuery({
    queryKey: ["email-config", appId],
    queryFn: () => api.email.getConfig(appId!),
    enabled: !!appId,
    staleTime: 30_000,
  });
}

export function useUpdateEmailConfig(appId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EmailConfigUpdateBody) => api.email.updateConfig(appId!, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["email-config", appId] });
      // Unblock deploy — app.configuredByMerchant derives from the config row.
      void qc.invalidateQueries({ queryKey: ["app"] });
    },
  });
}

export function useSendTestEmail(appId: string | null) {
  return useMutation({
    mutationFn: (recipient?: string) => api.email.sendTest(appId!, recipient),
  });
}

export function useEmailStats(appId: string | null) {
  return useQuery({
    queryKey: ["email-stats", appId],
    queryFn: () => api.email.getStats(appId!),
    enabled: !!appId,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

// ─── Tenant brand ────────────────────────────────────────────────────────────

export function useTenantBrand(tenantId: string | null) {
  return useQuery({
    queryKey: ["tenant-brand", tenantId],
    queryFn: () => api.email.getBrand(tenantId!),
    enabled: !!tenantId,
    staleTime: 60_000,
  });
}

export function useUpdateTenantBrand(tenantId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TenantBrandUpdateBody) => api.email.updateBrand(tenantId!, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tenant-brand", tenantId] });
      // Brand changes propagate to all email previews.
      void qc.invalidateQueries({ queryKey: ["email-config"] });
    },
  });
}
