import { useRef } from "react";
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

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSubmit();
    }
  };

  return (
    <div className="px-5 py-4 border-t border-white/7 bg-surface shrink-0">
      {!placeholder && <div className="flex gap-2 mb-2.5 flex-wrap">
        {HINTS.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => { onChange(h); ref.current?.focus(); }}
            className="text-[11px] text-faint px-2.5 py-1 border border-white/7 rounded-full hover:border-accent hover:text-accent transition-all duration-150 cursor-pointer bg-transparent"
          >
            {h}
          </button>
        ))}
      </div>}
      <div
        className={cn(
          "flex gap-2.5 items-end bg-raised border rounded-xl px-3.5 py-2.5 transition-colors duration-150",
          "focus-within:border-accent border-white/13"
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          disabled={disabled}
          placeholder={placeholder ?? "Describe the feature you want to build..."}
          className="flex-1 bg-transparent border-0 outline-none resize-none font-sans text-sm text-ink placeholder:text-faint min-h-[22px] max-h-[120px] leading-relaxed disabled:opacity-50"
        />
        {disabled && onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="w-8 h-8 rounded-lg bg-red-500/20 border border-red-500/40 flex items-center justify-center transition-all duration-150 hover:bg-red-500/30 shrink-0 cursor-pointer"
          >
            <span className="w-3 h-3 bg-red-400 rounded-sm block" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
            className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white text-sm transition-all duration-150 hover:bg-accent-hi disabled:opacity-40 disabled:cursor-not-allowed shrink-0 border-0 cursor-pointer"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
