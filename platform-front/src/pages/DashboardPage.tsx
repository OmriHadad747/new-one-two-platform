import { useNavigate } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { StatsGrid } from "@/components/features/dashboard/StatsGrid";
import { AppGrid } from "@/components/features/dashboard/AppGrid";
import { ActivityFeed } from "@/components/features/dashboard/ActivityFeed";
import { LoadingSpinner, ErrorMessage, EmptyApps } from "@/components/ui/StateViews";
import { useSessionStore } from "@/stores/session";
import { useApps, useTenantStats, useWebhookLogs } from "@/hooks/useApps";
import type { WebhookInvocationLogEntry } from "@/types/dashboard";

function logToActivityIcon(log: WebhookInvocationLogEntry): string {
  if (log.status === "failed" || log.status === "timeout") return "⚠";
  if (log.topic.startsWith("orders")) return "🛒";
  if (log.topic.startsWith("products")) return "📦";
  if (log.topic.startsWith("customers")) return "👤";
  if (log.topic.startsWith("inventory")) return "🗃";
  return "⚡";
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { tenantId, shopDomain } = useSessionStore();

  const appsQuery = useApps(tenantId);
  const statsQuery = useTenantStats(tenantId);
  const logsQuery = useWebhookLogs(tenantId, 10);

  const apps = appsQuery.data ?? [];
  const stats = statsQuery.data ?? {
    totalApps: 0,
    liveApps: 0,
    apiCallsThisMonth: 0,
    avgResponseMs: 0,
  };

  const activityItems = (logsQuery.data ?? []).map((log) => ({
    id: log.id,
    icon: logToActivityIcon(log),
    text: `${log.appName} — ${log.topic} · ${log.status}${log.durationMs ? ` (${log.durationMs}ms)` : ""}`,
    time: timeAgo(log.queuedAt),
    tag: log.appName.toLowerCase().replace(/\s+/g, "-"),
    tagVariant: (log.status === "failed" || log.status === "timeout" ? "purple" : "teal") as
      | "purple"
      | "teal",
  }));

  if (!tenantId) {
    return (
      <>
        <TopBar title="Dashboard" />
        <EmptyApps onNew={() => navigate("/app/new")} />
      </>
    );
  }

  return (
    <>
      <TopBar title="Dashboard" subtitle={shopDomain ?? tenantId} />
      <main className="flex-1 overflow-y-auto p-7">
        {/* Stats */}
        {statsQuery.isLoading ? (
          <div className="grid grid-cols-4 gap-3.5 mb-7">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="bg-white/[0.03] border border-white/7 rounded-xl px-5 py-[18px] animate-pulse-subtle h-[88px]"
              />
            ))}
          </div>
        ) : (
          <div className="mb-7">
            <StatsGrid stats={stats} />
          </div>
        )}

        {/* Apps */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-ink">Your Apps</h2>
          {apps.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => navigate("/app/apps")}>
              View all
            </Button>
          )}
        </div>

        {appsQuery.isLoading && <LoadingSpinner message="Loading apps…" />}
        {appsQuery.isError && (
          <ErrorMessage
            message="Failed to load apps"
            onRetry={() => void appsQuery.refetch()}
          />
        )}
        {!appsQuery.isLoading && !appsQuery.isError && apps.length === 0 && (
          <EmptyApps onNew={() => navigate("/app/new")} />
        )}
        {apps.length > 0 && (
          <AppGrid
            apps={apps.slice(0, 6)}
            onSelect={(app) => navigate(`/app/apps/${app.id}`)}
          />
        )}

        {/* Activity */}
        {activityItems.length > 0 && (
          <>
            <div className="h-px bg-white/7 my-5" />
            <h2 className="text-sm font-bold text-ink mb-4">Recent Activity</h2>
            <ActivityFeed items={activityItems} />
          </>
        )}
      </main>
    </>
  );
}
