import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SessionState {
  tenantId: string | null;
  shopDomain: string | null;
  setTenant: (id: string, shopDomain: string) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      tenantId: null,
      shopDomain: null,
      setTenant: (tenantId, shopDomain) =>
        set({ tenantId, shopDomain }),
      clear: () => set({ tenantId: null, shopDomain: null }),
    }),
    { name: "new-one-two-session" }
  )
);
