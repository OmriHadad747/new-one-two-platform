import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";

interface Props {
  initialName: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function NameAppModal({ initialName, onConfirm, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6">
        <h2 className="text-[15px] font-bold text-ink mb-1">Name your app</h2>
        <p className="text-[12px] text-faint mb-5">
          You can change this later from the app detail page.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Back In Stock Notifier"
            className="w-full bg-raised border border-white/[0.08] rounded-lg px-4 py-2.5 text-[13px] text-ink placeholder:text-faint outline-none focus:border-accent transition-colors"
          />

          <div className="flex gap-2 justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!name.trim()}>
              Generate →
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
