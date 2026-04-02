import { useNavigate } from "react-router";
import { Badge } from "@/components/ui/Badge";
import type { App } from "@/types/dashboard";
import { cn } from "@/lib/cn";

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

function AppCard({ app, onClick }: { app: App; onClick: () => void }) {
  const { icon, bg } = appIcon(app.name);
  const statusVariant =
    app.status === "active" ? "live" : app.status === "inactive" ? "draft" : "failed";

  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-white/[0.03] border border-white/7 rounded-xl p-[18px] text-left w-full cursor-pointer transition-all duration-150 hover:bg-white/[0.055] hover:border-white/13 hover:-translate-y-0.5"
    >
      <div className="flex items-start justify-between mb-3.5">
        <div className={cn("w-10 h-10 rounded-[10px] flex items-center justify-center text-lg", bg)}>
          {icon}
        </div>
        <Badge variant={statusVariant}>
          {app.status === "active" ? "live" : app.status}
        </Badge>
      </div>
      <div className="text-sm font-bold text-ink mb-1">{app.name}</div>
      <div className="text-xs text-faint leading-relaxed capitalize">
        {app.appArchetype.replace("_", " ")}
      </div>
      <div className="flex items-center justify-between mt-3.5 pt-3.5 border-t border-white/7">
        <div className="text-[11px] text-faint capitalize">
          {app.appArchetype.replace("_", " ")}
        </div>
        <div className="text-[11px] text-faint">Updated {timeAgo(app.updatedAt)}</div>
      </div>
    </button>
  );
}

function NewAppCard() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/new")}
      className="bg-transparent border-2 border-dashed border-white/7 rounded-xl p-[18px] cursor-pointer transition-all duration-150 hover:border-accent hover:bg-accent/[0.04] flex flex-col items-center justify-center min-h-[160px] gap-2.5 w-full"
    >
      <span className="text-3xl text-faint">+</span>
      <span className="text-[13px] font-semibold text-faint">Build a new app</span>
    </button>
  );
}

export function AppGrid({ apps, onSelect }: { apps: App[]; onSelect: (app: App) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3.5">
      {apps.map((app) => (
        <AppCard key={app.id} app={app} onClick={() => onSelect(app)} />
      ))}
      <NewAppCard />
    </div>
  );
}
