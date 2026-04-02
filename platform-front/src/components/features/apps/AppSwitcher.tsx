import { cn } from "@/lib/cn";
import type { App } from "@/types/dashboard";

interface AppSwitcherProps {
  apps: App[];
  activeId: string;
  onSelect: (app: App) => void;
}

export function AppSwitcher({ apps, activeId, onSelect }: AppSwitcherProps) {
  return (
    <div className="flex gap-2 mb-5 flex-wrap">
      {apps.map((app) => (
        <button
          key={app.id}
          type="button"
          onClick={() => onSelect(app)}
          className={cn(
            "px-3.5 py-1.5 rounded-lg text-[13px] font-semibold border transition-all duration-150 cursor-pointer",
            activeId === app.id
              ? "bg-accent text-white border-transparent"
              : "bg-white/[0.03] text-faint border-white/7 hover:text-ink hover:border-white/13"
          )}
        >
          {app.name}
        </button>
      ))}
    </div>
  );
}
