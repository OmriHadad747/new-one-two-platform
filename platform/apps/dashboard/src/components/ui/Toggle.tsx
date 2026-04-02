import { cn } from "@/lib/cn";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, disabled, className }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer border-0",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-accent" : "bg-raised border border-white/13",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-[left] duration-200",
          checked ? "left-[21px]" : "left-[3px]"
        )}
      />
    </button>
  );
}
