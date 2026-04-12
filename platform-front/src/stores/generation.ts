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
import type { ProgressEvent, AnalyzeMessage } from "@/types/dashboard";
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

export type AnalyzePhase = "idle" | "thinking" | "awaiting_confirm";

interface GenerationStoreState {
  active: ActiveGeneration | null;
  /** Pre-generation chat messages keyed by appId — survives navigation before a jobId exists. */
  draftMessages: Record<string, ChatMessage[]>;
  /** Persisted analyze conversation phase — survives navigation so confirm cards stay actionable. */
  analyzePhase: AnalyzePhase;
  /** Persisted analyze conversation history — survives navigation so context isn't lost mid-clarification. */
  analyzeHistory: AnalyzeMessage[];
  setActive: (appId: string, jobId: string, status: GenStatus) => void;
  updateStatus: (jobId: string, status: GenStatus) => void;
  updateEvents: (jobId: string, events: ProgressEvent[]) => void;
  updateMessages: (jobId: string, messages: ChatMessage[]) => void;
  setDraftMessages: (appId: string, messages: ChatMessage[]) => void;
  clearDraftMessages: (appId: string) => void;
  setAnalyzePhase: (phase: AnalyzePhase) => void;
  setAnalyzeHistory: (history: AnalyzeMessage[]) => void;
  clear: () => void;
}

export const useGenerationStore = create<GenerationStoreState>()(
  persist(
    (set, get) => ({
      active: null,
      draftMessages: {},
      analyzePhase: "idle" as AnalyzePhase,
      analyzeHistory: [] as AnalyzeMessage[],

      setDraftMessages: (appId, messages) =>
        set((s) => ({ draftMessages: { ...s.draftMessages, [appId]: messages } })),

      clearDraftMessages: (appId) =>
        set((s) => {
          const { [appId]: _, ...rest } = s.draftMessages;
          return { draftMessages: rest };
        }),

      setAnalyzePhase: (phase) => set({ analyzePhase: phase }),
      setAnalyzeHistory: (history) => set({ analyzeHistory: history }),

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

      clear: () => set({ active: null, analyzePhase: "idle" as AnalyzePhase, analyzeHistory: [] }),
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
        draftMessages: Object.fromEntries(
          Object.entries(state.draftMessages).map(([appId, msgs]) => [
            appId,
            msgs.map(({ actions: _actions, ...msg }) => msg),
          ])
        ),
        analyzePhase: state.analyzePhase,
        analyzeHistory: state.analyzeHistory,
      }),
    }
  )
);
