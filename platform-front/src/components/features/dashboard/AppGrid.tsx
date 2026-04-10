import { useNavigate } from "react-router";
import type { App } from "@/types/dashboard";
import { cn } from "@/lib/cn";
import { AppStatusBadge } from "@/components/ui/AppStatusBadge";
import { ArchetypePills } from "@/components/ui/ArchetypePills";

function appIcon(name: string): { icon: string; bg: string } {
  const lower = name.toLowerCase();
  if (lower.includes("notify") || lower.includes("stock"))
    return { icon: "🔔", bg: "bg-accent/15" };
  if (lower.includes("upsell") || lower.includes("recommend"))
    return { icon: "⚡", bg: "bg-amber/15" };
  if (lower.includes("review") || lower.includes("rating"))
    return { icon: "⭐", bg: "bg-teal/15" };
  return { icon: "◈", bg: "bg-accent/15" };
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function AppCard({ app, onClick, onRevise }: { app: App; onClick: () => void; onRevise: () => void }) {
  const { icon, bg } = appIcon(app.name);

  return (
    <div className="bg-white/[0.03] border border-white/7 rounded-xl text-left w-full transition-all duration-150 hover:bg-white/[0.055] hover:border-white/13 hover:-translate-y-0.5 flex flex-col overflow-hidden">
      <button
        type="button"
        onClick={onClick}
        className="flex-1 p-[18px] bg-transparent border-0 cursor-pointer text-left w-full"
      >
        <div className="flex items-start justify-between mb-3.5">
          <div className={cn("w-10 h-10 rounded-[10px] flex items-center justify-center text-lg", bg)}>
            {icon}
          </div>
          <AppStatusBadge status={app.status} size="sm" />
        </div>
        <div className="text-sm font-bold text-ink mb-1">{app.name}</div>
        <div className="mt-1.5">
          <ArchetypePills archetype={app.appArchetype} />
        </div>
      </button>
      <div className="flex items-center justify-between px-[18px] py-3 border-t border-white/7">
        <div className="text-[11px] text-faint">Updated {timeAgo(app.updatedAt)}</div>
        <button
          type="button"
          onClick={onRevise}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-accent hover:bg-accent/10 border-0 cursor-pointer transition-colors bg-transparent"
        >
          <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}>auto_awesome</span>
          Revise
        </button>
      </div>
    </div>
  );
}

function NewAppCard() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/app/new")}
      className="bg-transparent border-2 border-dashed border-white/7 rounded-xl p-[18px] cursor-pointer transition-all duration-150 hover:border-accent hover:bg-accent/[0.04] flex flex-col items-center justify-center min-h-[160px] gap-2.5 w-full"
    >
      <span className="text-3xl text-faint">+</span>
      <span className="text-[13px] font-semibold text-faint">Build a new app</span>
    </button>
  );
}

export function AppGrid({
  apps,
  onSelect,
  onRevise,
}: {
  apps: App[];
  onSelect: (app: App) => void;
  onRevise: (app: App) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3.5">
      {apps.map((app) => (
        <AppCard key={app.id} app={app} onClick={() => onSelect(app)} onRevise={() => onRevise(app)} />
      ))}
      <NewAppCard />
    </div>
  );
}
