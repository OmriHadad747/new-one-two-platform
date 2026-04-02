import type { DashboardStats } from "@/types/dashboard";

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  delta: string;
  positive?: boolean;
}

function StatCard({ label, value, sub, delta, positive }: StatCardProps) {
  return (
    <div className="bg-white/[0.03] border border-white/7 rounded-xl px-5 py-[18px]">
      <div className="text-[11px] font-semibold text-faint tracking-[0.8px] uppercase mb-2">
        {label}
      </div>
      <div className="text-[28px] font-extrabold text-ink tracking-tight leading-none mb-1">
        {value}
        {sub && (
          <span className="text-[13px] font-medium text-faint ml-1">{sub}</span>
        )}
      </div>
      <div className={`text-[11px] ${positive ? "text-teal" : "text-faint"}`}>
        {delta}
      </div>
    </div>
  );
}

export function StatsGrid({ stats }: { stats: DashboardStats }) {
  const calls =
    stats.apiCallsThisMonth >= 1000
      ? `${(stats.apiCallsThisMonth / 1000).toFixed(1)}K`
      : String(stats.apiCallsThisMonth);

  return (
    <div className="grid grid-cols-4 gap-3.5">
      <StatCard label="Total Apps" value={String(stats.totalApps)} delta="↑ 1 this week" positive />
      <StatCard label="Live Apps" value={String(stats.liveApps)} delta="Active on storefront" />
      <StatCard label="API Calls" value={calls} sub="/ mo" delta="↑ 12% vs last month" positive />
      <StatCard label="Avg Response" value={String(stats.avgResponseMs)} sub="ms" delta="Within SLA" />
    </div>
  );
}
