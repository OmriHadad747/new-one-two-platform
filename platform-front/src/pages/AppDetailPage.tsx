import { useNavigate, useParams } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session";
import { useGenerationStore } from "@/stores/generation";
import { useApp, useWebhookAppLogs, useWidgetLogs, useAdminLogs } from "@/hooks/useApps";
import { useLatestSession, useGeneration } from "@/hooks/useGeneration";
import type { WebhookInvocationLogEntry, InvocationLogEntry, App, SessionBundle } from "@/types/dashboard";
import { ArchetypePills } from "@/components/ui/ArchetypePills";
import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Status config ────────────────────────────────────────────────────────────

const LOG_STATUS_CFG = {
  success: { dot: "bg-teal", label: "success", cls: "text-teal" },
  failed: { dot: "bg-danger", label: "failed", cls: "text-danger" },
  running: { dot: "bg-accent animate-pulse", label: "running", cls: "text-accent" },
  queued: { dot: "bg-faint", label: "queued", cls: "text-faint" },
  timeout: { dot: "bg-amber-400", label: "timeout", cls: "text-amber-400" },
} satisfies Record<WebhookInvocationLogEntry["status"], { dot: string; label: string; cls: string }>;

const INVOCATION_STATUS_CFG = {
  success: { dot: "bg-teal", label: "success", cls: "text-teal" },
  failed:  { dot: "bg-danger", label: "failed", cls: "text-danger" },
  running: { dot: "bg-accent animate-pulse", label: "running", cls: "text-accent" },
} satisfies Record<InvocationLogEntry["status"], { dot: string; label: string; cls: string }>;

// ─── Shared sub-components ────────────────────────────────────────────────────

function StatusPill({ status }: { status: App["status"] }) {
  const cfg = {
    active:   { label: "Live",     cls: "bg-teal/12 text-teal" },
    draft:    { label: "Draft",    cls: "bg-amber/12 text-amber" },
    inactive: { label: "Inactive", cls: "bg-white/[0.06] text-faint" },
    deleted:  { label: "Deleted",  cls: "bg-danger/12 text-danger" },
  }[status] ?? { label: status, cls: "bg-white/[0.06] text-faint" };
  return (
    <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", cfg.cls)}>
      {cfg.label}
    </span>
  );
}

function EmptyLogs({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
      <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
        <span className="material-symbols-outlined text-faint text-[20px]">receipt_long</span>
      </div>
      <p className="text-sm text-faint">{label}</p>
      <p className="text-[11px] text-faint opacity-60">{sub}</p>
    </div>
  );
}

function LogTable({ pathHeader = "Event / Error", children }: { pathHeader?: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-white/[0.07] rounded-xl overflow-hidden">
      <div className="grid grid-cols-[16px_1fr_100px] gap-4 px-5 py-2.5 border-b border-white/[0.07] bg-white/[0.02]">
        <span />
        <span className="text-[10px] font-bold text-faint uppercase tracking-wider">{pathHeader}</span>
        <span className="text-[10px] font-bold text-faint uppercase tracking-wider text-right">Duration</span>
      </div>
      {children}
    </div>
  );
}

function LogRow({ entry, last }: { entry: WebhookInvocationLogEntry; last: boolean }) {
  const cfg = LOG_STATUS_CFG[entry.status];
  return (
    <div className={cn("flex items-start gap-4 px-5 py-3.5", !last && "border-b border-white/[0.05]")}>
      <div className="pt-1.5 shrink-0">
        <span className={cn("w-2 h-2 rounded-full block", cfg.dot)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-mono text-ink truncate">{entry.topic}</span>
          <span className={cn("text-[10px] font-bold uppercase tracking-wide", cfg.cls)}>{cfg.label}</span>
        </div>
        {entry.errorMessage && (
          <p className="text-[11px] text-danger mt-1 font-mono truncate">{entry.errorMessage}</p>
        )}
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <div className="text-[11px] font-mono text-faint">{formatDuration(entry.durationMs)}</div>
        <div className="text-[10px] text-faint">{timeAgo(entry.queuedAt)}</div>
      </div>
    </div>
  );
}

function InvocationLogRow({ entry, last }: { entry: InvocationLogEntry; last: boolean }) {
  const cfg = INVOCATION_STATUS_CFG[entry.status];
  return (
    <div className={cn("flex items-start gap-4 px-5 py-3.5", !last && "border-b border-white/[0.05]")}>
      <div className="pt-1.5 shrink-0">
        <span className={cn("w-2 h-2 rounded-full block", cfg.dot)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-mono text-ink truncate">{entry.path}</span>
          <span className={cn("text-[10px] font-bold uppercase tracking-wide", cfg.cls)}>{cfg.label}</span>
        </div>
        {entry.errorMessage && (
          <p className="text-[11px] text-danger mt-1 font-mono truncate">{entry.errorMessage}</p>
        )}
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <div className="text-[11px] font-mono text-faint">{formatDuration(entry.durationMs)}</div>
        <div className="text-[10px] text-faint">{timeAgo(entry.invokedAt)}</div>
      </div>
    </div>
  );
}

// ─── Sidebar sub-components ───────────────────────────────────────────────────

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider mb-2.5">{title}</h3>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-white/[0.05] last:border-0">
      <span className="text-[11px] text-faint shrink-0">{label}</span>
      <span className="text-[12px] text-ink text-right">{value}</span>
    </div>
  );
}

