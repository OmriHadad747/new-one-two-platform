import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "ghost", size = "md", className, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg font-sans font-semibold transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
        size === "sm" && "text-xs px-3 py-1.5",
        size === "md" && "text-[13px] px-4 py-2",
        variant === "primary" &&
          "bg-accent text-white border-0 hover:bg-accent-hi active:scale-[0.98]",
        variant === "ghost" &&
          "bg-white/[0.04] text-muted border-0 hover:bg-white/[0.08] hover:text-ink",
        variant === "danger" &&
          "bg-danger/10 text-danger border-0 hover:bg-danger/15",
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
);
Button.displayName = "Button";
