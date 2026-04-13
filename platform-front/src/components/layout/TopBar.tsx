import type { ReactNode } from "react";
import { useThemeStore } from "@/stores/theme";

interface TopBarProps {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}

export function TopBar({ title, subtitle, actions }: TopBarProps) {
  const { theme, toggle } = useThemeStore();

  return (
    <header className="h-16 flex items-center px-7 gap-4 bg-surface border-b border-white/[0.04] shrink-0">
      <h1 className="flex-1 text-base font-bold text-ink leading-none">
        {title}
        {subtitle && (
          <span className="text-sm font-normal text-faint ml-2">/ {subtitle}</span>
        )}
      </h1>
      <div className="flex items-center gap-2">
        {actions}
        <button
          type="button"
          onClick={toggle}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          className="w-8 h-8 flex items-center justify-center rounded-md text-faint hover:text-ink hover:bg-white/[0.06] transition-colors bg-transparent border-0 cursor-pointer"
        >
          <span className="material-symbols-outlined text-[16px]">
            {theme === "dark" ? "light_mode" : "dark_mode"}
          </span>
        </button>
      </div>
    </header>
  );
}