// ─── Tab bar helper ───────────────────────────────────────────────────────────

function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  end,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (t: T) => void;
  end?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-white/[0.07] pb-0">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            "px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors bg-transparent border-x-0 border-t-0 cursor-pointer",
            active === t.id
              ? "border-accent text-ink"
              : "border-transparent text-faint hover:text-ink"
          )}
        >
          {t.label}
        </button>
      ))}
      {end && <div className="flex-1 flex items-center justify-end gap-2 mb-0.5">{end}</div>}
    </div>
  );
}

// ─── Code viewer ──────────────────────────────────────────────────────────────

function CodeViewer({ bundle }: { bundle: SessionBundle | null | undefined }) {
  const handlerCode = bundle?.handlerModule?.code ?? null;
  const widgetCode  = bundle?.widgetModule ?? null;
  const adminCode   = bundle?.adminUiModule ?? null;

  const files = [
    ...(handlerCode ? [{ id: "handler" as const, label: "handler.js", code: handlerCode }] : []),
    ...(widgetCode  ? [{ id: "widget"  as const, label: "widget.js",  code: widgetCode  }] : []),
    ...(adminCode   ? [{ id: "admin"   as const, label: "admin-ui.js",code: adminCode   }] : []),
  ];

  const [activeFile, setActiveFile] = useState<string>(files[0]?.id ?? "handler");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (files.length && !files.find((f) => f.id === activeFile)) {
      setActiveFile(files[0].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle]);

  if (!files.length) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
        <div className="w-12 h-12 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
          <span className="material-symbols-outlined text-faint text-[22px]">code_blocks</span>
        </div>
        <p className="text-sm text-faint">No generated code yet</p>
        <p className="text-[11px] text-faint opacity-60">Generate your app to see the code here.</p>
      </div>
    );
  }

  const current = files.find((f) => f.id === activeFile) ?? files[0];

  const copyCode = () => {
    void navigator.clipboard.writeText(current.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* File tabs + copy */}
      <div className="flex items-center gap-1 border-b border-white/[0.07] pb-0 mb-0 flex-shrink-0">
        {files.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setActiveFile(f.id)}
            className={cn(
              "px-3 py-2 text-[11px] font-mono border-b-2 -mb-px transition-colors bg-transparent border-x-0 border-t-0 cursor-pointer",
              activeFile === f.id
                ? "border-accent text-ink"
                : "border-transparent text-faint hover:text-ink"
            )}
          >
            {f.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          onClick={copyCode}
          className="flex items-center gap-1.5 text-[11px] text-faint hover:text-accent transition-colors bg-transparent border-0 cursor-pointer px-3 py-2"
        >
          <span className="material-symbols-outlined text-[14px]">
            {copied ? "check" : "content_copy"}
          </span>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* Code block */}
      <div className="flex-1 overflow-auto">
        <pre className="p-5 text-[12px] font-mono text-ink leading-relaxed whitespace-pre overflow-x-auto min-h-full">
          <code>{current.code}</code>
        </pre>
      </div>
    </div>
  );
}

// ─── Settings panel ───────────────────────────────────────────────────────────

