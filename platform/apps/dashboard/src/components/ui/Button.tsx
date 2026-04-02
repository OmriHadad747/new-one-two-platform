import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "ghost", size = "md", className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg font-sans font-semibold transition-all duration-150 cursor-pointer border-0 disabled:opacity-50 disabled:cursor-not-allowed",
          size === "sm" && "text-xs px-3 py-1.5",
          size === "md" && "text-[13px] px-4 py-2",
          variant === "primary" && "bg-accent text-white hover:bg-accent-hi active:scale-[0.98]",
          variant === "ghost" &&
            "bg-transparent text-muted border border-white/13 hover:bg-white/5 hover:text-ink",
          variant === "danger" &&
            "bg-danger/10 text-danger border border-danger/20 hover:bg-danger/15",
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
