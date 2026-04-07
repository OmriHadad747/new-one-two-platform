import type { AppArchetype } from "@/types/dashboard";

const PILLS: Record<string, { icon: string; label: string; cls: string }> = {
  Backend: { icon: "api",                  label: "Backend",          cls: "bg-accent/10 text-accent border border-accent/20" },
  Widget:  { icon: "widgets",              label: "Storefront Widget", cls: "bg-teal/10   text-teal   border border-teal/20"   },
  Admin:   { icon: "admin_panel_settings", label: "Admin UI",         cls: "bg-amber/10  text-amber  border border-amber/20"  },
};

interface ArchetypePillsProps {
  archetype: AppArchetype;
}

export function ArchetypePills({ archetype }: ArchetypePillsProps) {
  const hasWidget = archetype === "storefront_backend" || archetype === "storefront_backend_admin";
  const hasAdmin  = archetype === "backend_admin"      || archetype === "storefront_backend_admin";

  const pills = [
    PILLS["Backend"],
    ...(hasWidget ? [PILLS["Widget"]] : []),
    ...(hasAdmin  ? [PILLS["Admin"]]  : []),
  ];

  return (
    <div className="flex items-center flex-wrap gap-1.5">
      {pills.map(({ icon, label, cls }) => (
        <span
          key={icon}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-bold ${cls}`}
        >
          <span className="material-symbols-outlined text-[12px] leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>
            {icon}
          </span>
          {label}
        </span>
      ))}
    </div>
  );
}
