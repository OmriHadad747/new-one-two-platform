import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { ChatMessages, type ChatMessage } from "@/components/features/generation/ChatMessages";
import { ChatInput } from "@/components/features/generation/ChatInput";
import { AppTestingPanel } from "@/components/features/generation/AppTestingPanel";
import { useGeneration, useLatestSession } from "@/hooks/useGeneration";
import { useSessionStore } from "@/stores/session";
import { useGenerationStore } from "@/stores/generation";
import { useApps, useApp } from "@/hooks/useApps";
import { api } from "@/lib/api";
import type { SessionBundle } from "@/types/dashboard";
import { NameAppModal } from "@/components/features/generation/NameAppModal";
import type { GenerationBundle, AnalyzeMessage } from "@/types/dashboard";

/**
 * Normalize the raw FeatureBundle from the API into the frontend GenerationBundle shape.
 * The API returns { widgetModule, adminUiModule, handlerModule, explanation } —
 * the UI needs hasWidget, hasAdminUI, triggerType derived from those fields.
 */
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

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "ai",
  text: "Hey! Describe the Shopify feature you want to build and I'll make sure I understand it before we generate anything.",
};

function nameFromPrompt(prompt: string): string {
  const clean = prompt.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  const words = clean.split(/\s+/).slice(0, 5).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1) || "New App";
}

function slugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 30) +
    "-" +
    Math.random().toString(36).slice(2, 6)
  );
}

