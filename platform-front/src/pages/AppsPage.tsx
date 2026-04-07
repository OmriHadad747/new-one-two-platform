import { useNavigate } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { useSessionStore } from "@/stores/session";
import { useGenerationStore } from "@/stores/generation";
import { useApps } from "@/hooks/useApps";
import { AppStatusBadge } from "@/components/ui/AppStatusBadge";
import { ArchetypePills } from "@/components/ui/ArchetypePills";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000)  return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

const AVATAR_GRADIENTS = [
  "from-violet-500 to-indigo-600",
  "from-blue-500 to-cyan-600",
  "from-teal-500 to-emerald-600",
  "from-amber-500 to-orange-600",
  "from-rose-500 to-pink-600",
  "from-fuchsia-500 to-purple-600",
  "from-sky-500 to-blue-600",
  "from-lime-500 to-green-600",
];

function AppCard({
  app,
  isGenerating,
  onOpen,
  onRevise,
}: {
  app: { id: string; name: string; slug: string; status: string; appArchetype: string; updatedAt: string };
  isGenerating: boolean;
  onOpen: () => void;
  onRevise: (e: React.MouseEvent) => void;
}) {
  const initials = app.name.split(" ").slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
  const seed = app.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const gradient = AVATAR_GRADIENTS[seed % AVATAR_GRADIENTS.length];

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full text-left bg-white/[0.03] border border-white/[0.07] rounded-2xl overflow-hidden hover:bg-white/[0.055] hover:border-white/[0.12] transition-all cursor-pointer"
    >
      {/* Card body */}
      <div className="p-4 space-y-3">

        {/* Top row: avatar + name + status */}
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center shrink-0`}>
            <span className="text-white text-[13px] font-bold">{initials}</span>
          </div>

          {/* Name + slug */}
          <div className="flex-1 min-w-0 pt-0.5">
            <p className="text-[14px] font-semibold text-ink leading-tight truncate">{app.name}</p>
            <p className="text-[11px] text-faint font-mono truncate mt-0.5">{app.slug}</p>
          </div>

          {/* Status */}
          <div className="shrink-0 pt-0.5">
            <AppStatusBadge status={app.status as never} isBuilding={isGenerating} size="sm" />
          </div>
        </div>

        {/* Archetype pills */}
        {!isGenerating && (
          <div>
            <ArchetypePills archetype={app.appArchetype as never} />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-white/[0.05] flex items-center justify-between">
        <span className="text-[11px] text-faint">Updated {timeAgo(app.updatedAt)}</span>

        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={onRevise}
            title="Revise with AI"
            className="w-7 h-7 rounded-lg flex items-center justify-center text-faint hover:text-accent hover:bg-accent/10 transition-colors bg-transparent border-0 cursor-pointer opacity-0 group-hover:opacity-100"
          >
            <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            title="View details"
            className="w-7 h-7 rounded-lg flex items-center justify-center text-faint hover:text-ink hover:bg-white/[0.08] transition-colors bg-transparent border-0 cursor-pointer opacity-0 group-hover:opacity-100"
          >
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </button>
        </div>
      </div>
    </button>
  );
}

export function AppsPage() {
  const navigate = useNavigate();
  const { tenantId } = useSessionStore();
  const appsQuery = useApps(tenantId);
  const apps = appsQuery.data ?? [];
  const activeGen = useGenerationStore((s) => s.active);

  return (
    <>
      <TopBar title="My Apps" />

      <main className="flex-1 overflow-y-auto p-7">

        {/* Loading */}
        {appsQuery.isLoading && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-36 bg-white/[0.03] rounded-2xl animate-pulse-subtle border border-white/[0.06]" />
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

        {/* Grid */}
        {apps.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {apps.map((app) => {
              const isGenerating = activeGen?.appId === app.id && activeGen.status === "running";
              return (
                <AppCard
                  key={app.id}
                  app={app}
                  isGenerating={isGenerating}
                  onOpen={() => navigate(`/app/apps/${app.id}`)}
                  onRevise={(e) => { e.stopPropagation(); navigate(`/app/apps/${app.id}/revise`); }}
                />
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
