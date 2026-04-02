import { NavLink } from "react-router";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session";

interface NavItem {
  to: string;
  icon: string;
  label: string;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", icon: "⬡", label: "Dashboard", end: true },
  { to: "/new", icon: "✦", label: "New App" },
  { to: "/apps", icon: "⊞", label: "My Apps" },
  { to: "/settings", icon: "⊙", label: "Settings" },
];

export function Sidebar() {
  const { shopDomain, plan } = useSessionStore();

  return (
    <aside className="w-[220px] min-w-[220px] bg-surface border-r border-white/7 flex flex-col z-10">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-[22px] border-b border-white/7">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-teal flex items-center justify-center text-[13px] font-extrabold text-white leading-none select-none">
          N
        </div>
        <span className="text-[15px] font-bold text-ink tracking-tight">
          New One<span className="text-accent"> Two</span>
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2.5 py-3">
        <div className="text-[10px] font-semibold text-faint tracking-[1.2px] uppercase px-2.5 mb-1.5">
          Platform
        </div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "relative flex items-center gap-2 px-2.5 py-2 rounded-[7px] text-[13.5px] font-medium transition-all duration-150 mb-px no-underline",
                isActive
                  ? "bg-accent/12 text-accent before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-4 before:bg-accent before:rounded-r"
                  : "text-muted hover:bg-white/5 hover:text-ink"
              )
            }
          >
            <span className="w-[18px] text-center text-[15px] leading-none">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Store pill */}
      <div className="px-2.5 py-3.5 border-t border-white/7">
        <div className="flex items-center gap-2 px-2.5 py-2 bg-white/[0.03] rounded-lg border border-white/7">
          <span className={`w-2 h-2 rounded-full shrink-0 ${shopDomain ? "bg-teal" : "bg-faint"}`} />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-ink truncate">
              {shopDomain ?? "Not connected"}
            </div>
            <div className="text-[10px] text-faint capitalize">
              {shopDomain ? `Connected · ${plan} Plan` : "Complete OAuth to connect"}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
