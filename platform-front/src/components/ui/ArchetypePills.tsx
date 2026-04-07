import type { AppArchetype } from "@/types/dashboard";

const PILLS: Record<string, { icon: string; label: string; cls: string; dotCls: string }> = {
  Backend: { icon: "bolt",                 label: "Backend",          cls: "bg-slate-500/10 text-slate-400 border border-slate-500/20", dotCls: "bg-slate-500/15 text-slate-400" },
  Widget:  { icon: "widgets",              label: "Storefront Widget", cls: "bg-teal/10   text-teal   border border-teal/20",   dotCls: "bg-teal/15   text-teal"   },
  Admin:   { icon: "admin_panel_settings", label: "Admin UI",         cls: "bg-amber/10  text-amber  border border-amber/20",  dotCls: "bg-amber/15  text-amber"  },
};

interface ArchetypePillsProps {
  archetype: AppArchetype;
  /** Compact mode: icon-only badges, always one row — use inside cards */
  compact?: boolean;
}

export function ArchetypePills({ archetype, compact }: ArchetypePillsProps) {
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
              style={{ fontVariationSettings: "'FILL' 1" }}
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
          <span className="material-symbols-outlined text-[11px] leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>
            {icon}
          </span>
          {label}
        </span>
      ))}
    </div>
  );
}
