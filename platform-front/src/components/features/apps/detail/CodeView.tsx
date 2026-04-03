import { CodeBlock } from "@/components/ui/CodeBlock";
import { Tag } from "@/components/ui/Badge";
import type { App } from "@/types/dashboard";

export function CodeView({ app }: { app: App }) {
  const hasWidget = (app.appArchetype === "storefront_backend" || app.appArchetype === "storefront_backend_admin") && app.widgetJs;

  return (
    <div className="grid grid-cols-[1fr_320px] gap-4">
      <CodeBlock
        title={`widgets/${app.shopDomain}/${app.slug}.js`}
        badge={<Tag variant="purple">Generated</Tag>}
      >
        {hasWidget ? (
          <pre className="whitespace-pre-wrap break-all">
            {app.widgetJs!.length > 800
              ? app.widgetJs!.slice(0, 800) + "\n// … truncated"
              : app.widgetJs}
          </pre>
        ) : (
          <span className="text-faint italic">
            {app.appArchetype === "backend"
              ? "Backend-only app — no widget JS"
              : "Widget JS not yet generated"}
          </span>
        )}
      </CodeBlock>

      <div className="flex flex-col gap-3.5">
        <div className="bg-raised border border-white/7 rounded-xl p-4">
          <div className="text-[11px] font-bold text-faint tracking-[0.8px] uppercase mb-3">
            Metadata
          </div>
          {[
            { k: "App ID", v: app.id.slice(0, 8) + "…" },
            { k: "Archetype", v: app.appArchetype },
            { k: "Shop", v: app.shopDomain },
            { k: "Status", v: app.status },
          ].map(({ k, v }) => (
            <div key={k} className="flex justify-between py-1.5 border-b border-white/5 last:border-0">
              <span className="text-xs text-faint">{k}</span>
              <span className="text-xs text-ink font-mono">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
