import { useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import type {
  GenerationState,
  GenerationSSEEvent,
  ProgressEvent,
  CompletedEvent,
} from "@/types/dashboard";

const INITIAL: GenerationState = {
  jobId: null,
  status: "idle",
  events: [],
  completedEvent: null,
  error: null,
};

export function useGeneration() {
  const [state, setState] = useState<GenerationState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);

  const reset = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setState(INITIAL);
  }, []);

  const start = useCallback(
    async (params: { appId: string; tenantId: string; prompt: string }) => {
      esRef.current?.close();
      setState({ ...INITIAL, status: "running" });

      let jobId: string;
      try {
        const res = await api.generation.start(params);
        jobId = res.jobId;
        setState((s) => ({ ...s, jobId }));
      } catch (err) {
        setState((s) => ({
          ...s,
          status: "failed",
          error: err instanceof Error ? err.message : "Failed to start",
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
          status: s.status === "running" ? "failed" : s.status,
          error: s.status === "running" ? "Connection lost" : s.error,
        }));
      };
    },
    []
  );

  const approve = useCallback(
    (jobId: string) => api.generation.approve(jobId),
    []
  );

  const revise = useCallback(
    (jobId: string, feedback: string) => api.generation.revise(jobId, feedback),
    []
  );

  return { state, start, reset, approve, revise };
}
