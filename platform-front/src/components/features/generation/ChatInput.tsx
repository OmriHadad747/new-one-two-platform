import { useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/cn";

const HINTS = [
  "Notify me when back in stock",
  "Upsell on cart page",
  "Post-purchase review request",
  "Track abandoned checkouts",
];

interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  onStop?: () => void;
}

export function ChatInput({ value, onChange, onSubmit, disabled, placeholder, onStop }: ChatInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  // Resize whenever value changes — catches both typing and external resets (e.g. after submit).
  useEffect(() => { autoResize(); }, [value, autoResize]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSubmit();
    }
  };

  return (
    <div className="absolute bottom-6 left-0 right-0 flex flex-col items-center gap-2 px-4 pointer-events-none">

      {/* Hint pills */}
      {!placeholder && (
        <div className="flex gap-2 flex-wrap justify-center pointer-events-auto">
          {HINTS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => { onChange(h); ref.current?.focus(); autoResize(); }}
              className="text-[11px] text-faint px-2.5 py-1 rounded-full hover:text-accent hover:bg-accent/[0.06] transition-all duration-150 cursor-pointer bg-surface/80 backdrop-blur-sm"
            >
              {h}
            </button>
          ))}
        </div>
      )}

      {/* Floating input */}
      <div
        className={cn(
          "w-full max-w-[600px] pointer-events-auto",
          "flex gap-2.5 items-end bg-surface/90 backdrop-blur-xl rounded-2xl px-4 py-3 transition-colors duration-150",
          "shadow-[0_8px_32px_rgba(0,0,0,0.35)]"
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKey}
          disabled={disabled}
          placeholder={placeholder ?? "Describe the feature you want to build..."}
          className="flex-1 bg-transparent border-0 outline-none resize-none font-sans text-sm text-ink placeholder:text-faint min-h-[22px] leading-relaxed disabled:opacity-50 overflow-hidden"
          style={{ height: "22px" }}
        />
        {disabled && onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="w-7 h-7 rounded-lg bg-red-500/20 border border-red-500/40 flex items-center justify-center transition-all duration-150 hover:bg-red-500/30 shrink-0 cursor-pointer"
          >
            <span className="w-2.5 h-2.5 bg-red-400 rounded-sm block" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
            className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center text-white text-sm transition-all duration-150 hover:bg-accent-hi disabled:opacity-40 disabled:cursor-not-allowed shrink-0 border-0 cursor-pointer"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
