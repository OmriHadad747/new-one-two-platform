import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useSearchParams, useParams, useNavigate } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { ChatMessages, type ChatMessage, type DeployBundle } from "@/components/features/generation/ChatMessages";
import { ChatInput } from "@/components/features/generation/ChatInput";
import { useGeneration, useLatestSession } from "@/hooks/useGeneration";
import { useSessionStore } from "@/stores/session";
import { useGenerationStore } from "@/stores/generation";
import { useApps, useApp } from "@/hooks/useApps";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SessionBundle, GenerationBundle, AppArchetype, AnalyzeMessage } from "@/types/dashboard";
import { NameAppModal } from "@/components/features/generation/NameAppModal";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeBundleFromApi(raw: Record<string, unknown>): GenerationBundle {
  const handler = (raw.handlerModule ?? {}) as Record<string, unknown>;
  const topics = (handler.webhookTopics as string[] | undefined) ?? [];
  const hasCron = !!handler.cronSchedule;
  const hasWidget = !!raw.widgetModule;
  const hasAdminUI = !!raw.adminUiModule;
  const explanation = raw.explanation as Record<string, unknown> | string | undefined;
  return {
    explanation: typeof explanation === "string"
      ? explanation
      : (explanation as Record<string, unknown> | undefined)?.merchantFacing as string | undefined,
    triggerTopics: topics,
    triggerType: hasCron ? "cron" : hasAdminUI ? "admin" : hasWidget ? "widget" : "webhook",
    hasWidget,
    hasAdminUI,
  };
}

function computeArchetype(bundle: GenerationBundle | null): DeployBundle["archetype"] {
  const hasAdmin  = !!bundle?.hasAdminUI;
  const hasWidget = !!bundle?.hasWidget;
  if (hasAdmin && hasWidget) return "storefront_backend_admin";
  if (hasAdmin)  return "backend_admin";
  if (hasWidget) return "storefront_backend";
  return "backend";
}

function bundleToDeployBundle(bundle: GenerationBundle | null): DeployBundle | undefined {
  if (!bundle) return undefined;
  return {
    triggerType:   bundle.triggerType   ?? "webhook",
    triggerTopics: bundle.triggerTopics ?? [],
    hasWidget:     !!bundle.hasWidget,
    hasAdminUI:    !!bundle.hasAdminUI,
    archetype:     computeArchetype(bundle),
    explanation:   typeof bundle.explanation === "string" ? bundle.explanation : null,
  };
}

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "ai",
  text: "Hey! Describe the Shopify feature you want to build and I'll make sure I understand it before we generate anything.",
};

function nameFromPrompt(prompt: string): string {
  const clean = prompt.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  const words = clean.split(/\s+/).slice(0, 5).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1) || "New app";
}

function slugFromName(name: string): string {
  return (
    name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 30) +
    "-" + Math.random().toString(36).slice(2, 6)
  );
}

