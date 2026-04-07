import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { useNavigate } from "react-router";
import { useState } from "react";
import type { GenerationState, GenerationBundle, App, ProgressEvent } from "@/types/dashboard";
import { ArchetypePills } from "@/components/ui/ArchetypePills";

interface AppTestingPanelProps {
  gen: GenerationState;
  bundle: GenerationBundle | null;
  app: App | null;
  shopDomain: string | null;
  tenantId: string | null;
  deployed: boolean;
  onDeploy: () => void;
  deploying: boolean;
}

// ─── Pipeline steps ───────────────────────────────────────────────────────────

// Fixed steps always shown, in pipeline order.
const STATIC_STEPS: { agent: string; label: string }[] = [
  { agent: "product",     label: "Understanding your request"  },
  { agent: "architect",   label: "Planning API surface"        },
  { agent: "codespec",    label: "Writing implementation plan" },
  { agent: "handler",     label: "Generating backend handler"  },
  { agent: "migration",   label: "Writing DB migration"        },
  // widget_js and admin_ui are injected dynamically below when the backend emits them
  { agent: "validation",  label: "Validating output"           },
  { agent: "explanation", label: "Preparing summary"           },
];

// Optional agents inserted dynamically when the backend emits them.
// widget_js / admin_ui go before validation; validator goes after.
const OPTIONAL_AGENTS: Record<string, string> = {
  widget_js: "Generating storefront widget",
  admin_ui:  "Generating admin panel",
  validator: "Semantic alignment check",
  revision:  "Applying revisions",
};

function buildSteps(byAgent: Record<string, ProgressEvent>) {
  const steps = [...STATIC_STEPS];
  const validationIdx = steps.findIndex((s) => s.agent === "validation");

  // widget_js / admin_ui go before validation
  const beforeValidation = ["widget_js", "admin_ui"]
    .filter((a) => a in byAgent)
    .map((a) => ({ agent: a, label: OPTIONAL_AGENTS[a] }));
  if (beforeValidation.length > 0) {
    steps.splice(validationIdx, 0, ...beforeValidation);
  }

  // validator goes after validation, revision goes after validator (both optional)
  if ("validator" in byAgent) {
    const newValidationIdx = steps.findIndex((s) => s.agent === "validation");
    steps.splice(newValidationIdx + 1, 0, { agent: "validator", label: OPTIONAL_AGENTS["validator"] });
  }
  if ("revision" in byAgent) {
    const validatorIdx = steps.findIndex((s) => s.agent === "validator");
    const insertAfter = validatorIdx !== -1 ? validatorIdx : steps.findIndex((s) => s.agent === "validation");
    steps.splice(insertAfter + 1, 0, { agent: "revision", label: OPTIONAL_AGENTS["revision"] });
  }

  return steps;
}

function stepStatus(agent: string, byAgent: Record<string, ProgressEvent>) {
  return byAgent[agent]?.status ?? "waiting";
}

// ─── Generating state ─────────────────────────────────────────────────────────

