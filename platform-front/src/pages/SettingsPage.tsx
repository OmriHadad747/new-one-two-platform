import { useState } from "react";
import { TopBar } from "@/components/layout/TopBar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useSessionStore } from "@/stores/session";
import { useTenant, useTenantStats, useBillingUsage } from "@/hooks/useApps";
import { useThemeStore } from "@/stores/theme";
import { api } from "@/lib/api";
import type { BillingPlan } from "@/types/dashboard";
import { BrandPanel } from "@/components/features/email/BrandPanel";

// ─── Ring Progress ────────────────────────────────────────────────────────────

const RING_R = 18;
const RING_C = 2 * Math.PI * RING_R;
const RING_SIZE = 46;
const RING_CX = RING_SIZE / 2;

function RingProgress({ pct, color }: { pct: number; color: string }) {
  // Always show at least a 4% arc so the ring is visually present even at near-0
  const visual = pct > 0 ? Math.max(pct, 4) : 0;
  const offset = RING_C * (1 - visual / 100);
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      style={{ transform: "rotate(-90deg)" }}
    >
      {/* Track — uses CSS var so it adapts to data-theme="light" */}
      <circle
        cx={RING_CX} cy={RING_CX} r={RING_R}
        fill="none"
        stroke="var(--color-ring-track)"
        strokeWidth="3.5"
      />
      {visual > 0 && (
        <circle
          cx={RING_CX} cy={RING_CX} r={RING_R}
          fill="none"
          stroke={color}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
      )}
    </svg>
  );
}

// ─── Stat Tile ────────────────────────────────────────────────────────────────

function StatTile({
  label,
  used,
  max,
  unlimited = false,
}: {
  label: string;
  used: number;
  max: number;
  unlimited?: boolean;
}) {
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(max, 1)) * 100));
  const danger = !unlimited && pct >= 90;
  const warn   = !unlimited && pct >= 70;
  // Use accent (violet) for normal state — readable in both light and dark themes.
  // Teal (#5de6ff) is too faint at small sizes in light mode.
  const color  = danger ? "var(--color-danger)" : warn ? "#f59e0b" : "var(--color-accent)";
  const maxLabel = unlimited ? "∞" : max.toLocaleString();

  return (
    <div className={`rounded-xl p-3 flex flex-col gap-2 ${
      danger
        ? "bg-danger/[0.06]"
        : warn
        ? "bg-amber-400/[0.06]"
        : "bg-white/[0.05]"
    }`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[22px] font-bold text-ink tabular-nums leading-none tracking-tight">
            {used.toLocaleString()}
          </div>
          <div className="text-[11px] text-faint mt-1.5 tabular-nums">
            of {maxLabel}
          </div>
        </div>
        <div className="relative w-[46px] h-[46px] shrink-0">
          <RingProgress pct={unlimited ? 0 : pct} color={unlimited ? "currentColor" : color} />
          <span
            className={`absolute inset-0 flex items-center justify-center text-[10px] font-black tabular-nums leading-none ${unlimited ? "text-faint" : ""}`}
            style={unlimited ? undefined : { color }}
          >
            {unlimited ? "∞" : `${pct}%`}
          </span>
        </div>
      </div>
      <div className="text-[11px] text-faint font-medium">{label}</div>
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-white/[0.04] last:border-0">
      <span className="text-[12px] text-faint">{label}</span>
      <span className="text-[12px] text-ink font-medium">{value}</span>
    </div>
  );
}

// ─── Plan Picker Modal ────────────────────────────────────────────────────────

const PLAN_DEFS: Array<{
  id: BillingPlan;
  name: string;
  priceMonthly: number;
  priceYearly: number;
  apps: string;
  builds: string;
  executions: string;
  emails: string;
  highlight?: boolean;
}> = [
  {
    id: "starter",
    name: "Starter",
    priceMonthly: 19,
    priceYearly: 190,
    apps: "3 active apps",
    builds: "3 generations/mo",
    executions: "10k invocations/mo",
    emails: "1k emails/mo",
  },
  {
    id: "growth",
    name: "Growth",
    priceMonthly: 49,
    priceYearly: 490,
    apps: "10 active apps",
    builds: "10 generations/mo",
    executions: "50k invocations/mo",
    emails: "5k emails/mo",
    highlight: true,
  },
  {
    id: "pro",
    name: "Pro",
    priceMonthly: 99,
    priceYearly: 990,
    apps: "Unlimited active apps",
    builds: "Unlimited generations",
    executions: "200k invocations/mo",
    emails: "20k emails/mo",
  },
];

