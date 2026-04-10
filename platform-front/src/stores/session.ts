import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SessionState {
  tenantId: string | null;
  shopDomain: string | null;
  plan: string;
  setTenant: (id: string, shopDomain: string, plan: string) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      tenantId: null,
      shopDomain: null,
      plan: "free",
      setTenant: (tenantId, shopDomain, plan) =>
        set({ tenantId, shopDomain, plan }),
      clear: () => set({ tenantId: null, shopDomain: null, plan: "free" }),
    }),
    { name: "new-one-two-session" }
  )
);
