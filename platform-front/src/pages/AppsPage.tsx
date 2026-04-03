import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { AppSwitcher } from "@/components/features/apps/AppSwitcher";
import { CodeView } from "@/components/features/apps/detail/CodeView";
import { PreviewView } from "@/components/features/apps/detail/PreviewView";
import { AppSettingsView } from "@/components/features/apps/detail/AppSettingsView";
import { LoadingSpinner, ErrorMessage, EmptyApps } from "@/components/ui/StateViews";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session";
import { useApps, useApp } from "@/hooks/useApps";
import type { App } from "@/types/dashboard";

type Tab = "code" | "preview" | "settings";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function appIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("notify") || lower.includes("stock")) return "🔔";
  if (lower.includes("upsell") || lower.includes("recommend")) return "⚡";
  if (lower.includes("review") || lower.includes("rating")) return "⭐";
  if (lower.includes("email") || lower.includes("notify")) return "✉️";
  return "◈";
}

export function AppsPage() {
  const { appId: paramAppId } = useParams();
  const navigate = useNavigate();
  const { tenantId } = useSessionStore();
  const [activeAppId, setActiveAppId] = useState<string | null>(paramAppId ?? null);
  const [tab, setTab] = useState<Tab>("code");

  const appsQuery = useApps(tenantId);
  const appQuery = useApp(tenantId, activeAppId);

  const apps = appsQuery.data ?? [];

  // When app list loads, auto-select first if no param
  useEffect(() => {
    if (!activeAppId && apps.length > 0 && apps[0]) {
      setActiveAppId(apps[0].id);
    }
  }, [apps, activeAppId]);

  // Sync URL param → active app
  useEffect(() => {
    if (paramAppId) setActiveAppId(paramAppId);
  }, [paramAppId]);

  const activeApp: App | null = appQuery.data ?? null;

  const statusVariant =
    activeApp?.status === "active"
      ? "live"
      : activeApp?.status === "inactive"
        ? "draft"
        : "failed";

  if (appsQuery.isLoading) {
    return (
      <>
        <TopBar title="My Apps" />
        <LoadingSpinner message="Loading apps…" />
      </>
    );
  }

  if (appsQuery.isError) {
    return (
      <>
        <TopBar title="My Apps" />
        <ErrorMessage
          message="Failed to load apps"
          onRetry={() => void appsQuery.refetch()}
        />
      </>
    );
  }

  if (apps.length === 0) {
    return (
      <>
        <TopBar title="My Apps" />
        <EmptyApps onNew={() => navigate("/app/new")} />
      </>
    );
  }

  return (
    <>
      <TopBar
        title="My Apps"
        subtitle={activeApp?.name}
        actions={
          <>
            <Button variant="ghost" size="sm">
              ↗ View on Store
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigate("/app/new")}
            >
              ↺ Regenerate
            </Button>
          </>
        }
      />
      <main className="flex-1 overflow-y-auto p-7">
        <AppSwitcher
          apps={apps}
          activeId={activeAppId ?? ""}
          onSelect={(app) => {
            setActiveAppId(app.id);
            navigate(`/app/apps/${app.id}`, { replace: true });
          }}
        />

        {appQuery.isLoading && <LoadingSpinner message="Loading app…" />}

        {activeApp && (
          <>
            {/* Hero */}
            <div className="bg-raised border border-white/7 rounded-xl px-7 py-6 mb-6 flex items-center gap-5">
              <div className="w-14 h-14 rounded-xl bg-accent/15 flex items-center justify-center text-2xl shrink-0">
                {appIcon(activeApp.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[22px] font-extrabold text-ink tracking-tight">
                  {activeApp.name}
                </div>
                <div className="text-[13px] text-faint mt-1 font-mono truncate">
                  {activeApp.slug}
                </div>
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <Badge variant={statusVariant}>
                  {activeApp.status === "active" ? "live" : activeApp.status}
                </Badge>
                <span className="text-[11px] text-faint">
                  Updated {timeAgo(activeApp.updatedAt)}
                </span>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/7 mb-5">
              {(["code", "preview", "settings"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "text-[13px] font-semibold px-4 py-2.5 cursor-pointer transition-all duration-150 border-b-2 -mb-px bg-transparent",
                    tab === t
                      ? "text-accent border-accent"
                      : "text-faint border-transparent hover:text-muted"
                  )}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {tab === "code" && <CodeView app={activeApp} />}
            {tab === "preview" && <PreviewView app={activeApp} />}
            {tab === "settings" && <AppSettingsView />}
          </>
        )}
      </main>
    </>
  );
}