function SettingsPanel({
  app,
  tenantId,
  latestSession,
  onAppChange,
  onDelete,
}: {
  app: App;
  tenantId: string;
  latestSession: { prompt: string; webhookTopics: string[]; cronSchedule: string | null } | null;
  onAppChange: () => void;
  onDelete: () => void;
}) {
  const appId = app.id;

  // Rename
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming]);

  const startRename = () => { setRenameValue(app.name); setRenaming(true); };

  const commitRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === app.name) { setRenaming(false); return; }
    setRenameSaving(true);
    try {
      await api.apps.rename(tenantId, appId, trimmed);
      onAppChange();
    } finally {
      setRenameSaving(false);
      setRenaming(false);
    }
  };

  // Status toggle
  const [statusSaving, setStatusSaving] = useState(false);
  const canToggleStatus = app.status === "active" || app.status === "inactive";
  const toggleStatus = async () => {
    if (!canToggleStatus) return;
    const next = app.status === "active" ? "inactive" : "active";
    setStatusSaving(true);
    try {
      await api.apps.setStatus(tenantId, appId, next);
      onAppChange();
    } finally {
      setStatusSaving(false);
    }
  };

  // Delete
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.apps.delete(tenantId, appId);
      onDelete();
    } finally {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  };

  const webhookTopics = latestSession?.webhookTopics ?? [];
  const cronSchedule  = latestSession?.cronSchedule ?? null;
  const prompt        = latestSession?.prompt ?? null;

  return (
    <div className="max-w-2xl mx-auto py-8 px-6 space-y-8">

      {/* Identity */}
      <section>
        <h2 className="text-[11px] font-bold text-faint uppercase tracking-wider mb-4">Identity</h2>
        <div className="bg-white/[0.03] border border-white/[0.07] rounded-xl divide-y divide-white/[0.05]">

          {/* Name */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-[13px] font-medium text-ink">Name</p>
              <p className="text-[11px] text-faint mt-0.5">Display name shown in the platform.</p>
            </div>
            {renaming ? (
              <div className="flex items-center gap-2">
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  disabled={renameSaving}
                  className="text-[13px] text-ink bg-raised border border-accent/50 rounded-lg px-3 py-1.5 outline-none w-44"
                />
                <Button size="sm" variant="primary" onClick={() => void commitRename()} disabled={renameSaving}>
                  {renameSaving ? "…" : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-ink">{app.name}</span>
                <Button size="sm" variant="ghost" onClick={startRename}>Rename</Button>
              </div>
            )}
          </div>

          {/* Status */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-[13px] font-medium text-ink">Status</p>
              <p className="text-[11px] text-faint mt-0.5">
                {app.status === "active"
                  ? "App is live and handling requests."
                  : app.status === "inactive"
                  ? "App is paused — no requests are handled."
                  : app.status === "draft"
                  ? "App has not been deployed yet."
                  : "App is deleted."}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <StatusPill status={app.status} />
              {canToggleStatus && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void toggleStatus()}
                  disabled={statusSaving}
                >
                  {statusSaving ? "…" : app.status === "active" ? "Deactivate" : "Activate"}
                </Button>
              )}
            </div>
          </div>

          {/* App type — only show once deployed (archetype is set by generator on deploy) */}
          {app.status !== "draft" && (
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div>
                <p className="text-[13px] font-medium text-ink">Type</p>
                <p className="text-[11px] text-faint mt-0.5">Archetype generated for this app.</p>
              </div>
              <ArchetypePills archetype={app.appArchetype} />
            </div>
          )}

          {/* Created */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-[13px] font-medium text-ink">Created</p>
            </div>
            <span className="text-[12px] text-ink">{formatDate(app.createdAt)}</span>
          </div>

        </div>
      </section>

      {/* Triggers */}
      <section>
        <h2 className="text-[11px] font-bold text-faint uppercase tracking-wider mb-4">Triggers</h2>
        <div className="bg-white/[0.03] border border-white/[0.07] rounded-xl divide-y divide-white/[0.05]">

          <div className="px-5 py-4">
            <p className="text-[13px] font-medium text-ink mb-2">Webhook topics</p>
            {webhookTopics.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {webhookTopics.map((topic) => (
                  <span
                    key={topic}
                    className="text-[11px] font-mono px-2 py-0.5 bg-white/[0.05] border border-white/[0.07] rounded-md text-faint"
                  >
                    {topic}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-faint mt-1">No webhook subscriptions.</p>
            )}
          </div>

          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <p className="text-[13px] font-medium text-ink">Cron schedule</p>
            <span className="text-[12px] font-mono text-faint">
              {cronSchedule ?? "—"}
            </span>
          </div>

        </div>
      </section>

      {/* Original prompt */}
      {prompt && (
        <section>
          <h2 className="text-[11px] font-bold text-faint uppercase tracking-wider mb-4">Original Prompt</h2>
          <div className="bg-white/[0.03] border border-white/[0.07] rounded-xl px-5 py-4">
            <p className="text-[12px] text-faint leading-relaxed whitespace-pre-wrap">{prompt}</p>
          </div>
        </section>
      )}

      {/* Store */}
      <section>
        <h2 className="text-[11px] font-bold text-faint uppercase tracking-wider mb-4">Store</h2>
        <div className="bg-white/[0.03] border border-white/[0.07] rounded-xl px-5 py-4">
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-medium text-ink">Shop domain</p>
            <span className="text-[12px] font-mono text-faint">{app.shopDomain}</span>
          </div>
        </div>
      </section>

      {/* Danger zone */}
      {app.status !== "deleted" && (
        <section>
          <h2 className="text-[11px] font-bold text-danger uppercase tracking-wider mb-4">Danger Zone</h2>
          <div className="bg-danger/5 border border-danger/20 rounded-xl px-5 py-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-ink">Delete this app</p>
              <p className="text-[11px] text-faint mt-0.5">
                Permanently removes the app and stops all processing. This cannot be undone.
              </p>
            </div>
            {deleteConfirm ? (
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-danger">Are you sure?</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger hover:bg-danger/10 border border-danger/30"
                  onClick={() => void handleDelete()}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Yes, delete"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger hover:bg-danger/10 border border-danger/30 shrink-0"
                onClick={() => setDeleteConfirm(true)}
              >
                Delete app
              </Button>
            )}
          </div>
        </section>
      )}

    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AppDetailPage() {
  const navigate = useNavigate();
  const { appId } = useParams<{ appId: string }>();
  const { tenantId } = useSessionStore();

  const appQuery = useApp(tenantId, appId ?? null);
  const latestSessionQuery = useLatestSession(appId ?? null);
  const { approve } = useGeneration();

  const [mainTab, setMainTab] = useState<"logs" | "code" | "settings">("logs");
  const [activeLogTab, setActiveLogTab] = useState<"webhook" | "widget" | "admin">("webhook");
  const [deploying, setDeploying] = useState(false);

  const logsQuery      = useWebhookAppLogs(tenantId, appId ?? null, mainTab === "logs" && activeLogTab === "webhook");
  const widgetLogsQuery = useWidgetLogs(tenantId, appId ?? null, mainTab === "logs" && activeLogTab === "widget");
  const adminLogsQuery  = useAdminLogs(tenantId, appId ?? null, mainTab === "logs" && activeLogTab === "admin");

  // Inline rename (sidebar, logs tab)
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming]);

  const app = appQuery.data ?? null;
  const latestSession = latestSessionQuery.data ?? null;
  const activeGen = useGenerationStore((s) => s.active);
  const isGenerating = activeGen?.appId === appId && activeGen?.status === "running";

  const startRename = () => { setRenameValue(app?.name ?? ""); setRenaming(true); };

  const commitRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === app?.name) { setRenaming(false); return; }
    setRenameSaving(true);
    try {
      await api.apps.rename(tenantId!, appId!, trimmed);
      await appQuery.refetch();
    } catch {
      // swallow — name reverts visually on next refetch
    } finally {
      setRenameSaving(false);
      setRenaming(false);
    }
  };

  const handleDeployDraft = async () => {
    if (!latestSession?.jobId) return;
    setDeploying(true);
    try {
      await approve(latestSession.jobId);
      await appQuery.refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Deployment failed");
    } finally {
      setDeploying(false);
    }
  };

  const activeLogsQuery =
    activeLogTab === "webhook" ? logsQuery
    : activeLogTab === "widget" ? widgetLogsQuery
    : adminLogsQuery;

  return (
    <>
      <TopBar
        title={app?.name ?? "App"}
        subtitle={app?.slug}
        actions={
          <>
            <Button
              variant={app?.status === "active" ? "primary" : "ghost"}
              size="sm"
              onClick={() => navigate(`/app/new?appId=${appId}`)}
            >
              {app?.status === "active" ? "Revise →" : "Edit in AI"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/app/apps")}>
              ← Apps
            </Button>
          </>
        }
      />

      {appQuery.isLoading ? (
        <main className="flex-1 overflow-y-auto p-7">
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 bg-white/[0.03] rounded-xl animate-pulse-subtle border border-white/[0.06]" />
            ))}
          </div>
        </main>
      ) : !app ? (
        <main className="flex-1 flex items-center justify-center">
          <p className="text-sm text-faint">App not found.</p>
        </main>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col">

          {/* ── Draft Banner ──────────────────────────────────────────────────── */}
          {!isGenerating && app.status === "draft" && latestSession?.status === "completed" && (
            <div className="bg-amber/5 border-b border-amber/15 px-7 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-amber text-[20px]">info</span>
                <div>
                  <p className="text-[13px] font-bold text-ink">Draft ready for deployment</p>
                  <p className="text-[11px] text-faint">Your AI-generated feature is ready to go live on your store.</p>
                </div>
              </div>
              <Button
                variant="primary"
                size="sm"
                className="bg-amber text-black hover:bg-amber/90"
                onClick={handleDeployDraft}
                disabled={deploying}
              >
                {deploying ? "Deploying..." : "🚀 Deploy Now"}
              </Button>
            </div>
          )}

          {/* ── Main tab bar ─────────────────────────────────────────────────── */}
          <div className="border-b border-white/[0.07] px-7 shrink-0">
            <TabBar
              tabs={[
                { id: "logs" as const, label: "Logs" },
                { id: "code" as const, label: "Code" },
                { id: "settings" as const, label: "Settings" },
              ]}
              active={mainTab}
              onChange={setMainTab}
            />
          </div>

          {/* ── Tab content ──────────────────────────────────────────────────── */}

          {/* LOGS */}
          {mainTab === "logs" && (
            <div className="flex-1 overflow-hidden flex">
              {/* Log list */}
              <main className="flex-1 overflow-y-auto p-7 min-w-0">
                <div className="mb-5">
                  <TabBar
                    tabs={[
                      { id: "webhook" as const, label: "Webhook" },
                      { id: "widget"  as const, label: "Widget" },
                      { id: "admin"   as const, label: "Admin" },
                    ]}
                    active={activeLogTab}
                    onChange={setActiveLogTab}
                    end={
                      <>
                        {activeLogsQuery.isFetching && (
                          <span className="text-[10px] text-faint">Refreshing…</span>
                        )}
                        <button
                          type="button"
                          onClick={() => void activeLogsQuery.refetch()}
                          className="text-[11px] text-faint hover:text-accent transition-colors bg-transparent border-0 cursor-pointer underline"
                        >
                          Refresh
                        </button>
                      </>
                    }
                  />
                </div>

                {activeLogTab === "webhook" && (
                  <>
                    {logsQuery.isError && <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>}
                    {!logsQuery.isError && (logsQuery.data ?? []).length === 0 && (
                      <EmptyLogs label="No webhook executions yet" sub="Logs appear here once Shopify sends events to your app." />
                    )}
                    {(logsQuery.data ?? []).length > 0 && (
                      <LogTable>
                        {(logsQuery.data ?? []).map((entry, i, arr) => (
                          <LogRow key={entry.id} entry={entry} last={i === arr.length - 1} />
                        ))}
                      </LogTable>
                    )}
                  </>
                )}

                {activeLogTab === "widget" && (
                  <>
                    {widgetLogsQuery.isError && <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>}
                    {!widgetLogsQuery.isError && (widgetLogsQuery.data ?? []).length === 0 && (
                      <EmptyLogs label="No widget calls yet" sub="Logs appear here once the storefront widget calls your backend." />
                    )}
                    {(widgetLogsQuery.data ?? []).length > 0 && (
                      <LogTable pathHeader="Path">
                        {(widgetLogsQuery.data ?? []).map((entry, i, arr) => (
                          <InvocationLogRow key={entry.id} entry={entry} last={i === arr.length - 1} />
                        ))}
                      </LogTable>
                    )}
                  </>
                )}

                {activeLogTab === "admin" && (
                  <>
                    {adminLogsQuery.isError && <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>}
                    {!adminLogsQuery.isError && (adminLogsQuery.data ?? []).length === 0 && (
                      <EmptyLogs label="No admin calls yet" sub="Logs appear here once the Admin UI panel calls your backend." />
                    )}
                    {(adminLogsQuery.data ?? []).length > 0 && (
                      <LogTable pathHeader="Path">
                        {(adminLogsQuery.data ?? []).map((entry, i, arr) => (
                          <InvocationLogRow key={entry.id} entry={entry} last={i === arr.length - 1} />
                        ))}
                      </LogTable>
                    )}
                  </>
                )}
              </main>

              {/* Sidebar */}
              <aside className="w-[240px] shrink-0 border-l border-white/[0.07] overflow-y-auto p-5">
                <SidebarSection title="App Info">
                  <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-1">
                    {/* Inline rename */}
                    <div className="flex items-center justify-between gap-2 py-2 border-b border-white/[0.05]">
                      <span className="text-[11px] text-faint shrink-0">Name</span>
                      {renaming ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => void commitRename()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename();
                            if (e.key === "Escape") setRenaming(false);
                          }}
                          disabled={renameSaving}
                          className="text-[12px] text-ink bg-raised border border-accent/50 rounded-md px-2 py-0.5 outline-none w-full text-right"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={startRename}
                          className="text-[12px] text-ink text-right truncate max-w-[130px] bg-transparent border-0 cursor-pointer hover:text-accent transition-colors"
                          title="Click to rename"
                        >
                          {app.name}
                        </button>
                      )}
                    </div>
                    <InfoRow label="Status" value={
                      isGenerating
                        ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide bg-accent/12 text-accent">Building…</span>
                        : <StatusPill status={app.status} />
                    } />
                    {!isGenerating && <InfoRow label="Type" value={<ArchetypePills archetype={app.appArchetype} />} />}
                    <InfoRow label="Created" value={formatDate(app.createdAt)} />
                    <InfoRow label="Updated" value={timeAgo(app.updatedAt)} />
                  </div>
                </SidebarSection>

                <SidebarSection title="Actions">
                  <div className="space-y-2">
                    {/* Primary action changes based on status */}
                    {app.status === "active" ? (
                      <Button
                        variant="primary"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => navigate(`/app/new?appId=${appId}`)}
                      >
                        <span className="material-symbols-outlined text-[15px] mr-2">edit</span>
                        Revise this app
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => navigate(`/app/new?appId=${appId}`)}>
                        <span className="material-symbols-outlined text-[15px] mr-2">edit</span>
                        Edit in AI
                      </Button>
                    )}
                    {isGenerating ? (
                      <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-faint">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
                        Building your app…
                      </div>
                    ) : latestSession?.status === "completed" && app.status === "draft" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start text-amber hover:bg-amber/10"
                        onClick={handleDeployDraft}
                        disabled={deploying}
                      >
                        <span className="material-symbols-outlined text-[15px] mr-2">rocket_launch</span>
                        {deploying ? "Deploying..." : "Deploy now"}
                      </Button>
                    ) : null}
                    <div className="border-t border-white/[0.06] mt-3 pt-3">
                      <button
                        type="button"
                        className="w-full text-left text-[12px] text-faint hover:text-accent transition-colors bg-transparent border-0 cursor-pointer py-1"
                        onClick={() => setMainTab("settings")}
                      >
                        Settings →
                      </button>
                    </div>
                  </div>
                </SidebarSection>
              </aside>
            </div>
          )}

          {/* CODE */}
          {mainTab === "code" && (
            <div className="flex-1 overflow-hidden">
              {latestSessionQuery.isLoading ? (
                <div className="p-7 space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-8 bg-white/[0.03] rounded-lg animate-pulse-subtle border border-white/[0.06]" />
                  ))}
                </div>
              ) : (
                <CodeViewer bundle={latestSession?.bundle} />
              )}
            </div>
          )}

          {/* SETTINGS */}
          {mainTab === "settings" && (
            <div className="flex-1 overflow-y-auto">
              <SettingsPanel
                app={app}
                tenantId={tenantId!}
                latestSession={latestSession}
                onAppChange={() => void appQuery.refetch()}
                onDelete={() => navigate("/app/apps")}
              />
            </div>
          )}

        </div>
      )}
    </>
  );
}
