interface ArtifactBlockProps {
  label: string;
  files: string[];
}

export function ArtifactBlock({ label, files }: ArtifactBlockProps) {
  return (
    <div className="mt-3 bg-raised border border-white/7 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2 bg-white/[0.03] border-b border-white/7">
        <span className="text-[10px] font-bold text-accent tracking-widest uppercase">
          {label}
        </span>
      </div>
      <div className="px-3.5 py-3 font-mono text-[11px] text-muted leading-[1.7]">
        {files.map((name, i) => (
          <div key={i} className="flex items-center gap-2 mb-1 last:mb-0">
            <span className="text-teal">✓</span>
            <span>{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
