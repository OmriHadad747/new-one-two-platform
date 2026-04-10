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
    <div className="group bg-white/[0.03] border border-white/[0.07] rounded-xl overflow-hidden hover:border-white/[0.13] hover:bg-white/[0.05] transition-colors duration-150 flex flex-col">

      {/* Clickable body */}
      <button
        type="button"
        onClick={onOpen}
        className="text-left flex flex-col flex-1 px-5 pt-5 pb-4 gap-0 bg-transparent border-0 cursor-pointer w-full"
      >
        {/* Avatar + name + status */}
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center shrink-0`}>
            <span className="text-white text-[13px] font-bold">{initials}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-ink leading-snug truncate">{app.name}</p>
            <p className="text-[11.5px] text-faint font-mono truncate mt-0.5">{app.slug}</p>
          </div>
          <div className="shrink-0">
            <AppStatusBadge status={app.status as never} isBuilding={isGenerating} size="sm" />
          </div>
        </div>

        {/* Pills — flex-nowrap so they never wrap to a second line */}
        <div className="mt-4 flex items-center gap-1.5 flex-nowrap overflow-hidden">
          {isGenerating
            ? <span className="text-[11px] text-accent animate-pulse-subtle">Building…</span>
            : <ArchetypePills archetype={app.appArchetype as never} />
          }
        </div>
      </button>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-white/[0.05] flex items-center justify-between shrink-0">
        <span className="text-[11px] text-faint/70">{timeAgo(app.updatedAt)}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRevise}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-accent hover:bg-accent/10 border-0 cursor-pointer transition-colors bg-transparent"
          >
            <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}>auto_awesome</span>
            Revise
          </button>
          <button
            type="button"
            onClick={onOpen}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-faint hover:text-ink hover:bg-white/[0.07] border-0 cursor-pointer transition-colors bg-transparent"
          >
            Open
            <span className="material-symbols-outlined text-[12px]">arrow_forward</span>
          </button>
        </div>
      </div>
    </div>
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

        {/* Loading skeleton */}
        {appsQuery.isLoading && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[130px] bg-white/[0.03] rounded-2xl animate-pulse-subtle border border-white/[0.06]" />
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

        {/* Empty state */}
        {!appsQuery.isLoading && !appsQuery.isError && apps.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
              <span className="material-symbols-outlined text-faint text-[28px]" style={{ fontVariationSettings: "'wght' 200" }}>layers</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-faint">No apps yet</p>
              <p className="text-[12px] text-faint mt-1 opacity-60">Describe your first feature and Ton will build it.</p>
            </div>
            <Button variant="primary" onClick={() => navigate("/app/new")}>
              Build your first app
            </Button>
          </div>
        )}

        {/* Grid */}
        {apps.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
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

            {/* New App card */}
            <button
              type="button"
              onClick={() => navigate("/app/new")}
              className="group flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-white/[0.09] hover:border-accent/40 hover:bg-accent/[0.04] transition-all duration-200 cursor-pointer bg-transparent min-h-[130px]"
            >
              <div className="w-10 h-10 rounded-xl bg-white/[0.04] group-hover:bg-accent/12 flex items-center justify-center transition-colors duration-200">
                <span className="material-symbols-outlined text-faint group-hover:text-accent text-[22px] transition-colors duration-200">add</span>
              </div>
              <div className="text-center">
                <p className="text-[13px] font-semibold text-faint group-hover:text-ink transition-colors duration-200">New app</p>
                <p className="text-[11px] text-faint/60 mt-0.5">Build with Ton</p>
              </div>
            </button>
          </div>
        )}
      </main>
    </>
  );
}
