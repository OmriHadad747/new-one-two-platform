import { forwardRef, useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router";
import { cn } from "@/lib/cn";
import { ArtifactBlock } from "./ArtifactBlock";
import { ArchetypePills } from "@/components/ui/ArchetypePills";
import type { ProgressEvent } from "@/types/dashboard";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessageAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "ghost";
}

export interface DeployBundle {
  triggerType: string;
  triggerTopics: string[];
  hasWidget: boolean;
  hasAdminUI: boolean;
  archetype: "backend" | "storefront_backend" | "backend_admin" | "storefront_backend_admin";
  explanation?: string | null;
}

export interface ClarifyingData {
  suggestions: string[];
  /** Set once the user picks an answer — switches card to answered state. */
  answeredText?: string;
}

export interface ChatMessage {
  id: string;
  role: "ai" | "user";
  text?: string;
  /** Special inline card type rendered below the text. */
  type?: "generating" | "deploy-ready" | "live" | "clarifying";
  /** For "deploy-ready" messages. */
  deployBundle?: DeployBundle;
  /** For "live" messages — the app id to link to. */
  liveAppId?: string;
  /** For "clarifying" messages. */
  clarifyingData?: ClarifyingData;
  artifacts?: string[];
  actions?: ChatMessageAction[];
}

// ─── Generation step logic ────────────────────────────────────────────────────

const STATIC_STEPS: { agent: string; label: string }[] = [
  { agent: "product",     label: "Understanding your request"   },
  { agent: "architect",   label: "Planning API surface"         },
  { agent: "codespec",    label: "Writing implementation plan"  },
  { agent: "handler",     label: "Generating backend handler"   },
  { agent: "migration",   label: "Writing DB migration"         },
  { agent: "validation",  label: "Validating output"            },
  { agent: "explanation", label: "Preparing summary"            },
];

const OPTIONAL_AGENTS: Record<string, string> = {
  widget_js: "Generating storefront widget",
  admin_ui:  "Generating admin panel",
  validator: "Semantic alignment check",
  revision:  "Applying revisions",
};

function buildSteps(byAgent: Record<string, ProgressEvent>) {
  const steps = [...STATIC_STEPS];
  const validationIdx = steps.findIndex((s) => s.agent === "validation");

  const beforeValidation = ["widget_js", "admin_ui"]
    .filter((a) => a in byAgent)
    .map((a) => ({ agent: a, label: OPTIONAL_AGENTS[a] }));
  if (beforeValidation.length) steps.splice(validationIdx, 0, ...beforeValidation);

  if ("validator" in byAgent) {
    const idx = steps.findIndex((s) => s.agent === "validation");
    steps.splice(idx + 1, 0, { agent: "validator", label: OPTIONAL_AGENTS["validator"] });
  }
  if ("revision" in byAgent) {
    const idx = steps.findIndex((s) => s.agent === "validator");
    const after = idx !== -1 ? idx : steps.findIndex((s) => s.agent === "validation");
    steps.splice(after + 1, 0, { agent: "revision", label: OPTIONAL_AGENTS["revision"] });
  }
  return steps;
}

// ─── Inline cards ─────────────────────────────────────────────────────────────

