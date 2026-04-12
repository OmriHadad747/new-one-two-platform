interface LoadingProps {
  message?: string;
}

export function LoadingSpinner({ message = "Loading…" }: LoadingProps) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-3 py-20">
      <div className="w-6 h-6 rounded-full border-2 border-faint/20 border-t-accent animate-spin" />
      <span className="text-sm text-faint">{message}</span>
    </div>
  );
}

interface ErrorProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorMessage({
  message = "Something went wrong",
  onRetry,
}: ErrorProps) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 py-20">
      <div className="text-3xl">⚠</div>
      <p className="text-sm text-danger">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="text-xs text-faint px-3 py-1.5 rounded-lg bg-white/[0.04] hover:text-ink hover:bg-white/[0.08] transition-all cursor-pointer"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyApps({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 py-20">
      <div className="text-5xl">✦</div>
      <p className="text-base font-bold text-ink">No apps yet</p>
      <p className="text-sm text-faint text-center max-w-xs">
        Describe a feature in plain English and New One Two will generate the widget, handler, and DB migration for you.
      </p>
      <button
        type="button"
        onClick={onNew}
        className="mt-2 px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-semibold hover:bg-accent-hi transition-all border-0 cursor-pointer"
      >
        Build your first app
      </button>
    </div>
  );
}
