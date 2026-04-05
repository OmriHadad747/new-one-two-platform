import type { AppArchetype } from "@/types/dashboard";

const PILL_CLASSES = "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide";

const PILLS: Record<string, string> = {
  Backend: "bg-accent/10 text-accent",
  Widget:  "bg-teal/10 text-teal",
  Admin:   "bg-amber/10 text-amber",
};

interface ArchetypePillsProps {
  archetype: AppArchetype;
  size?: "sm" | "md";
}

export function ArchetypePills({ archetype }: ArchetypePillsProps) {
  const hasWidget = archetype === "storefront_backend" || archetype === "storefront_backend_admin";
  const hasAdmin  = archetype === "backend_admin"       || archetype === "storefront_backend_admin";

  return (
    <div className="flex items-center flex-wrap gap-1">
      <span className={`${PILL_CLASSES} ${PILLS["Backend"]}`}>Backend</span>
      {hasWidget && <span className={`${PILL_CLASSES} ${PILLS["Widget"]}`}>Widget</span>}
      {hasAdmin  && <span className={`${PILL_CLASSES} ${PILLS["Admin"]}`}>Admin</span>}
    </div>
  );
}
