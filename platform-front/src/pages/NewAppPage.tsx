import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { ChatMessages, type ChatMessage } from "@/components/features/generation/ChatMessages";
import { ChatInput } from "@/components/features/generation/ChatInput";
import { GenerationPreview } from "@/components/features/generation/GenerationPreview";
import { useGeneration } from "@/hooks/useGeneration";
import { useSessionStore } from "@/stores/session";
import { useApps } from "@/hooks/useApps";

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "ai",
  text: "Hey! Describe the Shopify feature you want to build. Be as specific or vague as you like — New One Two will handle the rest.",
};

const OUTPUT_FILES = [
  { name: "widget.js", icon: "📦", size: "—" },
  { name: "backend_handler.js", icon: "⚙️", size: "—" },
  { name: "migration_001.sql", icon: "🗃️", size: "—" },
];

export function NewAppPage() {
  const navigate = useNavigate();
  const { tenantId } = useSessionStore();
  const appsQuery = useApps(tenantId);

  // Use the first app for generation target, or prompt user to select
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const apps = appsQuery.data ?? [];

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevStatus = useRef<string>("idle");

  const { state: gen, start, approve } = useGeneration();
  const isStreaming = gen.status === "running";

  // Auto-select first available app when loaded
  useEffect(() => {
    if (!selectedAppId && apps.length > 0 && apps[0]) {
      setSelectedAppId(apps[0].id);
    }
  }, [apps, selectedAppId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming, gen.events.length]);

  useEffect(() => {
    if (prevStatus.current === "running" && gen.status === "completed") {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: "Done! Preview the widget on the right. When you're happy, deploy it to your store.",
          artifacts: OUTPUT_FILES.map((f) => f.name),
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
    if (!input.trim() || isStreaming) return;
    const prompt = input.trim();
    setInput("");

    if (!tenantId || !selectedAppId) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ai",
          text: "No app selected. Please create an app first or complete store setup.",
        },
      ]);
      return;
    }

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text: prompt },
    ]);

    await start({ appId: selectedAppId, tenantId, prompt });
  }, [input, isStreaming, start, tenantId, selectedAppId]);

  const showFiles = gen.status === "completed" ? OUTPUT_FILES : [];

  return (
    <>
      <TopBar
        title="New App"
        subtitle="Prompt to widget"
        actions={
          <>
            {apps.length > 1 && (
              <select
                value={selectedAppId ?? ""}
                onChange={(e) => setSelectedAppId(e.target.value)}
                className="text-xs bg-raised border border-white/13 text-muted rounded-lg px-2.5 py-1.5 outline-none focus:border-accent"
              >
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            {gen.status === "completed" && gen.jobId && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void approve(gen.jobId!).then(() => navigate("/apps"))}
              >
                ↑ Deploy
              </Button>
            )}
            <Button variant="ghost" onClick={() => navigate(-1)}>
              ← Back
            </Button>
          </>
        }
      />
      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 flex flex-col border-r border-white/7 overflow-hidden">
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
            disabled={isStreaming}
          />
        </div>
        <GenerationPreview files={showFiles} />
      </div>
    </>
  );
}
