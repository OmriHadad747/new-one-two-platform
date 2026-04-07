import { cn } from "@/lib/cn";
import type { App } from "@/types/dashboard";

// ─── Single source of truth for app status colors ────────────────────────────

export const APP_STATUS_CFG: Record<string, { label: string; dot: string; badge: string }> = {
  draft:    { label: "Draft",       dot: "bg-faint",                          badge: "bg-white/[0.05] text-faint border-white/15 border-dashed"  },
  building: { label: "Building",    dot: "bg-accent animate-pulse",           badge: "bg-accent/10 text-accent border-accent/20"                 },
  ready:    { label: "Ready",       dot: "bg-orange-400 animate-pulse",       badge: "bg-orange-400/10 text-orange-300 border-orange-400/25"     },
  active:   { label: "Live",        dot: "bg-green-500 animate-pulse",        badge: "bg-green-500/10 text-green-500 border-green-500/25"        },
  inactive: { label: "Inactive",    dot: "bg-danger",                         badge: "bg-danger/10 text-danger border-danger/25"                 },
  deleted:  { label: "Deleted",     dot: "bg-danger opacity-50",              badge: "bg-danger/5 text-danger/60 border-danger/15"              },
};

interface AppStatusBadgeProps {
  status: App["status"];
  /** Override with "building" when generation is in progress */
  isBuilding?: boolean;
  /** sm = table rows / compact lists  |  md = detail cards (default) */
  size?: "sm" | "md";
}

export function AppStatusBadge({ status, isBuilding, size = "md" }: AppStatusBadgeProps) {
  const effectiveStatus = isBuilding ? "building" : status;
  const cfg = APP_STATUS_CFG[effectiveStatus] ?? APP_STATUS_CFG.deleted;

  if (size === "sm") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-bold uppercase tracking-wide border", cfg.badge)}>
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", cfg.dot)} />
        {cfg.label}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold border", cfg.badge)}>
      <span className={cn("w-2 h-2 rounded-full shrink-0", cfg.dot)} />
      {cfg.label}
    </span>
  );
}
