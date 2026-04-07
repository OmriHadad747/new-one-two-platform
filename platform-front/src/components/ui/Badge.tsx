import { cn } from "@/lib/cn";

export type BadgeVariant = "live" | "draft" | "building" | "failed" | "purple" | "teal";

const variants: Record<BadgeVariant, string> = {
  live: "bg-green-500/10 text-green-500 border border-green-500/25",
  draft: "bg-white/[0.05] text-faint border border-white/15",
  building: "bg-accent/10 text-accent border border-accent/20",
  failed: "bg-danger/10 text-danger border border-danger/20",
  purple: "bg-accent/15 text-accent",
  teal: "bg-teal/15 text-teal",
};

interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant, children, className }: BadgeProps) {
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
