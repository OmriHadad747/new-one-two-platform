import { cn } from "@/lib/cn";
import { useThemeStore } from "@/stores/theme";

export type BadgeVariant = "live" | "draft" | "building" | "failed" | "purple" | "teal" | "source";

const VARIANTS_DARK: Record<BadgeVariant, string> = {
  live:     "bg-emerald-500/[.12] text-emerald-400 border border-emerald-500/25",
  draft:    "bg-white/[0.05] text-faint border border-white/[0.12] border-dashed",
  building: "bg-accent/10 text-accent border border-accent/20",
  failed:   "bg-danger/10 text-danger border border-danger/20",
  purple:   "bg-accent/15 text-accent border border-accent/20",
  teal:     "bg-teal/15 text-teal border border-teal/25",
  source:   "bg-white/[0.05] text-faint border border-white/[0.12]",
};

const VARIANTS_LIGHT: Record<BadgeVariant, string> = {
  live:     "bg-emerald-600/[.08] text-emerald-700 border border-emerald-600/[.22]",
  draft:    "bg-black/[0.04] text-faint border border-black/[0.12] border-dashed",
  building: "bg-accent/10 text-accent border border-accent/20",
  failed:   "bg-danger/10 text-danger border border-danger/20",
  purple:   "bg-accent/15 text-accent border border-accent/20",
  teal:     "bg-teal/15 text-teal border border-teal/25",
  source:   "bg-black/[0.04] text-faint border border-black/[0.10]",
};

interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant, children, className }: BadgeProps) {
  const theme = useThemeStore((s) => s.theme);
  const variants = theme === "light" ? VARIANTS_LIGHT : VARIANTS_DARK;
  return (
    <span
      className={cn(
        "text-[10px] font-bold px-2 py-0.5 rounded-full tracking-wide uppercase",
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

export function Tag({ variant, children, className }: BadgeProps) {
  const theme = useThemeStore((s) => s.theme);
  const variants = theme === "light" ? VARIANTS_LIGHT : VARIANTS_DARK;
  return (
    <span
      className={cn(
        "text-[10px] font-bold px-2 py-0.5 rounded tracking-wide uppercase",
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
