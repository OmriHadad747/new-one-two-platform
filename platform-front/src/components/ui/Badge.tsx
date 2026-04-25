import { cn } from "@/lib/cn";
import { useThemeStore } from "@/stores/theme";

export type BadgeVariant = "live" | "draft" | "building" | "failed" | "purple" | "teal" | "source";

const VARIANTS_DARK: Record<BadgeVariant, string> = {
  live: "bg-emerald-500/[.12] text-emerald-400",
  draft: "bg-white/[0.05] text-faint",
  building: "bg-accent/10 text-accent",
  failed: "bg-danger/10 text-danger",
  purple: "bg-accent/15 text-accent",
  teal: "bg-teal/15 text-teal",
  source: "bg-white/[0.05] text-faint",
};

const VARIANTS_LIGHT: Record<BadgeVariant, string> = {
  live: "bg-emerald-600/[.08] text-emerald-700",
  draft: "bg-black/[0.04] text-faint",
  building: "bg-accent/10 text-accent",
  failed: "bg-danger/10 text-danger",
  purple: "bg-accent/15 text-accent",
  teal: "bg-teal/15 text-teal",
  source: "bg-black/[0.04] text-faint",
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
        className,
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
        className,
      )}
    >
      {children}
    </span>
  );
}