function GeneratingCard({ events }: { events: ProgressEvent[] }) {
  const byAgent = events.reduce<Record<string, ProgressEvent>>((acc, e) => {
    acc[e.agent] = e;
    return acc;
  }, {});
  const steps = buildSteps(byAgent);
  const latestMessage = [...events].reverse().find(
    (e) => e.status === "running" || e.status === "retrying"
  )?.message;

  return (
    <div className="mt-2.5 bg-white/[0.04] border border-white/[0.07] rounded-xl p-4 max-w-[420px]">
      <p className="text-[10px] font-bold text-faint uppercase tracking-wider mb-3.5">
        Building your app
      </p>
      <div className="space-y-3">
        {steps.map(({ agent, label }) => {
          const status = byAgent[agent]?.status ?? "waiting";
          return (
            <div key={agent} className="flex items-center gap-3">
              <div className="w-5 h-5 flex items-center justify-center shrink-0">
                {status === "completed" && (
                  <span className="material-symbols-outlined text-teal text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                )}
                {status === "running" && (
                  <span className="w-2 h-2 rounded-full bg-accent animate-pulse-subtle block" />
                )}
                {status === "failed" && (
                  <span className="material-symbols-outlined text-danger text-[15px]">cancel</span>
                )}
                {status === "retrying" && (
                  <span className="material-symbols-outlined text-amber text-[15px] animate-spin">refresh</span>
                )}
                {!["completed", "running", "failed", "retrying"].includes(status) && (
                  <span className="w-2 h-2 rounded-full bg-white/10 block" />
                )}
              </div>
              <span className={cn(
                "text-[12.5px]",
                status === "completed" ? "text-muted" :
                status === "running"   ? "text-ink font-medium" :
                status === "failed"    ? "text-danger" :
                status === "retrying"  ? "text-amber" :
                "text-faint"
              )}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
      {latestMessage && (
        <div className="mt-3 pt-3 border-t border-white/[0.06]">
          <p className="text-[11px] text-accent animate-pulse-subtle leading-relaxed">{latestMessage}</p>
        </div>
      )}
    </div>
  );
}

function DeployReadyCard({
  bundle,
  onDeploy,
  deploying,
}: {
  bundle?: DeployBundle;
  onDeploy?: () => void;
  deploying?: boolean;
}) {
  const triggerLabel =
    bundle?.triggerType === "cron"   ? "Scheduled (cron)"  :
    bundle?.triggerType === "admin"  ? "Admin-triggered"   :
    bundle?.triggerType === "widget" ? "Widget interaction" :
    bundle?.triggerTopics?.[0]       ?? "Webhook-triggered";

  return (
    <div className="mt-2.5 max-w-[420px] space-y-3">
      {/* Summary card */}
      <div className="bg-white/[0.04] border border-white/[0.07] rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-teal text-[19px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          <span className="text-[15px] font-bold text-ink">Generation complete</span>
        </div>
        {bundle && (
          <div className="space-y-2.5 pt-1">
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] font-semibold text-faint uppercase tracking-wider w-16 shrink-0">Type</span>
              <ArchetypePills archetype={bundle.archetype} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] font-semibold text-faint uppercase tracking-wider w-16 shrink-0">Trigger</span>
              <span className="text-[12px] px-2.5 py-0.5 bg-teal/10 text-teal rounded-full font-mono">{triggerLabel}</span>
            </div>
          </div>
        )}
        {bundle?.explanation && (
          <p className="text-[12.5px] text-muted leading-relaxed pt-2.5 border-t border-white/[0.06]">
            {bundle.explanation.split("\n")[0]}
          </p>
        )}
      </div>

      {/* Deploy button */}
      <button
        type="button"
        onClick={onDeploy}
        disabled={deploying || !onDeploy}
        className="w-full py-3 bg-gradient-to-br from-accent to-accent/70 text-white rounded-xl text-sm font-bold border-0 cursor-pointer transition-all hover:opacity-90 disabled:opacity-60 flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>
          {deploying ? "hourglass_empty" : "rocket_launch"}
        </span>
        {deploying ? "Deploying…" : "Deploy to store"}
      </button>
    </div>
  );
}

function LiveCard({ appId }: { appId?: string }) {
  const navigate = useNavigate();
  return (
    <div className="mt-2.5 max-w-[420px] space-y-2.5">
      <div className="flex items-center gap-2.5 p-3.5 bg-teal/8 border border-teal/15 rounded-xl">
        <span className="w-2 h-2 rounded-full bg-teal shrink-0 animate-pulse" />
        <div>
          <p className="text-[13px] font-semibold text-teal">App is live</p>
          <p className="text-[11px] text-muted mt-0.5">Describe what's wrong here to revise and redeploy.</p>
        </div>
      </div>
      {appId && (
        <button
          type="button"
          onClick={() => navigate(`/app/apps/${appId}`)}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-white/[0.04] border border-white/[0.07] rounded-xl text-[12.5px] font-semibold text-muted hover:bg-white/[0.07] hover:text-ink transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[15px]">dashboard</span>
            <span>View App Details</span>
          </div>
          <span className="material-symbols-outlined text-[13px] text-faint">arrow_forward</span>
        </button>
      )}
    </div>
  );
}

// ─── Clarifying card ──────────────────────────────────────────────────────────

function ClarifyingCard({
  data,
  onAnswer,
}: {
  data: ClarifyingData;
  onAnswer?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data.answeredText) inputRef.current?.focus();
  }, [data.answeredText]);

  if (data.answeredText) {
    return (
      <div className="mt-2">
        <span className="inline-flex items-center gap-1.5 text-[12.5px] px-3 py-1.5 rounded-xl bg-accent/10 text-accent border border-accent/20 font-medium">
          <span className="material-symbols-outlined text-[13px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          {data.answeredText}
        </span>
      </div>
    );
  }

  const submit = (val: string) => { const v = val.trim(); if (v) onAnswer?.(v); };

  return (
    <div className="mt-3 max-w-[440px] space-y-2">

      {/* Stacked option buttons */}
      {data.suggestions.length > 0 && (
        <div className="space-y-1.5">
          {data.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => submit(s)}
              className="w-full text-left text-[13px] px-4 py-2.5 rounded-xl bg-white/[0.04] hover:bg-accent/8 border border-white/[0.09] hover:border-accent/30 text-muted hover:text-ink transition-all duration-150 cursor-pointer"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Always-visible free-text input */}
      <div className="flex gap-2 items-center">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(text); }}
          placeholder={data.suggestions.length > 0 ? "Or type your own…" : "Type your answer…"}
          className="flex-1 text-[13px] bg-white/[0.04] border border-white/[0.09] rounded-xl px-3.5 py-2 text-ink placeholder:text-faint outline-none focus:border-accent/40 transition-colors"
        />
        <button
          type="button"
          onClick={() => submit(text)}
          disabled={!text.trim()}
          className="w-8 h-8 rounded-xl bg-accent/15 hover:bg-accent/25 text-accent disabled:opacity-30 cursor-pointer border-0 transition-all flex items-center justify-center shrink-0"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
        </button>
      </div>

    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ChatMessagesProps {
  messages: ChatMessage[];
  isAnalyzing?: boolean;
  liveGenEvents?: ProgressEvent[];
  onDeploy?: () => void;
  deploying?: boolean;
  onClarifyAnswer?: (text: string) => void;
}

export const ChatMessages = forwardRef<HTMLDivElement, ChatMessagesProps>(
  ({ messages, isAnalyzing, liveGenEvents = [], onDeploy, deploying, onClarifyAnswer }, ref) => (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-6 flex flex-col gap-5 w-full max-w-[800px] mx-auto">
        {messages.map((msg) => (
          <div key={msg.id} className="flex gap-3">
            <div
              className={`w-[30px] h-[30px] rounded-lg shrink-0 flex items-center justify-center text-[13px] font-bold select-none
                ${msg.role === "ai"
                  ? "bg-gradient-to-br from-accent to-teal text-white"
                  : "bg-raised border border-white/13 text-muted"
                }`}
            >
              {msg.role === "ai" ? "A" : "M"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold text-faint mb-1.5 tracking-wide uppercase">
                {msg.role === "ai" ? "New One Two AI" : "You"}
              </div>

              {msg.text && (
                <p className={`text-sm leading-relaxed ${msg.role === "user" ? "text-muted" : "text-ink"}`}>
                  {msg.text}
                </p>
              )}

              {msg.type === "generating" && (
                <GeneratingCard events={liveGenEvents} />
              )}

              {msg.type === "deploy-ready" && (
                <DeployReadyCard bundle={msg.deployBundle} onDeploy={onDeploy} deploying={deploying} />
              )}

              {msg.type === "live" && (
                <LiveCard appId={msg.liveAppId} />
              )}

              {msg.type === "clarifying" && msg.clarifyingData && (
                <ClarifyingCard data={msg.clarifyingData} onAnswer={onClarifyAnswer} />
              )}

              {msg.artifacts && msg.artifacts.length > 0 && (
                <ArtifactBlock label="Output" files={msg.artifacts} />
              )}

              {msg.actions && msg.actions.length > 0 && (
                <div className="flex gap-2 mt-3 flex-wrap">
                  {msg.actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={action.onClick}
                      className={
                        action.variant === "ghost"
                          ? "text-xs px-3 py-1.5 rounded-lg border border-white/13 text-muted hover:text-ink hover:border-white/25 transition-all duration-150 cursor-pointer bg-transparent"
                          : "text-xs px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent-hi transition-all duration-150 cursor-pointer border-0"
                      }
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {isAnalyzing && (
          <div className="flex gap-3">
            <div className="w-[30px] h-[30px] rounded-lg shrink-0 flex items-center justify-center text-[13px] font-bold bg-gradient-to-br from-accent to-teal text-white select-none">
              A
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold text-faint mb-1.5 tracking-wide uppercase">
                New One Two AI
              </div>
              <p className="text-sm text-faint animate-pulse">Thinking…</p>
            </div>
          </div>
        )}

        <div ref={ref} />
      </div>
    </div>
  )
);
ChatMessages.displayName = "ChatMessages";
