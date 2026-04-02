import type { ReactNode } from "react";

interface TopBarProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function TopBar({ title, subtitle, actions }: TopBarProps) {
  return (
    <header className="h-14 flex items-center px-7 gap-4 bg-surface border-b border-white/7 shrink-0">
      <h1 className="flex-1 text-base font-bold text-ink leading-none">
        {title}
        {subtitle && (
          <span className="text-sm font-normal text-faint ml-2">/ {subtitle}</span>
        )}
      </h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
