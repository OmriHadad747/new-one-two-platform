import { useNavigate, useParams } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session";
import { useApp, useAppLogs } from "@/hooks/useApps";
import type { ExecutionLogEntry, App } from "@/types/dashboard";

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
} satisfies Record<ExecutionLogEntry["status"], { dot: string; label: string; cls: string }>;

function LogRow({ entry, last }: { entry: ExecutionLogEntry; last: boolean }) {
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
    inactive: { label: "Inactive", cls: "bg-white/[0.06] text-faint" },
    deleted: { label: "Deleted", cls: "bg-danger/12 text-danger" },
  }[status] ?? { label: status, cls: "bg-white/[0.06] text-faint" };
  return (
    <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", cfg.cls)}>
      {cfg.label}
    </span>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AppDetailPage() {
  const navigate = useNavigate();
  const { appId } = useParams<{ appId: string }>();
  const { tenantId } = useSessionStore();

  const appQuery = useApp(tenantId, appId ?? null);
  const logsQuery = useAppLogs(tenantId, appId ?? null, true);

  const app = appQuery.data ?? null;
  const logs = logsQuery.data ?? [];

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
        <div className="flex-1 overflow-hidden flex">

          {/* ── Left: Logs ──────────────────────────────────────────────────── */}
          <main className="flex-1 overflow-y-auto p-7 min-w-0">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-ink">Execution Logs</h2>
              <div className="flex items-center gap-2">
                {logsQuery.isFetching && (
                  <span className="text-[10px] text-faint">Refreshing…</span>
                )}
                <button
                  type="button"
                  onClick={() => void logsQuery.refetch()}
                  className="text-[11px] text-faint hover:text-accent transition-colors bg-transparent border-0 cursor-pointer underline"
                >
                  Refresh
                </button>
              </div>
            </div>

            {logsQuery.isError && (
              <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>
            )}

            {!logsQuery.isError && logs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
                  <span className="material-symbols-outlined text-faint text-[20px]">receipt_long</span>
                </div>
                <p className="text-sm text-faint">No executions yet</p>
                <p className="text-[11px] text-faint opacity-60">
                  Logs appear here once your app processes events.
                </p>
              </div>
            )}

            {logs.length > 0 && (
              <div className="bg-surface border border-white/[0.07] rounded-xl overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-[16px_1fr_100px] gap-4 px-5 py-2.5 border-b border-white/[0.07] bg-white/[0.02]">
                  <span />
                  <span className="text-[10px] font-bold text-faint uppercase tracking-wider">Event / Error</span>
                  <span className="text-[10px] font-bold text-faint uppercase tracking-wider text-right">Duration</span>
                </div>
                {logs.map((entry, i) => (
                  <LogRow key={entry.id} entry={entry} last={i === logs.length - 1} />
                ))}
              </div>
            )}
          </main>

          {/* ── Right: Sidebar ──────────────────────────────────────────────── */}
          <aside className="w-[260px] shrink-0 border-l border-white/[0.07] overflow-y-auto p-5">

            <SidebarSection title="App Info">
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-1">
                <InfoRow label="Status" value={<StatusPill status={app.status} />} />
                <InfoRow
                  label="Type"
                  value={
                    app.appArchetype === "backend"
                      ? "Backend only"
                      : app.appArchetype === "storefront_backend"
                      ? "Widget + Backend"
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => navigate("/app/new")}
                >
                  <span className="material-symbols-outlined text-[15px] mr-2">rocket_launch</span>
                  Redeploy
                </Button>
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
      )}
    </>
  );
}
