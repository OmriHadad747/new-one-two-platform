import { useState, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
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
  // Mirror state in a ref so onerror can read it without stale closures
  const stateRef = useRef<GenerationState>(INITIAL);
  const _setState = useCallback((updater: GenerationState | ((s: GenerationState) => GenerationState)) => {
    setState((s) => {
      const next = typeof updater === "function" ? updater(s) : updater;
      stateRef.current = next;
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    _setState(INITIAL);
  }, [_setState]);

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
        _setState((s) => ({
          ...s,
          events: [...s.events, event as ProgressEvent],
        }));
      } else if (event.type === "completed") {
        const completed = event as CompletedEvent;
        es.close();
        esRef.current = null;
        _setState((s) => ({
          ...s,
          status: completed.status === "success" ? "completed" : "failed",
          completedEvent: completed,
          error: completed.error ?? null,
        }));
      }
    };

    es.onerror = () => {
      // Guard: if we already transitioned out of "running", the completed message
      // was already processed — this is just the stream closing normally.
      if (stateRef.current.status !== "running") return;

      es.close();
      esRef.current = null;

      // Stream closed before we got a "completed" message (e.g. deploy finished
      // while navigating away, or connection dropped). Check the server for the
      // real final status — do NOT leave the UI stuck at "running".
      api.generation.result(jobId)
        .then((res) => {
          const sessionStatus = (res as { status?: string }).status;
          const succeeded = sessionStatus === "completed" || res.bundle != null;
          _setState((prev) => ({
            ...prev,
            status: succeeded ? "completed" : "failed",
            completedEvent: null,
            error: succeeded ? null : ((res as { errorMessage?: string }).errorMessage ?? "Generation failed"),
          }));
        })
        .catch(() => {
          _setState((prev) => ({
            ...prev,
            status: "failed",
            error: "Connection lost",
          }));
        });
    };
  }, [_setState]);

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

/**
 * Fetches the latest *completed* session for an app.
 * Used as fallback data source when the latest session is failed
 * (e.g. after a failed revision — keeps triggers / explanation visible).
 */
export function useLatestCompletedSession(appId: string | null) {
  return useQuery({
    queryKey: ["latest-completed-session", appId],
    queryFn: () => api.generation.latestCompletedSession(appId!),
    enabled: !!appId,
    staleTime: 60_000,
    retry: false,
  });
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

/** Fetches the full session history for an app (version list). */
export function useAppSessions(appId: string | null) {
  return useQuery({
    queryKey: ["app-sessions", appId],
    queryFn: () => api.generation.sessions(appId!),
    enabled: !!appId,
    staleTime: 30_000,
  });
}

/** Fetches the bundle for a specific completed session by jobId. */
export function useSessionBundle(jobId: string | null) {
  return useQuery({
    queryKey: ["session-bundle", jobId],
    queryFn: () => api.generation.result(jobId!),
    enabled: !!jobId,
    staleTime: Infinity, // bundles are immutable once stored
    retry: false,
  });
}

