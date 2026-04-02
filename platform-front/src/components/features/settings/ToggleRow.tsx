import { Toggle } from "@/components/ui/Toggle";

interface ToggleRowProps {
  title: string;
  sub: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  last?: boolean;
}

export function ToggleRow({ title, sub, checked, onChange, last }: ToggleRowProps) {
  return (
    <div className={`flex items-center justify-between px-5 py-4 ${!last ? "border-b border-white/7" : ""}`}>
      <div>
        <div className="text-[13px] font-semibold text-ink mb-0.5">{title}</div>
        <div className="text-[11px] text-faint">{sub}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}
