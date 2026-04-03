import { TopBar } from "@/components/layout/TopBar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useSessionStore } from "@/stores/session";
import { useTenant, useTenantStats } from "@/hooks/useApps";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-bold text-ink mb-3.5 pb-2.5 border-b border-white/7">{title}</h2>
      {children}
    </section>
  );
}

function InfoCard({ rows }: { rows: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="bg-white/[0.03] border border-white/7 rounded-xl overflow-hidden">
      {rows.map(({ label, value }, i) => (
        <div
          key={label}
          className={`flex items-center justify-between px-5 py-3.5 ${i < rows.length - 1 ? "border-b border-white/[0.05]" : ""}`}
        >
          <span className="text-[12px] text-faint">{label}</span>
          <span className="text-[13px] text-ink font-medium">{value}</span>
        </div>
      ))}
    </div>
  );
}

function UsageBar({ used, max }: { used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  const danger = pct >= 90;
  const warn = pct >= 70;
  return (
    <div className="space-y-1">
      <div className="h-1.5 bg-white/[0.08] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${danger ? "bg-danger" : warn ? "bg-amber-400" : "bg-teal"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-faint">
        {used.toLocaleString()} / {max.toLocaleString()}
      </span>
    </div>
  );
}

export function SettingsPage() {
  const { tenantId, shopDomain } = useSessionStore();
  const tenantQuery = useTenant(tenantId);
  const statsQuery = useTenantStats(tenantId);

  const tenant = tenantQuery.data;
  const stats = statsQuery.data;

  const PLAN_LIMITS: Record<string, { appLimit: number; callLimit: number }> = {
    free: { appLimit: 1, callLimit: 1_000 },
    starter: { appLimit: 3, callLimit: 10_000 },
    growth: { appLimit: 10, callLimit: 50_000 },
    pro: { appLimit: 10, callLimit: 50_000 },
  };

  const plan = tenant?.plan ?? "starter";
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS["starter"]!;
  const connectedDomain = shopDomain ?? tenant?.shopDomain ?? null;

  return (
    <>
      <TopBar title="Settings" />
      <main className="flex-1 overflow-y-auto p-7 max-w-[560px]">

        {/* ── Store Connection ──────────────────────────────────────────── */}
        <Section title="Store Connection">
          <div className="bg-white/[0.03] border border-white/7 rounded-xl overflow-hidden">
            {connectedDomain ? (
              <>
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.05]">
                  <div>
                    <div className="text-[13px] font-semibold text-ink mb-0.5">{connectedDomain}</div>
                    <div className="text-[11px] text-faint">Connected via Shopify OAuth</div>
                  </div>
                  <Badge variant="live">Connected</Badge>
                </div>
                <div className="flex items-center justify-between px-5 py-3.5">
                  <div>
                    <div className="text-[13px] font-medium text-ink">Reconnect</div>
                    <div className="text-[11px] text-faint">Re-run OAuth to refresh token</div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { window.location.href = "/install"; }}>
                    Reconnect
                  </Button>
                </div>
              </>
            ) : (
              <div className="px-5 py-4 flex items-center justify-between">
                <div>
                  <div className="text-[13px] font-semibold text-ink mb-0.5">No store connected</div>
                  <div className="text-[11px] text-faint">Install the app on your Shopify store to begin</div>
                </div>
                <Button variant="primary" size="sm" onClick={() => { window.location.href = "/install"; }}>
                  Connect
                </Button>
              </div>
            )}
          </div>
        </Section>

        {/* ── Workspace ─────────────────────────────────────────────────── */}
        <Section title="Workspace">
          {tenantQuery.isLoading ? (
            <div className="h-24 bg-white/[0.03] border border-white/7 rounded-xl animate-pulse-subtle" />
          ) : (
            <div className="space-y-4">
              <InfoCard
                rows={[
                  { label: "Name", value: tenant?.name ?? "—" },
                  { label: "Slug", value: <span className="font-mono text-[12px]">{tenant?.slug ?? "—"}</span> },
                  {
                    label: "Plan",
                    value: (
                      <span className="capitalize">{plan}</span>
                    ),
                  },
                ]}
              />

              {/* Usage */}
              <div className="bg-white/[0.03] border border-white/7 rounded-xl p-5 space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[12px] text-faint">API Calls this month</span>
                    <span className="text-[12px] text-ink font-medium">
                      {(stats?.apiCallsThisMonth ?? 0).toLocaleString()}
                    </span>
                  </div>
                  <UsageBar used={stats?.apiCallsThisMonth ?? 0} max={limits.callLimit} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[12px] text-faint">Active Apps</span>
                    <span className="text-[12px] text-ink font-medium">
                      {stats?.liveApps ?? 0}
                    </span>
                  </div>
                  <UsageBar used={stats?.liveApps ?? 0} max={limits.appLimit} />
                </div>
              </div>
            </div>
          )}
        </Section>

        {/* ── Danger Zone ───────────────────────────────────────────────── */}
        <Section title="Danger Zone">
          <div className="bg-danger/[0.04] border border-danger/20 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4">
              <div>
                <div className="text-[13px] font-semibold text-ink mb-0.5">Disconnect Store</div>
                <div className="text-[11px] text-faint">
                  Removes OAuth access and pauses all live apps
                </div>
              </div>
              <Button variant="danger" size="sm">
                Disconnect
              </Button>
            </div>
          </div>
        </Section>

      </main>
    </>
  );
}
