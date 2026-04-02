import { cn } from "@/lib/cn";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
}

export function Card({ children, className, hover, onClick }: CardProps) {
  if (onClick || hover) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "bg-white/[0.03] border border-white/7 rounded-xl text-left w-full",
          "cursor-pointer transition-all duration-150 hover:bg-white/[0.055] hover:border-white/13 hover:-translate-y-0.5",
          className
        )}
      >
        {children}
      </button>
    );
  }
  return (
    <div
      className={cn(
        "bg-white/[0.03] border border-white/7 rounded-xl",
        className
      )}
    >
      {children}
    </div>
  );
}
