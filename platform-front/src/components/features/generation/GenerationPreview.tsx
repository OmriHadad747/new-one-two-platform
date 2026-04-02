import { useState } from "react";
import { WidgetMockup } from "./WidgetMockup";
import { cn } from "@/lib/cn";

type Tab = "preview" | "files";

interface GeneratedFile {
  name: string;
  icon: string;
  size: string;
}

export function GenerationPreview({ files }: { files: GeneratedFile[] }) {
  const [tab, setTab] = useState<Tab>("preview");

  return (
    <div className="w-[420px] min-w-[420px] flex flex-col bg-surface border-l border-white/7">
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/7 shrink-0">
        <span className="text-[13px] font-bold text-ink">Preview</span>
        <div className="flex gap-1">
          {(["preview", "files"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "text-[11px] px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer border-0",
                tab === t
                  ? "bg-accent text-white"
                  : "text-faint hover:text-muted bg-transparent"
              )}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {tab === "preview" ? (
          <>
            <p className="text-[11px] text-faint text-center mb-3.5">
              Simulated storefront widget render
            </p>
            <WidgetMockup />
            <div className="mt-4 p-3 bg-raised rounded-xl border border-white/7">
              <div className="text-[11px] font-bold text-faint tracking-[0.8px] uppercase mb-2">
                Host API Access
              </div>
              {[
                "host.context.product",
                "host.fetch('/api/notify', 'POST')",
                "host.ui.render(container)",
              ].map((l, i) => (
                <div key={i} className="font-mono text-[10px] text-teal py-0.5">
                  ↗ {l}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2.5">
            {files.length === 0 ? (
              <p className="text-center text-[13px] text-faint py-10">
                Files will appear here as they're generated
              </p>
            ) : (
              files.map((f, i) => (
                <div
                  key={i}
                  className="bg-raised border border-white/7 rounded-xl px-3.5 py-3 flex items-center gap-3"
                >
                  <span className="text-lg">{f.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-ink font-mono truncate">{f.name}</div>
                    <div className="text-[11px] text-faint mt-0.5">{f.size}</div>
                  </div>
                  <span className="text-teal text-base shrink-0">✓</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
