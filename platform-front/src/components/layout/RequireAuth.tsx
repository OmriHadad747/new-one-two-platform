import { Navigate, Outlet } from "react-router";
import { useSessionStore } from "@/stores/session";

/**
 * Wraps authenticated routes. If no session exists, redirects to /welcome.
 */
export function RequireAuth() {
  const tenantId = useSessionStore((s) => s.tenantId);
  if (!tenantId) return <Navigate to="/welcome" replace />;
  return <Outlet />;
}
