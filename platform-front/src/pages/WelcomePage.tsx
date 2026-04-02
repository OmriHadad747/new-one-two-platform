import { useState, useRef } from "react";
import { TopBar } from "@/components/layout/TopBar";

const INSTALL_URL = "/api/oauth/install";

function normalizeShop(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!trimmed) return null;
  // Already has the suffix
  if (trimmed.endsWith(".myshopify.com")) return trimmed;
  // Looks like a bare subdomain
  if (/^[a-z0-9-]+$/.test(trimmed)) return `${trimmed}.myshopify.com`;
  return null;
}

export function WelcomePage() {
  const [shop, setShop] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleInstall = () => {
    const normalized = normalizeShop(shop);
    if (!normalized) {
      setError("Enter a valid Shopify store URL, e.g. my-store.myshopify.com");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    window.location.href = `${INSTALL_URL}?shop=${encodeURIComponent(normalized)}`;
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleInstall();
  };

  return (
    <>
      <TopBar title="Welcome" />
      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Hero */}
        <div className="flex-1 flex flex-col items-center justify-center px-6 py-16">
          {/* Badge */}
          <div className="flex items-center gap-2 px-3 py-1 bg-accent/10 border border-accent/20 rounded-full mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-subtle" />
            <span className="text-[11px] font-semibold text-accent tracking-wide uppercase">
              AI-Powered Shopify Apps
            </span>
          </div>

          {/* Headline */}
          <h1 className="text-[44px] font-extrabold text-ink text-center tracking-tight leading-[1.1] mb-5 max-w-2xl">
            Build any Shopify feature
            <br />
            <span className="text-accent">from a single prompt.</span>
          </h1>

          <p className="text-base text-muted text-center max-w-md leading-relaxed mb-12">
            Describe what you want in plain English. New One Two generates the widget,
            backend handler, and database migration — then deploys it to your store.
          </p>

          {/* Install card */}
          <div className="w-full max-w-md bg-surface border border-white/7 rounded-2xl p-7">
            <div className="text-sm font-bold text-ink mb-1">Connect your Shopify store</div>
            <div className="text-xs text-faint mb-5">
              You'll be redirected to Shopify to approve access. Takes 30 seconds.
            </div>

            <div className="relative mb-3">
              <input
                ref={inputRef}
                type="text"
                value={shop}
                onChange={(e) => { setShop(e.target.value); setError(null); }}
                onKeyDown={handleKey}
                placeholder="my-store.myshopify.com"
                className="w-full bg-raised border border-white/13 rounded-xl px-4 py-3 text-sm text-ink placeholder:text-faint outline-none focus:border-accent transition-colors font-mono"
              />
              {shop && (
                <button
                  type="button"
                  onClick={() => setShop("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-muted text-xs bg-transparent border-0 cursor-pointer"
                >
                  ✕
                </button>
              )}
            </div>

            {error && (
              <p className="text-[11px] text-danger mb-3">{error}</p>
            )}

            <button
              type="button"
              onClick={handleInstall}
              className="w-full py-3 bg-accent text-white rounded-xl text-sm font-bold border-0 cursor-pointer hover:bg-accent-hi active:scale-[0.99] transition-all"
            >
              Install on Shopify →
            </button>

            <p className="text-[11px] text-faint text-center mt-4">
              No credit card required · Free plan available
            </p>
          </div>

          {/* Feature pills */}
          <div className="flex flex-wrap gap-3 justify-center mt-10 max-w-lg">
            {[
              { icon: "🔔", label: "Back in Stock Alerts" },
              { icon: "⚡", label: "Cart Upsells" },
              { icon: "⭐", label: "Review Collectors" },
              { icon: "✉️", label: "Order Emails" },
              { icon: "📦", label: "Inventory Automation" },
              { icon: "💬", label: "& 16 more app types" },
            ].map((f) => (
              <div
                key={f.label}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.03] border border-white/7 rounded-full text-[12px] text-muted"
              >
                <span>{f.icon}</span>
                <span>{f.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
