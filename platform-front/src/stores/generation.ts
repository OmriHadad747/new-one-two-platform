/**
 * Global generation store — tracks the active generation job across navigation.
 *
 * Intentionally NOT persisted: SSE streams are ephemeral and a page reload
 * should fall back to useLatestSession to restore state from the DB.
 * The store exists solely so sidebar/header components can show a live
 * spinner without prop-drilling through every page, and so chat history +
 * progress events survive navigation away and back.
 */
import { create } from "zustand";
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

export const useGenerationStore = create<GenerationStoreState>()((set, get) => ({
  active: null,

  setActive: (appId, jobId, status) =>
    set((s) => ({
      active: {
        appId,
        jobId,
        status,
        events:   s.active?.jobId === jobId ? (s.active.events)   : [],
        messages: s.active?.jobId === jobId ? (s.active.messages) : [],
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
}));
