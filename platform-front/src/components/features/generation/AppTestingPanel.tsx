import { useState } from "react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { useAppLogs } from "@/hooks/useApps";
import type { GenerationState, GenerationBundle, App } from "@/types/dashboard";

type Tab = "validate" | "logs" | "preview";

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

// ─── Fallback testing guides ──────────────────────────────────────────────────

function defaultSteps(bundle: GenerationBundle | null, app: App | null): string[] {
  const archetype = app?.appArchetype ?? "backend_only";
  const triggerType = bundle?.triggerType ?? "webhook";

  if (archetype === "storefront_ui") {
    return [
      "Click the Preview tab and open your store.",
      "Navigate to a product page — the widget should appear.",
      "Interact with it (subscribe, click, etc.) and watch the Logs tab for the backend call.",
      "If anything looks off, describe the issue in the chat and hit Revise.",
    ];
  }

  if (triggerType === "admin") {
    return [
      "Open your Shopify Admin → Apps → New One Two.",
      "Find this app and use the admin UI to trigger the action.",
      "Switch to the Logs tab to confirm the handler ran successfully.",
      "If it failed, copy the error from Logs and describe it in the chat.",
    ];
  }

  if (triggerType === "cron") {
    return [
      "Use the 'Fire test event' button below to manually invoke the handler.",
      "Switch to the Logs tab — you should see a new execution entry appear within seconds.",
      "Verify the expected action took place (email queued, data updated, etc.).",
      "If anything failed, paste the error into the chat and hit Revise.",
    ];
  }

  // Default: webhook
  const topics = bundle?.triggerTopics ?? [];
  const topicHint = topics.length > 0 ? `(topic: ${topics[0]})` : "in Shopify";
  return [
    `Trigger a real event ${topicHint} — e.g. create a test order.`,
    "Switch to the Logs tab — your execution should appear within 5 seconds.",
    "Verify the handler ran with status 'success' and the expected result occurred.",
    "If it failed, copy the error message from Logs and describe it in the chat.",
  ];
}

// ─── Sub-panels ───────────────────────────────────────────────────────────────

function ValidateTab({
  bundle,
  app,
  shopDomain,
  deployed,
}: {
  bundle: GenerationBundle | null;
  app: App | null;
  shopDomain: string | null;
  deployed: boolean;
}) {
  const [triggerState, setTriggerState] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [triggerOut, setTriggerOut] = useState<string | null>(null);

  const canTrigger =
    deployed &&
    !!shopDomain &&
    !!app?.id &&
    (bundle?.triggerType === "admin" ||
      bundle?.triggerType === "cron" ||
      bundle?.triggerType === "widget");

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

  const steps = bundle?.explanation
    ? bundle.explanation.split(/\n+/).filter(Boolean)
    : defaultSteps(bundle, app);

  return (
    <div className="space-y-6">
      {/* Testing checklist */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="material-symbols-outlined text-accent text-[16px]">checklist</span>
          <span className="text-xs font-bold text-ink uppercase tracking-wider">How to validate</span>
        </div>
        <ol className="space-y-3">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm text-muted leading-relaxed">
              <span className="w-5 h-5 rounded-full bg-accent/15 flex items-center justify-center text-accent text-[11px] font-bold shrink-0 mt-0.5">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Manual trigger — only for non-webhook apps */}
      {(canTrigger || !deployed) && (
        <div className="border-t border-white/[0.06] pt-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-teal text-[16px]">play_circle</span>
            <span className="text-xs font-bold text-ink uppercase tracking-wider">Fire test event</span>
          </div>
          <p className="text-xs text-faint mb-3 leading-relaxed">
            Manually invoke the handler to see it run without waiting for a real event.
          </p>
          <button
            type="button"
            onClick={handleTrigger}
            disabled={!canTrigger || triggerState === "loading"}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all border-0 cursor-pointer",
              canTrigger
                ? "bg-teal/15 text-teal hover:bg-teal/25"
                : "bg-white/[0.04] text-faint cursor-not-allowed opacity-60"
            )}
          >
            <span className="material-symbols-outlined text-[16px]">
              {triggerState === "loading" ? "hourglass_empty" : "send"}
            </span>
            {triggerState === "loading" ? "Triggering..." : "Send test payload"}
          </button>

          {triggerOut && (
            <pre
              className={cn(
                "mt-3 p-3 rounded-lg font-mono text-[10px] leading-relaxed overflow-x-auto",
                triggerState === "ok"
                  ? "bg-teal/10 text-teal"
                  : "bg-danger/10 text-danger"
              )}
            >
              {triggerOut}
            </pre>
          )}
        </div>
      )}

      {/* Revise hint */}
      {deployed && (
        <div className="border-t border-white/[0.06] pt-5 flex items-start gap-2.5">
          <span className="material-symbols-outlined text-faint text-[16px] mt-0.5">chat_bubble</span>
          <p className="text-xs text-faint leading-relaxed">
            Something wrong? Describe what failed in the chat on the left and the AI will revise and redeploy.
          </p>
        </div>
      )}
    </div>
  );
}