function GeneratingPanel({ events }: { events: ProgressEvent[] }) {
  const byAgent = events.reduce<Record<string, ProgressEvent>>((acc, e) => {
    acc[e.agent] = e;
    return acc;
  }, {});

  const steps = buildSteps(byAgent);

  const latestMessage = [...events].reverse().find(
    (e) => e.status === "running" || e.status === "retrying"
  )?.message;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold text-faint uppercase tracking-wider mb-4">
          Building your app
        </p>
        <div className="space-y-3.5">
          {steps.map(({ agent, label }) => {
            const status = stepStatus(agent, byAgent);
            return (
              <div key={agent} className="flex items-center gap-3">
                <div className="w-5 h-5 flex items-center justify-center shrink-0">
                  {status === "completed" && (
                    <span className="material-symbols-outlined text-teal text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                  )}
                  {status === "running" && (
                    <span className="w-2 h-2 rounded-full bg-accent animate-pulse-subtle block" />
                  )}
                  {status === "failed" && (
                    <span className="material-symbols-outlined text-danger text-[16px]">cancel</span>
                  )}
                  {status === "retrying" && (
                    <span className="material-symbols-outlined text-amber text-[16px] animate-spin">refresh</span>
                  )}
                  {!["completed", "running", "failed", "retrying"].includes(status) && (
                    <span className="w-2 h-2 rounded-full bg-white/10 block" />
                  )}
                </div>
                <span className={cn(
                  "text-[13px]",
                  status === "completed" ? "text-muted" :
                  status === "running"   ? "text-ink font-medium" :
                  status === "failed"    ? "text-danger" :
                  status === "retrying"  ? "text-amber" :
                  "text-faint"
                )}>
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {latestMessage && (
        <div className="bg-accent/5 border border-accent/10 rounded-xl px-4 py-3">
          <p className="text-[11px] text-accent animate-pulse-subtle leading-relaxed">
            {latestMessage}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Deploy gate ──────────────────────────────────────────────────────────────

function DeployPanel({
  bundle,
  app,
  onDeploy,
  deploying,
}: {
  bundle: GenerationBundle | null;
  app: App | null;
  onDeploy: () => void;
  deploying: boolean;
}) {
  const archetype = app?.appArchetype ?? "backend";
  
  // Use bundle info if available, otherwise fall back to app record
  const effectiveHasAdmin = bundle?.hasAdminUI ?? (archetype === "storefront_backend_admin" || archetype === "backend_admin");
  const effectiveHasWidget = bundle?.hasWidget ?? (archetype === "storefront_backend" || archetype === "storefront_backend_admin");

  const triggerType = bundle?.triggerType ?? "webhook";
  const topics = bundle?.triggerTopics ?? [];

  const effectiveArchetype =
    effectiveHasAdmin && effectiveHasWidget ? "storefront_backend_admin" as const :
    effectiveHasAdmin  ? "backend_admin"        as const :
    effectiveHasWidget ? "storefront_backend"   as const :
    "backend" as const;

  const triggerLabel =
    triggerType === "cron"    ? "Scheduled (cron)"  :
    triggerType === "admin"   ? "Admin-triggered"   :
    triggerType === "widget"  ? "Widget interaction" :
    topics[0] ?? "Webhook-triggered";

  // explanation may be a string (legacy) or { merchantFacing, technical } (new generator)
  const explanationText: string | null =
    typeof bundle?.explanation === "string"
      ? bundle.explanation
      : typeof bundle?.explanation === "object" && bundle?.explanation !== null
        ? ((bundle.explanation as unknown as { merchantFacing?: string }).merchantFacing ?? null)
        : null;

  return (
    <div className="space-y-5">
      {/* Summary card */}
      <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-teal text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          <span className="text-sm font-bold text-ink">Generation complete</span>
        </div>

        <div className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold text-faint uppercase tracking-wider w-14 shrink-0">Type</span>
            <ArchetypePills archetype={effectiveArchetype} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold text-faint uppercase tracking-wider w-14 shrink-0">Trigger</span>
            <span className="text-xs px-2 py-0.5 bg-teal/10 text-teal rounded-full font-mono">{triggerLabel}</span>
          </div>
        </div>

        {explanationText && (
          <p className="text-[11px] text-muted leading-relaxed pt-1 border-t border-white/[0.06]">
            {explanationText.split("\n")[0]}
          </p>
        )}
      </div>

      {/* Deploy CTA */}
      <button
        type="button"
        onClick={onDeploy}
        disabled={deploying}
        className="w-full py-3.5 bg-gradient-to-br from-accent to-accent/70 text-white rounded-xl text-sm font-bold border-0 cursor-pointer transition-all hover:opacity-90 disabled:opacity-60 flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>
          {deploying ? "hourglass_empty" : "rocket_launch"}
        </span>
        {deploying ? "Deploying…" : "Deploy to store"}
      </button>

      <p className="text-[11px] text-faint text-center leading-relaxed">
        Activates the handler and {effectiveHasWidget ? "injects the widget into your theme" : "registers webhook subscriptions"}.
      </p>
    </div>
  );
}

// ─── Live panel (post-deploy) ─────────────────────────────────────────────────

/** Realistic Shopify webhook payloads keyed by topic. */
const WEBHOOK_PAYLOADS: Record<string, Record<string, unknown>> = {
  "orders/create": { id: 820982911, email: "customer@example.com", total_price: "199.65", currency: "USD", financial_status: "pending", fulfillment_status: null, line_items: [{ id: 866550311, title: "Sample Product", quantity: 1, price: "199.00", sku: "SKU-001", variant_id: 808950810, product_id: 632910392 }], customer: { id: 207119551, email: "customer@example.com", first_name: "Jane", last_name: "Doe" }, shipping_address: { first_name: "Jane", last_name: "Doe", address1: "123 Main St", city: "Toronto", province: "Ontario", country: "Canada", zip: "M1M 1M1" }, created_at: "2024-01-15T12:00:00-05:00" },
  "orders/updated": { id: 820982911, email: "customer@example.com", total_price: "199.65", financial_status: "paid", fulfillment_status: null, updated_at: "2024-01-15T13:00:00-05:00" },
  "orders/cancelled": { id: 820982911, email: "customer@example.com", total_price: "199.65", cancel_reason: "customer", cancelled_at: "2024-01-15T14:00:00-05:00" },
  "orders/paid": { id: 820982911, email: "customer@example.com", total_price: "199.65", financial_status: "paid", transactions: [{ id: 1068278461, amount: "199.65", kind: "sale", status: "success" }] },
  "orders/fulfilled": { id: 820982911, email: "customer@example.com", fulfillment_status: "fulfilled", fulfillments: [{ id: 255858046, status: "success", tracking_company: "UPS", tracking_number: "1Z001985ZY58723423" }] },
  "orders/partially_fulfilled": { id: 820982911, email: "customer@example.com", fulfillment_status: "partial", fulfillments: [{ id: 255858046, status: "success", line_items: [{ id: 866550311, quantity: 1 }] }] },
  "products/create": { id: 632910392, title: "Sample Product", status: "active", variants: [{ id: 808950810, title: "Default Title", price: "199.00", sku: "SKU-001", inventory_quantity: 10 }], created_at: "2024-01-15T12:00:00-05:00" },
  "products/update": { id: 632910392, title: "Sample Product", status: "active", variants: [{ id: 808950810, title: "Default Title", price: "199.00", sku: "SKU-001", inventory_quantity: 8 }], updated_at: "2024-01-15T13:00:00-05:00" },
  "products/delete": { id: 632910392 },
  "customers/create": { id: 207119551, email: "customer@example.com", first_name: "Jane", last_name: "Doe", orders_count: 0, total_spent: "0.00", state: "enabled", created_at: "2024-01-15T12:00:00-05:00" },
  "customers/update": { id: 207119551, email: "customer@example.com", first_name: "Jane", last_name: "Doe", orders_count: 3, total_spent: "598.95", state: "enabled", updated_at: "2024-01-15T13:00:00-05:00" },
  "customers/delete": { id: 207119551 },
  "customers/enable": { id: 207119551, email: "customer@example.com", first_name: "Jane", last_name: "Doe", state: "enabled" },
  "customers/disable": { id: 207119551, email: "customer@example.com", first_name: "Jane", last_name: "Doe", state: "disabled" },
  "inventory_levels/update": { inventory_item_id: 808950810, location_id: 655441491, available: 6, updated_at: "2024-01-15T13:00:00-05:00", admin_graphql_api_id: "gid://shopify/InventoryLevel/655441491?inventory_item_id=808950810" },
  "inventory_levels/connect": { inventory_item_id: 808950810, location_id: 655441491, available: 10 },
  "inventory_levels/disconnect": { inventory_item_id: 808950810, location_id: 655441491 },
  "inventory_items/create": { id: 808950810, sku: "SKU-001", tracked: true, created_at: "2024-01-15T12:00:00-05:00" },
  "inventory_items/update": { id: 808950810, sku: "SKU-001", tracked: true, cost: "120.00", updated_at: "2024-01-15T13:00:00-05:00" },
  "inventory_items/delete": { id: 808950810 },
  "collections/create": { id: 841564295, title: "Summer Collection", handle: "summer-collection", published: true, created_at: "2024-01-15T12:00:00-05:00" },
  "collections/update": { id: 841564295, title: "Summer Collection", handle: "summer-collection", published: true, updated_at: "2024-01-15T13:00:00-05:00" },
  "collections/delete": { id: 841564295 },
  "fulfillments/create": { id: 255858046, order_id: 820982911, status: "pending", tracking_company: "UPS", tracking_number: "1Z001985ZY58723423", line_items: [{ id: 466157049, title: "Sample Product", quantity: 1 }], created_at: "2024-01-15T12:00:00-05:00" },
  "fulfillments/update": { id: 255858046, order_id: 820982911, status: "success", tracking_company: "UPS", tracking_number: "1Z001985ZY58723423", updated_at: "2024-01-15T13:00:00-05:00" },
  "refunds/create": { id: 509562969, order_id: 820982911, note: "Item returned by customer", refund_line_items: [{ id: 104689539, quantity: 1, subtotal: "199.00" }], transactions: [{ id: 1068278461, amount: "199.00", kind: "refund", status: "success" }], created_at: "2024-01-15T12:00:00-05:00" },
  "draft_orders/create": { id: 72885271, status: "open", email: "customer@example.com", total_price: "199.65", line_items: [{ title: "Sample Product", quantity: 1, price: "199.00" }], created_at: "2024-01-15T12:00:00-05:00" },
  "draft_orders/update": { id: 72885271, status: "open", email: "customer@example.com", total_price: "199.65", updated_at: "2024-01-15T13:00:00-05:00" },
  "checkouts/create": { id: 450789469, token: "2a1ace52255252df566af0fafc39b3c2", email: "customer@example.com", total_price: "199.65", line_items: [{ title: "Sample Product", quantity: 1, price: "199.00" }], created_at: "2024-01-15T12:00:00-05:00" },
  "checkouts/update": { id: 450789469, token: "2a1ace52255252df566af0fafc39b3c2", email: "customer@example.com", total_price: "199.65", completed_at: null, updated_at: "2024-01-15T13:00:00-05:00" },
  "checkouts/delete": { id: 450789469, token: "2a1ace52255252df566af0fafc39b3c2" },
  "carts/create": { id: "539e1c1eab6e52a591e0b6c13c96b56a", token: "539e1c1eab6e52a591e0b6c13c96b56a", line_items: [{ variant_id: 808950810, quantity: 1, title: "Sample Product", price: "199.00" }], created_at: "2024-01-15T12:00:00-05:00" },
  "carts/update": { id: "539e1c1eab6e52a591e0b6c13c96b56a", token: "539e1c1eab6e52a591e0b6c13c96b56a", line_items: [{ variant_id: 808950810, quantity: 2, title: "Sample Product", price: "199.00" }], updated_at: "2024-01-15T13:00:00-05:00" },
  "app/uninstalled": { id: 1234567, domain: "shop.myshopify.com", name: "My Store" },
};

/** Build a realistic test payload for a given webhook topic or trigger type. */
function defaultPayload(triggerType: string, topics: string[]): Record<string, unknown> {
  for (const topic of topics) {
    if (topic in WEBHOOK_PAYLOADS) return WEBHOOK_PAYLOADS[topic];
  }
  if (triggerType === "cron") return { scheduled_at: "2024-01-15T12:00:00-05:00", run_id: "cron_test_001" };
  if (triggerType === "admin" || triggerType === "widget") return { action: "test", value: "example" };
  return { test: true };
}

function LivePanel({
  bundle,
  app,
  shopDomain,
}: {
  bundle: GenerationBundle | null;
  app: App | null;
  shopDomain: string | null;
}) {
  const navigate = useNavigate();
  const [triggerState, setTriggerState] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [triggerOut, setTriggerOut] = useState<string | null>(null);
  const [payloadJson, setPayloadJson] = useState<string>(() =>
    JSON.stringify(defaultPayload(bundle?.triggerType ?? "webhook", bundle?.triggerTopics ?? []), null, 2)
  );
  const [payloadError, setPayloadError] = useState<string | null>(null);

  const canTrigger =
    !!shopDomain &&
    !!app?.id &&
    (bundle?.triggerType === "admin" || bundle?.triggerType === "cron" || bundle?.triggerType === "widget");

  const handleTrigger = async () => {
    if (!shopDomain || !app?.id) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payloadJson) as Record<string, unknown>;
      setPayloadError(null);
    } catch {
      setPayloadError("Invalid JSON — fix the payload before firing.");
      return;
    }
    setTriggerState("loading");
    setTriggerOut(null);
    try {
      const res = await api.widgets.trigger(shopDomain, app.id, parsed);
      setTriggerState("ok");
      setTriggerOut(JSON.stringify(res, null, 2));
    } catch (err) {
      setTriggerState("err");
      setTriggerOut(err instanceof Error ? err.message : "Trigger failed");
    }
  };

  return (
    <div className="space-y-4">

      {/* ── Live status ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 p-3.5 bg-teal/8 border border-teal/15 rounded-xl">
        <span className="w-2 h-2 rounded-full bg-teal shrink-0 animate-pulse" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-teal">App is live</p>
          <p className="text-[11px] text-muted mt-0.5">Describe what's wrong in the chat to revise.</p>
        </div>
      </div>

      {/* ── View App Details ────────────────────────────────────────────── */}
      {app?.id && (
        <button
          type="button"
          onClick={() => navigate(`/app/apps/${app.id}`)}
          className="w-full flex items-center justify-between px-4 py-3 bg-white/[0.04] border border-white/[0.08] rounded-xl text-[13px] font-semibold text-muted hover:bg-white/[0.07] hover:text-ink transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-[16px]">dashboard</span>
            <span>View App Details</span>
          </div>
          <span className="material-symbols-outlined text-[14px] text-faint">arrow_forward</span>
        </button>
      )}

      {/* ── Test trigger (cron / admin / widget apps only) ──────────────── */}
      {canTrigger && (
        <section>
          <p className="text-[10px] font-bold text-faint uppercase tracking-wider mb-2">Test event</p>
          <div className="space-y-2">
            <textarea
              value={payloadJson}
              onChange={(e) => { setPayloadJson(e.target.value); setPayloadError(null); }}
              spellCheck={false}
              rows={5}
              className={cn(
                "w-full font-mono text-[11px] bg-raised border rounded-lg px-3 py-2.5 text-ink resize-none outline-none leading-relaxed",
                payloadError ? "border-danger/50 focus:border-danger" : "border-white/[0.08] focus:border-accent/50"
              )}
            />
            {payloadError && <p className="text-[10px] text-danger">{payloadError}</p>}
            <button
              type="button"
              onClick={handleTrigger}
              disabled={triggerState === "loading"}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-teal/12 text-teal text-[12px] font-bold border-0 cursor-pointer hover:bg-teal/20 transition-colors disabled:opacity-60"
            >
              <span className="material-symbols-outlined text-[14px]">
                {triggerState === "loading" ? "hourglass_empty" : "play_arrow"}
              </span>
              {triggerState === "loading" ? "Firing…" : "Fire test event"}
            </button>
            {triggerOut && (
              <pre className={cn(
                "p-3 rounded-lg font-mono text-[10px] leading-relaxed overflow-x-auto",
                triggerState === "ok" ? "bg-teal/8 text-teal" : "bg-danger/8 text-danger"
              )}>
                {triggerOut}
              </pre>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function AppTestingPanel({
  gen,
  bundle,
  app,
  shopDomain,
  tenantId,
  deployed,
  onDeploy,
  deploying,
}: AppTestingPanelProps) {

  const headerStatus = deployed
    ? { label: "Live", cls: "bg-teal/15 text-teal" }
    : gen.status === "completed"
      ? { label: "Ready", cls: "bg-accent/15 text-accent" }
      : gen.status === "running"
        ? { label: "Generating", cls: "bg-accent/10 text-accent" }
        : null;

  return (
    <div className="w-[360px] min-w-[360px] flex flex-col bg-surface border-l border-white/[0.07]">

      {/* Header */}
      <div className="px-5 py-4 border-b border-white/[0.07] shrink-0 flex items-center justify-between">
        <span className="text-[13px] font-bold text-ink truncate pr-2">
          {app?.name ?? "App panel"}
        </span>
        {headerStatus && (
          <span className={cn("text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide shrink-0", headerStatus.cls)}>
            {headerStatus.label}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5">

        {/* Idle */}
        {gen.status === "idle" && (
          <div className="flex flex-col items-center justify-center h-full gap-4 py-16 text-center">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
              <span className="material-symbols-outlined text-faint text-[24px]">rocket_launch</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-faint">Your app will appear here</p>
              <p className="text-[11px] text-faint mt-1 opacity-60">Start by describing what you want to build.</p>
            </div>
          </div>
        )}

        {/* Generating */}
        {gen.status === "running" && (
          <GeneratingPanel events={gen.events} />
        )}

        {/* Ready to deploy */}
        {gen.status === "completed" && !deployed && (
          <DeployPanel bundle={bundle} app={app} onDeploy={onDeploy} deploying={deploying} />
        )}

        {/* Failed */}
        {gen.status === "failed" && !deployed && (
          <div className="flex flex-col items-center justify-center h-full gap-4 py-16 text-center px-6">
            {gen.completedEvent?.errorCode === "platform_limitation" ? (
              <>
                <span className="material-symbols-outlined text-amber text-[32px]">build_circle</span>
                <div>
                  <p className="text-sm font-semibold text-ink">Not supported yet</p>
                  <p className="text-[12px] text-muted mt-1 max-w-[280px]">
                    {gen.completedEvent.error ?? "This app type requires a capability that isn't available on the platform yet."}
                  </p>
                  <p className="text-[11px] text-faint mt-2">Try describing a different version of your idea in the chat.</p>
                </div>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-danger text-[32px]">error</span>
                <div>
                  <p className="text-sm font-semibold text-danger">Generation failed</p>
                  <p className="text-[11px] text-faint mt-1">Describe what went wrong in the chat to try again.</p>
                </div>
              </>
            )}
          </div>
        )}

        {/* Live / deployed */}
        {deployed && (
          <LivePanel
            bundle={bundle}
            app={app}
            shopDomain={shopDomain}
          />
        )}
      </div>
    </div>
  );
}
