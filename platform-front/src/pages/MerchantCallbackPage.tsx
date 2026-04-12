/**
 * Handles the post-OAuth redirect from the backend.
 *
 * The backend OAuth callback redirects to:
 *   ${DASHBOARD_URL}/merchants/:tenantId
 *
 * This page fetches the tenant, saves it to the session store,
 * then navigates to the dashboard.
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { api } from "@/lib/api";
import { useSessionStore } from "@/stores/session";

export function MerchantCallbackPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const setTenant = useSessionStore((s) => s.setTenant);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) {
      setError("Missing tenant ID.");
      return;
    }

    api.tenants.get(tenantId)
      .then((tenant) => {
        setTenant(tenant.id, tenant.shopDomain ?? "");
        navigate("/app/apps", { replace: true });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load store.");
      });
  }, [tenantId, setTenant, navigate]);

  if (error) {
    return (
      <div className="min-h-full bg-base flex flex-col items-center justify-center gap-4">
        <div className="text-3xl">⚠</div>
        <p className="text-sm text-danger">{error}</p>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="text-xs text-faint px-3 py-1.5 border border-white/13 rounded-lg hover:text-ink transition-all bg-transparent cursor-pointer"
        >
          ← Back to install
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-base flex flex-col items-center justify-center gap-4">
      <div className="w-8 h-8 rounded-full border-2 border-white/13 border-t-accent animate-spin" />
      <p className="text-sm text-faint">Connecting your store…</p>
    </div>
  );
}
