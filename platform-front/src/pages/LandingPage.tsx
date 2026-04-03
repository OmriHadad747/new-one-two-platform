import { useNavigate } from "react-router";
import { useSessionStore } from "@/stores/session";

const FEATURES = [
  {
    icon: "precision_manufacturing",
    iconColor: "text-accent",
    iconBg: "bg-accent/10",
    accentBar: "bg-accent",
    title: "Prompt to widget",
    desc: "Describe a feature in plain English — New One Two generates the widget, backend handler, and DB migration.",
  },
  {
    icon: "dashboard_customize",
    iconColor: "text-teal",
    iconBg: "bg-teal/10",
    accentBar: "bg-teal",
    title: "One dashboard",
    desc: "All your custom apps in one place. No tab-switching, no separate accounts.",
  },
  {
    icon: "integration_instructions",
    iconColor: "text-amber",
    iconBg: "bg-amber/10",
    accentBar: "bg-amber",
    title: "Native to your store",
    desc: "Apps deploy directly into your Shopify theme — no iframe, no lag, no bloat.",
  },
];

const LOG_LINES = [
  { ts: "08:24:12", color: "text-accent", msg: "Parsing requirements..." },
  { ts: "08:24:13", color: "text-accent", msg: 'Context: "Luxury Apparel Theme"' },
  { ts: "08:24:15", color: "text-teal", msg: "Generating widget + handler..." },
  { ts: "08:24:18", color: "text-teal", msg: "Injecting into Shopify Storefront..." },
  { ts: "08:24:20", color: "text-[#4ade80]", msg: "DEPLOYED — LIVE IN STORE ✓" },
];

