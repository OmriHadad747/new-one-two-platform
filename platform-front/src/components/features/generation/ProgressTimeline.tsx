import type { ProgressEvent } from "@/types/dashboard";
import { cn } from "@/lib/cn";

const AGENT_LABELS: Record<string, string> = {
  intent: "Parsing intent",
  schema: "Designing schema",
  codegen: "Generating code",
  widget_config: "Building widget config",
  handler: "Writing handler",
  migration: "Writing migration",
  validation: "Validating output",
  explanation: "Writing summary",
};

export function ProgressTimeline({
  events,
  isStreaming,
}: {
  events: ProgressEvent[];
  isStreaming: boolean;
}) {
  const byAgent = events.reduce<Record<string, ProgressEvent>>((acc, e) => {
    acc[e.agent] = e;
    return acc;
  }, {});

  const latest = events[events.length - 1];

  return (
    <div className="mt-3 bg-raised border border-white/7 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2 bg-white/[0.03] border-b border-white/7">
        <span className="text-[10px] font-bold text-accent tracking-widest uppercase">
          Generating
        </span>
        {isStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-subtle" />
        )}
      </div>
      <div className="px-3.5 py-3 font-mono text-[11px] text-muted leading-[1.7]">
        {Object.entries(byAgent).map(([agent, event]) => (
          <div key={agent} className="flex items-center gap-2 mb-1">
            <span
              className={cn(
                event.status === "completed" && "text-teal",
                event.status === "running" && "text-accent",
                event.status === "failed" && "text-danger",
                event.status === "retrying" && "text-amber"
              )}
            >
              {event.status === "completed"
                ? "✓"
                : event.status === "failed"
                  ? "✗"
                  : event.status === "retrying"
                    ? "↻"
                    : "·"}
            </span>
            <span
              className={cn(
                event.status === "running" && "text-ink animate-pulse-subtle",
                event.status === "completed" && "text-muted"
              )}
            >
              {AGENT_LABELS[agent] ?? agent}
            </span>
          </div>
        ))}
        {isStreaming && latest && (
          <div className="flex items-center gap-1.5 mt-1.5 text-faint text-[10px]">
            <span className="animate-pulse-subtle">{latest.message}</span>
            <span className="inline-block w-0.5 h-3 bg-accent animate-blink" />
          </div>
        )}
      </div>
    </div>
  );
}
