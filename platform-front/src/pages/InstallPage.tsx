import { useState, useRef } from "react";
import { useNavigate } from "react-router";
import { useSessionStore } from "@/stores/session";

const INSTALL_URL = "/api/oauth/install";

function normalizeShop(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!trimmed) return null;
  if (trimmed.endsWith(".myshopify.com")) return trimmed;
  if (/^[a-z0-9-]+$/.test(trimmed)) return `${trimmed}.myshopify.com`;
  return null;
}

export function InstallPage() {
  const navigate = useNavigate();
  const { shopDomain } = useSessionStore();

  const [shop, setShop] = useState(shopDomain ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleInstall = () => {
    const normalized = normalizeShop(shop);
    if (!normalized) {
      setError("Enter a valid Shopify store URL — e.g. my-store.myshopify.com");
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
    <div className="min-h-screen bg-base text-ink flex flex-col">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-8 h-16 border-b border-white/[0.06]">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="flex items-center gap-2 text-faint hover:text-ink transition-colors bg-transparent border-0 cursor-pointer text-sm"
        >
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          Back
        </button>
        <span className="text-base font-bold text-accent">NewOneTwo</span>
        <div className="w-16" /> {/* spacer */}
      </header>

      {/* ── Install card ──────────────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md space-y-8">

          {/* Icon + headline */}
          <div className="text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent to-teal mx-auto flex items-center justify-center">
              <span
                className="material-symbols-outlined text-white text-[32px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                store
              </span>
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-ink tracking-tight">
                Connect your store
              </h1>
              <p className="text-muted text-sm leading-relaxed">
                You'll be redirected to Shopify to approve access.
                <br />
                Takes about 30 seconds.
              </p>
            </div>
          </div>

          {/* Form card */}
          <div className="bg-surface border border-white/[0.08] rounded-2xl p-7 space-y-5">
            <div>
              <label
                htmlFor="shop-input"
                className="block text-sm font-semibold text-ink mb-1.5"
              >
                Shopify store URL
              </label>
              <p className="text-[11px] text-faint mb-4">
                Your store's unique Shopify address
              </p>

              <div className="relative">
                <input
                  ref={inputRef}
                  id="shop-input"
                  type="text"
                  value={shop}
                  onChange={(e) => {
                    setShop(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={handleKey}
                  placeholder="my-store.myshopify.com"
                  autoFocus
                  className="w-full bg-raised border border-white/[0.12] rounded-xl px-4 py-3.5 text-sm text-ink placeholder:text-faint outline-none focus:border-accent transition-colors font-mono"
                />
                {shop && (
                  <button
                    type="button"
                    onClick={() => setShop("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-muted text-xs bg-transparent border-0 cursor-pointer w-5 h-5 flex items-center justify-center"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                )}
              </div>

              {error && (
                <p className="text-[11px] text-danger mt-2">{error}</p>
              )}
            </div>

            <button
              type="button"
              onClick={handleInstall}
              className="kinetic-btn w-full py-3.5 bg-gradient-to-br from-accent to-accent/70 text-white rounded-xl text-sm font-bold border-0 cursor-pointer transition-all duration-300 flex items-center justify-center gap-2"
            >
              <span
                className="material-symbols-outlined text-[18px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                shopping_bag
              </span>
              Connect with Shopify
            </button>

            <p className="text-[11px] text-faint text-center">
              No credit card required · Free plan available · Disconnect anytime
            </p>
          </div>

          {/* What happens next */}
          <div className="space-y-3">
            <p className="text-[11px] text-faint uppercase tracking-widest font-semibold text-center">
              What happens next
            </p>
            <div className="space-y-2.5">
              {[
                { icon: "lock", text: "Shopify asks you to approve read/write permissions" },
                { icon: "check_circle", text: "We create your workspace — no data collected yet" },
                { icon: "rocket_launch", text: "You land in your dashboard, ready to generate" },
              ].map((step, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                    <span
                      className="material-symbols-outlined text-accent text-[14px]"
                      style={{ fontVariationSettings: "'FILL' 1" }}
                    >
                      {step.icon}
                    </span>
                  </div>
                  <p className="text-sm text-muted">{step.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