export function LandingPage() {
  const navigate = useNavigate();
  const { tenantId, shopDomain } = useSessionStore();
  const isConnected = Boolean(tenantId);

  return (
    <div className="min-h-screen bg-base text-ink overflow-x-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-8 h-16 bg-base/80 backdrop-blur-xl border-b border-white/[0.06]">
        <div className="flex items-center gap-6">
          <span className="text-xl font-bold tracking-tighter text-accent">NewOneTwo</span>
          {isConnected && shopDomain && (
            <span className="text-sm text-faint border-l border-white/[0.1] pl-6">
              {shopDomain}
            </span>
          )}
        </div>
        {isConnected ? (
          <button
            type="button"
            onClick={() => navigate("/app")}
            className="kinetic-btn bg-accent text-white px-5 py-1.5 rounded-full font-bold text-sm transition-all duration-200 border-0 cursor-pointer"
          >
            Open Dashboard →
          </button>
        ) : (
          <button
            type="button"
            onClick={() => navigate("/install")}
            className="bg-accent/10 border border-accent/30 text-accent px-5 py-1.5 rounded-full font-bold text-sm hover:bg-accent/20 transition-colors border-0 cursor-pointer"
          >
            Get Started
          </button>
        )}
      </header>

      {/* ── Main ───────────────────────────────────────────────────────────── */}
      <main className="pt-24 px-8 max-w-6xl mx-auto">

        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <section className="flex flex-col lg:flex-row items-center gap-16 py-20 relative">
          <div className="hero-glow -top-24 -left-24" />

          {/* Left */}
          <div className="w-full lg:w-1/2 space-y-7 z-10">
            <span className="inline-flex items-center gap-2 px-3 py-1 bg-accent/10 border border-accent/20 rounded-full text-[11px] font-semibold text-teal tracking-widest uppercase">
              <span className="w-1.5 h-1.5 rounded-full bg-teal animate-pulse-subtle" />
              AI-Powered Shopify Apps
            </span>

            <h1 className="text-5xl md:text-[68px] font-bold text-ink leading-[0.95] tracking-tight">
              Build any Shopify feature
              <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-accent to-teal">
                from a single prompt.
              </span>
            </h1>

            <p className="text-muted text-lg leading-relaxed max-w-md">
              Describe what you want. New One Two generates the widget, backend handler,
              and database migration — then deploys it to your store.
            </p>

            <button
              type="button"
              onClick={() => navigate(isConnected ? "/app" : "/install")}
              className="kinetic-btn bg-gradient-to-br from-accent to-accent/70 text-white px-8 py-4 rounded-lg font-bold text-base flex items-center gap-2 transition-all duration-300 border-0 cursor-pointer"
            >
              {isConnected ? "Open Dashboard" : "Install on Shopify"}
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
          </div>

          {/* Right — terminal mockup */}
          <div className="w-full lg:w-1/2 z-10">
            <div className="glass-card rounded-xl shadow-2xl overflow-hidden">
              {/* Window chrome */}
              <div className="flex items-center justify-between px-4 py-3 bg-elevated/60 border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-danger/60" />
                  <div className="w-2.5 h-2.5 rounded-full bg-amber/60" />
                  <div className="w-2.5 h-2.5 rounded-full bg-teal/60" />
                </div>
                <span className="text-[11px] text-faint font-mono">new-one-two</span>
                <span className="material-symbols-outlined text-teal text-[16px]">terminal</span>
              </div>

              {/* Chat */}
              <div className="p-5 space-y-4 bg-base/60">
                <div className="flex justify-end">
                  <div className="bg-accent/15 border border-accent/20 rounded-lg rounded-tr-sm px-4 py-3 max-w-[80%]">
                    <p className="text-sm text-ink leading-relaxed">
                      "Build a back-in-stock notifier with email capture for my luxury apparel store."
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-teal flex items-center justify-center text-[11px] font-extrabold text-white shrink-0">
                    N
                  </div>
                  <div className="bg-surface/80 border border-white/[0.06] rounded-lg rounded-tl-sm px-4 py-3 flex-1">
                    <p className="text-sm text-ink mb-3">On it — generating your widget...</p>
                    <div className="bg-base rounded-lg p-3 font-mono text-[10px] space-y-1.5">
                      {LOG_LINES.map((line) => (
                        <p key={line.ts} className="flex gap-3">
                          <span className={line.color}>[{line.ts}]</span>
                          <span className="text-muted">{line.msg}</span>
                        </p>
                      ))}
                      <p className="flex gap-3 items-center">
                        <span className="text-faint">[08:24:21]</span>
                        <span className="text-faint">Awaiting your approval</span>
                        <span className="animate-blink text-accent ml-1">▌</span>
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Input */}
              <div className="px-4 py-3 bg-surface/60 border-t border-white/[0.06] flex items-center gap-3">
                <div className="flex-1 bg-base/80 border border-white/10 rounded-lg px-3 py-2 text-[12px] text-faint font-mono">
                  Describe your next feature...
                </div>
                <div className="w-8 h-8 rounded-lg bg-accent/15 flex items-center justify-center text-accent shrink-0">
                  <span className="material-symbols-outlined text-[16px]">send</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Features ─────────────────────────────────────────────────────── */}
        <section className="py-16 border-t border-white/[0.06]">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="bg-surface relative overflow-hidden group rounded-xl p-7 flex flex-col gap-5 border border-white/[0.06] hover:border-white/[0.12] transition-colors"
              >
                <div className={`absolute left-0 top-0 w-[3px] h-full ${f.accentBar} opacity-50 group-hover:opacity-100 transition-opacity`} />
                <div className={`w-10 h-10 rounded-lg ${f.iconBg} flex items-center justify-center ${f.iconColor}`}>
                  <span className="material-symbols-outlined text-[22px]">{f.icon}</span>
                </div>
                <div>
                  <h3 className="font-bold text-ink mb-1.5">{f.title}</h3>
                  <p className="text-muted text-sm leading-relaxed">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── CTA ──────────────────────────────────────────────────────────── */}
        <section className="py-20 text-center">
          <button
            type="button"
            onClick={() => navigate(isConnected ? "/app" : "/install")}
            className="kinetic-btn bg-gradient-to-br from-accent to-accent/70 text-white px-12 py-4 rounded-lg font-bold text-lg transition-all duration-300 inline-flex items-center gap-3 border-0 cursor-pointer"
          >
            {isConnected ? "Open Dashboard" : "Get Started Free"}
            <span className="material-symbols-outlined text-[20px]">arrow_forward</span>
          </button>
          <p className="text-faint text-sm mt-4">No credit card required</p>
        </section>
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.06] py-8 px-8">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
          <span className="text-sm font-bold text-accent">NewOneTwo</span>
          <div className="flex gap-6">
            {["Privacy", "Terms", "Support"].map((item) => (
              <a key={item} href="#" className="text-[11px] uppercase tracking-widest text-faint hover:text-ink transition-colors no-underline">
                {item}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
