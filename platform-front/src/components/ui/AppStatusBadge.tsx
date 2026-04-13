import { cn } from "@/lib/cn";
import type { App } from "@/types/dashboard";
import { useThemeStore } from "@/stores/theme";

type StatusCfg = { label: string; dot: string; badge: string };

const CFG_DARK: Record<string, StatusCfg> = {
  draft:    { label: "Draft",    dot: "bg-faint",                        badge: "bg-white/[0.05] text-faint"                    },
  building: { label: "Building", dot: "bg-accent animate-pulse",         badge: "bg-accent/10 text-accent"                      },
  ready:    { label: "Ready",    dot: "bg-amber-400 animate-pulse",      badge: "bg-amber-400/[.12] text-amber-300"              },
  active:   { label: "Live",     dot: "bg-emerald-500 animate-pulse",    badge: "bg-emerald-500/[.12] text-emerald-400"          },
  inactive: { label: "Inactive", dot: "bg-danger",                       badge: "bg-danger/10 text-danger"                      },
};

const CFG_LIGHT: Record<string, StatusCfg> = {
  draft:    { label: "Draft",    dot: "bg-faint",                        badge: "bg-black/[0.04] text-faint"                    },
  building: { label: "Building", dot: "bg-accent animate-pulse",         badge: "bg-accent/10 text-accent"                      },
  ready:    { label: "Ready",    dot: "bg-amber-600 animate-pulse",      badge: "bg-amber-600/[.08] text-amber-700"              },
  active:   { label: "Live",     dot: "bg-emerald-600 animate-pulse",    badge: "bg-emerald-600/[.08] text-emerald-700"          },
  inactive: { label: "Inactive", dot: "bg-danger",                       badge: "bg-danger/10 text-danger"                      },
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
  const cfg = CFG[effectiveStatus] ?? CFG.draft;

  if (size === "sm") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide", cfg.badge)}>
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", cfg.dot)} />
        {cfg.label}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold", cfg.badge)}>
      <span className={cn("w-2 h-2 rounded-full shrink-0", cfg.dot)} />
      {cfg.label}
    </span>
  );
}
