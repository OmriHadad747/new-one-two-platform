import { forwardRef, useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router";
import { cn } from "@/lib/cn";
import { ArchetypePills } from "@/components/ui/ArchetypePills";
import type { AppArchetype, ProgressEvent } from "@/types/dashboard";

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
  /** App id used to navigate to the App Details page. */
  appId?: string;
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
  type?: "generating" | "deploy-ready" | "live" | "clarifying" | "confirm";
  /** For "deploy-ready" messages. */
  deployBundle?: DeployBundle;
  /** For "live" messages — the app id to link to. */
  liveAppId?: string;
  /** For "clarifying" messages. */
  clarifyingData?: ClarifyingData;
  /** For "confirm" messages — serializable data to reconstruct Generate/Change actions after hydration. */
  confirmData?: { intent: Record<string, unknown>; originalPrompt: string };
  /** Set on a "generating" message when the generation has failed — shows an inline failure banner. */
  generatingFailed?: boolean;
  /** For plan restriction errors — shows archetype pills + upgrade prompt. */
  planBlock?: { archetype: AppArchetype; upgradeHint: string };
  actions?: ChatMessageAction[];
}

// ─── Generation step logic ────────────────────────────────────────────────────

const STATIC_STEPS: { agent: string; label: string }[] = [
  { agent: "product",     label: "Understanding your request"   },
  { agent: "architect",   label: "Planning app architecture"    },
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
    const revTs = byAgent["revision"]?.timestampMs ?? 0;
    const valTs = byAgent["validation"]?.timestampMs ?? Infinity;
    if (revTs < valTs) {
      // Codegen-phase revision (holistic revision run) — insert just before handler
      const handlerIdx = steps.findIndex((s) => s.agent === "handler");
      steps.splice(handlerIdx, 0, { agent: "revision", label: OPTIONAL_AGENTS["revision"] });
    } else {
      // Post-validator semantic revision — insert after validator (or validation)
      const idx = steps.findIndex((s) => s.agent === "validator");
      const after = idx !== -1 ? idx : steps.findIndex((s) => s.agent === "validation");
      steps.splice(after + 1, 0, { agent: "revision", label: OPTIONAL_AGENTS["revision"] });
    }
  }
  return steps;
}

// ─── Inline cards ─────────────────────────────────────────────────────────────

/**
 * Resolves the display status for a step, using two inference rules:
 *
 * 1. Order inference — steps run sequentially. If a later step has started,
 *    earlier steps without a completion event must already be done.
 *
 * 2. Completion override — once generation is done, any step still showing
 *    "running" (because the backend never sent its completion event) is
 *    treated as "completed".
 */
function resolveStepStatus(
  agent: string,
  stepIndex: number,
  byAgent: Record<string, ProgressEvent>,
  steps: { agent: string }[],
  isCompleted: boolean,
): "waiting" | "running" | "completed" | "failed" | "retrying" {
  const event = byAgent[agent];

  // Furthest step index that has received any event
  const furthestActive = steps.reduce((max, s, i) => (byAgent[s.agent] ? Math.max(max, i) : max), -1);

  if (event) {
    if (isCompleted && event.status === "running") return "completed";
    return event.status;
  }

  // No event for this step — infer from context
  if (stepIndex < furthestActive || isCompleted) return "completed";
  return "waiting";
}

