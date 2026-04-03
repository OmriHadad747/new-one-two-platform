import { useNavigate } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session";
import { useApps } from "@/hooks/useApps";
import type { App } from "@/types/dashboard";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000)  return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function StatusBadge({ status }: { status: App["status"] }) {
  const cfg = {
    active:   { label: "Live",     cls: "bg-teal/12 text-teal"            },
    inactive: { label: "Inactive", cls: "bg-white/[0.06] text-faint"      },
    deleted:  { label: "Deleted",  cls: "bg-danger/12 text-danger"        },
  }[status] ?? { label: status, cls: "bg-white/[0.06] text-faint" };

  return (
    <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", cfg.cls)}>
      {cfg.label}
    </span>
  );
}

function ArchetypeBadge({ archetype }: { archetype: App["appArchetype"] }) {
  const label = archetype === "storefront_ui" ? "Widget + Backend" : "Backend only";
  return (
    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-accent/8 text-accent">
      {label}
    </span>
  );
}

export function AppsPage() {
  const navigate = useNavigate();
  const { tenantId } = useSessionStore();
  const appsQuery = useApps(tenantId);
  const apps = appsQuery.data ?? [];

  return (
    <>
      <TopBar
        title="My Apps"
        actions={
          <Button variant="primary" size="sm" onClick={() => navigate("/app/new")}>
            ✦ New App
          </Button>
        }
      />

      <main className="flex-1 overflow-y-auto p-7 max-w-[960px]">

        {/* Loading */}
        {appsQuery.isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 bg-white/[0.03] rounded-xl animate-pulse-subtle border border-white/[0.06]" />
            ))}
          </div>
        )}

        {/* Error */}
        {appsQuery.isError && (
          <div className="text-sm text-danger py-8 text-center">
            Failed to load apps.{" "}
            <button
              type="button"
              onClick={() => void appsQuery.refetch()}
              className="underline text-accent bg-transparent border-0 cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty */}
        {!appsQuery.isLoading && !appsQuery.isError && apps.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
              <span className="material-symbols-outlined text-faint text-[28px]">widgets</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-faint">No apps yet</p>
              <p className="text-[12px] text-faint mt-1 opacity-60">Describe your first feature and the AI will build it.</p>
            </div>
            <Button variant="primary" onClick={() => navigate("/app/new")}>
              Build your first app
            </Button>
          </div>
        )}

        {/* List */}
        {apps.length > 0 && (
          <div className="bg-surface border border-white/[0.07] rounded-xl overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_140px_100px_100px_80px] gap-4 px-5 py-2.5 border-b border-white/[0.07] bg-white/[0.02]">
              <span className="text-[10px] font-bold text-faint uppercase tracking-wider">App</span>
              <span className="text-[10px] font-bold text-faint uppercase tracking-wider">Type</span>
              <span className="text-[10px] font-bold text-faint uppercase tracking-wider">Status</span>
              <span className="text-[10px] font-bold text-faint uppercase tracking-wider">Updated</span>
              <span className="text-[10px] font-bold text-faint uppercase tracking-wider text-right">Actions</span>
            </div>

            {apps.map((app, i) => (
              <div
                key={app.id}
                className={cn(
                  "grid grid-cols-[1fr_140px_100px_100px_80px] gap-4 px-5 py-3.5 items-center transition-colors hover:bg-white/[0.02] cursor-pointer",
                  i < apps.length - 1 && "border-b border-white/[0.05]"
                )}
                onClick={() => navigate(`/app/apps/${app.id}`)}
              >
                {/* Name */}
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink truncate">{app.name}</div>
                  <div className="text-[11px] text-faint font-mono truncate mt-0.5">{app.slug}</div>
                </div>

                {/* Archetype */}
                <div>
                  <ArchetypeBadge archetype={app.appArchetype} />
                </div>

                {/* Status */}
                <div>
                  <StatusBadge status={app.status} />
                </div>

                {/* Updated */}
                <div className="text-[12px] text-faint">{timeAgo(app.updatedAt)}</div>

                {/* Actions */}
                <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => navigate("/app/new")}
                    title="Edit in AI"
                    className="w-7 h-7 rounded-md flex items-center justify-center text-faint hover:text-accent hover:bg-accent/10 transition-colors bg-transparent border-0 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[15px]">edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate(`/app/apps/${app.id}`)}
                    title="View details"
                    className="w-7 h-7 rounded-md flex items-center justify-center text-faint hover:text-ink hover:bg-white/[0.06] transition-colors bg-transparent border-0 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[15px]">arrow_forward</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
