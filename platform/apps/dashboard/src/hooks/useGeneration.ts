import { useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import type {
  GenerationState,
  GenerationSSEEvent,
  ProgressEvent,
  CompletedEvent,
} from "@/types/dashboard";

const INITIAL_STATE: GenerationState = {
  jobId: null,
  status: "idle",
  events: [],
  completedEvent: null,
  error: null,
};

export function useGeneration() {
  const [state, setState] = useState<GenerationState>(INITIAL_STATE);
  const esRef = useRef<EventSource | null>(null);

  const reset = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  const start = useCallback(
    async (params: { appId: string; tenantId: string; prompt: string }) => {
      reset();
      setState((s) => ({ ...s, status: "running", error: null }));

      let jobId: string;
      try {
        const res = await api.generation.start(params);
        jobId = res.jobId;
        setState((s) => ({ ...s, jobId }));
      } catch (err) {
        setState((s) => ({
          ...s,
          status: "failed",
          error: err instanceof Error ? err.message : "Failed to start generation",
        }));
        return;
      }

      const es = api.generation.progressStream(jobId);
      esRef.current = es;

      es.onmessage = (e: MessageEvent<string>) => {
        let event: GenerationSSEEvent;
        try {
          event = JSON.parse(e.data) as GenerationSSEEvent;
        } catch {
          return;
        }

        if (event.type === "progress") {
          setState((s) => ({
            ...s,
            events: [...s.events, event as ProgressEvent],
          }));
        } else if (event.type === "completed") {
          const completed = event as CompletedEvent;
          es.close();
          esRef.current = null;
          setState((s) => ({
            ...s,
            status: completed.status === "success" ? "completed" : "failed",
            completedEvent: completed,
            error: completed.error ?? null,
          }));
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setState((s) => ({
          ...s,
          status: "failed",
          error: s.status === "running" ? "Connection lost" : s.error,
        }));
      };
    },
    [reset]
  );

  const approve = useCallback(async (jobId: string) => {
    return api.generation.approve(jobId);
  }, []);

  const revise = useCallback(async (jobId: string, feedback: string) => {
    return api.generation.revise(jobId, feedback);
  }, []);

  return { state, start, reset, approve, revise };
}