function PlanModal({
  currentPlan,
  tenantId,
  onClose,
}: {
  currentPlan: BillingPlan;
  tenantId: string;
  onClose: () => void;
}) {
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [loading, setLoading] = useState<BillingPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(plan: BillingPlan) {
    if (plan === currentPlan) return;
    setLoading(plan);
    setError(null);
    try {
      const res = await api.billing.subscribe(tenantId, plan, interval);
      if (res.confirmationUrl) {
        window.location.href = res.confirmationUrl;
      } else {
        // No confirmation needed (e.g. test mode) — reload to refresh plan
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setLoading(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
    >
      <div className="bg-surface rounded-xl w-full max-w-[580px] overflow-hidden shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5">
          <div>
            <div className="text-[15px] font-bold text-ink">Upgrade your plan</div>
            <div className="text-[12px] text-faint mt-0.5">Unlock more apps, builds, and executions</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-faint hover:text-ink hover:bg-white/[0.06] transition-colors bg-transparent border-0 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Interval toggle */}
        <div className="px-6 pb-4">
          <div className="inline-flex items-center gap-0.5 p-1 rounded-lg bg-white/[0.04] border border-white/[0.06]">
            {(["monthly", "annual"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setInterval(opt)}
                className={`px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all border-0 cursor-pointer flex items-center gap-1.5 ${
                  interval === opt
                    ? "bg-white/[0.08] text-ink"
                    : "bg-transparent text-faint hover:text-ink"
                }`}
              >
                {opt === "monthly" ? "Monthly" : "Annual"}
                {opt === "annual" && (
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white"
                    style={{ background: "linear-gradient(135deg, #a78bfa 0%, #5de6ff 100%)" }}
                  >−17%</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-6 mb-3 px-4 py-2.5 rounded-xl bg-danger/[0.08] border border-danger/20 text-[12px] text-danger flex items-start gap-2">
            <span className="material-symbols-outlined text-[15px] shrink-0 mt-px">error</span>
            {error}
          </div>
        )}

        {/* Plan cards */}
        <div className="px-6 pb-6 grid grid-cols-3 gap-3">
          {PLAN_DEFS.map((plan) => {
            const isCurrent = plan.id === currentPlan;
            const price = interval === "monthly" ? plan.priceMonthly : Math.round(plan.priceYearly / 12);
            const isLoading = loading === plan.id;

            return (
              <div
                key={plan.id}
                className={`rounded-xl p-4 flex flex-col gap-3 relative ${
                  plan.highlight
                    ? "bg-accent/[0.05] ring-1 ring-accent/25"
                    : "bg-white/[0.03]"
                }`}
              >
                {plan.highlight && (
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-accent text-white">
                      Popular
                    </span>
                  </div>
                )}

                <div>
                  <div className="text-[13px] font-bold text-ink">{plan.name}</div>
                  <div className="flex items-baseline gap-1 mt-1.5">
                    <span className="text-[22px] font-extrabold text-ink tabular-nums">${price}</span>
                    <span className="text-[11px] text-faint">/mo</span>
                  </div>
                  {interval === "annual" && (
                    <div className="text-[10px] text-teal mt-0.5">
                      ${plan.priceYearly}/yr
                    </div>
                  )}
                </div>

                <ul className="space-y-1.5">
                  {[plan.apps, plan.builds, plan.executions, plan.emails].map((feat) => (
                    <li key={feat} className="flex items-center gap-2 text-[11px] text-faint">
                      <span className="material-symbols-outlined text-[13px] text-teal shrink-0">check</span>
                      {feat}
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  disabled={isCurrent || !!loading}
                  onClick={() => handleSelect(plan.id)}
                  className={`w-full py-2 rounded-lg text-[12px] font-semibold border-0 transition-all cursor-pointer mt-auto ${
                    isCurrent
                      ? "bg-white/[0.05] text-faint cursor-default"
                      : plan.highlight
                      ? "text-white hover:opacity-90"
                      : "bg-white/[0.07] text-ink hover:bg-white/[0.12]"
                  }`}
                  style={
                    !isCurrent && plan.highlight
                      ? { background: "var(--color-accent)", boxShadow: "0 0 12px rgba(167,139,250,0.3)" }
                      : undefined
                  }
                >
                  {isLoading ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full border border-white/30 border-t-white animate-spin" />
                      Redirecting…
                    </span>
                  ) : isCurrent ? "Current plan" : "Select"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Plan badge styles ────────────────────────────────────────────────────────
// Inline styles bypass Tailwind scanning — color values are always applied.
// Dark: light tints on dark surfaces. Light: solid chip colors on white.

type PlanStyle = { color: string; borderColor: string; backgroundColor: string };

const PLAN_BADGE_DARK: Record<string, PlanStyle> = {
  free:     { color: "var(--color-faint)",  borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.04)" },
  starter:  { color: "#7dd3fc",             borderColor: "rgba(56,189,248,0.25)",  backgroundColor: "rgba(56,189,248,0.08)"  },
  growth:   { color: "#6ee7b7",             borderColor: "rgba(52,211,153,0.25)",  backgroundColor: "rgba(52,211,153,0.08)"  },
  pro:      { color: "var(--color-accent)", borderColor: "rgba(167,139,250,0.25)", backgroundColor: "rgba(167,139,250,0.08)" },
  internal: { color: "#fcd34d",             borderColor: "rgba(251,191,36,0.25)",  backgroundColor: "rgba(251,191,36,0.08)"  },
};

const PLAN_BADGE_LIGHT: Record<string, PlanStyle> = {
  free:     { color: "var(--color-faint)",  borderColor: "rgba(0,0,0,0.12)",       backgroundColor: "rgba(0,0,0,0.04)"       },
  starter:  { color: "#075985",             borderColor: "#7dd3fc",                backgroundColor: "#f0f9ff"                 },
  growth:   { color: "#065f46",             borderColor: "#6ee7b7",                backgroundColor: "#ecfdf5"                 },
  pro:      { color: "var(--color-accent)", borderColor: "rgba(124,58,237,0.35)",  backgroundColor: "#f5f3ff"                 },
  internal: { color: "#92400e",             borderColor: "#f59e0b",                backgroundColor: "#fffbeb"                 },
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const { tenantId, shopDomain } = useSessionStore();
  const tenantQuery  = useTenant(tenantId);
  const statsQuery   = useTenantStats(tenantId);
  const usageQuery   = useBillingUsage(tenantId);
  const { theme }    = useThemeStore();
  const [showUpgrade, setShowUpgrade] = useState(false);

  const tenant  = tenantQuery.data;
  const stats   = statsQuery.data;
  const billing = usageQuery.data;

  const plan      = tenant?.billingPlan ?? "free";
  const planTable = theme === "light" ? PLAN_BADGE_LIGHT : PLAN_BADGE_DARK;
  const planStyle = planTable[plan] ?? planTable["free"]!;
  const canUpgrade = plan !== "pro" && plan !== "internal";
  const connectedDomain = shopDomain ?? tenant?.shopDomain ?? null;

  const limits = billing?.limits;
  const usage  = billing?.usage;

  return (
    <>
      <TopBar title="Settings" />
      <main className="flex-1 overflow-y-auto py-5 px-8 w-full max-w-[680px] mx-auto space-y-3">

        {/* ── Plan ──────────────────────────────────────────────────────── */}
        <section className="bg-white/[0.03] rounded-xl overflow-hidden">

          <div className="px-6 pt-4 pb-2">
            <span className="text-[11px] font-semibold text-faint uppercase tracking-widest">Plan</span>
          </div>

          <div className="flex items-center justify-between px-6 pb-3">
            <div className="flex items-center gap-3">
              <span className="text-[12px] font-semibold px-3 py-1 rounded-full border capitalize" style={planStyle}>{plan}</span>
              {tenant?.subscriptionStatus === "active" && <span className="text-[12px] text-teal">· Active</span>}
              {tenant?.subscriptionStatus === "frozen" && <span className="text-[12px] text-danger">· Payment issue</span>}
              {tenant?.subscriptionStatus === "pending" && <span className="text-[12px] text-faint">· Pending</span>}
            </div>
            {canUpgrade && (
              <button
                type="button"
                onClick={() => setShowUpgrade(true)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12px] font-bold text-white border-0 cursor-pointer transition-all hover:bg-accent-hi active:scale-[0.97]"
                style={{
                  background: "var(--color-accent)",
                  boxShadow: "0 0 16px rgba(167,139,250,0.35)",
                }}
              >
                <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
                Upgrade
              </button>
            )}
          </div>

          {/* Usage tiles */}
          <div className="px-4 pb-4 pt-1">
            {usageQuery.isLoading || statsQuery.isLoading ? (
              <div className="grid grid-cols-2 gap-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-28 bg-white/[0.04] rounded-xl animate-pulse-subtle" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <StatTile label="Active apps"      used={stats?.liveApps ?? 0}        max={limits?.maxApps ?? 1}                    unlimited={(limits?.maxApps ?? 0) >= 999}        />
                <StatTile label="Generations / mo" used={usage?.generations ?? 0}      max={limits?.maxGenerationsPerMonth ?? 1}      unlimited={(limits?.maxGenerationsPerMonth ?? 0) >= 999}    />
                <StatTile label="Invocations / mo" used={usage?.appExecutions ?? 0}    max={limits?.maxAppExecutionsPerMonth ?? 1000} unlimited={(limits?.maxAppExecutionsPerMonth ?? 0) >= 999_999} />
                <StatTile label="Emails / mo"      used={usage?.emailsSent ?? 0}       max={limits?.maxEmailsPerMonth ?? 0}           unlimited={(limits?.maxEmailsPerMonth ?? 0) >= 999_999}       />
              </div>
            )}
          </div>
        </section>

        {/* ── Workspace ─────────────────────────────────────────────────── */}
        <section className="bg-white/[0.03] rounded-xl overflow-hidden">

          <div className="px-6 pt-4 pb-2">
            <span className="text-[11px] font-semibold text-faint uppercase tracking-widest">Workspace</span>
          </div>

          {/* Store identity */}
          <div className="px-6 pb-4 flex items-center gap-4">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center text-[16px] font-extrabold text-white shrink-0 select-none"
              style={{ background: "linear-gradient(135deg, #a78bfa 0%, #5de6ff 100%)" }}
            >
              {connectedDomain ? connectedDomain[0]!.toUpperCase() : "?"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[15px] font-semibold text-ink truncate">
                {connectedDomain ?? "No store connected"}
              </div>
              <div className="text-[12px] text-faint mt-0.5">
                {connectedDomain ? "Connected via Shopify OAuth" : "Install on your Shopify store to begin"}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {connectedDomain ? (
                <>
                  <Badge variant="live">Live</Badge>
                  <Button variant="ghost" size="sm" onClick={() => { window.location.href = "/install"; }}>Reconnect</Button>
                </>
              ) : (
                <Button variant="primary" size="sm" onClick={() => { window.location.href = "/install"; }}>Connect</Button>
              )}
            </div>
          </div>

          {/* Account rows */}
          <div className="px-6 border-t border-white/[0.05] pt-1 pb-2">
            {tenantQuery.isLoading ? (
              <div className="py-4 space-y-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-4 bg-white/[0.04] rounded animate-pulse-subtle" />)}
              </div>
            ) : (
              <>
                <Row label="Name"       value={tenant?.name ?? "—"} />
                <Row label="Workspace"  value={<span className="font-mono text-[12px]">{tenant?.slug ?? "—"}</span>} />
                <Row label="Tenant ID"  value={<span className="font-mono text-[12px] text-faint">{tenantId ? `${tenantId.slice(0, 8)}…` : "—"}</span>} />
              </>
            )}
          </div>
        </section>

        {/* ── Danger Zone ───────────────────────────────────────────────── */}
        <section className="bg-danger/[0.03] rounded-xl overflow-hidden">
          <div className="px-6 pt-4 pb-2">
            <span className="text-[11px] font-semibold text-danger/60 uppercase tracking-widest">Danger Zone</span>
          </div>
          <div className="flex items-center justify-between px-6 pb-4">
            <div>
              <div className="text-[14px] font-medium text-ink">Disconnect store</div>
              <div className="text-[12px] text-faint mt-1">Removes OAuth access and pauses all live apps</div>
            </div>
            <Button variant="danger" size="sm">Disconnect</Button>
          </div>
        </section>

        {/* Email brand — tenant-level, shared across every email-using app */}
        {tenantId && <BrandPanel tenantId={tenantId} />}

      </main>

      {showUpgrade && tenantId && (
        <PlanModal
          currentPlan={plan}
          tenantId={tenantId}
          onClose={() => setShowUpgrade(false)}
        />
      )}
    </>
  );
}
