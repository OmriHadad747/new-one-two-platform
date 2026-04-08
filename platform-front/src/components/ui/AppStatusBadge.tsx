import { cn } from "@/lib/cn";
import type { App } from "@/types/dashboard";
import { useThemeStore } from "@/stores/theme";

type StatusCfg = { label: string; dot: string; badge: string };

const CFG_DARK: Record<string, StatusCfg> = {
  draft:    { label: "Draft",    dot: "bg-faint",                        badge: "bg-white/[0.05] text-faint border-white/15 border-dashed"           },
  building: { label: "Building", dot: "bg-accent animate-pulse",         badge: "bg-accent/10 text-accent border-accent/20"                          },
  ready:    { label: "Ready",    dot: "bg-amber-400 animate-pulse",      badge: "bg-amber-400/[.12] text-amber-300 border-amber-400/[.25]"            },
  active:   { label: "Live",     dot: "bg-emerald-500 animate-pulse",    badge: "bg-emerald-500/[.12] text-emerald-400 border-emerald-500/[.25]"      },
  inactive: { label: "Inactive", dot: "bg-danger",                       badge: "bg-danger/10 text-danger border-danger/25"                          },
  deleted:  { label: "Deleted",  dot: "bg-danger opacity-50",            badge: "bg-danger/5 text-danger/60 border-danger/15"                        },
};

const CFG_LIGHT: Record<string, StatusCfg> = {
  draft:    { label: "Draft",    dot: "bg-faint",                        badge: "bg-black/[0.04] text-faint border-black/[.12] border-dashed"        },
  building: { label: "Building", dot: "bg-accent animate-pulse",         badge: "bg-accent/10 text-accent border-accent/20"                          },
  ready:    { label: "Ready",    dot: "bg-amber-600 animate-pulse",      badge: "bg-amber-600/[.08] text-amber-700 border-amber-600/[.22]"            },
  active:   { label: "Live",     dot: "bg-emerald-600 animate-pulse",    badge: "bg-emerald-600/[.08] text-emerald-700 border-emerald-600/[.22]"      },
  inactive: { label: "Inactive", dot: "bg-danger",                       badge: "bg-danger/10 text-danger border-danger/25"                          },
  deleted:  { label: "Deleted",  dot: "bg-danger opacity-50",            badge: "bg-danger/5 text-danger/60 border-danger/15"                        },
};

interface AppStatusBadgeProps {
  status: App["status"];
  /** Override with "building" when generation is in progress */
  isBuilding?: boolean;
  /** sm = table rows / compact lists  |  md = detail cards (default) */
  size?: "sm" | "md";
}

export function AppStatusBadge({ status, isBuilding, size = "md" }: AppStatusBadgeProps) {
  const theme = useThemeStore((s) => s.theme);
  const CFG = theme === "light" ? CFG_LIGHT : CFG_DARK;

  const effectiveStatus = isBuilding ? "building" : status;
  const cfg = CFG[effectiveStatus] ?? CFG.deleted;

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
