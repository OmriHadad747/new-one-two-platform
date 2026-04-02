import { cn } from "@/lib/cn";

interface CodeBlockProps {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function CodeBlock({ title, badge, children, className }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "bg-raised border border-white/7 rounded-xl overflow-hidden",
        className
      )}
    >
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/7">
        <span className="text-xs font-bold text-ink font-mono">{title}</span>
        {badge}
      </div>
      <div className="p-4 font-mono text-[11px] text-muted leading-[1.8] overflow-x-auto">
        {children}
      </div>
    </div>
  );
}
