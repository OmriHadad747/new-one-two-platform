import { Tag } from "@/components/ui/Badge";
import type { ActivityItem } from "@/types/dashboard";

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div>
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-3 py-3 border-b border-white/7 last:border-b-0"
        >
          <span className="text-lg shrink-0">{item.icon}</span>
          <span className="text-[13px] text-muted flex-1 min-w-0">{item.text}</span>
          <Tag variant={item.tagVariant}>{item.tag}</Tag>
          <span className="text-[11px] text-faint whitespace-nowrap">{item.time}</span>
        </div>
      ))}
    </div>
  );
}