function LogsTab({
  tenantId,
  app,
  deployed,
}: {
  tenantId: string | null;
  app: App | null;
  deployed: boolean;
}) {
  const logsQuery = useAppLogs(tenantId, app?.id ?? null, deployed);
  const logs = logsQuery.data ?? [];

  const statusColor: Record<string, string> = {
    success: "text-teal",
    failed: "text-danger",
    timeout: "text-danger",
    running: "text-accent animate-pulse-subtle",
    queued: "text-faint",
  };

  const statusDot: Record<string, string> = {
    success: "bg-teal",
    failed: "bg-danger",
    timeout: "bg-danger",
    running: "bg-accent",
    queued: "bg-faint",
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={cn("w-1.5 h-1.5 rounded-full", deployed ? "bg-teal animate-pulse-subtle" : "bg-faint")} />
          <span className="text-[11px] text-faint">
            {deployed ? "Live · polling every 5s" : "Logs appear after deploy"}
          </span>
        </div>
        {logsQuery.isFetching && (
          <span className="material-symbols-outlined text-faint text-[14px] animate-spin">refresh</span>
        )}
      </div>

      {!deployed && (
        <p className="text-sm text-faint text-center py-10">
          Deploy the app first to start seeing execution logs.
        </p>
      )}

      {deployed && logs.length === 0 && !logsQuery.isFetching && (
        <div className="text-center py-10 space-y-2">
          <span className="material-symbols-outlined text-faint text-[32px]">history</span>
          <p className="text-sm text-faint">No executions yet.</p>
          <p className="text-xs text-faint">Trigger an event in Shopify or use the Validate tab.</p>
        </div>
      )}

      {logs.length > 0 && (
        <div className="space-y-2">
          {logs.map((log) => (
            <div
              key={log.id}
              className="bg-raised border border-white/[0.06] rounded-lg px-3.5 py-3"
            >
              <div className="flex items-center gap-2.5 mb-1">
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusDot[log.status] ?? "bg-faint")} />
                <span className="font-mono text-[11px] text-ink flex-1 truncate">{log.topic}</span>
                <span className={cn("text-[11px] font-bold shrink-0", statusColor[log.status] ?? "text-faint")}>
                  {log.status}
                </span>
              </div>
              <div className="flex items-center gap-3 pl-4">
                <span className="text-[10px] text-faint font-mono">
                  {new Date(log.queuedAt).toLocaleTimeString()}
                </span>
                {log.durationMs != null && (
                  <span className="text-[10px] text-faint">{log.durationMs}ms</span>
                )}
                {log.errorMessage && (
                  <span className="text-[10px] text-danger truncate max-w-[180px]">
                    {log.errorMessage}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewTab({
  bundle,
  app,
  shopDomain,
  deployed,
}: {
  bundle: GenerationBundle | null;
  app: App | null;
  shopDomain: string | null;
  deployed: boolean;
}) {
  const hasWidget = bundle?.hasWidget ?? app?.appArchetype === "storefront_ui";
  const storeFrontUrl = shopDomain ? `https://${shopDomain}` : null;
  const themeEditorUrl = shopDomain
    ? `https://${shopDomain}/admin/themes/current/editor`
    : null;
  const adminUrl = shopDomain ? `https://${shopDomain}/admin/apps` : null;

  if (!deployed) {
    return (
      <p className="text-sm text-faint text-center py-10">
        Preview link will be available after deploy.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {hasWidget ? (
        <>
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-teal text-[16px]">open_in_new</span>
              <span className="text-xs font-bold text-ink uppercase tracking-wider">Storefront preview</span>
            </div>
            <a
              href={storeFrontUrl ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "flex items-center justify-between px-4 py-3 bg-teal/10 border border-teal/25 rounded-lg text-teal text-sm font-bold hover:bg-teal/20 transition-colors no-underline",
                !storeFrontUrl && "opacity-40 pointer-events-none"
              )}
            >
              <span>{storeFrontUrl ?? "Not connected"}</span>
              <span className="material-symbols-outlined text-[16px]">arrow_outward</span>
            </a>
          </div>

          <div className="border border-white/[0.06] rounded-lg p-4 space-y-3">
            <p className="text-xs font-bold text-ink">Enable the app block in your theme</p>
            <ol className="space-y-2.5">
              {[
                { icon: "brush", text: "Open the Theme Editor link below" },
                { icon: "add_box", text: "In the left sidebar, find the product template section" },
                { icon: "widgets", text: "Click 'Add block' → App blocks → select this app" },
                { icon: "save", text: "Save — the widget is now live on your product pages" },
              ].map((s, i) => (
                <li key={i} className="flex items-center gap-2.5 text-xs text-muted">
                  <span className="material-symbols-outlined text-faint text-[14px]">{s.icon}</span>
                  {s.text}
                </li>
              ))}
            </ol>
            <a
              href={themeEditorUrl ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-accent hover:underline no-underline mt-1"
            >
              <span className="material-symbols-outlined text-[14px]">open_in_new</span>
              Open Theme Editor
            </a>
          </div>
        </>
      ) : (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-accent text-[16px]">admin_panel_settings</span>
            <span className="text-xs font-bold text-ink uppercase tracking-wider">Shopify Admin</span>
          </div>
          <p className="text-xs text-muted mb-3 leading-relaxed">
            This is a backend app — it runs automatically without a storefront widget.
            You can verify it via the Logs tab or your Shopify Admin.
          </p>
          <a
            href={adminUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between px-4 py-3 bg-accent/10 border border-accent/25 rounded-lg text-accent text-sm font-bold hover:bg-accent/20 transition-colors no-underline"
          >
            <span>Open Shopify Admin</span>
            <span className="material-symbols-outlined text-[16px]">arrow_outward</span>
          </a>
        </div>
      )}
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
  const [tab, setTab] = useState<Tab>("validate");

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: "validate", label: "Validate", icon: "checklist" },
    { id: "logs", label: "Logs", icon: "terminal" },
    { id: "preview", label: "Preview", icon: "open_in_new" },
  ];

  return (
    <div className="w-[400px] min-w-[400px] flex flex-col bg-surface border-l border-white/[0.07]">

      {/* Header */}
      <div className="px-5 py-4 border-b border-white/[0.07] shrink-0">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[13px] font-bold text-ink">
            {app ? app.name : "Testing"}
          </span>
          {app && (
            <span className={cn(
              "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide",
              deployed
                ? "bg-teal/15 text-teal"
                : gen.status === "completed"
                  ? "bg-accent/15 text-accent"
                  : "bg-white/[0.05] text-faint"
            )}>
              {deployed ? "Live" : gen.status === "completed" ? "Ready to deploy" : gen.status}
            </span>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-all cursor-pointer border-0 flex-1 justify-center",
                tab === t.id
                  ? "bg-accent/15 text-accent"
                  : "text-faint hover:text-muted bg-transparent"
              )}
            >
              <span className="material-symbols-outlined text-[14px]">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5">

        {/* Idle state */}
        {gen.status === "idle" && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-10">
            <span className="material-symbols-outlined text-faint text-[40px]">rocket_launch</span>
            <p className="text-sm text-faint">Generate an app to start testing.</p>
          </div>
        )}

        {/* Deploy gate — generation completed, not yet deployed */}
        {gen.status === "completed" && !deployed && (
          <div className="space-y-5">
            <div className="bg-accent/8 border border-accent/20 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-accent text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                <span className="text-sm font-bold text-ink">Generation complete</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">
                Review the code in the chat, then deploy when you're ready.
                Deploying injects the widget into your store theme and activates the backend handler.
              </p>
              <button
                type="button"
                onClick={onDeploy}
                disabled={deploying}
                className="w-full py-3 bg-gradient-to-br from-accent to-accent/70 text-white rounded-lg text-sm font-bold border-0 cursor-pointer transition-all hover:opacity-90 disabled:opacity-60 flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                  {deploying ? "hourglass_empty" : "rocket_launch"}
                </span>
                {deploying ? "Deploying..." : "Deploy to store"}
              </button>
            </div>

            {/* Show validate tab content even pre-deploy as a preview */}
            <div className="border-t border-white/[0.06] pt-5">
              <p className="text-[11px] text-faint uppercase tracking-wider font-semibold mb-3">After deploy, you'll validate:</p>
              <ValidateTab bundle={bundle} app={app} shopDomain={shopDomain} deployed={false} />
            </div>
          </div>
        )}

        {/* Live testing panel */}
        {deployed && (
          <>
            {tab === "validate" && (
              <ValidateTab bundle={bundle} app={app} shopDomain={shopDomain} deployed={deployed} />
            )}
            {tab === "logs" && (
              <LogsTab tenantId={tenantId} app={app} deployed={deployed} />
            )}
            {tab === "preview" && (
              <PreviewTab bundle={bundle} app={app} shopDomain={shopDomain} deployed={deployed} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
