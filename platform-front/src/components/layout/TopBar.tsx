import type { ReactNode } from "react";
import { useThemeStore } from "@/stores/theme";

interface TopBarProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function TopBar({ title, subtitle, actions }: TopBarProps) {
  const { theme, toggle } = useThemeStore();

  return (
    <header className="h-14 flex items-center px-7 gap-4 bg-surface border-b border-white/7 shrink-0">
      <h1 className="flex-1 text-base font-bold text-ink leading-none">
        {title}
        {subtitle && (
          <span className="text-sm font-normal text-faint ml-2">/ {subtitle}</span>
        )}
      </h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
      <button
        type="button"
        onClick={toggle}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        className="w-8 h-8 flex items-center justify-center rounded-lg text-faint hover:text-ink hover:bg-white/[0.06] transition-colors bg-transparent border-0 cursor-pointer"
      >
        <span className="material-symbols-outlined text-[18px]">
          {theme === "dark" ? "light_mode" : "dark_mode"}
        </span>
      </button>
    </header>
  );
}
