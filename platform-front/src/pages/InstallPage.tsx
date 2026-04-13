import { useState, useRef } from "react";
import { useNavigate } from "react-router";
import { useSessionStore } from "@/stores/session";

const INSTALL_URL = "/api/oauth/install";

function prefixFromDomain(domain: string | null): string {
  if (!domain) return "";
  return domain.replace(/\.myshopify\.com$/, "");
}

export function InstallPage() {
  const navigate = useNavigate();
  const { shopDomain } = useSessionStore();

  const [prefix, setPrefix] = useState(prefixFromDomain(shopDomain));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleInstall = () => {
    const clean = prefix.trim().toLowerCase().replace(/\s+/g, "-");
    if (!clean || !/^[a-z0-9-]+$/.test(clean)) {
      setError("Store name can only contain letters, numbers, and hyphens");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setLoading(true);
    window.location.href = `${INSTALL_URL}?shop=${encodeURIComponent(`${clean}.myshopify.com`)}`;
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleInstall();
  };

  return (
    <div className="min-h-screen bg-base text-ink flex flex-col">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-8 h-16 border-b border-white/[0.06]">
        <div className="flex items-center gap-6">
          <span className="text-xl font-bold tracking-tighter text-accent">New One Two</span>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-faint hover:text-ink transition-colors bg-transparent border-0 cursor-pointer text-sm border-l border-white/[0.1] pl-6"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            Back
          </button>
        </div>
        <div className="w-16" />
      </header>

      {/* ── Install card ──────────────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md space-y-8">

          {/* Connection header */}
          <div className="text-center space-y-6">
            <div className="flex items-center justify-center gap-5">
              {/* App logo */}
              <div className="flex flex-col items-center gap-1.5">
                <div className="w-14 h-14 bg-elevated rounded-xl flex items-center justify-center" style={{ boxShadow: "0 0 20px rgba(167,139,250,0.1)" }}>
                  <span className="font-bold text-accent text-xl tracking-tighter">N</span>
                </div>
                <span className="text-[10px] uppercase tracking-[0.2em] text-faint">New One Two</span>
              </div>

              {/* Link connector */}
              <div className="flex items-center justify-center h-14">
                <div className="relative h-px w-8 bg-gradient-to-r from-accent/20 via-accent/60 to-accent/20">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="material-symbols-outlined text-accent bg-surface px-0.5" style={{ fontSize: 16 }}>link</span>
                  </div>
                </div>
              </div>

              {/* Shopify logo */}
              <div className="flex flex-col items-center gap-1.5">
                <div className="w-14 h-14 bg-elevated rounded-xl flex items-center justify-center">
                  <svg viewBox="0 0 109 124" className="w-8 h-8" xmlns="http://www.w3.org/2000/svg" fill="#96bf47">
                    <path d="M74.7 14.8c-.1-.6-.6-1-1.1-1-.5 0-9.4-.2-9.4-.2s-7.5-7.3-8.2-8c-.8-.7-2.3-.5-2.9-.3l-4 1.2C47.5 4.3 45.3 3 42.8 3c-16.8 0-24.9 21-27.4 31.7l-11.7 3.6c-3.6 1.1-3.7 1.2-4.2 4.7L0 93.5l54.2 9.4 29.4-6.4L74.7 14.8zM55.4 11.3l-6.5 2c1.7-6.5 4.9-9.7 7.8-10.9.6 2.3.9 5.3-1.3 8.9zm-9.8 3l-13.3 4.1c2.6-9.8 7.4-14.6 11.6-16.4 1 2.7 1.5 6.7 1.7 12.3zm2.8-13.8c.8 0 1.5.2 2.2.7-5.4 2.5-11.2 8.9-13.6 21.6l-10.3 3.2C29 16.9 35.8 .5 48.4.5z"/>
                    <path d="M73.6 13.8c-.5 0-9.4-.2-9.4-.2s-7.5-7.3-8.2-8c-.3-.3-.7-.4-1-.5l-1.7 87.3 29.4-6.4L74.7 14.8c-.2-.6-.7-1-1.1-1z" opacity=".4"/>
                    <path d="M42.5 43.7l-3.6 10.7s-3.2-1.7-7-1.7c-5.6 0-5.9 3.5-5.9 4.4 0 4.8 12.5 6.6 12.5 17.9 0 8.8-5.6 14.5-13.2 14.5-9.1 0-13.7-5.7-13.7-5.7l2.4-8s4.8 4.1 8.8 4.1c2.6 0 3.7-2.1 3.7-3.6 0-6.3-10.2-6.6-10.2-16.9 0-8.7 6.2-17.1 18.8-17.1 4.8 0 7.4 1.4 7.4 1.4z"/>
                  </svg>
                </div>
                <span className="text-[10px] uppercase tracking-[0.2em] text-faint">Shopify</span>
              </div>
            </div>

            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-ink tracking-tight">
                Connect New One Two<br />to Your Store
              </h1>
              <p className="text-muted text-sm leading-relaxed">
                You'll be redirected to Shopify to approve access.
                <br />
                Takes about 30 seconds.
              </p>
            </div>
          </div>

          {/* Form card */}
          <div className="bg-surface rounded-xl p-7 space-y-5">
            <div>
              <label
                htmlFor="shop-input"
                className="block text-sm font-semibold text-ink mb-1.5"
              >
                Shopify store URL
              </label>
              <p className="text-[11px] text-faint mb-4">
                Enter your store name — the part before .myshopify.com
              </p>

              <div className="flex items-stretch bg-raised border border-white/[0.12] rounded-xl overflow-hidden focus-within:border-accent transition-colors">
                <input
                  ref={inputRef}
                  id="shop-input"
                  type="text"
                  value={prefix}
                  onChange={(e) => {
                    setPrefix(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={handleKey}
                  placeholder="my-store"
                  autoFocus
                  className="flex-1 min-w-0 bg-transparent px-4 py-3.5 text-sm text-ink placeholder:text-faint outline-none font-mono"
                />
                <span className="flex items-center pr-4 text-sm text-faint font-mono select-none whitespace-nowrap border-l border-white/[0.08] pl-3">
                  .myshopify.com
                </span>
              </div>

              {error && (
                <p className="text-[11px] text-danger mt-2">{error}</p>
              )}
            </div>

            <button
              type="button"
              onClick={handleInstall}
              disabled={loading}
              className="kinetic-btn w-full py-3.5 bg-gradient-to-br from-accent to-accent/70 text-white rounded-xl text-sm font-bold border-0 cursor-pointer transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Redirecting to Shopify…
                </>
              ) : (
                <>
                  <span
                    className="material-symbols-outlined text-[18px]"
                    style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}
                  >
                    shopping_bag
                  </span>
                  Connect with Shopify
                </>
              )}
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
                      style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}
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
