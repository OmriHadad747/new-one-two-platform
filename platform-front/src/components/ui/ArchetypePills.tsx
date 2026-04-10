import type { AppArchetype } from "@/types/dashboard";
import { useThemeStore } from "@/stores/theme";

type PillDef = { icon: string; label: string; cls: string; dotCls: string };

const PILLS_DARK: Record<string, PillDef> = {
  Backend: { icon: "bolt",                 label: "Backend",           cls: "bg-emerald-400/[.12] text-emerald-300 border border-emerald-400/[.2]", dotCls: "bg-emerald-400/[.15] text-emerald-300" },
  Widget:  { icon: "widgets",              label: "Storefront Widget", cls: "bg-sky-400/[.12]     text-sky-300     border border-sky-400/[.2]",     dotCls: "bg-sky-400/[.15]     text-sky-300"     },
  Admin:   { icon: "admin_panel_settings", label: "Admin UI",          cls: "bg-orange-400/[.12]  text-orange-300  border border-orange-400/[.2]",  dotCls: "bg-orange-400/[.15]  text-orange-300"  },
};

const PILLS_LIGHT: Record<string, PillDef> = {
  Backend: { icon: "bolt",                 label: "Backend",           cls: "bg-emerald-600/[.08] text-emerald-700 border border-emerald-600/[.18]", dotCls: "bg-emerald-600/[.1] text-emerald-700" },
  Widget:  { icon: "widgets",              label: "Storefront Widget", cls: "bg-sky-600/[.08]     text-sky-700     border border-sky-600/[.18]",     dotCls: "bg-sky-600/[.1]     text-sky-700"     },
  Admin:   { icon: "admin_panel_settings", label: "Admin UI",          cls: "bg-orange-600/[.08]  text-orange-700  border border-orange-600/[.18]",  dotCls: "bg-orange-600/[.1]  text-orange-700"  },
};

interface ArchetypePillsProps {
  archetype: AppArchetype;
  /** Compact mode: icon-only badges, always one row — use inside cards */
  compact?: boolean;
}

export function ArchetypePills({ archetype, compact }: ArchetypePillsProps) {
  const theme = useThemeStore((s) => s.theme);
  const PILLS = theme === "light" ? PILLS_LIGHT : PILLS_DARK;

  const hasWidget = archetype === "storefront_backend" || archetype === "storefront_backend_admin";
  const hasAdmin  = archetype === "backend_admin"      || archetype === "storefront_backend_admin";

  const pills = [
    PILLS["Backend"],
    ...(hasWidget ? [PILLS["Widget"]] : []),
    ...(hasAdmin  ? [PILLS["Admin"]]  : []),
  ];

  if (compact) {
    return (
      <div className="flex items-center gap-1.5">
        {pills.map(({ icon, label, dotCls }) => (
          <span
            key={icon}
            title={label}
            className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${dotCls}`}
          >
            <span
              className="material-symbols-outlined text-[13px] leading-none"
              style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}
            >
              {icon}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center flex-wrap gap-1">
      {pills.map(({ icon, label, cls }) => (
        <span
          key={icon}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9.5px] font-bold whitespace-nowrap ${cls}`}
        >
          <span className="material-symbols-outlined text-[11px] leading-none" style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}>
            {icon}
          </span>
          {label}
        </span>
      ))}
    </div>
  );
}