export function NewAppPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { tenantId, shopDomain } = useSessionStore();
  const appsQuery = useApps(tenantId);

  const [selectedAppId, setSelectedAppId] = useState<string | null>(searchParams.get("appId"));
  const apps = appsQuery.data ?? [];

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevStatus = useRef<string>("idle");

  // Deployment state
  const [deployed, setDeployed] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [bundle, setBundle] = useState<GenerationBundle | null>(null);

  // Name modal state
  const [nameModal, setNameModal] = useState<{ suggestedName: string; onConfirm: (name: string) => void } | null>(null);

  // Analyze conversation state
  const [analyzeHistory, setAnalyzeHistory] = useState<AnalyzeMessage[]>([]);
  const [analyzePhase, setAnalyzePhase] = useState<"idle" | "thinking" | "awaiting_confirm">("idle");
  const [, setPendingIntent] = useState<Record<string, unknown> | null>(null);

  const { state: gen, start, startRevision, reconnect, restore, reset, cancel } = useGeneration();
  const { setActive, updateStatus, updateEvents, updateMessages, active: activeGenStore } = useGenerationStore();
  const isStreaming = gen.status === "running";
  const isAnalyzing = analyzePhase === "thinking";

  const activeAppQuery = useApp(tenantId, selectedAppId);
  const activeApp = activeAppQuery.data ?? null;
  const latestSessionQuery = useLatestSession(selectedAppId);

  // Hydrate generation state from the persisted latest session when the user
  // returns to an app that was generating or has a completed generation.
  useEffect(() => {
    const session = latestSessionQuery.data;
    if (!session || gen.status !== "idle") return;

    // Still running — reconnect the SSE stream and restore cached state
    if (session.status === "running" && session.jobId) {
      const cached = activeGenStore?.jobId === session.jobId ? activeGenStore : null;
      reconnect(session.jobId, cached?.events ?? []);
      if (cached?.messages?.length) {
        setMessages(cached.messages);
      } else {
        setMessages([
          WELCOME,
          { id: "resume", role: "ai", text: "Welcome back! Your app is still being built — follow the progress on the right →" },
        ]);
      }
      return;
    }

    if (session.status !== "completed" && session.status !== "failed") return;

    const sb = session.bundle as SessionBundle | null | undefined;
    if (!sb?.handlerModule) return;

    const restoredBundle: GenerationBundle = {
      explanation: sb.explanation?.merchantFacing,
      triggerTopics: sb.handlerModule.webhookTopics ?? session.webhookTopics,
      triggerType: sb.handlerModule.cronSchedule
        ? "cron"
        : sb.adminUiModule
          ? "admin"
          : sb.widgetModule
            ? "widget"
            : "webhook",
      hasWidget: !!sb.widgetModule,
      hasAdminUI: !!sb.adminUiModule,
    };

    const alreadyDeployed = activeApp !== null && activeApp.status !== "draft";
    if (session.jobId) restore(session.jobId);
    setBundle(restoredBundle);
    setDeployed(alreadyDeployed);
    setMessages([
      WELCOME,
      {
        id: "resume",
        role: "ai",
        text: alreadyDeployed
          ? "Welcome back! This app is live. Describe what you'd like to change and I'll revise it."
          : "Welcome back! Your last generation is ready to deploy. Hit Deploy when you're ready, or describe changes first.",
      },
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSessionQuery.data, activeApp?.status]);

  // Intentionally no auto-selection: null means "create a new app" on confirm.

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isAnalyzing]);

  // Sync events to the store so they survive navigation
  useEffect(() => {
    if (gen.jobId && gen.events.length > 0) {
      updateEvents(gen.jobId, gen.events);
    }
  }, [gen.jobId, gen.events, updateEvents]);

  // Sync messages to the store so they survive navigation
  useEffect(() => {
    if (gen.jobId) {
      updateMessages(gen.jobId, messages);
    }
  }, [gen.jobId, messages, updateMessages]);

  // Sync global generation store so sidebar can show spinner on the right app
  useEffect(() => {
    if (gen.jobId && selectedAppId) {
      setActive(selectedAppId, gen.jobId, gen.status as "idle" | "running" | "completed" | "failed");
    } else if (gen.jobId) {
      updateStatus(gen.jobId, gen.status as "idle" | "running" | "completed" | "failed");
    }
    if (prevStatus.current === "running" && gen.status === "completed") {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: "Done! Review the output in the chat, then hit Deploy in the right panel whenever you're ready.",
        },
      ]);
      // Fetch the result bundle immediately so DeployPanel shows the real type/trigger
      if (gen.jobId) {
        api.generation.result(gen.jobId)
          .then((res) => { if (res.bundle) setBundle(normalizeBundleFromApi(res.bundle as Record<string, unknown>)); })
          .catch(() => null);
      }
    }
    if (prevStatus.current === "running" && gen.status === "failed") {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: gen.error === "Cancelled"
            ? "Generation cancelled."
            : `Generation failed: ${gen.error ?? "Unknown error. Please try again."}`,
        },
      ]);
    }
    prevStatus.current = gen.status;
  }, [gen.status, gen.jobId, gen.error, updateStatus]);

  /** Run the /analyze conversation step with the current history. */
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
      const question = result.question ?? "Could you tell me more about what you want to build?";
      const updatedHistory: AnalyzeMessage[] = [...history, { role: "assistant", content: question }];
      setAnalyzeHistory(updatedHistory);
      setAnalyzePhase("idle");
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "ai", text: question },
      ]);
    } else {
      // ready
      const summary = result.summary ?? "I understand your request. Ready to generate.";
      const intent = result.intent ?? {};
      setPendingIntent(intent);

      const confirmMsgId = crypto.randomUUID();
      setAnalyzePhase("awaiting_confirm");

      const handleConfirm = () => {
        const originalPrompt = history[0]?.content ?? "New App";
        const suggestedName = appIdForGen
          ? (apps.find((a) => a.id === appIdForGen)?.name ?? nameFromPrompt(originalPrompt))
          : nameFromPrompt(originalPrompt);

        setNameModal({
          suggestedName,
          onConfirm: async (chosenName: string) => {
            setNameModal(null);

            // Remove the action buttons from the confirm message
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
                await appsQuery.refetch();
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
              // Rename existing app if the merchant changed the name
              const existing = apps.find((a) => a.id === appId);
              if (existing && existing.name !== chosenName) {
                await api.apps.rename(tenantId!, appId, chosenName).catch(() => null);
                await appsQuery.refetch();
              }
            }

            setAnalyzePhase("idle");
            setPendingIntent(null);
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "ai", text: "Your app is being built — follow the progress on the right →" },
            ]);
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
                setMessages((prev) => prev.map((m) => (m.id === confirmMsgId ? { ...m, actions: [] } : m)));
                setAnalyzePhase("idle");
                setAnalyzeHistory([]);
                setPendingIntent(null);
              },
            },
          ],
        },
      ]);
    }
  }, [tenantId, appsQuery, start]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming || isAnalyzing || deploying) return;
    if (!tenantId) return;

    const prompt = input.trim();
    setInput("");

    // ── Revision path: deployed app, user describing a problem ───────────
    if (gen.jobId && deployed) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text: prompt },
        { id: crypto.randomUUID(), role: "ai", text: "Got it — revising the app..." },
      ]);
      setDeployed(false);
      setBundle(null);
      await startRevision(gen.jobId, prompt);
      return;
    }

    // ── Pre-deploy change: generation done but not yet deployed ───────────
    if (gen.jobId && gen.status === "completed" && !deployed) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text: prompt },
        { id: crypto.randomUUID(), role: "ai", text: "Revising before deploy..." },
      ]);
      await startRevision(gen.jobId, prompt);
      return;
    }

    // ── Analyze conversation ──────────────────────────────────────────────
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text: prompt },
    ]);

    const newHistory: AnalyzeMessage[] = [...analyzeHistory, { role: "user", content: prompt }];
    setAnalyzeHistory(newHistory);

    // If user typed while awaiting confirm, treat as a new request
    if (analyzePhase === "awaiting_confirm") {
      setPendingIntent(null);
      setAnalyzeHistory(newHistory);
    }

    await runAnalyze(newHistory, selectedAppId);
  }, [
    input,
    isStreaming,
    isAnalyzing,
    deploying,
    tenantId,
    selectedAppId,
    gen.jobId,
    gen.status,
    deployed,
    analyzeHistory,
    analyzePhase,
    startRevision,
    runAnalyze,
  ]);

  const handleStop = useCallback(() => {
    if (gen.jobId) void cancel(gen.jobId);
  }, [gen.jobId, cancel]);

  const handleDeploy = useCallback(async () => {
    if (!gen.jobId) return;
    setDeploying(true);
    try {
      await api.generation.approve(gen.jobId);
      const result = await api.generation.result(gen.jobId);
      setBundle(result.bundle ? normalizeBundleFromApi(result.bundle as Record<string, unknown>) : null);
      setDeployed(true);
      void activeAppQuery.refetch();
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: "Deployed! Use the right panel to validate the app. If something's wrong, describe it here and I'll revise.",
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: `Deploy failed: ${err instanceof Error ? err.message : "Unknown error."}`,
        },
      ]);
    } finally {
      setDeploying(false);
    }
  }, [gen.jobId, activeAppQuery]);

  const handleNewSession = () => {
    reset();
    setSelectedAppId(null);
    setDeployed(false);
    setBundle(null);
    setMessages([WELCOME]);
    setAnalyzeHistory([]);
    setAnalyzePhase("idle");
    setPendingIntent(null);
    prevStatus.current = "idle";
  };

  const chatPlaceholder = deployed
    ? "Describe what's wrong to revise and redeploy..."
    : gen.status === "completed"
      ? "Ask for a change before deploying..."
      : analyzePhase === "awaiting_confirm"
        ? "Or type here to change your request..."
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
        title="New App"
        subtitle={
          deployed && activeApp
            ? `${activeApp.name} · live`
            : activeApp
              ? activeApp.name
              : "Prompt to widget"
        }
        actions={
          <>
            {apps.length > 1 && !deployed && (
              <select
                value={selectedAppId ?? ""}
                onChange={(e) => setSelectedAppId(e.target.value)}
                className="text-xs bg-raised border border-white/13 text-muted rounded-lg px-2.5 py-1.5 outline-none focus:border-accent"
              >
                <option value="">New app</option>
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            {(deployed || gen.status !== "idle") && (
              <Button variant="ghost" size="sm" onClick={handleNewSession}>
                + New
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              ← Back
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-hidden flex">
        {/* ── Left: chat ─────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col border-r border-white/7 overflow-hidden min-w-0">
          <ChatMessages
            ref={bottomRef}
            messages={messages}
            isAnalyzing={isAnalyzing}
          />
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={handleSend}
            disabled={isStreaming || isAnalyzing || deploying}
            placeholder={chatPlaceholder}
            onStop={isStreaming ? handleStop : undefined}
          />
        </div>

        {/* ── Right: testing / deploy panel ──────────────────────────────── */}
        <AppTestingPanel
          gen={gen}
          bundle={bundle}
          app={activeApp}
          shopDomain={shopDomain}
          tenantId={tenantId}
          deployed={deployed}
          onDeploy={handleDeploy}
          deploying={deploying}
        />
      </div>
    </>
  );
}