function GeneratingCard({ events, isCompleted, stuckWarning, isFailed }: { events: ProgressEvent[]; isCompleted?: boolean; stuckWarning?: boolean; isFailed?: boolean }) {
  const byAgent = events.reduce<Record<string, ProgressEvent>>((acc, e) => {
    acc[e.agent] = e;
    return acc;
  }, {});
  const steps = buildSteps(byAgent);

  // Agents currently running in parallel (ordered by step position for determinism).
  const runningAgents = isCompleted
    ? []
    : steps
        .map((s) => s.agent)
        .filter((a) => byAgent[a]?.status === "running" || byAgent[a]?.status === "retrying");

  // Cycle through parallel agents every 2s when >1 active.
  const [cycleIdx, setCycleIdx] = useState(0);
  useEffect(() => {
    if (runningAgents.length <= 1) return;
    const id = setInterval(() => setCycleIdx((i) => i + 1), 2000);
    return () => clearInterval(id);
  }, [runningAgents.length]);

  // The one agent whose message and dot are "highlighted" this cycle.
  const activeAgent = runningAgents.length > 0
    ? runningAgents[cycleIdx % runningAgents.length]
    : null;

  const latestMessage = activeAgent ? (byAgent[activeAgent]?.message ?? null) : null;

  return (
    <div className="mt-2.5 bg-white/[0.04] rounded-xl p-4 max-w-[420px]">
      <p className="text-[10px] font-bold text-faint uppercase tracking-wider mb-3.5">
        Building your app
      </p>
      <div className="space-y-3">
        {steps.map(({ agent, label }, idx) => {
          const status = resolveStepStatus(agent, idx, byAgent, steps, isCompleted ?? false);
          // Parallel sibling: running but not the currently highlighted agent.
          const isParallelSibling = status === "running" && agent !== activeAgent;
          return (
            <div key={agent} className="flex items-center gap-3">
              <div className="w-5 h-5 flex items-center justify-center shrink-0">
                {status === "completed" && (
                  <span className="material-symbols-outlined text-accent/70 text-[16px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}>task_alt</span>
                )}
                {status === "running" && !isParallelSibling && (
                  <span className="w-2 h-2 rounded-full bg-accent animate-pulse-subtle block" />
                )}
                {status === "running" && isParallelSibling && (
                  <span className="w-2 h-2 rounded-full bg-accent/30 block" />
                )}
                {status === "failed" && (
                  <span className="material-symbols-outlined text-danger text-[15px]">cancel</span>
                )}
                {status === "retrying" && (
                  <span className="material-symbols-outlined text-amber text-[15px] animate-spin">refresh</span>
                )}
                {status === "waiting" && (
                  <span className="w-2 h-2 rounded-full bg-faint/30 block" />
                )}
              </div>
              <span className={cn(
                "text-[12.5px]",
                status === "completed"              ? "text-muted" :
                status === "running" && !isParallelSibling ? "text-ink font-medium" :
                status === "running" && isParallelSibling  ? "text-muted" :
                status === "failed"                 ? "text-danger" :
                status === "retrying"               ? "text-amber" :
                "text-faint"
              )}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
      {latestMessage && (
        <div className="mt-3 pt-3 border-t border-white/[0.04]">
          <p className="text-[11px] text-accent animate-pulse-subtle leading-relaxed">{latestMessage}</p>
        </div>
      )}
      {isFailed && (
        <div className="mt-3 pt-3 border-t border-danger/20">
          <div className="flex items-start gap-2 text-[11px] text-danger leading-relaxed">
            <span className="material-symbols-outlined text-[14px] shrink-0 mt-px">error</span>
            <span>Generation failed. See the error above for details.</span>
          </div>
        </div>
      )}
      {stuckWarning && !isCompleted && !isFailed && (
        <div className="mt-3 pt-3 border-t border-amber/20">
          <div className="flex items-start gap-2 text-[11px] text-amber leading-relaxed">
            <span className="material-symbols-outlined text-[14px] shrink-0 mt-px">warning</span>
            <span>This is taking longer than expected. You can wait or cancel and try again.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ExplanationText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const sentences = text
    .replace(/\n+/g, " ")
    .match(/[^.!?]+[.!?]+/g)
    ?.map((s) => s.trim())
    .filter(Boolean) ?? [text];
  const preview = sentences.slice(0, 2).join(" ");
  const rest = sentences.slice(2);

  return (
    <div className="text-[12px] text-muted leading-relaxed">
      <p>{preview}</p>
      {expanded && rest.length > 0 && (
        <div className="mt-2 space-y-2">
          {rest.map((s, i) => <p key={i}>{s}</p>)}
        </div>
      )}
      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 text-[11px] text-accent/70 hover:text-accent transition-colors bg-transparent border-0 cursor-pointer p-0 flex items-center gap-0.5"
        >
          {expanded ? "Show less" : `Show more`}
          <span className="material-symbols-outlined text-[13px]">
            {expanded ? "expand_less" : "expand_more"}
          </span>
        </button>
      )}
    </div>
  );
}

function DeployReadyCard({ bundle }: { bundle?: DeployBundle }) {
  const navigate = useNavigate();
  const triggerLabel =
    bundle?.triggerType === "cron"   ? "Scheduled (cron)"  :
    bundle?.triggerType === "admin"  ? "Admin-triggered"   :
    bundle?.triggerType === "widget" ? "Widget interaction" :
    bundle?.triggerTopics?.[0]       ?? "Webhook-triggered";

  return (
    <div className="mt-2.5 max-w-[420px] space-y-3">
      {/* Summary card */}
      <div className="bg-white/[0.04] rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-accent text-[19px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}>auto_awesome</span>
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
          <div className="pt-2.5 border-t border-white/[0.04]">
            <ExplanationText text={bundle.explanation} />
          </div>
        )}
      </div>

      {/* View App Details button */}
      {bundle?.appId && (
        <button
          type="button"
          onClick={() => navigate(`/app/apps/${bundle.appId}`)}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-white/[0.04] rounded-xl text-[12.5px] font-semibold text-muted hover:bg-white/[0.07] hover:text-ink transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[15px]">dashboard</span>
            <span>View App Details to deploy</span>
          </div>
          <span className="material-symbols-outlined text-[13px] text-faint">arrow_forward</span>
        </button>
      )}
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
          className="w-full flex items-center justify-between px-4 py-2.5 bg-white/[0.04] rounded-xl text-[12.5px] font-semibold text-muted hover:bg-white/[0.07] hover:text-ink transition-colors cursor-pointer"
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

// ─── Plan blocked card ────────────────────────────────────────────────────────

function PlanBlockedCard({ archetype, upgradeHint }: { archetype: AppArchetype; upgradeHint: string }) {
  return (
    <div className="mt-2.5 max-w-[380px] bg-white/[0.03] rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.04]">
        <span
          className="material-symbols-outlined text-[15px] text-amber"
          style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}
        >
          lock
        </span>
        <span className="text-[12.5px] font-semibold text-ink">Not available on your plan</span>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2.5">
        <div className="space-y-1.5">
          <p className="text-[10.5px] font-semibold text-faint uppercase tracking-wider">App type requested</p>
          <ArchetypePills archetype={archetype} />
        </div>
        <p className="text-[11.5px] text-muted leading-relaxed">{upgradeHint}</p>
      </div>
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
          <span className="material-symbols-outlined text-[13px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}>check_circle</span>
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
              className="w-full text-left text-[13px] px-4 py-2.5 rounded-xl bg-white/[0.04] hover:bg-accent/8 text-muted hover:text-ink transition-all duration-150 cursor-pointer"
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
          className="flex-1 text-[13px] bg-white/[0.04] rounded-xl px-3.5 py-2 text-ink placeholder:text-faint outline-none transition-colors"
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
  /** True once gen.status === "completed" — clears stale "running" step states */
  generationCompleted?: boolean;
  /** True when the generating card has been running for too long without progress. */
  stuckWarning?: boolean;
  onClarifyAnswer?: (text: string) => void;
}

export const ChatMessages = forwardRef<HTMLDivElement, ChatMessagesProps>(
  ({ messages, isAnalyzing, liveGenEvents = [], generationCompleted, stuckWarning, onClarifyAnswer }, ref) => {
    return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-5 pt-6 pb-32 flex flex-col gap-6 w-full max-w-[760px] mx-auto">
        {messages.map((msg) => {
          if (msg.role === "user") {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[72%] bg-raised rounded-2xl rounded-tr-sm px-4 py-2.5 shadow-sm">
                  {msg.text && (
                    <p className="text-[13px] text-ink leading-relaxed">{msg.text}</p>
                  )}
                </div>
              </div>
            );
          }

          // AI message
          return (
            <div key={msg.id} className="flex gap-3 items-start">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-bold text-accent mb-2 tracking-wide">Ton</div>

                {msg.text && (
                  <p className="text-[13px] text-ink leading-relaxed">{msg.text}</p>
                )}

                {msg.type === "generating" && (
                  <GeneratingCard events={liveGenEvents} isCompleted={generationCompleted} stuckWarning={stuckWarning} isFailed={msg.generatingFailed} />
                )}

                {msg.type === "deploy-ready" && (
                  <DeployReadyCard bundle={msg.deployBundle} />
                )}

                {msg.type === "live" && (
                  <LiveCard appId={msg.liveAppId} />
                )}

                {msg.type === "clarifying" && msg.clarifyingData && (
                  <ClarifyingCard data={msg.clarifyingData} onAnswer={onClarifyAnswer} />
                )}

                {msg.planBlock && (
                  <PlanBlockedCard archetype={msg.planBlock.archetype} upgradeHint={msg.planBlock.upgradeHint} />
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
                            ? "text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] text-muted hover:text-ink hover:bg-white/[0.08] transition-all duration-150 cursor-pointer"
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
          );
        })}

        {isAnalyzing && (
          <div className="flex gap-3 items-start">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-bold text-accent mb-2 tracking-wide">Ton</div>
              <p className="text-[13px] text-faint animate-pulse">Thinking…</p>
            </div>
          </div>
        )}

        <div ref={ref} />
      </div>
    </div>
    );
  }
);
ChatMessages.displayName = "ChatMessages";
