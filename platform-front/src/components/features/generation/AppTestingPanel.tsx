import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { useAppLogs } from "@/hooks/useApps";
import { useState } from "react";
import type { GenerationState, GenerationBundle, App, ProgressEvent } from "@/types/dashboard";

interface AppTestingPanelProps {
  gen: GenerationState;
  bundle: GenerationBundle | null;
  app: App | null;
  shopDomain: string | null;
  tenantId: string | null;
  deployed: boolean;
  onDeploy: () => void;
  deploying: boolean;
}

// ─── Pipeline steps ───────────────────────────────────────────────────────────

const STEPS = [
  { agent: "product",     label: "Understanding your request" },
  { agent: "architect",   label: "Planning API surface"       },
  { agent: "codespec",    label: "Writing implementation plan"},
  { agent: "handler",     label: "Generating backend handler" },
  { agent: "migration",   label: "Writing DB migration"       },
  { agent: "validation",  label: "Validating output"          },
  { agent: "explanation", label: "Preparing summary"          },
];

function stepStatus(agent: string, byAgent: Record<string, ProgressEvent>) {
  return byAgent[agent]?.status ?? "waiting";
}

// ─── Generating state ─────────────────────────────────────────────────────────

function GeneratingPanel({ events }: { events: ProgressEvent[] }) {
  const byAgent = events.reduce<Record<string, ProgressEvent>>((acc, e) => {
    acc[e.agent] = e;
    return acc;
  }, {});

  const latestMessage = [...events].reverse().find(
    (e) => e.status === "running" || e.status === "retrying"
  )?.message;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold text-faint uppercase tracking-wider mb-4">
          Building your app
        </p>
        <div className="space-y-3.5">
          {STEPS.map(({ agent, label }) => {
            const status = stepStatus(agent, byAgent);
            return (
              <div key={agent} className="flex items-center gap-3">
                <div className="w-5 h-5 flex items-center justify-center shrink-0">
                  {status === "completed" && (
                    <span className="material-symbols-outlined text-teal text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                  )}
                  {status === "running" && (
                    <span className="w-2 h-2 rounded-full bg-accent animate-pulse-subtle block" />
                  )}
                  {status === "failed" && (
                    <span className="material-symbols-outlined text-danger text-[16px]">cancel</span>
                  )}
                  {status === "retrying" && (
                    <span className="material-symbols-outlined text-amber text-[16px] animate-spin">refresh</span>
                  )}
                  {status === "waiting" && (
                    <span className="w-2 h-2 rounded-full bg-white/10 block" />
                  )}
                </div>
                <span className={cn(
                  "text-[13px]",
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
      </div>

      {latestMessage && (
        <div className="bg-accent/5 border border-accent/10 rounded-xl px-4 py-3">
          <p className="text-[11px] text-accent animate-pulse-subtle leading-relaxed">
            {latestMessage}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Deploy gate ──────────────────────────────────────────────────────────────

function DeployPanel({
  bundle,
  app,
  onDeploy,
  deploying,
}: {
  bundle: GenerationBundle | null;
  app: App | null;
  onDeploy: () => void;
  deploying: boolean;
}) {
  const archetype = app?.appArchetype ?? "backend_only";
  const triggerType = bundle?.triggerType ?? "webhook";
  const topics = bundle?.triggerTopics ?? [];

  const archetypeLabel = archetype === "storefront_ui" ? "Widget + Backend" : "Backend only";
  const triggerLabel =
    triggerType === "cron"    ? "Scheduled (cron)"  :
    triggerType === "admin"   ? "Admin-triggered"   :
    triggerType === "widget"  ? "Widget interaction" :
    topics[0] ?? "Webhook-triggered";

  return (
    <div className="space-y-5">
      {/* Summary card */}
      <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-teal text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          <span className="text-sm font-bold text-ink">Generation complete</span>
        </div>

        <div className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold text-faint uppercase tracking-wider w-14 shrink-0">Type</span>
            <span className="text-xs px-2 py-0.5 bg-accent/10 text-accent rounded-full">{archetypeLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold text-faint uppercase tracking-wider w-14 shrink-0">Trigger</span>
            <span className="text-xs px-2 py-0.5 bg-teal/10 text-teal rounded-full font-mono">{triggerLabel}</span>
          </div>
        </div>

        {bundle?.explanation && (
          <p className="text-[11px] text-muted leading-relaxed pt-1 border-t border-white/[0.06]">
            {bundle.explanation.split("\n")[0]}
          </p>
        )}
      </div>

      {/* Deploy CTA */}
      <button
        type="button"
        onClick={onDeploy}
        disabled={deploying}
        className="w-full py-3.5 bg-gradient-to-br from-accent to-accent/70 text-white rounded-xl text-sm font-bold border-0 cursor-pointer transition-all hover:opacity-90 disabled:opacity-60 flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>
          {deploying ? "hourglass_empty" : "rocket_launch"}
        </span>
        {deploying ? "Deploying…" : "Deploy to store"}
      </button>

      <p className="text-[11px] text-faint text-center leading-relaxed">
        Activates the handler and {archetype === "storefront_ui" ? "injects the widget into your theme" : "registers webhook subscriptions"}.
      </p>
    </div>
  );
}

// ─── Live panel (post-deploy) ─────────────────────────────────────────────────

function LivePanel({
  bundle,
  app,
  shopDomain,
  tenantId,
}: {
  bundle: GenerationBundle | null;
  app: App | null;
  shopDomain: string | null;
  tenantId: string | null;
}) {
  const [triggerState, setTriggerState] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [triggerOut, setTriggerOut] = useState<string | null>(null);

  const logsQuery = useAppLogs(tenantId, app?.id ?? null, true);
  const logs = logsQuery.data ?? [];

  const canTrigger =
    !!shopDomain &&
    !!app?.id &&
    (bundle?.triggerType === "admin" || bundle?.triggerType === "cron" || bundle?.triggerType === "widget");

  const handleTrigger = async () => {
    if (!shopDomain || !app?.id) return;
    setTriggerState("loading");
    setTriggerOut(null);
    try {
      const res = await api.widgets.trigger(shopDomain, app.id);
      setTriggerState("ok");
      setTriggerOut(JSON.stringify(res, null, 2));
    } catch (err) {
      setTriggerState("err");
      setTriggerOut(err instanceof Error ? err.message : "Trigger failed");
    }
  };

  const hasWidget = bundle?.hasWidget ?? app?.appArchetype === "storefront_ui";
  const storeFrontUrl = shopDomain ? `https://${shopDomain}` : null;
  const themeEditorUrl = shopDomain ? `https://${shopDomain}/admin/themes/current/editor` : null;
  const adminUrl = shopDomain ? `https://${shopDomain}/admin/apps` : null;

  const triggerTopics = bundle?.triggerTopics ?? [];
  const topicHint = triggerTopics.length > 0 ? `(${triggerTopics[0]})` : "in Shopify";
  const validateSteps = bundle?.explanation
    ? bundle.explanation.split(/\n+/).filter(Boolean)
    : app?.appArchetype === "storefront_ui"
      ? [
          "Open your store and navigate to a product page.",
          "The widget should appear — interact with it.",
          "Check the Logs section below for backend calls.",
          "Something wrong? Describe it in the chat to revise.",
        ]
      : [
          `Trigger a real event ${topicHint} — e.g. create a test order.`,
          "Check the Logs section — your execution should appear within 5s.",
          "Verify status shows 'success' and the expected action occurred.",
          "Something wrong? Describe it in the chat to revise.",
        ];

  const statusDot: Record<string, string> = {
    success: "bg-teal",
    failed:  "bg-danger",
    timeout: "bg-danger",
    running: "bg-accent animate-pulse-subtle",
    queued:  "bg-faint",
  };
  const statusText: Record<string, string> = {
    success: "text-teal",
    failed:  "text-danger",
    timeout: "text-danger",
    running: "text-accent",
    queued:  "text-faint",
  };

  return (
    <div className="space-y-7">

      {/* ── Validate ───────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3.5">
          <span className="material-symbols-outlined text-accent text-[16px]">checklist</span>
          <span className="text-[11px] font-bold text-ink uppercase tracking-wider">Validate</span>
        </div>
        <ol className="space-y-3">
          {validateSteps.map((step, i) => (
            <li key={i} className="flex gap-3 text-[13px] text-muted leading-relaxed">
              <span className="w-5 h-5 rounded-full bg-accent/12 flex items-center justify-center text-accent text-[10px] font-bold shrink-0 mt-0.5">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {canTrigger && (
          <div className="mt-4">
            <button
              type="button"
              onClick={handleTrigger}
              disabled={triggerState === "loading"}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-teal/12 text-teal text-[12px] font-bold border-0 cursor-pointer hover:bg-teal/20 transition-colors disabled:opacity-60"
            >
              <span className="material-symbols-outlined text-[14px]">
                {triggerState === "loading" ? "hourglass_empty" : "play_arrow"}
              </span>
              {triggerState === "loading" ? "Firing…" : "Fire test event"}
            </button>
            {triggerOut && (
              <pre className={cn(
                "mt-2.5 p-3 rounded-lg font-mono text-[10px] leading-relaxed overflow-x-auto",
                triggerState === "ok" ? "bg-teal/8 text-teal" : "bg-danger/8 text-danger"
              )}>
                {triggerOut}
              </pre>
            )}
          </div>
        )}
      </section>

      {/* ── Logs ───────────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3.5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-teal text-[16px]">terminal</span>
            <span className="text-[11px] font-bold text-ink uppercase tracking-wider">Logs</span>
            <span className="w-1.5 h-1.5 rounded-full bg-teal animate-pulse-subtle" />
          </div>
          {logsQuery.isFetching && (
            <span className="material-symbols-outlined text-faint text-[14px] animate-spin">refresh</span>
          )}
        </div>

        {logs.length === 0 && !logsQuery.isFetching && (
          <div className="py-8 text-center">
            <p className="text-[12px] text-faint">No executions yet.</p>
            <p className="text-[11px] text-faint mt-1 opacity-60">Trigger an event in Shopify to see logs.</p>
          </div>
        )}

        {logs.length > 0 && (
          <div className="space-y-1.5">
            {logs.slice(0, 8).map((log) => (
              <div key={log.id} className="bg-raised border border-white/[0.05] rounded-lg px-3.5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusDot[log.status] ?? "bg-faint")} />
                  <span className="font-mono text-[11px] text-ink flex-1 truncate">{log.topic}</span>
                  <span className={cn("text-[10px] font-bold shrink-0", statusText[log.status] ?? "text-faint")}>
                    {log.status}
                  </span>
                </div>
                <div className="flex items-center gap-3 pl-4 mt-0.5">
                  <span className="text-[10px] text-faint font-mono">
                    {new Date(log.queuedAt).toLocaleTimeString()}
                  </span>
                  {log.durationMs != null && (
                    <span className="text-[10px] text-faint">{log.durationMs}ms</span>
                  )}
                  {log.errorMessage && (
                    <span className="text-[10px] text-danger truncate max-w-[140px]" title={log.errorMessage}>
                      {log.errorMessage}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Open in Shopify ─────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3.5">
          <span className="material-symbols-outlined text-faint text-[16px]">open_in_new</span>
          <span className="text-[11px] font-bold text-ink uppercase tracking-wider">Open in Shopify</span>
        </div>

        <div className="space-y-2">
          {hasWidget && storeFrontUrl && (
            <a
              href={storeFrontUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between px-3.5 py-2.5 bg-teal/8 border border-teal/15 rounded-lg text-teal text-[12px] font-semibold hover:bg-teal/15 transition-colors no-underline"
            >
              <span>View storefront</span>
              <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
            </a>
          )}
          {hasWidget && themeEditorUrl && (
            <a
              href={themeEditorUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.07] rounded-lg text-muted text-[12px] font-semibold hover:bg-white/[0.06] transition-colors no-underline"
            >
              <span>Theme editor — add app block</span>
              <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
            </a>
          )}
          {adminUrl && (
            <a
              href={adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.07] rounded-lg text-muted text-[12px] font-semibold hover:bg-white/[0.06] transition-colors no-underline"
            >
              <span>Shopify Admin — Apps</span>
              <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
            </a>
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function AppTestingPanel({
  gen,
  bundle,
  app,
  shopDomain,
  tenantId,
  deployed,
  onDeploy,
  deploying,
}: AppTestingPanelProps) {

  const headerStatus = deployed
    ? { label: "Live", cls: "bg-teal/15 text-teal" }
    : gen.status === "completed"
      ? { label: "Ready", cls: "bg-accent/15 text-accent" }
      : gen.status === "running"
        ? { label: "Generating", cls: "bg-accent/10 text-accent" }
        : null;

  return (
    <div className="w-[360px] min-w-[360px] flex flex-col bg-surface border-l border-white/[0.07]">

      {/* Header */}
      <div className="px-5 py-4 border-b border-white/[0.07] shrink-0 flex items-center justify-between">
        <span className="text-[13px] font-bold text-ink truncate pr-2">
          {app?.name ?? "App panel"}
        </span>
        {headerStatus && (
          <span className={cn("text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide shrink-0", headerStatus.cls)}>
            {headerStatus.label}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5">

        {/* Idle */}
        {gen.status === "idle" && (
          <div className="flex flex-col items-center justify-center h-full gap-4 py-16 text-center">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
              <span className="material-symbols-outlined text-faint text-[24px]">rocket_launch</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-faint">Your app will appear here</p>
              <p className="text-[11px] text-faint mt-1 opacity-60">Start by describing what you want to build.</p>
            </div>
          </div>
        )}

        {/* Generating */}
        {gen.status === "running" && (
          <GeneratingPanel events={gen.events} />
        )}

        {/* Ready to deploy */}
        {gen.status === "completed" && !deployed && (
          <DeployPanel bundle={bundle} app={app} onDeploy={onDeploy} deploying={deploying} />
        )}

        {/* Failed */}
        {gen.status === "failed" && !deployed && (
          <div className="flex flex-col items-center justify-center h-full gap-4 py-16 text-center">
            <span className="material-symbols-outlined text-danger text-[32px]">error</span>
            <div>
              <p className="text-sm font-semibold text-danger">Generation failed</p>
              <p className="text-[11px] text-faint mt-1">Describe what went wrong in the chat to try again.</p>
            </div>
          </div>
        )}

        {/* Live / deployed */}
        {deployed && (
          <LivePanel
            bundle={bundle}
            app={app}
            shopDomain={shopDomain}
            tenantId={tenantId}
          />
        )}
      </div>
    </div>
  );
}
