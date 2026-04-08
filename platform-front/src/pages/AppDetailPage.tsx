import { useNavigate, useParams } from "react-router";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session";
import { useGenerationStore } from "@/stores/generation";
import { useApp, useWebhookAppLogs, useWidgetLogs, useAdminLogs } from "@/hooks/useApps";
import { useLatestSession, useLatestCompletedSession, useGeneration, useAppSessions, useSessionBundle } from "@/hooks/useGeneration";
import type { SessionSummary } from "@/types/dashboard";
import type { WebhookInvocationLogEntry, InvocationLogEntry, App, SessionBundle, ThemeTemplate, InjectionTarget } from "@/types/dashboard";
import { ArchetypePills } from "@/components/ui/ArchetypePills";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useThemeStore } from "@/stores/theme";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function humanizeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, , , dow] = parts;
  if (min === "0" && hour === "*") return "every hour";
  if (hour.startsWith("*/")) return `every ${hour.slice(2)} hours`;
  if (min.startsWith("*/")) return `every ${min.slice(2)} minutes`;
  const h = parseInt(hour, 10), m = parseInt(min, 10);
  if (!isNaN(h) && !isNaN(m) && dow === "*") {
    return `daily at ${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  }
  if (!isNaN(h) && !isNaN(m) && !isNaN(parseInt(dow, 10))) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${days[parseInt(dow, 10)] ?? "weekly"} at ${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  }
  return null;
}

// ─── Status configs ───────────────────────────────────────────────────────────

const LOG_STATUS_CFG = {
  success: { dot: "bg-teal",                     label: "success", cls: "text-teal"    },
  failed:  { dot: "bg-danger",                   label: "failed",  cls: "text-danger"  },
  running: { dot: "bg-accent animate-pulse",     label: "running", cls: "text-accent"  },
  queued:  { dot: "bg-faint",                    label: "queued",  cls: "text-faint"   },
  timeout: { dot: "bg-amber-400",                label: "timeout", cls: "text-amber-400"},
} satisfies Record<WebhookInvocationLogEntry["status"], { dot: string; label: string; cls: string }>;

const INVOCATION_STATUS_CFG = {
  success: { dot: "bg-teal",                 label: "success", cls: "text-teal"   },
  failed:  { dot: "bg-danger",               label: "failed",  cls: "text-danger" },
  running: { dot: "bg-accent animate-pulse", label: "running", cls: "text-accent" },
} satisfies Record<InvocationLogEntry["status"], { dot: string; label: string; cls: string }>;

// ─── Syntax highlighting ──────────────────────────────────────────────────────

const JS_KEYWORDS = new Set([
  "export", "function", "async", "await", "const", "let", "var", "if", "else",
  "return", "for", "while", "try", "catch", "throw", "new", "class", "extends",
  "import", "from", "null", "undefined", "true", "false", "of", "in", "typeof",
  "instanceof", "switch", "case", "break", "continue", "default", "delete", "do",
  "finally", "this", "super", "static", "get", "set", "yield",
]);

const SQL_KEYWORDS = new Set([
  "CREATE", "TABLE", "IF", "NOT", "EXISTS", "ALTER", "ADD", "COLUMN", "DROP",
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "INDEX", "ON", "DEFAULT",
  "NULL", "AND", "OR", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "AS", "WITH",
  "ENABLE", "ROW", "LEVEL", "SECURITY", "POLICY", "FOR", "USING", "TO", "GRANT",
  "RETURNS", "BEGIN", "END", "LANGUAGE", "PLPGSQL", "DECLARE", "RAISE", "EXCEPTION",
]);

const SQL_TYPES = new Set([
  "TEXT", "INTEGER", "BIGINT", "BIGSERIAL", "SERIAL", "BOOLEAN", "BOOL",
  "TIMESTAMP", "TIMESTAMPTZ", "DATE", "JSONB", "JSON", "UUID", "VARCHAR",
  "FLOAT", "DOUBLE", "NUMERIC", "REAL", "SMALLINT", "INT",
]);

type TokenType = "kw" | "str" | "cmt" | "num" | "fn" | "ty" | "txt";
type Token = { text: string; type: TokenType };

// Dark theme — slightly blue-tinted black (GitHub Dark-ish)
const DARK_PAL = {
  bg:       "#0d1219",
  gutterBg: "#11161f",
  border:   "rgba(255,255,255,0.045)",
  shadow:   "rgba(0,0,0,0.55)",
  lnum:     "rgba(149,142,160,0.28)",
  kw:  "#c792ea",  str: "#c3e88d",  cmt: "#546e7a",
  num: "#f78c6c",  fn:  "#82aaff",  ty:  "#89ddff",  txt: "#d4d4d4",
};

// Light theme — GitHub Light-inspired
const LIGHT_PAL = {
  bg:       "#f6f8fa",
  gutterBg: "#eef0f4",
  border:   "rgba(0,0,0,0.07)",
  shadow:   "rgba(0,0,0,0.06)",
  lnum:     "rgba(80,70,110,0.38)",
  kw:  "#a626a4",  str: "#50a14f",  cmt: "#9ca3af",
  num: "#986801",  fn:  "#4078f2",  ty:  "#0184bb",  txt: "#383a42",
};

function highlightJS(line: string): Token[] {
  const tokens: Token[] = [];
  let s = line;
  while (s.length > 0) {
    if (s.startsWith("//")) { tokens.push({ text: s, type: "cmt" }); break; }
    const strM = s.match(/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/);
    if (strM) { tokens.push({ text: strM[1], type: "str" }); s = s.slice(strM[1].length); continue; }
    const numM = s.match(/^(\b\d+(?:\.\d+)?\b)/);
    if (numM) { tokens.push({ text: numM[1], type: "num" }); s = s.slice(numM[1].length); continue; }
    const wordM = s.match(/^([a-zA-Z_$][\w$]*)/);
    if (wordM) {
      const w = wordM[1];
      const isKw = JS_KEYWORDS.has(w);
      const isFn = !isKw && s.slice(w.length).trimStart().startsWith("(");
      tokens.push({ text: w, type: isKw ? "kw" : isFn ? "fn" : "txt" });
      s = s.slice(w.length);
      continue;
    }
    tokens.push({ text: s[0], type: "txt" });
    s = s.slice(1);
  }
  return tokens;
}

function highlightSQL(line: string): Token[] {
  const tokens: Token[] = [];
  let s = line;
  while (s.length > 0) {
    if (s.startsWith("--")) { tokens.push({ text: s, type: "cmt" }); break; }
    const strM = s.match(/^('(?:''|[^'])*')/);
    if (strM) { tokens.push({ text: strM[1], type: "str" }); s = s.slice(strM[1].length); continue; }
    const numM = s.match(/^(\b\d+(?:\.\d+)?\b)/);
    if (numM) { tokens.push({ text: numM[1], type: "num" }); s = s.slice(numM[1].length); continue; }
    const wordM = s.match(/^([a-zA-Z_][\w]*)/);
    if (wordM) {
      const w = wordM[1];
      const up = w.toUpperCase();
      tokens.push({ text: w, type: SQL_KEYWORDS.has(up) ? "kw" : SQL_TYPES.has(up) ? "ty" : "txt" });
      s = s.slice(w.length);
      continue;
    }
    tokens.push({ text: s[0], type: "txt" });
    s = s.slice(1);
  }
  return tokens;
}

function CodeBlock({ code, lang }: { code: string; lang: "js" | "sql" }) {
  const theme = useThemeStore((s) => s.theme);
  const pal = theme === "light" ? LIGHT_PAL : DARK_PAL;
  const lines = code.split("\n");
  const highlight = lang === "sql" ? highlightSQL : highlightJS;
  const gutterW = lines.length >= 100 ? 54 : 44;

  return (
    <div className="h-full overflow-auto" style={{ background: pal.bg }}>
      {/* display:table keeps the sticky gutter cell pinned while
          the code cell scrolls horizontally with the container */}
      <div
        className="py-5 text-[12.5px] font-mono leading-[1.65]"
        style={{ display: "table", minWidth: "100%" }}
      >
        {lines.map((line, i) => {
          const tokens = highlight(line);
          return (
            <div key={i} style={{ display: "table-row" }}>

              {/* ── Gutter ─────────────────────────────────────────── */}
              <span
                className="select-none text-right"
                style={{
                  display: "table-cell",
                  position: "sticky",
                  left: 0,
                  zIndex: 1,
                  width: gutterW,
                  paddingLeft: 16,
                  paddingRight: 14,
                  background: pal.gutterBg,
                  borderRight: `1px solid ${pal.border}`,
                  boxShadow: `6px 0 18px ${pal.shadow}`,
                  color: pal.lnum,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {i + 1}
              </span>

              {/* ── Code ───────────────────────────────────────────── */}
              <span
                className="whitespace-pre"
                style={{ display: "table-cell", paddingLeft: 20, paddingRight: 48 }}
              >
                {tokens.length > 0
                  ? tokens.map((t, j) => <span key={j} style={{ color: pal[t.type] }}>{t.text}</span>)
                  : "\u00a0"}
              </span>

            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── App header ───────────────────────────────────────────────────────────────

const AVATAR_GRADIENTS = [
  "from-violet-500 to-indigo-600",
  "from-teal-500 to-emerald-600",
  "from-amber-500 to-orange-500",
  "from-rose-500 to-pink-600",
  "from-sky-500 to-blue-600",
  "from-lime-500 to-green-600",
];

function AppHeader({
  app, isGenerating,
}: {
  app: App;
  isGenerating: boolean;
}) {
  const initials = app.name.split(" ").slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
  const seed = app.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const gradient = AVATAR_GRADIENTS[seed % AVATAR_GRADIENTS.length];

  return (
    <div className="px-7 py-5 border-b border-white/[0.07] shrink-0">
      <div className="flex items-start gap-4">
        <div className={cn("w-12 h-12 rounded-2xl bg-gradient-to-br flex items-center justify-center shrink-0 shadow-lg", gradient)}>
          <span className="text-[14px] font-black text-white tracking-tight">{initials}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap mb-1.5">
            <h2 className="text-[18px] font-bold text-ink">{app.name}</h2>
            {isGenerating && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide bg-accent/12 text-accent border border-accent/20 animate-pulse">Building…</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-faint mb-1.5">
            <span>Created {formatDate(app.createdAt)}</span>
            <span className="opacity-40">·</span>
            <span>Updated {timeAgo(app.updatedAt)}</span>
          </div>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(app.id)}
            title="Copy App ID"
            className="flex items-center gap-1.5 bg-transparent border-0 p-0 cursor-pointer group"
          >
            <span className="text-[10px] text-faint/40 font-medium">App ID</span>
            <span className="font-mono text-[10px] text-faint/40 group-hover:text-accent transition-colors">{app.id}</span>
            <span className="material-symbols-outlined text-[11px] text-faint/25 group-hover:text-accent transition-colors">content_copy</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function EmptyLogs({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
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

function LogRow({ entry, last, showSource }: { entry: WebhookInvocationLogEntry; last: boolean; showSource?: boolean }) {
  const cfg = LOG_STATUS_CFG[entry.status];
  return (
    <div className={cn("flex items-start gap-4 px-5 py-3", !last && "border-b border-white/[0.05]")}>
      <div className="pt-1.5 shrink-0"><span className={cn("w-2 h-2 rounded-full block", cfg.dot)} /></div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-mono text-ink truncate">{entry.topic}</span>
          {showSource && <span className="text-[9.5px] font-bold uppercase tracking-wide text-faint border border-white/15 px-1 py-0.5 rounded">webhook</span>}
          <span className={cn("text-[10px] font-bold uppercase tracking-wide", cfg.cls)}>{cfg.label}</span>
        </div>
        {entry.errorMessage && <p className="text-[11px] text-danger mt-1 font-mono truncate">{entry.errorMessage}</p>}
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <div className="text-[10px] text-faint">{timeAgo(entry.queuedAt)}</div>
        <div className="text-[11px] font-mono text-faint">{formatDuration(entry.durationMs)}</div>
      </div>
    </div>
  );
}

function InvocationLogRow({ entry, last, source }: { entry: InvocationLogEntry; last: boolean; source?: "widget" | "admin" }) {
  const cfg = INVOCATION_STATUS_CFG[entry.status];
  return (
    <div className={cn("flex items-start gap-4 px-5 py-3", !last && "border-b border-white/[0.05]")}>
      <div className="pt-1.5 shrink-0"><span className={cn("w-2 h-2 rounded-full block", cfg.dot)} /></div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-mono text-ink truncate">{entry.path}</span>
          {source && <span className="text-[9.5px] font-bold uppercase tracking-wide text-faint border border-white/15 px-1 py-0.5 rounded">{source}</span>}
          <span className={cn("text-[10px] font-bold uppercase tracking-wide", cfg.cls)}>{cfg.label}</span>
        </div>
        {entry.errorMessage && <p className="text-[11px] text-danger mt-1 font-mono truncate">{entry.errorMessage}</p>}
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <div className="text-[10px] text-faint">{timeAgo(entry.invokedAt)}</div>
        <div className="text-[11px] font-mono text-faint">{formatDuration(entry.durationMs)}</div>
      </div>
    </div>
  );
}

function TabBar<T extends string>({
  tabs, active, onChange, end, action,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (t: T) => void;
  /** Renders flush-right (e.g. refresh button inside a sub-tab bar). */
  end?: React.ReactNode;
  /** Renders right after the last tab with a hairline separator — use for primary page actions. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-white/[0.07] pb-0">
      {tabs.map((t) => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)}
          className={cn(
            "px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors bg-transparent border-x-0 border-t-0 cursor-pointer",
            active === t.id ? "border-accent text-ink" : "border-transparent text-faint hover:text-ink"
          )}
        >{t.label}</button>
      ))}
      {action && (
        <>
          <span className="w-px h-3.5 bg-white/[0.12] mx-1.5 self-center shrink-0" />
          <div className="-mb-px">{action}</div>
        </>
      )}
      {end && <div className="flex-1 flex items-center justify-end gap-2 mb-0.5">{end}</div>}
    </div>
  );
}

// ─── Code viewer ──────────────────────────────────────────────────────────────

function CodeViewer({ bundle }: { bundle: SessionBundle | null | undefined }) {
  const files = [
    ...(bundle?.handlerModule?.code ? [{ id: "handler" as const, label: "handler.js",   lang: "js"  as const, code: bundle.handlerModule.code }] : []),
    ...(bundle?.widgetModule        ? [{ id: "widget"  as const, label: "widget.js",    lang: "js"  as const, code: bundle.widgetModule        }] : []),
    ...(bundle?.adminUiModule       ? [{ id: "admin"   as const, label: "admin-ui.js",  lang: "js"  as const, code: bundle.adminUiModule       }] : []),
  ];

  const [activeFile, setActiveFile] = useState<string>(files[0]?.id ?? "handler");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (files.length && !files.find((f) => f.id === activeFile)) setActiveFile(files[0].id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle]);

  if (!files.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
        <div className="w-12 h-12 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
          <span className="material-symbols-outlined text-faint text-[22px]">code_blocks</span>
        </div>
        <p className="text-sm text-faint">No generated code yet</p>
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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-white/[0.07] shrink-0 bg-surface">
        {files.map((f) => (
          <button key={f.id} type="button" onClick={() => setActiveFile(f.id)}
            className={cn(
              "px-3.5 py-2.5 text-[11px] font-mono border-b-2 -mb-px transition-colors bg-transparent border-x-0 border-t-0 cursor-pointer",
              activeFile === f.id ? "border-accent text-ink" : "border-transparent text-faint hover:text-ink"
            )}
          >{f.label}</button>
        ))}
        <div className="flex-1" />
        <button type="button" onClick={copyCode}
          className="flex items-center gap-1.5 text-[11px] text-faint hover:text-accent transition-colors bg-transparent border-0 cursor-pointer px-3.5 py-2.5"
        >
          <span className="material-symbols-outlined text-[14px]">{copied ? "check" : "content_copy"}</span>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Highlighted code */}
      <div className="flex-1 overflow-hidden">
        <CodeBlock code={current.code} lang={current.lang} />
      </div>
    </div>
  );
}

// ─── Versions tab ─────────────────────────────────────────────────────────────

const SESSION_STATUS_CFG = {
  completed: { dot: "bg-teal",                     label: "Generated",  cls: "text-teal"   },
  failed:    { dot: "bg-danger",                   label: "Failed",     cls: "text-danger" },
  running:   { dot: "bg-accent animate-pulse",     label: "Running",    cls: "text-accent" },
} satisfies Record<string, { dot: string; label: string; cls: string }>;

function VersionsTab({
  sessions, sessionsLoading, latestSession, app,
}: {
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  latestSession: { status: string; bundle?: import("@/types/dashboard").SessionBundle | null } | null;
  app: App;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default selection: latest session
  useEffect(() => {
    if (sessions.length && !selectedId) setSelectedId(sessions[0].id);
  }, [sessions, selectedId]);

  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;
  // Show code from latestSession when selectedId matches the first (latest) session
  const isLatest = selected?.id === sessions[0]?.id;
  // For non-latest completed sessions, fetch their bundle on demand
  const nonLatestJobId = (!isLatest && selected?.status === "completed") ? (selected.jobId ?? null) : null;
  const { data: selectedBundleData } = useSessionBundle(nonLatestJobId);
  const bundleToShow = isLatest ? latestSession?.bundle : (selectedBundleData?.bundle ?? null);

  return (
    <div className="flex-1 overflow-hidden flex gap-0">

      {/* ── Left: session list ── */}
      <div className="w-[260px] shrink-0 border-r border-white/[0.07] flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.07] bg-white/[0.02] shrink-0">
          <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">Generation history</h3>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessionsLoading ? (
            <div className="p-3 space-y-2">
              {[1,2,3].map((i) => <div key={i} className="h-14 bg-white/[0.03] rounded-lg animate-pulse-subtle border border-white/[0.06]" />)}
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[11px] text-faint">No versions yet</div>
          ) : (
            <div className="p-2 space-y-1">
              {sessions.map((s, i) => {
                const cfg = SESSION_STATUS_CFG[s.status as keyof typeof SESSION_STATUS_CFG]
                  ?? { dot: "bg-faint/40", label: s.status, cls: "text-faint" };
                const isSelected = s.id === selected?.id;
                // "Live" = this session's bundle is what's currently running in production
                const isLive = app.status === "active" && !!s.appVersionId && s.appVersionId === app.activeAppVersionId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 rounded-lg border transition-colors cursor-pointer bg-transparent",
                      isSelected
                        ? "border-accent/30 bg-accent/[0.07]"
                        : "border-transparent hover:bg-white/[0.04] hover:border-white/[0.08]"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", cfg.dot)} />
                        <span className={cn("text-[10px] font-semibold", cfg.cls)}>{cfg.label}</span>
                        {isLive && (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-teal/15 border border-teal/25 text-[9px] font-bold text-teal uppercase tracking-wide leading-none">
                            <span className="w-1 h-1 rounded-full bg-teal animate-pulse inline-block" />
                            Live
                          </span>
                        )}
                      </div>
                      <span className="text-[9.5px] text-faint/60 shrink-0">
                        v{sessions.length - i}
                      </span>
                    </div>
                    <p className="text-[11px] text-ink/70 truncate leading-tight">{s.prompt}</p>
                    {s.status === "failed" && s.errorMessage && (
                      <p className="text-[10px] text-danger/80 truncate mt-0.5">{s.errorMessage}</p>
                    )}
                    <p className="text-[10px] text-faint/50 mt-1">{formatDate(s.createdAt)}</p>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: code viewer ── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-faint">Select a version to view code</div>
        ) : selected.status === "failed" ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
            <div className="w-12 h-12 rounded-xl bg-danger/[0.08] border border-danger/20 flex items-center justify-center">
              <span className="material-symbols-outlined text-danger text-[22px]">error</span>
            </div>
            <p className="text-[13px] font-semibold text-ink/80">Generation failed</p>
            {selected.errorMessage && (
              <p className="text-[12px] text-faint max-w-[420px]">{selected.errorMessage}</p>
            )}
          </div>
        ) : selected.status === "running" ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-[12px] text-accent">
            <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
            Generating…
          </div>
        ) : (
          <CodeViewer bundle={bundleToShow} />
        )}
      </div>

    </div>
  );
}

// ─── Validation step builder ──────────────────────────────────────────────────

const WEBHOOK_TRIGGER_HINTS: Record<string, string> = {
  "orders/create":              "Place a test order through your storefront.",
  "orders/updated":             "Edit and save an existing order in admin.",
  "orders/paid":                "Mark a pending order as paid in admin.",
  "orders/fulfilled":           "Fulfill a pending order in admin.",
  "orders/cancelled":           "Cancel an order in Shopify Admin.",
  "orders/partially_fulfilled": "Partially fulfill an order in admin.",
  "products/create":            "Create a new product in Shopify Admin.",
  "products/update":            "Edit and save a product in Shopify Admin.",
  "products/delete":            "Delete a product in Shopify Admin.",
  "customers/create":           "Create a new customer in Shopify Admin.",
  "customers/update":           "Edit and save a customer's details in admin.",
  "customers/delete":           "Delete a customer in Shopify Admin.",
  "inventory_levels/update":    "Adjust stock for a product variant: Products → [product] → Edit.",
  "inventory_levels/connect":   "Connect inventory for a product variant in admin.",
  "collections/create":         "Create a new collection in Shopify Admin.",
  "collections/update":         "Edit and save a collection in Shopify Admin.",
  "fulfillments/create":        "Fulfill an order from the Orders section in admin.",
  "refunds/create":             "Issue a refund on an existing order in admin.",
  "draft_orders/create":        "Create a draft order in Shopify Admin.",
  "checkouts/create":           "Start a checkout in your storefront.",
  "carts/create":               "Add a product to cart in your storefront.",
  "app/uninstalled":            "Uninstall the app from admin (careful — reinstall to restore).",
};

function buildValidationSteps({
  webhookTopics,
  cronSchedule,
  hasWidget,
  hasAdminUI,
}: {
  webhookTopics: string[];
  cronSchedule: string | null;
  hasWidget: boolean;
  hasAdminUI: boolean;
}): { text: string; isRevise?: boolean }[] {
  const steps: { text: string; isRevise?: boolean }[] = [];

  if (hasWidget) {
    steps.push({ text: "Open your live storefront in a browser (not the Shopify Admin preview)." });
    steps.push({ text: "Navigate to the page where the widget is placed — usually a product page." });
    steps.push({ text: "Confirm the widget is visible and interactive. Test its behavior end-to-end." });
    if (webhookTopics.length === 0 && !cronSchedule) {
      steps.push({ text: "Open the Logs tab → Widget to see invocation logs and catch any errors." });
    }
  }

  if (hasAdminUI) {
    steps.push({ text: "In Shopify Admin, go to Apps & sales channels and open this app." });
    steps.push({ text: "Verify the panel loads correctly and all buttons, forms, and actions work." });
    if (webhookTopics.length === 0 && !cronSchedule) {
      steps.push({ text: "Open the Logs tab → Admin to review invocation logs." });
    }
  }

  if (webhookTopics.length > 0) {
    const topic = webhookTopics[0];
    const hint = WEBHOOK_TRIGGER_HINTS[topic] ?? "Perform the relevant action in Shopify admin or your storefront.";
    steps.push({ text: `Trigger a ${topic} event — ${hint}` });
    steps.push({ text: "Wait a few seconds, then open the Logs tab → Webhook and confirm the status is success." });
    steps.push({ text: "Check your store to verify the expected outcome actually occurred." });
    if (webhookTopics.length > 1) {
      steps.push({ text: `Repeat for the other registered topics: ${webhookTopics.slice(1).join(", ")}.` });
    }
  }

  if (cronSchedule) {
    const human = humanizeCron(cronSchedule);
    steps.push({ text: `This app runs on a schedule${human ? ` (${human})` : `: ${cronSchedule}`}. Wait for the next run.` });
    steps.push({ text: "After it fires, open the Logs tab → Webhook and confirm the status is success." });
    steps.push({ text: "Verify the expected outcome in your store or admin." });
  }

  if (!hasWidget && !hasAdminUI && webhookTopics.length === 0 && !cronSchedule) {
    steps.push({ text: "Trigger the relevant action in Shopify to activate the handler." });
    steps.push({ text: "Open the Logs tab and confirm the handler ran with status success." });
    steps.push({ text: "Verify the expected outcome occurred in your store." });
  }

  steps.push({
    text: "Found a logic error, wrong behavior, or missing functionality? Click Revise → and describe the issue — Ton will fix it.",
    isRevise: true,
  });

  return steps;
}

// ─── How it works card ────────────────────────────────────────────────────────

function HowItWorksCard({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const sentences = text
    .replace(/\n+/g, " ")
    .match(/[^.!?]+[.!?]+/g)
    ?.map((s) => s.trim())
    .filter(Boolean) ?? [text];
  const PREVIEW = 3;
  const visible  = expanded ? sentences : sentences.slice(0, PREVIEW);
  const hasMore  = sentences.length > PREVIEW;

  return (
    <section className="bg-white/[0.06] border border-white/[0.10] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.08] bg-white/[0.04] flex items-center gap-2">
        <span className="material-symbols-outlined text-accent text-[13px]" style={{ fontVariationSettings: "'FILL' 1" }}>info</span>
        <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">How it works</h3>
      </div>
      <div className="px-5 py-4">
        <div className="relative pl-4">
          {/* vertical guide line */}
          <div className="absolute left-[5px] top-2 bottom-2 w-px bg-white/[0.08]" />
          <div className="space-y-3.5">
            {visible.map((sentence, i) => (
              <div key={i} className="relative flex gap-3">
                <span className="absolute -left-4 top-[5px] w-2 h-2 rounded-full bg-accent/40 ring-2 ring-accent/10 shrink-0" />
                <p className="text-[12px] font-medium text-muted leading-relaxed">{sentence}</p>
              </div>
            ))}
          </div>
        </div>
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="mt-3.5 flex items-center gap-1 text-[11px] text-accent/70 hover:text-accent transition-colors bg-transparent border-0 cursor-pointer p-0"
          >
            {expanded ? "Show less" : `+${sentences.length - PREVIEW} more`}
            <span className="material-symbols-outlined text-[13px]">
              {expanded ? "expand_less" : "expand_more"}
            </span>
          </button>
        )}
      </div>
    </section>
  );
}

// ─── Overview dashboard components ───────────────────────────────────────────

function buildStatusPill(
  app: App,
  latestSession: { status: string } | null,
  deploying: boolean,
  isBuilding: boolean,
  hasFallback: boolean,
  onDeploy: () => void,
  onRedeploy: () => void,
  onDeactivate: () => void,
) {
  const sessionFailed = latestSession?.status === "failed";
  const isReady    = app.status === "ready" && !sessionFailed;
  const isReadyFallback = app.status === "ready" && sessionFailed && hasFallback;
  const isReadyBlocked  = app.status === "ready" && sessionFailed && !hasFallback;
  const isActive   = app.status === "active";
  const isInactive = app.status === "inactive";

  if (isBuilding) return {
    statusDot: "bg-accent animate-pulse", statusText: "Building…",
    pillBorder: "border-accent/20", pillBg: "bg-accent/[0.06]",
    action: null, note: null,
  };
  if (isReady) return {
    statusDot: "bg-amber-400", statusText: "Ready to deploy",
    pillBorder: "border-amber-400/25", pillBg: "bg-amber-400/[0.06]",
    action: { icon: "rocket_launch", label: deploying ? "Deploying…" : "Deploy", onClick: onDeploy,
      cls: "text-accent hover:bg-accent/[0.12]" },
    note: null,
  };
  if (isReadyFallback) return {
    statusDot: "bg-amber-400", statusText: "Generation failed",
    pillBorder: "border-amber-400/25", pillBg: "bg-amber-400/[0.06]",
    action: { icon: "rocket_launch", label: deploying ? "Deploying…" : "Deploy last version", onClick: onDeploy,
      cls: "text-accent hover:bg-accent/[0.12]" },
    note: "Last generation failed — deploying previous successful version",
  };
  if (isReadyBlocked) return {
    statusDot: "bg-danger", statusText: "Generation failed",
    pillBorder: "border-danger/20", pillBg: "bg-danger/[0.04]",
    action: null,
    note: "No successful version to deploy — generate a new version first",
  };
  if (isActive) return {
    statusDot: "bg-teal", statusText: "Active",
    pillBorder: "border-teal/20", pillBg: "bg-teal/[0.05]",
    action: { icon: "pause_circle", label: deploying ? "Deactivating…" : "Deactivate", onClick: onDeactivate,
      cls: "text-danger hover:bg-danger/[0.10]" },
    note: null,
  };
  if (isInactive) return {
    statusDot: "bg-faint/50", statusText: "Inactive",
    pillBorder: "border-teal/20", pillBg: "bg-teal/[0.05]",
    action: { icon: "play_circle", label: deploying ? "Activating…" : "Activate", onClick: onRedeploy,
      cls: "text-green-500 hover:bg-green-500/[0.10]" },
    note: null,
  };
  return {
    statusDot: "bg-faint/40", statusText: app.status.charAt(0).toUpperCase() + app.status.slice(1),
    pillBorder: "border-white/[0.08]", pillBg: "bg-white/[0.02]",
    action: null, note: null,
  };
}

function AppInfoBand({
  app, latestSession, hasFallback, onDeploy, onRedeploy, onDeactivate, deploying, isBuilding,
}: {
  app: App;
  latestSession: { status: string } | null;
  hasFallback: boolean;
  onDeploy: () => void; onRedeploy: () => void; onDeactivate: () => void;
  deploying: boolean; isBuilding: boolean;
}) {
  const pill = buildStatusPill(app, latestSession, deploying, isBuilding, hasFallback, onDeploy, onRedeploy, onDeactivate);

  return (
    <div className="flex flex-col shrink-0 border-b border-white/[0.06]">
      <div className="flex items-center justify-between">

        {/* ── App type ── */}
        <div className="flex flex-col gap-1.5 px-5 py-2.5">
          <span className="text-[10px] text-faint/40 font-medium whitespace-nowrap">App type</span>
          <div className="flex items-center gap-2 flex-wrap">
            <ArchetypePills archetype={app.appArchetype} />
            {app.currentSemver && (
              <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.10] text-faint/70">
                v{app.currentSemver}
              </span>
            )}
          </div>
        </div>

        <div className="w-px bg-white/[0.06] my-1.5 shrink-0" />

        {/* ── Status + action ── */}
        <div className="flex flex-col gap-1.5 px-5 py-2.5">
          <span className="text-[10px] text-faint/40 font-medium whitespace-nowrap">Status</span>
          <div className={cn("flex items-stretch rounded-full border overflow-hidden text-[12px] font-medium", pill.pillBorder, pill.pillBg)}>
            <div className="flex items-center justify-center gap-2 px-3.5 py-1.5 min-w-[130px]">
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", pill.statusDot)} />
              <span className="text-ink/80 whitespace-nowrap">{pill.statusText}</span>
            </div>
            {pill.action && (
              <>
                <span className={cn("w-px self-stretch", pill.pillBorder)} />
                <button
                  type="button"
                  onClick={pill.action.onClick}
                  disabled={deploying}
                  className={cn(
                    "flex items-center justify-center gap-1.5 px-3.5 py-1.5 min-w-[120px] transition-colors cursor-pointer border-0 bg-transparent disabled:opacity-40 disabled:cursor-not-allowed font-semibold whitespace-nowrap",
                    pill.action.cls
                  )}
                >
                  <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                    {pill.action.icon}
                  </span>
                  {pill.action.label}
                </button>
              </>
            )}
          </div>
          {pill.note && (
            <div className="flex items-center gap-1 text-[10px] text-faint/70">
              <span className="material-symbols-outlined text-[11px]">info</span>
              {pill.note}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function MiniStats({
  activity, loading,
}: {
  activity: Array<{ status: string; durationMs: number | null; ts: string }>;
  loading: boolean;
}) {
  const lastRun = activity[0]?.ts ?? null;
  const total   = activity.length;
  const successRate = total > 0
    ? Math.round((activity.filter((e) => e.status === "success").length / total) * 100)
    : null;
  const durations = activity.filter((e) => e.durationMs !== null).map((e) => e.durationMs!);
  const avgMs = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  const stats = [
    { icon: "history",       label: "Last run",     value: lastRun ? timeAgo(lastRun) : "—",
      color: "text-ink" },
    { icon: "bolt",          label: "Recent runs",  value: total > 0 ? String(total) : "—",
      color: "text-ink" },
    { icon: "avg_pace",      label: "Avg latency",  value: avgMs !== null ? formatDuration(avgMs) : "—",
      color: "text-ink" },
    { icon: "check_circle",  label: "Success rate", value: successRate !== null ? `${successRate}%` : "—",
      color: successRate === null ? "text-ink" : successRate >= 90 ? "text-teal" : successRate >= 70 ? "text-amber-400" : "text-danger" },
  ];

  if (loading) return (
    <div className="grid grid-cols-4 gap-2">
      {[1,2,3,4].map((i) => <div key={i} className="h-16 bg-white/[0.03] rounded-xl animate-pulse-subtle" />)}
    </div>
  );

  return (
    <div className="grid grid-cols-4 gap-2">
      {stats.map((s) => (
        <div key={s.label} className="bg-white/[0.06] border border-white/[0.10] rounded-xl px-3.5 py-3">
          <div className="flex items-center gap-1 text-faint mb-1.5">
            <span className="material-symbols-outlined text-[12px]">{s.icon}</span>
            <span className="text-[9.5px] font-bold uppercase tracking-wider">{s.label}</span>
          </div>
          <div className={cn("text-[15px] font-bold tracking-tight leading-none", s.color)}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  app, latestSession, recentLogs, recentWidgetLogs, recentAdminLogs, recentLogsLoading, shopDomain, onLogsTab,
  injectingWidget, injectError, onInjectWidget, onDeleteInjectedTheme,
}: {
  app: App;
  latestSession: {
    status: string; webhookTopics?: string[]; cronSchedule?: string | null;
    prompt?: string | null; bundle?: SessionBundle | null;
  } | null;
  recentLogs: WebhookInvocationLogEntry[];
  recentWidgetLogs: InvocationLogEntry[];
  recentAdminLogs: InvocationLogEntry[];
  recentLogsLoading: boolean;
  shopDomain: string | null;
  onLogsTab: () => void;
  injectingWidget: boolean;
  injectError: string | null;
  onInjectWidget: () => void;
  onDeleteInjectedTheme: () => void;
}) {
  const webhookTopics  = latestSession?.webhookTopics ?? [];
  const cronSchedule   = latestSession?.cronSchedule ?? null;
  const appExplanation = (() => {
    const exp = latestSession?.bundle?.explanation;
    if (!exp) return null;
    if (typeof exp === "string") return exp;
    return exp.merchantFacing ?? null;
  })();

  const hasWidget  = !!(latestSession?.bundle?.widgetModule  ?? (app.appArchetype === "storefront_backend" || app.appArchetype === "storefront_backend_admin"));
  const hasAdminUI = !!(latestSession?.bundle?.adminUiModule ?? (app.appArchetype === "backend_admin"      || app.appArchetype === "storefront_backend_admin"));

  const effectiveShop = app.shopDomain || shopDomain || null;
  const storeFrontUrl = effectiveShop ? `https://${effectiveShop}` : null;
  const adminUrl      = effectiveShop ? `https://${effectiveShop}/admin` : null;

  const theme = useThemeStore((s) => s.theme);
  const navigate = useNavigate();
  const validateSteps = buildValidationSteps({ webhookTopics, cronSchedule, hasWidget, hasAdminUI });

  // Merged activity — used by both MiniStats and the activity feed
  type AnyEntry =
    | { kind: "webhook"; data: WebhookInvocationLogEntry; ts: string }
    | { kind: "widget" | "admin"; data: InvocationLogEntry; ts: string };
  const allActivity: AnyEntry[] = [
    ...recentLogs.map((d) => ({ kind: "webhook" as const, data: d, ts: d.queuedAt })),
    ...recentWidgetLogs.map((d) => ({ kind: "widget" as const, data: d, ts: d.invokedAt })),
    ...recentAdminLogs.map((d) => ({ kind: "admin" as const, data: d, ts: d.invokedAt })),
  ].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, 15);

  const statsActivity = allActivity.map((e) => ({
    status: e.kind === "webhook"
      ? (e.data as WebhookInvocationLogEntry).status
      : (e.data as InvocationLogEntry).status,
    durationMs: e.data.durationMs,
    ts: e.ts,
  }));

  return (
    <div className="flex-1 overflow-y-auto flex flex-col">

      <div className="max-w-[960px] mx-auto p-7 grid grid-cols-[1fr_280px] gap-6 items-start w-full">

        {/* ── LEFT COLUMN ──────────────────────────────────────────────── */}
        <div className="space-y-5">

          {latestSession !== null && (
            <MiniStats activity={statsActivity} loading={recentLogsLoading} />
          )}

          {/* How it works */}
          {appExplanation && <HowItWorksCard text={appExplanation} />}

          {/* Triggers */}
          {(webhookTopics.length > 0 || cronSchedule) && (
            <section className="bg-white/[0.06] border border-white/[0.10] rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.08] bg-white/[0.04]">
                <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">Triggers</h3>
              </div>
              <div className="divide-y divide-white/[0.05]">
                {webhookTopics.length > 0 && (
                  <div className="px-5 py-3.5">
                    <p className="text-[11px] font-semibold text-faint mb-2">Active webhooks</p>
                    <div className="flex flex-wrap gap-1.5">
                      {webhookTopics.map((t) => (
                        <span key={t} className="text-[11px] font-mono px-2 py-0.5 bg-white/[0.05] border border-white/[0.07] rounded-md text-ink">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {cronSchedule && (
                  <div className="px-5 py-3.5">
                    <p className="text-[11px] font-semibold text-faint mb-1.5">Cron schedule</p>
                    <div className="flex items-center gap-3">
                      <code className="text-[12px] font-mono text-ink bg-white/[0.04] px-2.5 py-1 rounded-lg border border-white/[0.07]">
                        {cronSchedule}
                      </code>
                      {humanizeCron(cronSchedule) && (
                        <span className="text-[11px] font-medium text-muted">{humanizeCron(cronSchedule)}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Recent activity */}
          {latestSession !== null && (
            <section className="bg-white/[0.06] border border-white/[0.10] rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.08] bg-white/[0.04] flex items-center justify-between">
                <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">Recent Activity</h3>
                <button type="button" onClick={onLogsTab}
                  className="text-[10px] text-faint hover:text-accent transition-colors bg-transparent border-0 cursor-pointer">
                  All logs →
                </button>
              </div>
              {recentLogsLoading ? (
                <div className="px-5 py-4 space-y-2">
                  {[1,2,3].map((i) => <div key={i} className="h-8 bg-white/[0.03] rounded-lg animate-pulse-subtle" />)}
                </div>
              ) : allActivity.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <span className="material-symbols-outlined text-faint/40 text-[28px] block mb-2">query_stats</span>
                  <p className="text-[12px] text-faint">No executions yet</p>
                  <p className="text-[11px] text-faint/60 mt-0.5">Logs appear once Shopify sends events.</p>
                </div>
              ) : (
                <div className="max-h-[420px] overflow-y-auto">
                  {allActivity.map((entry, i, arr) =>
                    entry.kind === "webhook"
                      ? <LogRow key={entry.data.id} entry={entry.data} last={i === arr.length - 1} showSource />
                      : <InvocationLogRow key={entry.data.id} entry={entry.data} source={entry.kind} last={i === arr.length - 1} />
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        {/* ── RIGHT COLUMN ─────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Shopify — only for generated apps (above How to test) */}
          {latestSession !== null && (storeFrontUrl || adminUrl) && (() => {
            const isInjected = hasWidget && app.themeInjectionStatus === "injected" && app.themeInjectionThemeId;
            // Editor URL works reliably (no password wall) — use it as the primary "open" action
            const editorUrl = isInjected && effectiveShop
              ? `https://${effectiveShop}/admin/themes/${app.themeInjectionThemeId}/editor`
              : null;
            // Injected: use Shopify's preview_theme_id param — opens the storefront with the
            // test theme active (works because the merchant is authenticated in Shopify admin).
            // Not injected: just go to the live storefront directly.
            const storefrontPreviewUrl = isInjected && effectiveShop
              ? `https://${effectiveShop}/?preview_theme_id=${app.themeInjectionThemeId}`
              : storeFrontUrl;

            return (
              <section className="bg-white/[0.06] border border-white/[0.10] rounded-xl overflow-hidden">
                {/* Section header */}
                <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.08] bg-white/[0.04]">
                  <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">Open in Shopify</h3>
                </div>

                <div>

                  {/* ── Admin ── */}
                  {adminUrl && (
                    <a href={adminUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-3 px-4 py-3 no-underline transition-colors hover:bg-white/[0.05] group"
                    >
                      <span className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", theme === "light" ? "bg-orange-600/[0.08]" : "bg-orange-400/[0.12]")}>
                        <span className={cn("material-symbols-outlined text-[15px]", theme === "light" ? "text-orange-700" : "text-orange-300")} style={{ fontVariationSettings: "'FILL' 1" }}>admin_panel_settings</span>
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-medium text-ink leading-tight">
                          {hasAdminUI ? "Admin panel" : "Shopify Admin"}
                        </div>
                        <div className="text-[10px] text-faint mt-0.5">
                          {hasAdminUI ? "Open your app's admin UI" : "Open Shopify store dashboard"}
                        </div>
                      </div>
                      <span className="material-symbols-outlined text-[13px] text-faint/40 group-hover:text-faint transition-colors">arrow_outward</span>
                    </a>
                  )}

                  {/* ── Storefront ── */}
                  {storefrontPreviewUrl && (
                    <a href={storefrontPreviewUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-3 px-4 py-3 no-underline transition-colors hover:bg-white/[0.05] group"
                    >
                      <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                        style={{ backgroundColor: theme === "light" ? "rgba(88,166,44,0.12)" : "rgba(150,191,72,0.15)" }}>
                        <span className="material-symbols-outlined text-[15px]"
                          style={{ color: theme === "light" ? "#3a7d17" : "#96bf48", fontVariationSettings: "'FILL' 1" }}>storefront</span>
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-medium text-ink leading-tight">View storefront</div>
                        <div className="text-[10px] text-faint mt-0.5">
                          {isInjected ? "Preview your theme copy with the app block injected" : "Live storefront"}
                        </div>
                      </div>
                      <span className="material-symbols-outlined text-[13px] text-faint/40 group-hover:text-faint transition-colors">arrow_outward</span>
                    </a>
                  )}

                  {/* ── new-one-two App Block (widget apps only) ── */}
                  {hasWidget && (
                    <div className={cn(isInjected && "bg-accent/[0.03]")}>
                      <div className={cn("mx-4 mt-3 mb-1 border-t", theme === "light" ? "border-black/[0.10]" : "border-white/[0.08]")} />
                      {/* Block header row */}
                      <div className="flex items-center gap-3 px-4 py-3">
                        <span className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", theme === "light" ? "bg-sky-600/[.08]" : "bg-sky-400/[.12]")}>
                          <span className={cn("material-symbols-outlined text-[15px]", theme === "light" ? "text-sky-700" : "text-sky-300")}
                            style={{ fontVariationSettings: "'FILL' 1" }}>widgets</span>
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className="text-[12px] font-medium leading-tight text-ink">
                            new-one-two App Block
                          </span>
                          <div className={cn("text-[10px] mt-0.5", isInjected ? "text-faint" : "text-faint")}>
                            {isInjected
                              ? "Injected on a private copy · live store unchanged"
                              : "Installs the block on a private copy of your theme for testing"}
                          </div>
                        </div>
                      </div>

                      {/* Injected actions */}
                      {isInjected && (
                        <div className="px-4 pb-4 space-y-2">
                          {editorUrl && (
                            <a href={editorUrl} target="_blank" rel="noopener noreferrer"
                              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11.5px] font-semibold text-accent bg-accent/[0.10] hover:bg-accent/[0.16] border border-accent/[0.20] no-underline transition-colors"
                            >
                              <span className="material-symbols-outlined text-[13px]">brush</span>
                              Open theme editor
                              <span className="material-symbols-outlined text-[10px] opacity-60">arrow_outward</span>
                            </a>
                          )}
                          <button onClick={onDeleteInjectedTheme}
                            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11.5px] font-semibold text-danger bg-danger/[0.08] hover:bg-danger/[0.14] border border-danger/[0.20] transition-colors cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[13px]">delete</span>
                            Remove test theme copy
                          </button>
                        </div>
                      )}

                      {/* Not injected CTA */}
                      {!isInjected && (
                        <div className="px-4 pb-4 space-y-2 flex flex-col items-center">
                          {injectingWidget ? (
                            <div className="flex items-center gap-2 py-1 text-[12px] text-accent">
                              <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                              Installing… this may take ~30 seconds
                            </div>
                          ) : app.status === "active" ? (
                            <button onClick={onInjectWidget}
                              className={cn(
                                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer transition-colors border",
                                theme === "light"
                                  ? "text-sky-700 bg-sky-600/[.08] hover:bg-sky-600/[.14] border-sky-600/[.18]"
                                  : "text-sky-300 bg-sky-400/[.12] hover:bg-sky-400/[.20] border-sky-400/[.2]"
                              )}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}>install_desktop</span>
                              Install on test theme
                            </button>
                          ) : (
                            <div className="flex items-center gap-2 py-2 text-[11px] text-faint">
                              <span className="material-symbols-outlined text-[13px]">lock</span>
                              Activate the app first to install the block
                            </div>
                          )}
                          {injectError && (
                            <div className="w-full flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 text-danger text-[11px]">
                              <span className="material-symbols-outlined text-[13px] mt-0.5 shrink-0">error</span>
                              <span>{injectError}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                </div>
              </section>
            );
          })()}

          {/* How to test / Revise CTA */}
          {latestSession === null ? (
            <section className="bg-white/[0.06] border border-white/[0.10] rounded-xl overflow-hidden">
              <div className="px-4 py-5 space-y-3 text-center">
                <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center mx-auto">
                  <span className="material-symbols-outlined text-accent text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-ink">Ready to build?</p>
                  <p className="text-[11px] text-faint mt-1 leading-relaxed">Describe what you want this app to do and Ton will generate it.</p>
                </div>
                <button type="button" onClick={() => navigate(`/app/apps/${app.id}/revise`)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-accent text-white text-[13px] font-semibold transition-all hover:opacity-90 cursor-pointer border-0">
                  <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                  Start building with Ton
                </button>
              </div>
            </section>
          ) : (
            <section className="bg-white/[0.06] border border-white/[0.10] rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.08] bg-white/[0.04]">
                <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">How to test</h3>
              </div>
              <div className="mx-4 mt-4 mb-3 px-3.5 py-3 bg-accent/5 border border-accent/[0.12] rounded-xl space-y-2.5 flex flex-col">
                <p className="text-[11px] text-accent/90 leading-relaxed">
                  {validateSteps.find((s) => s.isRevise)?.text}
                </p>
                <button type="button" onClick={() => navigate(`/app/apps/${app.id}/revise`)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-accent/15 text-accent text-[11px] font-semibold hover:bg-accent/25 transition-colors cursor-pointer border border-accent/25 self-center">
                  <span className="material-symbols-outlined" style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                  Revise with Ton
                </button>
              </div>
              <ol className="px-4 pb-4 pt-1 space-y-3">
                {validateSteps.filter((s) => !s.isRevise).map((step, i) => (
                  <li key={i} className="flex gap-2.5 text-[12px] text-muted leading-relaxed">
                    <span className="w-5 h-5 rounded-full bg-accent/10 flex items-center justify-center text-accent text-[10px] font-bold shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    <span>{step.text}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── Settings panel ───────────────────────────────────────────────────────────

function SettingsPanel({
  app, tenantId, onAppChange, onDelete,
}: {
  app: App;
  tenantId: string;
  onAppChange: () => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming]       = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const startRename = () => { setRenameValue(app.name); setRenaming(true); };
  const commitRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === app.name) { setRenaming(false); return; }
    setRenameSaving(true);
    try { await api.apps.rename(tenantId, app.id, trimmed); onAppChange(); }
    finally { setRenameSaving(false); setRenaming(false); }
  };

  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    setDeleting(true);
    try { await api.apps.delete(tenantId, app.id); onDelete(); }
    finally { setDeleting(false); setDeleteConfirm(false); }
  };

  const [permDeleteInput, setPermDeleteInput] = useState("");
  const [permDeleteOpen, setPermDeleteOpen]   = useState(false);
  const [permDeleting, setPermDeleting]       = useState(false);
  const [permDeleteError, setPermDeleteError] = useState<string | null>(null);
  const handlePermanentDelete = async () => {
    if (permDeleteInput !== app.name) return;
    setPermDeleting(true);
    setPermDeleteError(null);
    try {
      await api.apps.permanentDelete(tenantId, app.id);
      onDelete();
    } catch (err) {
      setPermDeleteError(err instanceof Error ? err.message : "Delete failed. Please try again.");
    } finally {
      setPermDeleting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-8 px-6 space-y-8">

      <section>
        <h2 className="text-[11px] font-bold text-faint uppercase tracking-wider mb-4">Identity</h2>
        <div className="bg-white/[0.03] border border-white/[0.07] rounded-xl divide-y divide-white/[0.05]">
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-[13px] font-medium text-ink">Name</p>
              <p className="text-[11px] text-faint mt-0.5">Display name shown in the platform.</p>
            </div>
            {renaming ? (
              <div className="flex items-center gap-2">
                <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void commitRename(); if (e.key === "Escape") setRenaming(false); }}
                  disabled={renameSaving}
                  className="text-[13px] text-ink bg-raised border border-accent/50 rounded-lg px-3 py-1.5 outline-none w-44"
                />
                <Button size="sm" variant="primary" onClick={() => void commitRename()} disabled={renameSaving}>{renameSaving ? "…" : "Save"}</Button>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-ink">{app.name}</span>
                <Button size="sm" variant="ghost" onClick={startRename}>Rename</Button>
              </div>
            )}
          </div>
        </div>
      </section>

      {app.status !== "deleted" && (
        <section>
          <h2 className="text-[11px] font-bold text-danger uppercase tracking-wider mb-4">Danger Zone</h2>
          <div className="bg-danger/5 border border-danger/20 rounded-xl divide-y divide-danger/10">

            {/* Soft delete */}
            <div className="px-5 py-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-[13px] font-medium text-ink">Archive this app</p>
                <p className="text-[11px] text-faint mt-0.5">Stops all processing and hides the app. Reversible.</p>
              </div>
              {deleteConfirm ? (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] text-danger">Are you sure?</span>
                  <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10 border border-danger/30" onClick={() => void handleDelete()} disabled={deleting}>
                    {deleting ? "Archiving…" : "Yes, archive"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10 border border-danger/30 shrink-0" onClick={() => setDeleteConfirm(true)}>
                  Archive
                </Button>
              )}
            </div>

            {/* Hard delete */}
            <div className="px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[13px] font-medium text-ink">Permanently delete</p>
                  <p className="text-[11px] text-faint mt-0.5">
                    Removes all data, DB tables, images, and webhooks. Cannot be undone.
                  </p>
                </div>
                {!permDeleteOpen && (
                  <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10 border border-danger/30 shrink-0" onClick={() => setPermDeleteOpen(true)}>
                    Delete forever
                  </Button>
                )}
              </div>
              {permDeleteOpen && (
                <div className="mt-4 p-4 bg-danger/5 border border-danger/20 rounded-xl space-y-3">
                  <p className="text-[12px] text-danger leading-relaxed">
                    This will destroy everything associated with <span className="font-semibold">{app.name}</span>. Type the app name to confirm.
                  </p>
                  <input
                    autoFocus
                    value={permDeleteInput}
                    onChange={(e) => { setPermDeleteInput(e.target.value); setPermDeleteError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handlePermanentDelete();
                      if (e.key === "Escape") { setPermDeleteOpen(false); setPermDeleteInput(""); setPermDeleteError(null); }
                    }}
                    placeholder={app.name}
                    className="w-full text-[13px] text-ink bg-raised border border-danger/40 rounded-lg px-3 py-2 outline-none focus:border-danger/70 transition-colors placeholder:text-faint/50"
                  />
                  {permDeleteError && (
                    <p className="text-[11px] text-danger">{permDeleteError}</p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm" variant="ghost"
                      className="text-danger hover:bg-danger/15 border border-danger/40 disabled:opacity-40"
                      onClick={() => void handlePermanentDelete()}
                      disabled={permDeleting || permDeleteInput !== app.name}
                    >
                      {permDeleting ? "Deleting…" : "Delete forever"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setPermDeleteOpen(false); setPermDeleteInput(""); setPermDeleteError(null); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>

          </div>
        </section>
      )}
    </div>
  );
}

// ─── Inject Wizard ────────────────────────────────────────────────────────────

/**
 * Detects which Shopify theme template the widget requires by scanning
 * the generated widget JS for URL pathname patterns.
 * Returns e.g. "templates/product.json". Defaults to "templates/product.json".
 */
function detectWidgetTemplateKey(widgetJs: string | null): string {
  if (!widgetJs) return "templates/product.json";
  if (/\/products\//.test(widgetJs))    return "templates/product.json";
  if (/\/collections\//.test(widgetJs)) return "templates/collection.json";
  if (/\/cart/.test(widgetJs))          return "templates/cart.json";
  if (/\/pages\//.test(widgetJs))       return "templates/page.json";
  return "templates/product.json";
}

function InjectWizard({
  app, tenantId, onClose, onStart, onDone, onError,
}: {
  app: App;
  tenantId: string;
  onClose: () => void;
  onStart: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const requiredTemplateKey = detectWidgetTemplateKey(app.widgetJs);

  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [activeThemeName, setActiveThemeName] = useState("");
  const [lockedTemplate, setLockedTemplate] = useState<ThemeTemplate | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [insertAt, setInsertAt]       = useState<number>(0); // index in block_order
  useEffect(() => {
    api.apps.getThemeTemplates(tenantId, app.id)
      .then(({ activeTheme, templates: tpls }) => {
        setActiveThemeName(activeTheme.name);
        const match = tpls.find((t) => t.key === requiredTemplateKey) ?? tpls[0] ?? null;
        setLockedTemplate(match);
        setSelectedSectionId(match?.sections[0]?.sectionId ?? null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load templates"))
      .finally(() => setLoading(false));
  }, [tenantId, app.id, requiredTemplateKey]);

  const handleInject = async () => {
    if (!lockedTemplate || !selectedSectionId) return;
    const target: InjectionTarget = {
      templateKey: lockedTemplate.key,
      sectionId: selectedSectionId,
      position: insertAt,
    };
    onStart();
    try {
      await api.apps.injectTheme(tenantId, app.id, [target]);
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Injection failed");
      onDone();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface border border-white/[0.09] rounded-2xl shadow-2xl w-[480px] max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.07]">
          <div>
            <h2 className="text-[14px] font-bold text-ink">Inject app block</h2>
            <p className="text-[11px] text-faint mt-0.5">Duplicates your active theme and adds the app block to a section</p>
          </div>
          <button onClick={onClose} className="text-faint hover:text-ink bg-transparent border-0 cursor-pointer p-1">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-[12px] text-faint">
              <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
              Loading templates from {activeThemeName || "active theme"}…
            </div>
          )}

          {error && (
            <div className="text-[12px] text-danger bg-danger/10 border border-danger/20 rounded-lg px-4 py-3">
              {error}
            </div>
          )}

          {!loading && !error && lockedTemplate && (
            <>
              {/* Locked template notice */}
              <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg bg-accent/[0.07] border border-accent/[0.15]">
                <span className="material-symbols-outlined text-[14px] text-accent mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>info</span>
                <p className="text-[11.5px] text-accent/90 leading-relaxed">
                  This widget runs on the <span className="font-semibold">{lockedTemplate.name}</span> page.
                  Injecting it on another page would break it.
                </p>
              </div>

              {activeThemeName && (
                <p className="text-[11px] text-faint">
                  Active theme: <span className="text-muted font-medium">{activeThemeName}</span>
                </p>
              )}

              {/* Section picker */}
              {lockedTemplate.sections.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-faint">Choose a section</label>
                  <div className="space-y-1">
                    {lockedTemplate.sections.map((s) => (
                      <button
                        key={s.sectionId}
                        onClick={() => setSelectedSectionId(s.sectionId)}
                        className={cn(
                          "w-full flex items-center justify-between px-3 py-2 rounded-lg text-[12px] border transition-colors text-left",
                          selectedSectionId === s.sectionId
                            ? "bg-accent/10 border-accent/25 text-accent"
                            : "bg-white/[0.03] border-white/[0.06] text-muted hover:text-ink hover:bg-white/[0.05]"
                        )}
                      >
                        <span>{s.sectionId}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Block order — slot-based position picker */}
              {(() => {
                const section = lockedTemplate.sections.find((s) => s.sectionId === selectedSectionId);
                const blocks = section?.blockOrder ?? [];
                const blockNames = section?.blockNames ?? {};
                // Clamp insertAt when section changes
                const clampedInsert = Math.min(insertAt, blocks.length);

                const widgetSlot = (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/[0.12] border border-accent/30 border-dashed">
                    <span className="material-symbols-outlined text-[13px] text-accent" style={{ fontVariationSettings: "'FILL' 1" }}>science</span>
                    <span className="text-[11.5px] font-semibold text-accent">Your widget</span>
                  </div>
                );

                const insertHandle = (idx: number) => (
                  <button
                    key={`gap-${idx}`}
                    type="button"
                    onClick={() => setInsertAt(idx)}
                    className={cn(
                      "w-full flex items-center gap-2 py-1 transition-colors cursor-pointer border-0 bg-transparent group",
                    )}
                  >
                    <span className={cn(
                      "flex-1 h-px transition-colors",
                      clampedInsert === idx ? "bg-accent/50" : "bg-white/[0.06] group-hover:bg-accent/25"
                    )} />
                    <span className={cn(
                      "text-[9.5px] font-semibold shrink-0 transition-colors",
                      clampedInsert === idx ? "text-accent" : "text-faint/40 group-hover:text-accent/60"
                    )}>
                      {clampedInsert === idx ? "↓ insert here" : "insert here"}
                    </span>
                    <span className={cn(
                      "flex-1 h-px transition-colors",
                      clampedInsert === idx ? "bg-accent/50" : "bg-white/[0.06] group-hover:bg-accent/25"
                    )} />
                  </button>
                );

                return (
                  <div className="space-y-2">
                    <label className="text-[11px] font-medium text-faint">
                      Click a slot to choose where the widget is inserted
                    </label>
                    <div className="p-3 bg-white/[0.02] border border-white/[0.06] rounded-xl space-y-0.5">
                      {blocks.length === 0 ? (
                        <>
                          {widgetSlot}
                          <p className="text-[10px] text-faint/50 mt-1.5 text-center">No existing blocks — widget will be the only one</p>
                        </>
                      ) : (
                        <>
                          {insertHandle(0)}
                          {blocks.map((id, idx) => (
                            <div key={id}>
                              {clampedInsert === idx ? widgetSlot : null}
                              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                <span className="material-symbols-outlined text-[13px] text-faint/40">widgets</span>
                                <span className="text-[11px] text-faint">{blockNames[id] ?? "Block"}</span>
                              </div>
                              {insertHandle(idx + 1)}
                            </div>
                          ))}
                          {clampedInsert === blocks.length ? widgetSlot : null}
                        </>
                      )}
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-white/[0.07]">
            <button
              onClick={onClose}
              className="px-4 py-2 text-[12px] font-medium text-muted hover:text-ink bg-transparent border border-white/[0.08] rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleInject}
              disabled={!lockedTemplate || !selectedSectionId || !!error}
              className="flex items-center gap-2 px-4 py-2 text-[12px] font-semibold text-white bg-accent rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-opacity cursor-pointer hover:bg-accent/90"
            >
              Inject widget
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AppDetailPage() {
  const navigate = useNavigate();
  const { appId } = useParams<{ appId: string }>();
  const { tenantId, shopDomain } = useSessionStore();

  const appQuery                   = useApp(tenantId, appId ?? null);
  const latestSessionQuery         = useLatestSession(appId ?? null);
  const latestCompletedSessionQuery = useLatestCompletedSession(appId ?? null);
  const sessionsQuery              = useAppSessions(appId ?? null);
  const { approve }       = useGeneration();
  const queryClient       = useQueryClient();

  const [mainTab, setMainTab]         = useState<"overview" | "logs" | "versions" | "settings">("overview");
  const [activeLogTab, setActiveLogTab] = useState<"webhook" | "widget" | "admin">("webhook");
  const [deploying, setDeploying]     = useState(false);

  const logsEnabled       = (mainTab === "logs" && activeLogTab === "webhook") || mainTab === "overview";
  const widgetLogsEnabled = (mainTab === "logs" && activeLogTab === "widget")  || mainTab === "overview";
  const adminLogsEnabled  = (mainTab === "logs" && activeLogTab === "admin")   || mainTab === "overview";

  const logsQuery       = useWebhookAppLogs(tenantId, appId ?? null, logsEnabled);
  const widgetLogsQuery = useWidgetLogs(tenantId, appId ?? null, widgetLogsEnabled);
  const adminLogsQuery  = useAdminLogs(tenantId, appId ?? null, adminLogsEnabled);

  const app                    = appQuery.data ?? null;
  const latestSession          = latestSessionQuery.data ?? null;
  const latestCompletedSession = latestCompletedSessionQuery.data ?? null;
  const sessions               = sessionsQuery.data ?? [];
  // True when the latest session failed but a prior completed session exists to fall back to.
  const hasFallback   = latestSession?.status === "failed"
    && sessions.some((s) => s.status === "completed");
  // When the latest failed, use the last completed session for display data (triggers, explanation).
  const displaySession = (latestSession?.status === "failed" ? latestCompletedSession : latestSession) ?? latestSession;
  const activeGen     = useGenerationStore((s) => s.active);
  const isGenerating  = activeGen?.appId === appId && activeGen?.status === "running";

  const invalidateAppCache = () =>
    queryClient.invalidateQueries({ queryKey: ["apps", tenantId] });

  const handleDeployDraft = async () => {
    if (!latestSession?.jobId) return;
    setDeploying(true);
    try { await approve(latestSession.jobId); await appQuery.refetch(); void invalidateAppCache(); }
    catch (err) { alert(err instanceof Error ? err.message : "Deployment failed"); }
    finally { setDeploying(false); }
  };

  const handleRedeploy = async () => {
    if (!tenantId || !appId) return;
    setDeploying(true);
    try { await api.apps.setStatus(tenantId, appId, "active"); await appQuery.refetch(); void invalidateAppCache(); }
    catch (err) { alert(err instanceof Error ? err.message : "Redeployment failed"); }
    finally { setDeploying(false); }
  };

  const handleDeactivate = async () => {
    if (!tenantId || !appId) return;
    setDeploying(true);
    try { await api.apps.setStatus(tenantId, appId, "inactive"); await appQuery.refetch(); void invalidateAppCache(); }
    catch (err) { alert(err instanceof Error ? err.message : "Deactivation failed"); }
    finally { setDeploying(false); }
  };

  // ─── Theme injection ─────────────────────────────────────────────────────────

  const [injectWizardOpen, setInjectWizardOpen] = useState(false);
  const [injectingWidget, setInjectingWidget]   = useState(false);
  const [injectError, setInjectError]           = useState<string | null>(null);

  const handleDeleteInjectedTheme = async () => {
    if (!tenantId || !appId) return;
    try {
      await api.apps.deleteInjectedTheme(tenantId, appId);
      await appQuery.refetch();
      void invalidateAppCache();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete test theme");
    }
  };

  const activeLogsQuery =
    activeLogTab === "webhook" ? logsQuery
    : activeLogTab === "widget" ? widgetLogsQuery
    : adminLogsQuery;

  return (
    <>
      <TopBar
        title={
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => navigate("/app/apps")}
              className="text-faint hover:text-ink transition-colors font-medium bg-transparent border-0 cursor-pointer p-0"
            >
              My Apps
            </button>
            <span className="text-faint/40 select-none">/</span>
            <span className="text-ink font-semibold truncate">{app?.name ?? "App"}</span>
          </div>
        }
      />

      {appQuery.isLoading ? (
        <main className="flex-1 overflow-y-auto p-7">
          <div className="space-y-3">
            <div className="flex items-center gap-4 pb-5 border-b border-white/[0.07]">
              <div className="w-12 h-12 rounded-2xl bg-white/[0.05] animate-pulse-subtle" />
              <div className="space-y-2 flex-1">
                <div className="h-5 w-48 bg-white/[0.05] rounded-lg animate-pulse-subtle" />
                <div className="h-3 w-64 bg-white/[0.03] rounded-lg animate-pulse-subtle" />
              </div>
            </div>
            {[1,2,3,4,5].map((i) => <div key={i} className="h-12 bg-white/[0.03] rounded-xl animate-pulse-subtle border border-white/[0.06]" />)}
          </div>
        </main>
      ) : !app ? (
        <main className="flex-1 flex items-center justify-center">
          <p className="text-sm text-faint">App not found.</p>
        </main>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col">

          {/* App Header — always visible */}
          <AppHeader
            app={app}
            isGenerating={isGenerating}
          />

          {/* App type + status band — always visible above tabs */}
          <AppInfoBand
            app={app}
            latestSession={latestSession}
            hasFallback={hasFallback}
            onDeploy={handleDeployDraft}
            onRedeploy={handleRedeploy}
            onDeactivate={handleDeactivate}
            deploying={deploying}
            isBuilding={isGenerating}
          />

          {/* Tab bar */}
          <div className="border-b border-white/[0.07] px-7 shrink-0">
            <TabBar
              tabs={[
                { id: "overview" as const, label: "Dashboard" },
                { id: "logs"     as const, label: "Logs"     },
                { id: "versions" as const, label: "Versions"  },
                { id: "settings" as const, label: "Settings" },
              ]}
              active={mainTab}
              onChange={setMainTab}
              action={
                <button
                  type="button"
                  onClick={() => navigate(`/app/apps/${app.id}/revise`)}
                  className="flex items-center gap-1 px-3 py-2 text-[12px] font-semibold text-accent border-b-2 border-accent bg-transparent border-x-0 border-t-0 cursor-pointer hover:text-accent/80 transition-colors"
                >
                  <span className="material-symbols-outlined text-[13px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                  Revise
                </button>
              }
            />
          </div>

          {/* OVERVIEW */}
          {mainTab === "overview" && (
            <OverviewTab
              app={app}
              latestSession={displaySession}
              recentLogs={logsQuery.data ?? []}
              recentWidgetLogs={widgetLogsQuery.data ?? []}
              recentAdminLogs={adminLogsQuery.data ?? []}
              recentLogsLoading={logsQuery.isLoading || widgetLogsQuery.isLoading || adminLogsQuery.isLoading}
              shopDomain={shopDomain}
              onLogsTab={() => setMainTab("logs")}
              injectingWidget={injectingWidget}
              injectError={injectError}
              onInjectWidget={() => { setInjectError(null); setInjectWizardOpen(true); }}
              onDeleteInjectedTheme={handleDeleteInjectedTheme}
            />
          )}

          {/* LOGS */}
          {mainTab === "logs" && (
            <main className="flex-1 overflow-y-auto p-7">
              <div className="mb-5">
                <TabBar
                  tabs={[
                    { id: "webhook" as const, label: "Webhook" },
                    { id: "widget"  as const, label: "Widget"  },
                    { id: "admin"   as const, label: "Admin"   },
                  ]}
                  active={activeLogTab}
                  onChange={setActiveLogTab}
                  end={
                    <>
                      {activeLogsQuery.isFetching && <span className="text-[10px] text-faint">Refreshing…</span>}
                      <button type="button" onClick={() => void activeLogsQuery.refetch()}
                        className="text-[11px] text-faint hover:text-accent transition-colors bg-transparent border-0 cursor-pointer underline"
                      >Refresh</button>
                    </>
                  }
                />
              </div>

              {activeLogTab === "webhook" && (
                <>
                  {logsQuery.isError && <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>}
                  {!logsQuery.isError && (logsQuery.data ?? []).length === 0 && <EmptyLogs label="No webhook executions yet" sub="Logs appear here once Shopify sends events to your app." />}
                  {(logsQuery.data ?? []).length > 0 && (
                    <LogTable>{(logsQuery.data ?? []).map((e, i, a) => <LogRow key={e.id} entry={e} last={i === a.length - 1} />)}</LogTable>
                  )}
                </>
              )}
              {activeLogTab === "widget" && (
                <>
                  {widgetLogsQuery.isError && <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>}
                  {!widgetLogsQuery.isError && (widgetLogsQuery.data ?? []).length === 0 && <EmptyLogs label="No widget calls yet" sub="Logs appear once the storefront widget calls your backend." />}
                  {(widgetLogsQuery.data ?? []).length > 0 && (
                    <LogTable pathHeader="Path">{(widgetLogsQuery.data ?? []).map((e, i, a) => <InvocationLogRow key={e.id} entry={e} last={i === a.length - 1} />)}</LogTable>
                  )}
                </>
              )}
              {activeLogTab === "admin" && (
                <>
                  {adminLogsQuery.isError && <p className="text-sm text-danger py-6 text-center">Failed to load logs.</p>}
                  {!adminLogsQuery.isError && (adminLogsQuery.data ?? []).length === 0 && <EmptyLogs label="No admin calls yet" sub="Logs appear once the Admin UI panel calls your backend." />}
                  {(adminLogsQuery.data ?? []).length > 0 && (
                    <LogTable pathHeader="Path">{(adminLogsQuery.data ?? []).map((e, i, a) => <InvocationLogRow key={e.id} entry={e} last={i === a.length - 1} />)}</LogTable>
                  )}
                </>
              )}
            </main>
          )}

          {/* VERSIONS */}
          {mainTab === "versions" && (
            <VersionsTab
              sessions={sessions}
              sessionsLoading={sessionsQuery.isLoading}
              latestSession={latestSession}
              app={app}
            />
          )}

          {/* SETTINGS */}
          {mainTab === "settings" && (
            <div className="flex-1 overflow-y-auto">
              <SettingsPanel
                app={app} tenantId={tenantId!}
                onAppChange={() => void appQuery.refetch()}
                onDelete={() => {
                  void queryClient.invalidateQueries({ queryKey: ["apps", tenantId] });
                  navigate("/app/apps");
                }}
              />
            </div>
          )}

        </div>
      )}

      {/* Theme injection wizard */}
      {injectWizardOpen && app && tenantId && (
        <InjectWizard
          app={app}
          tenantId={tenantId}
          onClose={() => setInjectWizardOpen(false)}
          onStart={() => { setInjectWizardOpen(false); setInjectingWidget(true); setInjectError(null); }}
          onDone={() => { setInjectingWidget(false); void appQuery.refetch(); void invalidateAppCache(); }}
          onError={(msg) => setInjectError(msg)}
        />
      )}
    </>
  );
}
