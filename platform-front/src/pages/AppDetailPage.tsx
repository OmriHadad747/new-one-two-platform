import { useNavigate, useParams } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session";
import { useApp, useWebhookAppLogs, useWidgetLogs, useAdminLogs } from "@/hooks/useApps";
import { useLatestSession, useGeneration } from "@/hooks/useGeneration";
import type { WebhookInvocationLogEntry, InvocationLogEntry, App } from "@/types/dashboard";
import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Log status ───────────────────────────────────────────────────────────────

const LOG_STATUS_CFG = {
  success: { dot: "bg-teal", label: "success", cls: "text-teal" },
  failed: { dot: "bg-danger", label: "failed", cls: "text-danger" },
  running: { dot: "bg-accent animate-pulse", label: "running", cls: "text-accent" },
  queued: { dot: "bg-faint", label: "queued", cls: "text-faint" },
  timeout: { dot: "bg-amber-400", label: "timeout", cls: "text-amber-400" },
} satisfies Record<WebhookInvocationLogEntry["status"], { dot: string; label: string; cls: string }>;

function LogRow({ entry, last }: { entry: WebhookInvocationLogEntry; last: boolean }) {
  const cfg = LOG_STATUS_CFG[entry.status];
  return (
    <div className={cn("flex items-start gap-4 px-5 py-3.5", !last && "border-b border-white/[0.05]")}>
      {/* Status dot */}
      <div className="pt-1.5 shrink-0">
        <span className={cn("w-2 h-2 rounded-full block", cfg.dot)} />
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-mono text-ink truncate">{entry.topic}</span>
          <span className={cn("text-[10px] font-bold uppercase tracking-wide", cfg.cls)}>
            {cfg.label}
          </span>
        </div>
        {entry.errorMessage && (
          <p className="text-[11px] text-danger mt-1 font-mono truncate">{entry.errorMessage}</p>
        )}
      </div>

      {/* Meta */}
      <div className="text-right shrink-0 space-y-0.5">
        <div className="text-[11px] font-mono text-faint">{formatDuration(entry.durationMs)}</div>
        <div className="text-[10px] text-faint">{timeAgo(entry.queuedAt)}</div>
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider mb-2.5">{title}</h3>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-white/[0.05] last:border-0">
      <span className="text-[11px] text-faint shrink-0">{label}</span>
      <span className="text-[12px] text-ink text-right">{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: App["status"] }) {
  const cfg = {
    active: { label: "Live", cls: "bg-teal/12 text-teal" },
    draft: { label: "Draft", cls: "bg-amber/12 text-amber" },
    inactive: { label: "Inactive", cls: "bg-white/[0.06] text-faint" },
    deleted: { label: "Deleted", cls: "bg-danger/12 text-danger" },
  }[status] ?? { label: status, cls: "bg-white/[0.06] text-faint" };
  return (
    <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", cfg.cls)}>
      {cfg.label}
    </span>
  );
}

// ─── Shared log panel helpers ─────────────────────────────────────────────────

function EmptyLogs({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
      <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
        <span className="material-symbols-outlined text-faint text-[20px]">receipt_long</span>
      </div>
      <p className="text-sm text-faint">{label}</p>
      <p className="text-[11px] text-faint opacity-60">{sub}</p>
    </div>
  );
}

function LogTable({ pathHeader = "Event / Error", children }: { pathHeader?: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-white/[0.07] rounded-xl overflow-hidden">
      <div className="grid grid-cols-[16px_1fr_100px] gap-4 px-5 py-2.5 border-b border-white/[0.07] bg-white/[0.02]">
        <span />
        <span className="text-[10px] font-bold text-faint uppercase tracking-wider">{pathHeader}</span>
        <span className="text-[10px] font-bold text-faint uppercase tracking-wider text-right">Duration</span>
      </div>
      {children}
    </div>
  );
}

// ─── Invocation log row (widget / admin) ─────────────────────────────────────

const INVOCATION_STATUS_CFG = {
  success: { dot: "bg-teal", label: "success", cls: "text-teal" },
  failed:  { dot: "bg-danger", label: "failed", cls: "text-danger" },
  running: { dot: "bg-accent animate-pulse", label: "running", cls: "text-accent" },
} satisfies Record<InvocationLogEntry["status"], { dot: string; label: string; cls: string }>;

function InvocationLogRow({ entry, last }: { entry: InvocationLogEntry; last: boolean }) {
  const cfg = INVOCATION_STATUS_CFG[entry.status];
  return (
    <div className={cn("flex items-start gap-4 px-5 py-3.5", !last && "border-b border-white/[0.05]")}>
      <div className="pt-1.5 shrink-0">
        <span className={cn("w-2 h-2 rounded-full block", cfg.dot)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-mono text-ink truncate">{entry.path}</span>
          <span className={cn("text-[10px] font-bold uppercase tracking-wide", cfg.cls)}>{cfg.label}</span>
        </div>
        {entry.errorMessage && (
          <p className="text-[11px] text-danger mt-1 font-mono truncate">{entry.errorMessage}</p>
        )}
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <div className="text-[11px] font-mono text-faint">{formatDuration(entry.durationMs)}</div>
        <div className="text-[10px] text-faint">{timeAgo(entry.invokedAt)}</div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AppDetailPage() {
  const navigate = useNavigate();
  const { appId } = useParams<{ appId: string }>();
  const { tenantId } = useSessionStore();

  const appQuery = useApp(tenantId, appId ?? null);
  const latestSessionQuery = useLatestSession(appId ?? null);
  const { approve } = useGeneration();

  const [activeTab, setActiveTab] = useState<"webhook" | "widget" | "admin">("webhook");
  const [deploying, setDeploying] = useState(false);

  const logsQuery = useWebhookAppLogs(tenantId, appId ?? null, activeTab === "webhook");
  const widgetLogsQuery = useWidgetLogs(tenantId, appId ?? null, activeTab === "widget");
  const adminLogsQuery = useAdminLogs(tenantId, appId ?? null, activeTab === "admin");

  // Inline rename
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming]);

  const startRename = () => {
    setRenameValue(app?.name ?? "");
    setRenaming(true);
  };

  const commitRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === app?.name) { setRenaming(false); return; }
    setRenameSaving(true);
    try {
      await api.apps.rename(tenantId!, appId!, trimmed);
      await appQuery.refetch();
    } catch {
      // swallow — name reverts visually on next refetch
    } finally {
      setRenameSaving(false);
      setRenaming(false);
    }
  };

  const app = appQuery.data ?? null;
  const latestSession = latestSessionQuery.data ?? null;

  const handleDeployDraft = async () => {
    if (!latestSession?.jobId) return;
    setDeploying(true);
    try {
      await approve(latestSession.jobId);
      await appQuery.refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Deployment failed");
    } finally {
      setDeploying(false);
    }
  };

  return (
    <>
      <TopBar
        title={app?.name ?? "App"}
        subtitle={app?.slug}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate("/app/new")}>
              Edit in AI
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/app/apps")}>
              ← Apps
            </Button>
          </>
        }
      />

      {appQuery.isLoading ? (
        <main className="flex-1 overflow-y-auto p-7">
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 bg-white/[0.03] rounded-xl animate-pulse-subtle border border-white/[0.06]" />
            ))}
          </div>
        </main>
      ) : !app ? (
        <main className="flex-1 flex items-center justify-center">
          <p className="text-sm text-faint">App not found.</p>
        </main>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* ── Draft Banner ────────────────────────────────────────────────── */}
          {app.status === "draft" && latestSession?.status === "completed" && (
            <div className="bg-amber/5 border-b border-amber/15 px-7 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-amber text-[20px]">info</span>
                <div>
                  <p className="text-[13px] font-bold text-ink">Draft ready for deployment</p>
                  <p className="text-[11px] text-faint">Your AI-generated feature is ready to go live on your store.</p>
                </div>
              </div>
              <Button
                variant="primary"
                size="sm"
                className="bg-amber text-black hover:bg-amber/90"
                onClick={handleDeployDraft}
                disabled={deploying}
              >
                {deploying ? "Deploying..." : "🚀 Deploy Now"}
              </Button>
            </div>
          )}

          <div className="flex-1 overflow-hidden flex">
            {/* ── Left: Logs ──────────────────────────────────────────────────── */}
            <main className="flex-1 overflow-y-auto p-7 min-w-0">
              {/* Tab bar */}
              <div className="flex items-center gap-1 mb-5 border-b border-white/[0.07] pb-0">
                {(["webhook", "widget", "admin"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      "px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors bg-transparent border-x-0 border-t-0 cursor-pointer capitalize",
                      activeTab === tab
                        ? "border-accent text-ink"
                        : "border-transparent text-faint hover:text-ink"
                    )}
                  >
                    {tab === "webhook" ? "Webhook" : tab === "widget" ? "Widget" : "Admin"}
                  </button>
                ))}
                <div className="flex-1" />
                {(activeTab === "webhook" ? logsQuery : activeTab === "widget" ? widgetLogsQuery : adminLogsQuery).isFetching && (
                  <span className="text-[10px] text-faint">Refreshing…</span>
                )}
                <button
                  type="button"
                  onClick={() => void (activeTab === "webhook" ? logsQuery : activeTab === "widget" ? widgetLogsQuery : adminLogsQuery).refetch()}
                  className="text-[11px] text-faint hover:text-accent transition-colors bg-transparent border-0 cursor-pointer underline mb-1"
                >
                  Refresh
                </button>
              </div>

              {/* Webhook tab */}
              {activeTab === "webhook" && (
                <>
                  {logsQuery.isError && <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>}
                  {!logsQuery.isError && (logsQuery.data ?? []).length === 0 && <EmptyLogs label="No webhook executions yet" sub="Logs appear here once Shopify sends events to your app." />}
                  {(logsQuery.data ?? []).length > 0 && (
                    <LogTable>
                      {(logsQuery.data ?? []).map((entry, i, arr) => (
                        <LogRow key={entry.id} entry={entry} last={i === arr.length - 1} />
                      ))}
                    </LogTable>
                  )}
                </>
              )}

              {/* Widget tab */}
              {activeTab === "widget" && (
                <>
                  {widgetLogsQuery.isError && <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>}
                  {!widgetLogsQuery.isError && (widgetLogsQuery.data ?? []).length === 0 && <EmptyLogs label="No widget calls yet" sub="Logs appear here once the storefront widget calls your backend." />}
                  {(widgetLogsQuery.data ?? []).length > 0 && (
                    <LogTable pathHeader="Path">
                      {(widgetLogsQuery.data ?? []).map((entry, i, arr) => (
                        <InvocationLogRow key={entry.id} entry={entry} last={i === arr.length - 1} />
                      ))}
                    </LogTable>
                  )}
                </>
              )}

              {/* Admin tab */}
              {activeTab === "admin" && (
                <>
                  {adminLogsQuery.isError && <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>}
                  {!adminLogsQuery.isError && (adminLogsQuery.data ?? []).length === 0 && <EmptyLogs label="No admin calls yet" sub="Logs appear here once the Admin UI panel calls your backend." />}
                  {(adminLogsQuery.data ?? []).length > 0 && (
                    <LogTable pathHeader="Path">
                      {(adminLogsQuery.data ?? []).map((entry, i, arr) => (
                        <InvocationLogRow key={entry.id} entry={entry} last={i === arr.length - 1} />
                      ))}
                    </LogTable>
                  )}
                </>
              )}
            </main>

            {/* ── Right: Sidebar ──────────────────────────────────────────────── */}
            <aside className="w-[260px] shrink-0 border-l border-white/[0.07] overflow-y-auto p-5">

              <SidebarSection title="App Info">
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-1">
                  <div className="flex items-center justify-between gap-2 py-2 border-b border-white/[0.05]">
                    <span className="text-[11px] text-faint shrink-0">Name</span>
                    {renaming ? (
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          if (e.key === "Escape") setRenaming(false);
                        }}
                        disabled={renameSaving}
                        className="text-[12px] text-ink bg-raised border border-accent/50 rounded-md px-2 py-0.5 outline-none w-full text-right"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={startRename}
                        className="text-[12px] text-ink text-right truncate max-w-[140px] bg-transparent border-0 cursor-pointer hover:text-accent transition-colors"
                        title="Click to rename"
                      >
                        {app.name}
                      </button>
                    )}
                  </div>
                  <InfoRow label="Status" value={<StatusPill status={app.status} />} />
                  <InfoRow
                    label="Type"
                    value={
                      app.appArchetype === "backend"
                        ? "Backend only"
                        : app.appArchetype === "storefront_backend"
                        ? "Widget + Backend"
                        : app.appArchetype === "backend_admin"
                        ? "Backend + Admin"
                        : "Widget + Backend + Admin"
                    }
                  />
                  <InfoRow label="Created" value={formatDate(app.createdAt)} />
                  <InfoRow label="Updated" value={timeAgo(app.updatedAt)} />
                </div>
              </SidebarSection>

              <SidebarSection title="Store">
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-1">
                  <InfoRow
                    label="Domain"
                    value={
                      <span className="font-mono text-[11px] truncate max-w-[120px] block">
                        {app.shopDomain}
                      </span>
                    }
                  />
                </div>
              </SidebarSection>

              <SidebarSection title="Actions">
                <div className="space-y-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => navigate("/app/new")}
                  >
                    <span className="material-symbols-outlined text-[15px] mr-2">edit</span>
                    Edit in AI
                  </Button>
                  {app.status === "draft" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-amber hover:bg-amber/10"
                      onClick={handleDeployDraft}
                      disabled={deploying}
                    >
                      <span className="material-symbols-outlined text-[15px] mr-2">rocket_launch</span>
                      {deploying ? "Deploying..." : "Deploy Draft"}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => navigate("/app/new")}
                    >
                      <span className="material-symbols-outlined text-[15px] mr-2">rocket_launch</span>
                      Redeploy
                    </Button>
                  )}
                  <div className="border-t border-white/[0.06] mt-3 pt-3">
                    <button
                      type="button"
                      className="w-full text-left text-[12px] text-danger hover:text-danger/80 transition-colors bg-transparent border-0 cursor-pointer py-1"
                    >
                      Delete app…
                    </button>
                  </div>
                </div>
              </SidebarSection>

            </aside>
          </div>
        </div>
      )}
    </>
  );
}
