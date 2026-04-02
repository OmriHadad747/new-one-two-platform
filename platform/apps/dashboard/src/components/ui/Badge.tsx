import { cn } from "@/lib/cn";

export type BadgeVariant = "live" | "draft" | "building" | "failed" | "purple" | "teal";

interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variants: Record<BadgeVariant, string> = {
  live: "bg-teal/10 text-teal border border-teal/25",
  draft: "bg-amber/10 text-amber border border-amber/20",
  building: "bg-accent/10 text-accent border border-accent/20",
  failed: "bg-danger/10 text-danger border border-danger/20",
  purple: "bg-accent/15 text-accent",
  teal: "bg-teal/15 text-teal",
};

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
