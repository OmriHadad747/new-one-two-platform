import { NavLink, useNavigate, useParams } from "react-router";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session";
import { useGenerationStore } from "@/stores/generation";
import { useThemeStore } from "@/stores/theme";
import { useApps } from "@/hooks/useApps";
import type { App } from "@/types/dashboard";

// ─── Status dot ───────────────────────────────────────────────────────────────

function AppStatusDot({ app, isGenerating }: { app: App; isGenerating: boolean }) {
  if (isGenerating) {
    return (
      <span
        className="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0"
        title="Generating…"
      />
    );
  }
  const cls = {
    active:   "bg-teal",
    draft:    "bg-amber",
    inactive: "bg-faint opacity-50",
    deleted:  "bg-danger opacity-50",
  }[app.status] ?? "bg-faint";
  return <span className={cn("w-2 h-2 rounded-full shrink-0", cls)} />;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { shopDomain, plan, clear } = useSessionStore();
  const { tenantId } = useSessionStore();
  const navigate = useNavigate();
  const { appId: activeAppId } = useParams<{ appId?: string }>();
  const { theme, toggle } = useThemeStore();
  const activeGen = useGenerationStore((s) => s.active);

  const appsQuery = useApps(tenantId);
  const apps = (appsQuery.data ?? []);

  const handleDisconnect = () => {
    clear();
    navigate("/");
  };

  return (
    <aside className="w-[220px] min-w-[220px] bg-surface border-r border-white/7 flex flex-col z-10 select-none">

      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-[18px] border-b border-white/7">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-teal flex items-center justify-center text-[13px] font-extrabold text-white leading-none">
          N
        </div>
        <span className="text-[15px] font-bold text-ink tracking-tight flex-1">
          New One<span className="text-accent"> Two</span>
        </span>
        <button
          type="button"
          onClick={toggle}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          className="w-7 h-7 flex items-center justify-center rounded-md text-faint hover:text-ink hover:bg-white/[0.06] transition-colors bg-transparent border-0 cursor-pointer"
        >
          <span className="material-symbols-outlined text-[16px]">
            {theme === "dark" ? "light_mode" : "dark_mode"}
          </span>
        </button>
      </div>

      {/* New App CTA */}
      <div className="px-3 py-3 border-b border-white/7">
        <button
          type="button"
          onClick={() => navigate("/app/new")}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 hover:bg-accent/15 text-accent text-[13px] font-semibold transition-colors border-0 cursor-pointer"
        >
          <span className="text-[15px] leading-none">✦</span>
          New App
        </button>
      </div>

      {/* App list */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
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
            <button
              key={app.id}
              type="button"
              onClick={() => navigate(`/app/apps/${app.id}`)}
              className={cn(
                "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all duration-150 mb-px border-0 cursor-pointer group",
                isActive
                  ? "bg-accent/10 text-ink"
                  : "text-muted hover:bg-white/[0.05] hover:text-ink"
              )}
            >
              <AppStatusDot app={app} isGenerating={isGenerating} />
              <span className="flex-1 text-[13px] font-medium truncate min-w-0">{app.name}</span>
              {/* Edit in AI — appears on hover when not generating */}
              {!isGenerating && (
                <span
                  role="button"
                  tabIndex={0}
                  title="Edit in AI"
                  onClick={(e) => { e.stopPropagation(); navigate(`/app/new?appId=${app.id}`); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); navigate(`/app/new?appId=${app.id}`); } }}
                  className={cn(
                    "material-symbols-outlined text-[14px] shrink-0 transition-all",
                    isActive
                      ? "text-faint hover:text-accent"
                      : "opacity-0 group-hover:opacity-100 text-faint hover:text-accent"
                  )}
                >
                  edit
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom: store info + disconnect */}
      <div className="px-2.5 py-3 border-t border-white/7 space-y-1">
        <NavLink
          to="/app/settings"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors no-underline",
              isActive ? "bg-accent/10 text-accent" : "text-faint hover:text-ink hover:bg-white/[0.05]"
            )
          }
        >
          <span className="material-symbols-outlined text-[15px]">settings</span>
          Settings
        </NavLink>

        <div className="flex items-center gap-2 px-2.5 py-2 bg-white/[0.03] rounded-lg border border-white/7 mt-1">
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
