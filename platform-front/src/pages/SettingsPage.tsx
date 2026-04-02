import { useState } from "react";
import { TopBar } from "@/components/layout/TopBar";
import { PlanCard } from "@/components/features/settings/PlanCard";
import { ToggleRow } from "@/components/features/settings/ToggleRow";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { LoadingSpinner } from "@/components/ui/StateViews";
import { useSessionStore } from "@/stores/session";
import { useTenant, useTenantStats } from "@/hooks/useApps";

interface Toggles {
  webhooks: boolean;
  sandbox: boolean;
  autoDeploy: boolean;
}

const PLAN_LIMITS: Record<string, { appLimit: number; callLimit: number; price: string }> = {
  free: { appLimit: 1, callLimit: 1000, price: "Free" },
  starter: { appLimit: 3, callLimit: 10000, price: "$15 / month" },
  growth: { appLimit: 10, callLimit: 50000, price: "$35 / month" },
  pro: { appLimit: 10, callLimit: 50000, price: "$49 / month" },
};

export function SettingsPage() {
  const { tenantId, shopDomain } = useSessionStore();
  const tenantQuery = useTenant(tenantId);
  const statsQuery = useTenantStats(tenantId);
  const [toggles, setToggles] = useState<Toggles>({
    webhooks: true,
    sandbox: true,
    autoDeploy: false,
  });

  const flip = (key: keyof Toggles) =>
    setToggles((t) => ({ ...t, [key]: !t[key] }));

  const tenant = tenantQuery.data;
  const stats = statsQuery.data;
  const plan = tenant?.plan ?? "starter";
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS["starter"]!;

  return (
    <>
      <TopBar title="Settings" />
      <main className="flex-1 overflow-y-auto p-7 max-w-[640px]">
        {tenantQuery.isLoading ? (
          <LoadingSpinner />
        ) : (
          <>
            {/* Plan */}
            <section className="mb-7">
              <h2 className="text-sm font-bold text-ink mb-3.5 pb-2.5 border-b border-white/7">
                Plan & Usage
              </h2>
              <PlanCard
                plan={plan.charAt(0).toUpperCase() + plan.slice(1) + " Plan"}
                price={limits.price + " · billed monthly"}
                usage={[
                  {
                    label: "API Calls",
                    used: stats?.apiCallsThisMonth ?? 0,
                    max: limits.callLimit,
                  },
                  {
                    label: "Active Apps",
                    used: stats?.liveApps ?? 0,
                    max: limits.appLimit,
                  },
                ]}
                onUpgrade={() => {}}
              />
            </section>

            {/* Platform Behavior */}
            <section className="mb-7">
              <h2 className="text-sm font-bold text-ink mb-3.5 pb-2.5 border-b border-white/7">
                Platform Behavior
              </h2>
              <div className="bg-white/[0.03] border border-white/7 rounded-xl overflow-hidden">
                <ToggleRow
                  title="Webhook Processing"
                  sub="Receive and process Shopify webhook events"
                  checked={toggles.webhooks}
                  onChange={() => flip("webhooks")}
                />
                <ToggleRow
                  title="Execution Sandbox"
                  sub="Run widget handlers in isolated environment"
                  checked={toggles.sandbox}
                  onChange={() => flip("sandbox")}
                />
                <ToggleRow
                  title="Auto-Deploy on Generate"
                  sub="Automatically deploy new widgets without manual approval"
                  checked={toggles.autoDeploy}
                  onChange={() => flip("autoDeploy")}
                  last
                />
              </div>
            </section>

            {/* Store Connection */}
            <section>
              <h2 className="text-sm font-bold text-ink mb-3.5 pb-2.5 border-b border-white/7">
                Store Connection
              </h2>
              <div className="bg-white/[0.03] border border-white/7 rounded-xl overflow-hidden">
                {shopDomain || tenant?.shopDomain ? (
                  <>
                    <div className="flex items-center justify-between px-5 py-4 border-b border-white/7">
                      <div>
                        <div className="text-[13px] font-semibold text-ink mb-0.5">
                          {shopDomain ?? tenant?.shopDomain}
                        </div>
                        <div className="text-[11px] text-faint">
                          Connected via OAuth · Scopes: read_products, write_script_tags
                        </div>
                      </div>
                      <Badge variant="live">Connected</Badge>
                    </div>
                    <div className="flex items-center justify-between px-5 py-4">
                      <div>
                        <div className="text-[13px] font-semibold text-ink mb-0.5">
                          Disconnect Store
                        </div>
                        <div className="text-[11px] text-faint">
                          Removes access token and pauses all apps
                        </div>
                      </div>
                      <Button variant="danger" size="sm">
                        Disconnect
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="px-5 py-4 flex items-center justify-between">
                    <div>
                      <div className="text-[13px] font-semibold text-ink mb-0.5">
                        No store connected
                      </div>
                      <div className="text-[11px] text-faint">
                        Install the New One Two app on your Shopify store to get started
                      </div>
                    </div>
                    <Badge variant="draft">Disconnected</Badge>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
