/**
 * Global generation store — tracks the active generation job across navigation.
 *
 * Layer 1 persistence: Zustand `persist` writes to localStorage so chat history
 * survives navigation and page reloads within the same browser session.
 * `partialize` strips non-serializable `actions` (onClick closures) from messages
 * before writing; they're ephemeral UI state that gets re-bound on mount anyway.
 *
 * Layer 2 persistence (DB) is handled in NewAppPage via a debounced PATCH call.
 * On first load the DB copy takes priority over localStorage (see hydration logic).
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ProgressEvent } from "@/types/dashboard";
import type { ChatMessage } from "@/components/features/generation/ChatMessages";

export type GenStatus = "idle" | "running" | "completed" | "failed";

interface ActiveGeneration {
  appId: string;
  jobId: string;
  status: GenStatus;
  /** Accumulated SSE progress events — preserved across navigation. */
  events: ProgressEvent[];
  /** Chat message history — preserved across navigation. */
  messages: ChatMessage[];
}

interface GenerationStoreState {
  active: ActiveGeneration | null;
  setActive: (appId: string, jobId: string, status: GenStatus) => void;
  updateStatus: (jobId: string, status: GenStatus) => void;
  updateEvents: (jobId: string, events: ProgressEvent[]) => void;
  updateMessages: (jobId: string, messages: ChatMessage[]) => void;
  clear: () => void;
}

export const useGenerationStore = create<GenerationStoreState>()(
  persist(
    (set, get) => ({
      active: null,

      setActive: (appId, jobId, status) =>
        set((s) => ({
          active: {
            appId,
            jobId,
            status,
            events:   s.active?.jobId === jobId ? s.active.events   : [],
            messages: s.active?.jobId === jobId ? s.active.messages : [],
          },
        })),

      updateStatus: (jobId, status) => {
        const { active } = get();
        if (active?.jobId === jobId) set({ active: { ...active, status } });
      },

      updateEvents: (jobId, events) => {
        const { active } = get();
        if (active?.jobId === jobId) set({ active: { ...active, events } });
      },

      updateMessages: (jobId, messages) => {
        const { active } = get();
        if (active?.jobId === jobId) set({ active: { ...active, messages } });
      },

      clear: () => set({ active: null }),
    }),
    {
      name: "gen-store-v1",
      storage: createJSONStorage(() => localStorage),
      /**
       * Strip non-serializable `actions` (onClick closures) before writing to
       * localStorage. All other fields (id, role, text, type, deployBundle,
       * liveAppId, clarifyingData) are plain data and serialize cleanly.
       */
      partialize: (state) => ({
        active: state.active
          ? {
              ...state.active,
              messages: state.active.messages.map(
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                ({ actions: _actions, ...msg }) => msg
              ),
            }
          : null,
      }),
    }
  )
);
