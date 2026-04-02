interface UsageItem {
  label: string;
  used: number;
  max: number;
}

function UsageBar({ label, used, max }: UsageItem) {
  const pct = Math.min((used / max) * 100, 100);
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex justify-between text-xs text-faint mb-1">
        <span>{label}</span>
        <span>{used.toLocaleString()} / {max.toLocaleString()}</span>
      </div>
      <div className="h-1.5 bg-raised rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-accent to-teal rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

interface PlanCardProps {
  plan: string;
  price: string;
  usage: UsageItem[];
  onUpgrade: () => void;
}

export function PlanCard({ plan, price, usage, onUpgrade }: PlanCardProps) {
  return (
    <div className="bg-gradient-to-br from-accent/10 to-teal/[0.06] border border-accent/25 rounded-xl p-5 mb-3.5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-xl font-extrabold text-ink">{plan}</div>
          <div className="text-[13px] text-faint mt-0.5">{price}</div>
        </div>
        <button
          type="button"
          onClick={onUpgrade}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-white/13 text-muted hover:text-ink hover:bg-white/5 transition-all cursor-pointer bg-transparent"
        >
          Upgrade
        </button>
      </div>
      {usage.map((u) => (
        <UsageBar key={u.label} {...u} />
      ))}
    </div>
  );
}
