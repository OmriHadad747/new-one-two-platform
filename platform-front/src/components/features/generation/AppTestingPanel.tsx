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

// Optional codegen agents inserted between migration and validation when present.
const OPTIONAL_AGENTS: Record<string, string> = {
  widget_js: "Generating storefront widget",
  admin_ui:  "Generating admin panel",
};

function buildSteps(byAgent: Record<string, ProgressEvent>) {
  const steps = [...STATIC_STEPS];
  const validationIdx = steps.findIndex((s) => s.agent === "validation");
  const toInsert = Object.entries(OPTIONAL_AGENTS)
    .filter(([agent]) => agent in byAgent)
    .map(([agent, label]) => ({ agent, label }));
  if (toInsert.length > 0) {
    steps.splice(validationIdx, 0, ...toInsert);
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

/** Build a sensible default payload for a given webhook topic or trigger type. */
function defaultPayload(triggerType: string, topics: string[]): Record<string, unknown> {
  const topic = topics[0] ?? "";
  if (topic.startsWith("orders/")) return { id: 1001, email: "customer@example.com", total_price: "49.99", line_items: [{ title: "Example Product", quantity: 1 }] };
  if (topic.startsWith("products/")) return { id: 2001, title: "Example Product", status: "active" };
  if (topic.startsWith("customers/")) return { id: 3001, email: "customer@example.com", first_name: "Jane", last_name: "Doe" };
  if (triggerType === "cron") return { scheduled_at: new Date().toISOString() };
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

  const hasWidget = bundle?.hasWidget ?? (app?.appArchetype === "storefront_backend" || app?.appArchetype === "storefront_backend_admin");
  const storeFrontUrl = shopDomain ? `https://${shopDomain}` : null;
  const themeEditorUrl = shopDomain ? `https://${shopDomain}/admin/themes/current/editor` : null;
  const adminUrl = shopDomain ? `https://${shopDomain}/admin/apps` : null;

  const triggerTopics = bundle?.triggerTopics ?? [];
  const topicHint = triggerTopics.length > 0 ? `(${triggerTopics[0]})` : "in Shopify";

  const explanationText: string | null =
    typeof bundle?.explanation === "string"
      ? bundle.explanation
      : typeof bundle?.explanation === "object" && bundle?.explanation !== null
        ? ((bundle.explanation as unknown as { merchantFacing?: string }).merchantFacing ?? null)
        : null;

  const validateSteps = explanationText
    ? explanationText.split(/\n+/).filter(Boolean)
    : hasWidget
      ? [
          "Open your store and navigate to a product page.",
          "The widget should appear — interact with it.",
          "Something wrong? Describe it in the chat to revise.",
        ]
      : [
          `Trigger a real event ${topicHint} — e.g. create a test order.`,
          "Verify the expected action occurred in your store.",
          "Something wrong? Describe it in the chat to revise.",
        ];

  return (
    <div className="space-y-7">

      {/* ── Validate ───────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3.5">
          <span className="material-symbols-outlined text-accent text-[16px]">checklist</span>
          <span className="text-[11px] font-bold text-ink uppercase tracking-wider">Validate</span>
        </div>
        <ol className="space-y-3">
          {validateSteps.map((step, i) => (
            <li key={i} className="flex gap-3 text-[13px] text-muted leading-relaxed">
              <span className="w-5 h-5 rounded-full bg-accent/12 flex items-center justify-center text-accent text-[10px] font-bold shrink-0 mt-0.5">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {canTrigger && (
          <div className="mt-4 space-y-2">
            {/* Editable payload */}
            <div>
              <label className="text-[10px] font-semibold text-faint uppercase tracking-wider block mb-1.5">
                Event payload
              </label>
              <textarea
                value={payloadJson}
                onChange={(e) => { setPayloadJson(e.target.value); setPayloadError(null); }}
                spellCheck={false}
                rows={6}
                className={cn(
                  "w-full font-mono text-[11px] bg-raised border rounded-lg px-3 py-2.5 text-ink resize-none outline-none leading-relaxed",
                  payloadError ? "border-danger/50 focus:border-danger" : "border-white/[0.08] focus:border-accent/50"
                )}
              />
              {payloadError && (
                <p className="text-[10px] text-danger mt-1">{payloadError}</p>
              )}
            </div>

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
        )}
      </section>

      {/* ── Logs link ──────────────────────────────────────────────────── */}
      {app?.id && (
        <section>
          <button
            type="button"
            onClick={() => navigate(`/app/apps/${app.id}`)}
            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.07] rounded-lg text-muted text-[12px] font-semibold hover:bg-white/[0.06] hover:text-ink transition-colors border-0 cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[15px]">terminal</span>
              <span>View logs</span>
            </div>
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </button>
        </section>
      )}

      {/* ── Open in Shopify ─────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3.5">
          <span className="material-symbols-outlined text-faint text-[16px]">open_in_new</span>
          <span className="text-[11px] font-bold text-ink uppercase tracking-wider">Open in Shopify</span>
        </div>

        <div className="space-y-2">
          {hasWidget && storeFrontUrl && (
            <a
              href={storeFrontUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between px-3.5 py-2.5 bg-teal/8 border border-teal/15 rounded-lg text-teal text-[12px] font-semibold hover:bg-teal/15 transition-colors no-underline"
            >
              <span>View storefront</span>
              <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
            </a>
          )}
          {hasWidget && themeEditorUrl && (
            <div className="space-y-1.5">
              <a
                href={themeEditorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.07] rounded-lg text-muted text-[12px] font-semibold hover:bg-white/[0.06] transition-colors no-underline"
              >
                <span>Theme editor — add app block</span>
                <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
              </a>
              {app?.id && (
                <p className="text-[10px] text-faint px-1 leading-relaxed">
                  In the theme editor: Apps → Browse apps → find the block, then set{" "}
                  <span className="font-mono bg-white/[0.05] px-1 py-0.5 rounded text-faint/80">App ID</span>{" "}
                  to{" "}
                  <span
                    className="font-mono bg-white/[0.05] px-1 py-0.5 rounded text-accent/80 cursor-pointer select-all"
                    title="Click to copy"
                    onClick={() => navigator.clipboard.writeText(app.id)}
                  >
                    {app.id}
                  </span>
                </p>
              )}
            </div>
          )}
          {adminUrl && (
            <a
              href={adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.07] rounded-lg text-muted text-[12px] font-semibold hover:bg-white/[0.06] transition-colors no-underline"
            >
              <span>Shopify Admin — Apps</span>
              <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
            </a>
          )}
        </div>
      </section>
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
