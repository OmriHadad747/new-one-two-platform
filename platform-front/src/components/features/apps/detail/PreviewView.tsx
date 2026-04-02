import { WidgetMockup } from "@/components/features/generation/WidgetMockup";
import type { App } from "@/types/dashboard";

export function PreviewView({ app }: { app: App }) {
  if (app.appArchetype === "backend_only") {
    return (
      <div className="max-w-[420px] bg-raised border border-white/7 rounded-xl p-8 text-center">
        <div className="text-4xl mb-4">⚙️</div>
        <div className="text-sm font-bold text-ink mb-2">Backend-only App</div>
        <div className="text-xs text-faint">
          This app runs as a webhook handler and has no storefront UI.
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-[420px]">
      <WidgetMockup />
    </div>
  );
}
