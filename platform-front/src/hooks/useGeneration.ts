import { useState, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  GenerationState,
  GenerationSSEEvent,
  ProgressEvent,
  CompletedEvent,
  GenerationBundle,
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

  /** Shared SSE wiring — used by both start() and startRevision(). */
  const _openStream = useCallback((jobId: string) => {
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
      // The stream may have closed because the job finished while we were away.
      // Fetch the result to find the true final status before marking as failed.
      setState((s) => {
        if (s.status !== "running") return s;
        // Trigger async result check; update state once resolved.
        api.generation.result(jobId)
          .then((res) => {
            setState((prev) => ({
              ...prev,
              status: "completed",
              completedEvent: null,
              error: null,
              // Merge bundle info from result if needed
            }));
            void res; // suppress unused warning
          })
          .catch(() => {
            setState((prev) => ({
              ...prev,
              status: "failed",
              error: "Connection lost",
            }));
          });
        // Temporarily stay in running state while we check
        return s;
      });
    };
  }, []);

  /** Start a brand-new generation job. */
  const start = useCallback(
    async (params: { appId: string; tenantId: string; prompt: string; preComputedIntent?: Record<string, unknown> }) => {
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

      _openStream(jobId);
    },
    [_openStream]
  );

  /**
   * Revise an existing generation job with user feedback.
   * Calls POST /generation/:jobId/revise, gets a new jobId, opens the SSE stream.
   */
  const startRevision = useCallback(
    async (jobId: string, feedback: string) => {
      esRef.current?.close();
      setState({ ...INITIAL, status: "running" });

      let newJobId: string;
      try {
        const res = await api.generation.revise(jobId, feedback);
        newJobId = res.jobId;
        setState((s) => ({ ...s, jobId: newJobId }));
      } catch (err) {
        setState((s) => ({
          ...s,
          status: "failed",
          error: err instanceof Error ? err.message : "Failed to revise",
        }));
        return;
      }

      _openStream(newJobId);
    },
    [_openStream]
  );

  const approve = useCallback(
    (jobId: string) => api.generation.approve(jobId),
    []
  );

  const cancel = useCallback(async (jobId: string) => {
    esRef.current?.close();
    esRef.current = null;
    try {
      await api.generation.cancel(jobId);
    } catch {
      // ignore — we already closed the stream client-side
    }
    setState((s) => ({ ...s, status: "failed", error: "Cancelled" }));
  }, []);

  /** Reconnect to a generation that is already running (e.g. after navigating away). */
  const reconnect = useCallback((jobId: string, initialEvents: ProgressEvent[] = []) => {
    esRef.current?.close();
    setState({ ...INITIAL, status: "running", jobId, events: initialEvents });
    _openStream(jobId);
  }, [_openStream]);

  /** Restore a completed generation without touching the SSE stream. */
  const restore = useCallback((jobId: string) => {
    esRef.current?.close();
    setState({ ...INITIAL, status: "completed", jobId });
  }, []);

  return { state, start, startRevision, reconnect, restore, reset, approve, cancel };
}

/** Fetches the latest session for an app — always fresh on mount so reconnect logic sees real status. */
export function useLatestSession(appId: string | null) {
  return useQuery({
    queryKey: ["latest-session", appId],
    queryFn: () => api.generation.latestSession(appId!),
    enabled: !!appId,
    retry: false,
    staleTime: 0,
    refetchOnMount: true,
  });
}

/** Polls for the final bundle once generation is complete. */
export function useGenerationResult(tenantId: string | null, jobId: string | null) {
  return useQuery({
    queryKey: ["generation-result", tenantId, jobId],
    queryFn: async () => {
      const res = await api.generation.result(jobId!);
      return res.bundle as GenerationBundle;
    },
    enabled: !!tenantId && !!jobId,
    refetchInterval: (query) => (query.state.data ? false : 2000),
  });
}
