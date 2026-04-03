import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { ChatMessages, type ChatMessage } from "@/components/features/generation/ChatMessages";
import { ChatInput } from "@/components/features/generation/ChatInput";
import { AppTestingPanel } from "@/components/features/generation/AppTestingPanel";
import { useGeneration } from "@/hooks/useGeneration";
import { useSessionStore } from "@/stores/session";
import { useApps, useApp } from "@/hooks/useApps";
import { api } from "@/lib/api";
import type { GenerationBundle } from "@/types/dashboard";

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "ai",
  text: "Hey! Describe the Shopify feature you want to build. New One Two will generate the widget, backend handler, and any DB migrations — then deploy it to your store.",
};

/** Derives a human-readable app name from the first ~40 chars of the prompt. */
function nameFromPrompt(prompt: string): string {
  const clean = prompt.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  const words = clean.split(/\s+/).slice(0, 5).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1) || "New App";
}

/** Derives a URL-safe slug and appends a short random suffix to ensure uniqueness. */
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
  const { tenantId, shopDomain } = useSessionStore();
  const appsQuery = useApps(tenantId);

  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const apps = appsQuery.data ?? [];

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevStatus = useRef<string>("idle");

  // Deployment state
  const [deployed, setDeployed] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [bundle, setBundle] = useState<GenerationBundle | null>(null);

  const { state: gen, start, startRevision, reset } = useGeneration();
  const isStreaming = gen.status === "running";

  const activeAppQuery = useApp(tenantId, selectedAppId);
  const activeApp = activeAppQuery.data ?? null;

  // Auto-select first existing app (for re-generation against an existing one)
  useEffect(() => {
    if (!selectedAppId && apps.length > 0 && apps[0]) {
      setSelectedAppId(apps[0].id);
    }
  }, [apps, selectedAppId]);

  // Scroll to bottom on new messages / streaming events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming, gen.events.length]);

  // React to generation status transitions
  useEffect(() => {
    if (prevStatus.current === "running" && gen.status === "completed") {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: "Done! Review the output in the chat, then hit Deploy in the right panel whenever you're ready.",
        },
      ]);
    }
    if (prevStatus.current === "running" && gen.status === "failed") {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: `Generation failed: ${gen.error ?? "Unknown error. Please try again."}`,
        },
      ]);
    }
    prevStatus.current = gen.status;
  }, [gen.status, gen.error]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming || deploying) return;
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

    // ── Fresh generation ──────────────────────────────────────────────────
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text: prompt },
    ]);

    // If no app exists yet, create one automatically
    let appId = selectedAppId;
    if (!appId) {
      const name = nameFromPrompt(prompt);
      const slug = slugFromName(name);
      try {
        const newApp = await api.apps.create(tenantId, { slug, name });
        appId = newApp.id;
        setSelectedAppId(newApp.id);
        await appsQuery.refetch();
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "ai",
            text: `Created app "${newApp.name}". Generating now...`,
          },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "ai",
            text: `Couldn't create the app: ${err instanceof Error ? err.message : "Unknown error"}`,
          },
        ]);
        return;
      }
    }

    await start({ appId, tenantId, prompt });
  }, [
    input,
    isStreaming,
    deploying,
    tenantId,
    selectedAppId,
    gen.jobId,
    gen.status,
    deployed,
    start,
    startRevision,
    appsQuery,
  ]);

  const handleDeploy = useCallback(async () => {
    if (!gen.jobId) return;
    setDeploying(true);
    try {
      await api.generation.approve(gen.jobId);
      // Fetch the result bundle for testing instructions
      const result = await api.generation.result(gen.jobId);
      setBundle(result.bundle ?? null);
      setDeployed(true);
      // Refresh the app data so status shows "active"
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
    prevStatus.current = "idle";
  };

  const chatPlaceholder = deployed
    ? "Describe what's wrong to revise and redeploy..."
    : gen.status === "completed"
      ? "Ask for a change before deploying..."
      : undefined;

  return (
    <>
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
            isStreaming={isStreaming}
            streamingEvents={gen.events}
          />
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={handleSend}
            disabled={isStreaming || deploying}
            placeholder={chatPlaceholder}
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