/** Parse a raw API error string into a user-facing message + optional upgrade hint + error code. */
function parseGenError(raw: string): { text: string; upgradeHint?: string; code?: string } {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { error?: string; upgradeHint?: string; code?: string };
      if (parsed.error) {
        return { text: parsed.error, upgradeHint: parsed.upgradeHint, code: parsed.code };
      }
    }
  } catch { /* ignore */ }
  return { text: raw };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function NewAppPage() {
  const { appId: routeAppId } = useParams<{ appId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { tenantId } = useSessionStore();
  const appsQuery = useApps(tenantId);
  const queryClient = useQueryClient();

  const [selectedAppId, setSelectedAppId] = useState<string | null>(
    routeAppId ?? searchParams.get("appId")
  );
  const apps = appsQuery.data ?? [];

  const [input, setInput]     = useState(searchParams.get("prompt") ?? "");
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevStatus = useRef<string>("idle");
  const genMsgIdRef = useRef<string | null>(null);
  const prevRouteAppId = useRef<string | undefined>(routeAppId);
  const lastStartParamsRef = useRef<{ appId: string; tenantId: string; prompt: string; preComputedIntent?: Record<string, unknown> } | null>(null);
  // Tracks whether hydration has run for the current mount of this component.
  // Resets to false on every mount so navigation back to the same app re-hydrates.
  const hasHydratedRef = useRef(false);

  // Name modal
  const [nameModal, setNameModal] = useState<{
    suggestedName: string;
    onConfirm: (name: string) => void;
  } | null>(null);

  // Analyze conversation
  const [analyzeHistory, setAnalyzeHistory] = useState<AnalyzeMessage[]>([]);
  const [analyzePhase, setAnalyzePhase]     = useState<"idle" | "thinking" | "awaiting_confirm">("idle");

  const { state: gen, start, startRevision, reconnect, restore, reset, cancel } = useGeneration();
  const { setActive, updateStatus, updateEvents, updateMessages, active: activeGenStore,
          setDraftMessages, clearDraftMessages, draftMessages } = useGenerationStore();
  const isStreaming  = gen.status === "running";
  const isAnalyzing  = analyzePhase === "thinking";

  const activeAppQuery   = useApp(tenantId, selectedAppId);
  const activeApp        = activeAppQuery.data ?? null;
  const latestSessionQuery = useLatestSession(selectedAppId);

  // ── Reset all state when the user navigates to a different app's revise page ─
  useEffect(() => {
    if (routeAppId === prevRouteAppId.current) return;
    prevRouteAppId.current = routeAppId;
    genMsgIdRef.current = null;
    hasHydratedRef.current = false;
    reset();
    setSelectedAppId(routeAppId ?? null);
    setMessages([WELCOME]);
    setAnalyzeHistory([]);
    setAnalyzePhase("idle");
    prevStatus.current = "idle";
  }, [routeAppId, reset]);

  // ── Hydrate state from the persisted latest session ─────────────────────────
  useEffect(() => {
    const session = latestSessionQuery.data;
    if (!session || hasHydratedRef.current) return;

    if (session.status === "running" && session.jobId) {
      // Don't reconnect if already connected to this job
      if (gen.status !== "idle") return;
      const cached = activeGenStore?.jobId === session.jobId ? activeGenStore : null;
      // Don't reconnect to a job the user already cancelled this session
      if (cached?.status === "failed") return;
      hasHydratedRef.current = true;
      reconnect(session.jobId, cached?.events ?? []);

      // Priority 1: DB-persisted chat history (survives hard navigation).
      const dbMessages = session.chatMessages as ChatMessage[] | null | undefined;
      if (dbMessages?.length) {
        // Ensure the generating card is present — the user is still mid-build.
        const hasGeneratingCard = dbMessages.some((m) => m.type === "generating");
        if (hasGeneratingCard) {
          const genMsg = dbMessages.find((m) => m.type === "generating");
          if (genMsg) genMsgIdRef.current = genMsg.id;
          setMessages(dbMessages);
        } else {
          const genMsgId = crypto.randomUUID();
          genMsgIdRef.current = genMsgId;
          setMessages([...dbMessages, { id: genMsgId, role: "ai", type: "generating" }]);
        }
        return;
      }

      // Priority 2: In-memory Zustand store (survives soft navigation).
      if (cached?.messages?.length) {
        setMessages(cached.messages);
        return;
      }

      // Priority 3: Bare generating card fallback.
      const genMsgId = "resume-gen";
      genMsgIdRef.current = genMsgId;
      setMessages([WELCOME, { id: genMsgId, role: "ai", type: "generating" }]);
      return;
    }

    if (session.status !== "completed" && session.status !== "failed") return;
    if (!activeAppQuery.isSuccess) return;

    hasHydratedRef.current = true;

    const sb = session.bundle as SessionBundle | null | undefined;
    if (session.jobId) restore(session.jobId);

    // Priority 1: DB-persisted chat history (survives page reload, most durable).
    const dbMessages = session.chatMessages as ChatMessage[] | null | undefined;
    if (dbMessages?.length) {
      setMessages(dbMessages);
      return;
    }

    // Priority 2: In-memory Zustand store (survives navigation without reload).
    const cachedForSession = activeGenStore?.jobId === session.jobId ? activeGenStore : null;
    if (cachedForSession?.messages?.length) {
      setMessages(cachedForSession.messages);
      return;
    }

    // Priority 3: Rebuild a minimal summary card from session metadata.
    if (!sb?.handlerModule) return;
    const restoredBundle: GenerationBundle = {
      explanation: sb.explanation?.merchantFacing,
      triggerTopics: sb.handlerModule.webhookTopics ?? session.webhookTopics,
      triggerType: sb.handlerModule.cronSchedule
        ? "cron" : sb.adminUiModule ? "admin" : sb.widgetModule ? "widget" : "webhook",
      hasWidget:  !!sb.widgetModule,
      hasAdminUI: !!sb.adminUiModule,
    };
    const resumeMsgId = "resume-card";
    genMsgIdRef.current = resumeMsgId;

    setMessages([
      WELCOME,
      {
        id: resumeMsgId,
        role: "ai",
        type: "deploy-ready",
        deployBundle: { ...bundleToDeployBundle(restoredBundle)!, appId: selectedAppId ?? undefined },
      },
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSessionQuery.data, gen.status, activeApp?.status, activeAppQuery.isSuccess]);

  // Restore pre-generation messages from store when there's no session yet
  useEffect(() => {
    if (hasHydratedRef.current) return;
    if (!selectedAppId) return;
    // Only restore if session query resolved with no session
    if (!latestSessionQuery.isSuccess || latestSessionQuery.data) return;
    const saved = draftMessages[selectedAppId];
    if (saved?.length && saved.length > 1) {
      hasHydratedRef.current = true;
      setMessages(saved);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAppId, latestSessionQuery.isSuccess, latestSessionQuery.data]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isAnalyzing]);

  // Sync events to store
  useEffect(() => {
    if (gen.jobId && gen.events.length > 0) updateEvents(gen.jobId, gen.events);
  }, [gen.jobId, gen.events, updateEvents]);

  // Sync messages to store (jobId-based for active generation)
  useEffect(() => {
    if (gen.jobId) updateMessages(gen.jobId, messages);
  }, [gen.jobId, messages, updateMessages]);

  // Persist pre-generation messages by appId so they survive navigation before gen starts
  useEffect(() => {
    if (gen.jobId) return; // once gen starts, jobId-based persistence takes over
    if (!selectedAppId) return;
    if (messages.length <= 1) return; // only WELCOME — nothing to save
    setDraftMessages(selectedAppId, messages);
  }, [gen.jobId, selectedAppId, messages, setDraftMessages]);

  // Debounced DB save — Layer 2 persistence.
  // Skips the initial single-message state (just WELCOME) and fire-and-forgets
  // after 1.5 s of inactivity. Errors are swallowed; the store is the fallback.
  const saveChatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Memoize serializable messages (actions stripped) to avoid re-serializing on every render.
  const serializableMessages = useMemo(
    () => messages.map(({ actions: _actions, ...msg }) => msg as Record<string, unknown>),
    [messages]
  );
  // Always hold the latest save state so the unmount flush can use it.
  const pendingSaveRef = useRef<{ jobId: string; messages: Array<Record<string, unknown>> } | null>(null);
  useEffect(() => {
    if (!gen.jobId || messages.length <= 1) return;
    pendingSaveRef.current = { jobId: gen.jobId, messages: serializableMessages };
    if (saveChatTimerRef.current) clearTimeout(saveChatTimerRef.current);
    saveChatTimerRef.current = setTimeout(() => {
      api.generation.saveChat(gen.jobId!, serializableMessages).catch(() => null);
    }, 1500);
    return () => {
      if (saveChatTimerRef.current) clearTimeout(saveChatTimerRef.current);
    };
  }, [gen.jobId, serializableMessages, messages.length]);
  // Flush immediately on unmount so navigation away never loses the last save.
  useEffect(() => {
    return () => {
      const p = pendingSaveRef.current;
      if (p) api.generation.saveChat(p.jobId, p.messages).catch(() => null);
    };
  }, []);

  // Sync global generation store
  useEffect(() => {
    if (gen.jobId && selectedAppId) {
      setActive(selectedAppId, gen.jobId, gen.status as "idle" | "running" | "completed" | "failed");
    } else if (gen.jobId) {
      updateStatus(gen.jobId, gen.status as "idle" | "running" | "completed" | "failed");
    }

    if (prevStatus.current === "running" && gen.status === "completed") {
      if (gen.jobId) {
        api.generation.result(gen.jobId)
          .then((res) => {
            const newBundle = res.bundle
              ? normalizeBundleFromApi(res.bundle as Record<string, unknown>)
              : null;
            const genMsgId = genMsgIdRef.current;
            setMessages((prev) => prev.map((m) =>
              m.id === genMsgId
                ? {
                    id: m.id,
                    role: "ai" as const,
                    type: "deploy-ready" as const,
                    deployBundle: {
                      ...bundleToDeployBundle(newBundle)!,
                      appId: selectedAppId ?? undefined,
                    },
                  }
                : m
            ));
          })
          .catch((err: unknown) => {
            const genMsgId = genMsgIdRef.current;
            const errText = err instanceof Error ? err.message : "Failed to load generation result.";
            setMessages((prev) => prev.map((m) =>
              m.id === genMsgId
                ? { id: m.id, role: "ai" as const, text: `Generation failed: ${errText}` }
                : m
            ));
          });
      }
    }

    if (prevStatus.current === "running" && gen.status === "failed") {
      const genMsgId = genMsgIdRef.current;
      if (gen.error === "Cancelled") {
        setMessages((prev) => prev.map((m) =>
          m.id === genMsgId ? { id: m.id, role: "ai" as const, text: "Generation cancelled." } : m
        ));
      } else {
        const { text, upgradeHint, code } = parseGenError(gen.error ?? "Unknown error. Please try again.");
        const blockedArchetype = code === "category_not_allowed"
          ? lastStartParamsRef.current?.preComputedIntent?.appCategory as string | undefined
          : undefined;

        if (blockedArchetype && upgradeHint) {
          setMessages((prev) => prev.map((m) =>
            m.id === genMsgId
              ? {
                  id: m.id, role: "ai" as const,
                  planBlock: { archetype: blockedArchetype as AppArchetype, upgradeHint },
                  actions: [{ label: "Upgrade plan →", onClick: () => navigate("/app/settings") }],
                }
              : m
          ));
        } else {
          const actions = upgradeHint
            ? [{ label: "Upgrade plan →", onClick: () => navigate("/app/settings") }]
            : [
                {
                  label: "Try again",
                  onClick: () => {
                    const params = lastStartParamsRef.current;
                    if (!params || !genMsgIdRef.current) return;
                    const retryMsgId = genMsgIdRef.current;
                    setMessages((prev) => prev.map((m) =>
                      m.id === retryMsgId ? { id: m.id, role: "ai" as const, type: "generating" as const } : m
                    ));
                    void start(params);
                  },
                },
              ];
          setMessages((prev) => prev.map((m) =>
            m.id === genMsgId
              ? { id: m.id, role: "ai" as const, text: upgradeHint ? text : `Generation failed: ${text}`, actions }
              : m
          ));
        }
      }
    }

    prevStatus.current = gen.status;
  }, [gen.status, gen.jobId, gen.error, updateStatus, navigate, start]);

  // ── Analyze ──────────────────────────────────────────────────────────────────

  const runAnalyze = useCallback(async (history: AnalyzeMessage[], appIdForGen: string | null) => {
    setAnalyzePhase("thinking");
    let result;
    try {
      result = await api.generation.analyze(history);
    } catch (err) {
      setAnalyzePhase("idle");
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: `Couldn't analyze your request: ${err instanceof Error ? err.message : "Unknown error"}`,
        },
      ]);
      return;
    }

    if (result.status === "needs_clarification") {
      const question    = result.question    ?? "Could you tell me more about what you want to build?";
      const suggestions = result.suggestions ?? [];
      setAnalyzeHistory([...history, { role: "assistant", content: question }]);
      setAnalyzePhase("idle");
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: question,
          type: "clarifying" as const,
          clarifyingData: { suggestions },
        },
      ]);
    } else {
      const summary = result.summary ?? "I understand your request. Ready to generate.";
      const intent  = result.intent ?? {};
      const confirmMsgId = crypto.randomUUID();
      setAnalyzePhase("awaiting_confirm");

      const handleConfirm = () => {
        const originalPrompt = history[0]?.content ?? "New App";
        const suggestedName  = appIdForGen
          ? (apps.find((a) => a.id === appIdForGen)?.name ?? nameFromPrompt(originalPrompt))
          : nameFromPrompt(originalPrompt);

        setNameModal({
          suggestedName,
          onConfirm: async (chosenName: string) => {
            setNameModal(null);
            setMessages((prev) =>
              prev.map((m) => (m.id === confirmMsgId ? { ...m, actions: [] } : m))
            );

            let appId = appIdForGen;
            if (!appId) {
              const slug = slugFromName(chosenName);
              try {
                const newApp = await api.apps.create(tenantId!, { slug, name: chosenName });
                appId = newApp.id;
                setSelectedAppId(newApp.id);
                await queryClient.invalidateQueries({ queryKey: ["apps", tenantId] });
              } catch (err) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: "ai",
                    text: `Couldn't create the app: ${err instanceof Error ? err.message : "Unknown error"}`,
                  },
                ]);
                setAnalyzePhase("idle");
                return;
              }
            } else {
              const existing = apps.find((a) => a.id === appId);
              if (existing && existing.name !== chosenName) {
                await api.apps.rename(tenantId!, appId, chosenName).catch(() => null);
                await queryClient.invalidateQueries({ queryKey: ["apps", tenantId] });
                await queryClient.invalidateQueries({ queryKey: ["app", tenantId, appId] });
              }
            }

            setAnalyzePhase("idle");

            const genMsgId = crypto.randomUUID();
            genMsgIdRef.current = genMsgId;
            setMessages((prev) => [
              ...prev,
              { id: genMsgId, role: "ai", type: "generating" },
            ]);
            // Clear draft messages — generation now takes over persistence
            if (appId) clearDraftMessages(appId);
            lastStartParamsRef.current = { appId: appId!, tenantId: tenantId!, prompt: originalPrompt, preComputedIntent: intent };
            await start({ appId: appId!, tenantId: tenantId!, prompt: originalPrompt, preComputedIntent: intent });
          },
        });
      };

      setMessages((prev) => [
        ...prev,
        {
          id: confirmMsgId,
          role: "ai",
          text: summary,
          actions: [
            { label: "Generate →", onClick: handleConfirm },
            {
              label: "Change request",
              variant: "ghost" as const,
              onClick: () => {
                setMessages((prev) => prev.map((m) =>
                  m.id === confirmMsgId ? { ...m, actions: [] } : m
                ));
                setAnalyzePhase("idle");
                setAnalyzeHistory([]);
              },
            },
          ],
        },
      ]);
    }
  }, [tenantId, appsQuery, start]);

  // ── Send ─────────────────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming || isAnalyzing) return;
    if (!tenantId) return;

    const prompt = input.trim();
    setInput("");

    // Generation complete — start revision
    if (gen.jobId && gen.status === "completed") {
      const genMsgId = crypto.randomUUID();
      genMsgIdRef.current = genMsgId;
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text: prompt },
        { id: genMsgId, role: "ai", type: "generating" },
      ]);
      await startRevision(gen.jobId, prompt);
      return;
    }

    // Analyze conversation
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text: prompt }]);
    const newHistory: AnalyzeMessage[] = [...analyzeHistory, { role: "user", content: prompt }];
    setAnalyzeHistory(newHistory);
    if (analyzePhase === "awaiting_confirm") {
      setAnalyzeHistory(newHistory);
    }

    // First message with no app yet → create a draft immediately so it appears in the sidebar
    let appIdForAnalyze = selectedAppId;
    if (!selectedAppId && analyzeHistory.length === 0 && tenantId) {
      try {
        // Use "..." as placeholder — real name is set after the name modal confirms
        const newApp = await api.apps.create(tenantId, { slug: slugFromName("draft-" + Date.now()), name: "..." });
        appIdForAnalyze = newApp.id;
        setSelectedAppId(newApp.id);
        void queryClient.invalidateQueries({ queryKey: ["apps", tenantId] });
      } catch {
        // non-fatal — continue without pre-created app
      }
    }

    await runAnalyze(newHistory, appIdForAnalyze);
  }, [
    input, isStreaming, isAnalyzing, tenantId, selectedAppId,
    gen.jobId, gen.status, analyzeHistory, analyzePhase,
    startRevision, runAnalyze,
  ]);

  const handleStop = useCallback(() => {
    if (gen.jobId) void cancel(gen.jobId);
  }, [gen.jobId, cancel]);

  const handleClarifyAnswer = useCallback((text: string) => {
    // Mark the last unanswered clarifying message as answered
    setMessages((prev) => {
      const lastClarifyIdx = [...prev].reverse().findIndex(
        (m) => m.type === "clarifying" && !m.clarifyingData?.answeredText
      );
      if (lastClarifyIdx === -1) return prev;
      const idx = prev.length - 1 - lastClarifyIdx;
      return prev.map((m, i) =>
        i === idx ? { ...m, clarifyingData: { ...m.clarifyingData!, answeredText: text } } : m
      );
    });
    // Add user message and continue the analyze loop
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text }]);
    const newHistory: AnalyzeMessage[] = [...analyzeHistory, { role: "user", content: text }];
    setAnalyzeHistory(newHistory);
    void runAnalyze(newHistory, selectedAppId);
  }, [analyzeHistory, runAnalyze, selectedAppId]);

  const chatPlaceholder = isStreaming
    ? "Generating your app…"
    : gen.status === "completed"
      ? "Ask for a change to generate a new version..."
      : analyzePhase === "awaiting_confirm"
        ? "Or type here to change your request..."
        : messages.length > 1
          ? "What would you like to build?"
          : undefined;

  return (
    <>
      {nameModal && (
        <NameAppModal
          initialName={nameModal.suggestedName}
          onConfirm={nameModal.onConfirm}
          onCancel={() => setNameModal(null)}
        />
      )}
      <TopBar
        title={activeApp ? activeApp.name : "New App"}
        subtitle={
          activeApp && (gen.status === "completed" || latestSessionQuery.data?.status === "completed")
            ? "Revision"
            : "New app"
        }
      />

      <div className="flex-1 overflow-hidden flex flex-col relative">
        <ChatMessages
          ref={bottomRef}
          messages={messages}
          isAnalyzing={isAnalyzing}
          liveGenEvents={gen.events}
          generationCompleted={gen.status === "completed"}
          onClarifyAnswer={handleClarifyAnswer}
        />
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={handleSend}
          disabled={isStreaming || isAnalyzing}
          placeholder={chatPlaceholder}
          onStop={isStreaming ? handleStop : undefined}
        />
      </div>
    </>
  );
}
