import { NavLink, useNavigate, useParams } from "react-router";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session";
import { useGenerationStore } from "@/stores/generation";
import { useApps, useTenant } from "@/hooks/useApps";
import type { App } from "@/types/dashboard";

// ─── Status dot ───────────────────────────────────────────────────────────────

function AppStatusDot({ app, isGenerating }: { app: App; isGenerating: boolean }) {
  if (isGenerating) {
    return <span className="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" title="Generating…" />;
  }
  if (app.status === "active")
    return <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" title="Live" />;
  if (app.status === "draft")
    return <span className="w-2 h-2 rounded-full bg-faint opacity-50 shrink-0" title="Draft" />;
  if (app.status === "inactive")
    return <span className="w-2 h-2 rounded-full bg-danger opacity-70 shrink-0" title="Inactive" />;
  return <span className="w-2 h-2 rounded-full bg-danger opacity-50 shrink-0" title={app.status} />;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { shopDomain, clear, tenantId } = useSessionStore();
  const tenantQuery = useTenant(tenantId);
  const plan = tenantQuery.data?.billingPlan ?? "free";
  const navigate = useNavigate();
  const { appId: activeAppId } = useParams<{ appId?: string }>();
  const activeGen = useGenerationStore((s) => s.active);

  const appsQuery = useApps(tenantId);
  const apps = (appsQuery.data ?? []);

  const handleDisconnect = () => {
    clear();
    navigate("/");
  };

  return (
    <aside className="w-[220px] min-w-[220px] bg-surface border-r border-white/[0.04] flex flex-col z-10 select-none">

      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-[18px] border-b border-white/[0.04]">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-teal flex items-center justify-center text-[13px] font-extrabold text-white leading-none">
          N
        </div>
        <span className="text-[15px] font-bold text-ink tracking-tight">
          New One<span className="text-accent"> Two</span>
        </span>
      </div>

      {/* New App */}
      <div className="px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={() => navigate("/app/new")}
          className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.07] text-[13px] font-medium text-ink transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-accent text-[14px] leading-none">✦</span>
            <span>New app</span>
          </div>
          <span className="material-symbols-outlined text-[8px] text-faint/40" style={{ fontVariationSettings: "'wght' 200" }}>edit</span>
        </button>
      </div>

      {/* Divider */}
      <div className="mx-3 border-t border-white/[0.04]" />

      {/* Section label — clickable to go to full apps list */}
      <div className="px-3 pt-2.5 pb-1">
        <button
          type="button"
          onClick={() => navigate("/app/apps")}
          className="group w-full flex items-center justify-between px-1.5 py-1 rounded-md hover:bg-white/[0.05] transition-colors bg-transparent border-0 cursor-pointer"
        >
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[13px] text-faint/60 group-hover:text-ink transition-colors" style={{ fontVariationSettings: "'wght' 200" }}>layers</span>
            <span className="text-[11px] font-semibold text-faint group-hover:text-ink transition-colors">My apps</span>
          </div>
          <span className="material-symbols-outlined text-[13px] text-faint/50 group-hover:text-accent transition-colors">chevron_right</span>
        </button>
      </div>

      {/* App list */}
      <nav className="flex-1 overflow-y-auto py-1 px-2">
        {apps.length === 0 && !appsQuery.isLoading && (
          <p className="text-[11px] text-faint text-center py-6 px-3 leading-relaxed">
            No apps yet — build your first one above.
          </p>
        )}

        {appsQuery.isLoading && (
          <div className="space-y-1 px-1 py-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-9 rounded-lg bg-white/[0.03] animate-pulse-subtle" />
            ))}
          </div>
        )}

        {apps.map((app) => {
          const isGenerating = activeGen?.appId === app.id && activeGen.status === "running";
          const isActive = activeAppId === app.id;

          return (
            <div key={app.id} className="relative group/app mb-px">
              <button
                type="button"
                onClick={() => navigate(`/app/apps/${app.id}`)}
                className={cn(
                  "w-full flex items-center gap-2.5 pl-2.5 pr-8 py-2 rounded-lg text-left transition-all duration-150 border-0 cursor-pointer",
                  isActive
                    ? "bg-accent/10 text-ink"
                    : "text-muted hover:bg-white/[0.05] hover:text-ink"
                )}
              >
                <AppStatusDot app={app} isGenerating={isGenerating} />
                <span className={`flex-1 text-[13px] font-medium truncate min-w-0 ${app.name === "..." ? "text-faint italic" : ""}`}>
                  {app.name === "..." ? "Untitled app" : app.name}
                </span>
              </button>
              <button
                type="button"
                onClick={() => navigate(`/app/apps/${app.id}/revise`)}
                title="Revise with Ton"
                className={cn(
                  "absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md transition-all border-0 cursor-pointer bg-transparent",
                  isActive
                    ? "opacity-100 text-accent/60 hover:text-accent hover:bg-accent/10"
                    : "opacity-0 group-hover/app:opacity-100 text-faint hover:text-accent hover:bg-accent/10"
                )}
              >
                <span className="material-symbols-outlined text-[13px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 200" }}>auto_awesome</span>
              </button>
            </div>
          );
        })}
      </nav>

      {/* Bottom: store info + disconnect */}
      <div className="px-2.5 py-3 border-t border-white/[0.04] space-y-1">
        <NavLink
          to="/app/settings"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors no-underline",
              isActive ? "bg-accent/10 text-accent" : "text-faint hover:text-ink hover:bg-white/[0.05]"
            )
          }
        >
          <span className="material-symbols-outlined text-[13px]">settings</span>
          Settings
        </NavLink>

        <div className="flex items-center gap-2 px-2.5 py-2 bg-white/[0.03] rounded-lg mt-1">
          <span className={`w-2 h-2 rounded-full shrink-0 ${shopDomain ? "bg-teal" : "bg-faint"}`} />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold text-ink truncate">
              {shopDomain ?? "Not connected"}
            </div>
            <div className="text-[10px] text-faint capitalize">
              {shopDomain ? `${plan} plan` : "Complete OAuth"}
            </div>
          </div>
          {shopDomain && (
            <button
              type="button"
              onClick={handleDisconnect}
              title="Disconnect"
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-faint hover:text-danger transition-colors bg-transparent border-0 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[13px]">logout</span>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
