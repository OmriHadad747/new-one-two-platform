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
import { AppStatusBadge } from "@/components/ui/AppStatusBadge";
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
          <div className="flex items-center gap-3 text-[11px] text-faint">
            <span>Created {formatDate(app.createdAt)}</span>
            <span className="opacity-40">·</span>
            <span>Updated {timeAgo(app.updatedAt)}</span>
          </div>
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

function LogRow({ entry, last }: { entry: WebhookInvocationLogEntry; last: boolean }) {
  const cfg = LOG_STATUS_CFG[entry.status];
  return (
    <div className={cn("flex items-start gap-4 px-5 py-3", !last && "border-b border-white/[0.05]")}>
      <div className="pt-1.5 shrink-0"><span className={cn("w-2 h-2 rounded-full block", cfg.dot)} /></div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-mono text-ink truncate">{entry.topic}</span>
          <span className={cn("text-[10px] font-bold uppercase tracking-wide", cfg.cls)}>{cfg.label}</span>
        </div>
        {entry.errorMessage && <p className="text-[11px] text-danger mt-1 font-mono truncate">{entry.errorMessage}</p>}
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
    <div className={cn("flex items-start gap-4 px-5 py-3", !last && "border-b border-white/[0.05]")}>
      <div className="pt-1.5 shrink-0"><span className={cn("w-2 h-2 rounded-full block", cfg.dot)} /></div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-mono text-ink truncate">{entry.path}</span>
          <span className={cn("text-[10px] font-bold uppercase tracking-wide", cfg.cls)}>{cfg.label}</span>
        </div>
        {entry.errorMessage && <p className="text-[11px] text-danger mt-1 font-mono truncate">{entry.errorMessage}</p>}
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <div className="text-[11px] font-mono text-faint">{formatDuration(entry.durationMs)}</div>
        <div className="text-[10px] text-faint">{timeAgo(entry.invokedAt)}</div>
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

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  app, latestSession, recentLogs, recentLogsLoading, shopDomain, onLogsTab,
  onDeploy, onRedeploy, onDeactivate, deploying, isBuilding,
}: {
  app: App;
  latestSession: {
    status: string; webhookTopics?: string[]; cronSchedule?: string | null;
    prompt?: string | null; bundle?: SessionBundle | null;
  } | null;
  recentLogs: WebhookInvocationLogEntry[];
  recentLogsLoading: boolean;
  shopDomain: string | null;
  onLogsTab: () => void;
  onDeploy: () => void;
  onRedeploy: () => void;
  onDeactivate: () => void;
  deploying: boolean;
  isBuilding: boolean;
}) {
  const webhookTopics = latestSession?.webhookTopics ?? [];
  const cronSchedule  = latestSession?.cronSchedule ?? null;
  const prompt        = latestSession?.prompt ?? null;

  const hasWidget  = !!(latestSession?.bundle?.widgetModule  ?? (app.appArchetype === "storefront_backend" || app.appArchetype === "storefront_backend_admin"));
  const hasAdminUI = !!(latestSession?.bundle?.adminUiModule ?? (app.appArchetype === "backend_admin"      || app.appArchetype === "storefront_backend_admin"));

  // Prefer app.shopDomain (always authoritative for this app) over the session-store
  // shopDomain (may be stale or null after store rehydration).
  const effectiveShop  = app.shopDomain || shopDomain || null;
  const storeFrontUrl  = effectiveShop ? `https://${effectiveShop}` : null;
  const themeEditorUrl = effectiveShop ? `https://${effectiveShop}/admin/themes/current/editor` : null;
  const adminUrl       = effectiveShop ? `https://${effectiveShop}/admin/apps` : null;

  const navigate = useNavigate();
  const validateSteps = buildValidationSteps({ webhookTopics, cronSchedule, hasWidget, hasAdminUI });


  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[960px] mx-auto p-7 grid grid-cols-[1fr_280px] gap-6 items-start">

        {/* ── LEFT COLUMN ──────────────────────────────────────────────── */}
        <div className="space-y-5">

          {/* About — pure info */}
          <section className="bg-white/[0.04] border border-white/[0.07] rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02]">
              <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">About</h3>
            </div>
            <div className="divide-y divide-white/[0.05]">
              <Row label="Type" value={<ArchetypePills archetype={app.appArchetype} />} />
              <Row label="Created" value={formatDate(app.createdAt)} />
              <Row label="Updated" value={timeAgo(app.updatedAt)} />
              {app.slug && <Row label="Slug" value={<span className="font-mono text-[11px]">{app.slug}</span>} />}
              {app.shopDomain && <Row label="Store" value={<span className="font-mono text-[11px]">{app.shopDomain}</span>} />}
              <Row label="App ID" value={
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(app.id)}
                  title="Click to copy"
                  className="flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-accent transition-colors cursor-pointer bg-transparent border-0 p-0"
                >
                  <span>{app.id}</span>
                  <span className="material-symbols-outlined text-[12px]">content_copy</span>
                </button>
              } />
            </div>
          </section>

          {/* Triggers */}
          {(webhookTopics.length > 0 || cronSchedule) && (
            <section className="bg-white/[0.04] border border-white/[0.07] rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02]">
                <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">Triggers</h3>
              </div>
              <div className="divide-y divide-white/[0.05]">
                {webhookTopics.length > 0 && (
                  <div className="px-5 py-3.5">
                    <p className="text-[11px] text-faint mb-2">Active webhooks</p>
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
                    <p className="text-[11px] text-faint mb-1.5">Cron schedule</p>
                    <div className="flex items-center gap-3">
                      <code className="text-[12px] font-mono text-ink bg-white/[0.04] px-2.5 py-1 rounded-lg border border-white/[0.07]">
                        {cronSchedule}
                      </code>
                      {humanizeCron(cronSchedule) && (
                        <span className="text-[11px] text-faint">{humanizeCron(cronSchedule)}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Recent activity — only for generated apps */}
          {latestSession !== null && (
          <section className="bg-white/[0.04] border border-white/[0.07] rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02] flex items-center justify-between">
              <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">Recent Activity</h3>
              <button type="button" onClick={onLogsTab}
                className="text-[10px] text-faint hover:text-accent transition-colors bg-transparent border-0 cursor-pointer"
              >
                All logs →
              </button>
            </div>
            {recentLogsLoading ? (
              <div className="px-5 py-4 space-y-2">
                {[1, 2, 3].map((i) => <div key={i} className="h-8 bg-white/[0.03] rounded-lg animate-pulse-subtle" />)}
              </div>
            ) : recentLogs.length === 0 ? (
              <div className="px-5 py-6 text-center">
                <p className="text-[12px] text-faint">No executions yet</p>
                <p className="text-[11px] text-faint opacity-60 mt-1">Logs appear once Shopify sends events.</p>
              </div>
            ) : (
              <div>
                {recentLogs.slice(0, 5).map((entry, i, arr) => (
                  <LogRow key={entry.id} entry={entry} last={i === arr.length - 1} />
                ))}
              </div>
            )}
          </section>
          )}

          {/* Original prompt */}
          {latestSession !== null && prompt && (
            <section className="bg-white/[0.04] border border-white/[0.07] rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02]">
                <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">Original Prompt</h3>
              </div>
              <p className="px-5 py-4 text-[12px] text-faint leading-relaxed whitespace-pre-wrap">{prompt}</p>
            </section>
          )}
        </div>

        {/* ── RIGHT COLUMN ─────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Status & Actions */}
          <section className="bg-white/[0.04] border border-white/[0.07] rounded-xl overflow-hidden">
            <div className="px-4 pt-4 pb-3">
              <p className="text-[9.5px] font-bold uppercase tracking-wider text-faint mb-2.5">Status</p>
              <AppStatusBadge status={app.status} isBuilding={isBuilding} />
            </div>
            {latestSession !== null && (
              <div className="px-4 pb-4 space-y-2 border-t border-white/[0.06] pt-3">
                {latestSession?.status === "completed" && app.status === "draft" && (
                  <button type="button" onClick={onDeploy} disabled={deploying}
                    className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-green-500/10 hover:bg-green-500/18 border border-green-500/25 text-green-500 text-[13px] font-semibold transition-colors cursor-pointer disabled:opacity-50">
                    <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>rocket_launch</span>
                    {deploying ? "Deploying…" : "Deploy to store"}
                  </button>
                )}
                {app.status === "inactive" && (
                  <button type="button" onClick={onRedeploy} disabled={deploying}
                    className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-green-500/10 hover:bg-green-500/18 border border-green-500/25 text-green-500 text-[13px] font-semibold transition-colors cursor-pointer disabled:opacity-50">
                    <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>power_settings_new</span>
                    {deploying ? "Activating…" : "Activate"}
                  </button>
                )}
                {app.status === "active" && (
                  <button type="button" onClick={onDeactivate} disabled={deploying}
                    className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-white/[0.04] hover:bg-white/[0.07] border border-white/15 text-faint text-[13px] font-semibold transition-colors cursor-pointer disabled:opacity-50">
                    <span className="material-symbols-outlined text-[15px]">pause_circle</span>
                    {deploying ? "Deactivating…" : "Deactivate"}
                  </button>
                )}
              </div>
            )}
          </section>

          {/* How to test / Revise CTA */}
          {latestSession === null ? (
            /* Ungenerated draft — show only Revise */
            <section className="bg-white/[0.04] border border-white/[0.07] rounded-xl overflow-hidden">
              <div className="px-4 py-5 space-y-3 text-center">
                <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center mx-auto">
                  <span className="material-symbols-outlined text-accent text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-ink">Ready to build?</p>
                  <p className="text-[11px] text-faint mt-1 leading-relaxed">Describe what you want this app to do and Ton will generate it.</p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(`/app/apps/${app.id}/revise`)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-accent text-white text-[13px] font-semibold transition-all hover:opacity-90 cursor-pointer border-0"
                >
                  <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                  Start building with Ton
                </button>
              </div>
            </section>
          ) : (
            <section className="bg-white/[0.04] border border-white/[0.07] rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
                <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">How to test</h3>
              </div>
              <div className="mx-4 mt-4 mb-3 px-3.5 py-3 bg-accent/5 border border-accent/12 rounded-xl space-y-2.5">
                <p className="text-[11px] text-accent/90 leading-relaxed">
                  {validateSteps.find((s) => s.isRevise)?.text}
                </p>
                <button
                  type="button"
                  onClick={() => navigate(`/app/apps/${app.id}/revise`)}
                  className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-accent text-white text-[12px] font-semibold transition-all hover:opacity-90 cursor-pointer border-0"
                >
                  <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
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

          {/* Shopify links — only for generated apps */}
          {latestSession !== null && (storeFrontUrl || adminUrl) && (
            <section className="bg-white/[0.04] border border-white/[0.07] rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
                <h3 className="text-[10px] font-bold text-faint uppercase tracking-wider">Open in Shopify</h3>
              </div>
              <div className="px-3 py-3 space-y-1.5">
                {hasWidget && storeFrontUrl && (
                  <ShopifyLink href={storeFrontUrl} label="View storefront" highlight />
                )}
                {hasWidget && themeEditorUrl && (
                  <ShopifyLink href={themeEditorUrl} label="Theme editor" />
                )}
                {hasAdminUI && adminUrl && (
                  <ShopifyLink href={adminUrl} label="Admin panel" />
                )}
                {!hasWidget && !hasAdminUI && adminUrl && (
                  <ShopifyLink href={adminUrl} label="Shopify Admin" />
                )}
              </div>
              {hasWidget && (
                <div className="px-4 pb-3 pt-1 border-t border-white/[0.05] mt-1">
                  <p className="text-[10px] text-faint leading-relaxed">
                    In the Theme editor: Apps → find the block → paste the <span className="text-muted font-medium">App ID</span> from the About section.
                  </p>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <span className="text-[9.5px] font-bold uppercase tracking-wider text-faint w-[68px] shrink-0">{label}</span>
      <span className="text-[12.5px] text-ink flex-1 min-w-0">{value}</span>
    </div>
  );
}

function ShopifyLink({ href, label, highlight }: { href: string; label: string; highlight?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className={cn(
        "flex items-center justify-between px-3.5 py-2.5 rounded-lg text-[12px] font-medium no-underline transition-colors",
        highlight
          ? "bg-teal/10 border border-teal/20 text-teal hover:bg-teal/15"
          : "bg-white/[0.03] border border-white/[0.06] text-muted hover:bg-white/[0.06] hover:text-ink"
      )}
    >
      <span>{label}</span>
      <span className="material-symbols-outlined text-[13px]">arrow_outward</span>
    </a>
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
          <div className="bg-danger/5 border border-danger/20 rounded-xl px-5 py-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-ink">Delete this app</p>
              <p className="text-[11px] text-faint mt-0.5">Permanently removes the app and stops all processing.</p>
            </div>
            {deleteConfirm ? (
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-danger">Are you sure?</span>
                <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10 border border-danger/30" onClick={() => void handleDelete()} disabled={deleting}>
                  {deleting ? "Deleting…" : "Yes, delete"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10 border border-danger/30 shrink-0" onClick={() => setDeleteConfirm(true)}>
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
  const { tenantId, shopDomain } = useSessionStore();

  const appQuery          = useApp(tenantId, appId ?? null);
  const latestSessionQuery = useLatestSession(appId ?? null);
  const { approve }       = useGeneration();
  const queryClient       = useQueryClient();

  const [mainTab, setMainTab]         = useState<"overview" | "logs" | "code" | "settings">("overview");
  const [activeLogTab, setActiveLogTab] = useState<"webhook" | "widget" | "admin">("webhook");
  const [deploying, setDeploying]     = useState(false);

  const logsEnabled       = (mainTab === "logs" && activeLogTab === "webhook") || mainTab === "overview";
  const widgetLogsEnabled = mainTab === "logs" && activeLogTab === "widget";
  const adminLogsEnabled  = mainTab === "logs" && activeLogTab === "admin";

  const logsQuery       = useWebhookAppLogs(tenantId, appId ?? null, logsEnabled);
  const widgetLogsQuery = useWidgetLogs(tenantId, appId ?? null, widgetLogsEnabled);
  const adminLogsQuery  = useAdminLogs(tenantId, appId ?? null, adminLogsEnabled);

  const app           = appQuery.data ?? null;
  const latestSession = latestSessionQuery.data ?? null;
  const activeGen     = useGenerationStore((s) => s.active);
  const isGenerating  = activeGen?.appId === appId && activeGen?.status === "running";

  const handleDeployDraft = async () => {
    if (!latestSession?.jobId) return;
    setDeploying(true);
    try { await approve(latestSession.jobId); await appQuery.refetch(); }
    catch (err) { alert(err instanceof Error ? err.message : "Deployment failed"); }
    finally { setDeploying(false); }
  };

  const handleRedeploy = async () => {
    if (!tenantId || !appId) return;
    setDeploying(true);
    try { await api.apps.setStatus(tenantId, appId, "active"); await appQuery.refetch(); }
    catch (err) { alert(err instanceof Error ? err.message : "Redeployment failed"); }
    finally { setDeploying(false); }
  };

  const handleDeactivate = async () => {
    if (!tenantId || !appId) return;
    setDeploying(true);
    try { await api.apps.setStatus(tenantId, appId, "inactive"); await appQuery.refetch(); }
    catch (err) { alert(err instanceof Error ? err.message : "Deactivation failed"); }
    finally { setDeploying(false); }
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

          {/* Tab bar */}
          <div className="border-b border-white/[0.07] px-7 shrink-0">
            <TabBar
              tabs={[
                { id: "overview" as const, label: "Overview" },
                { id: "logs"     as const, label: "Logs"     },
                { id: "code"     as const, label: "Generated" },
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
              latestSession={latestSession}
              recentLogs={logsQuery.data ?? []}
              recentLogsLoading={logsQuery.isLoading}
              shopDomain={shopDomain}
              onLogsTab={() => setMainTab("logs")}
              onDeploy={handleDeployDraft}
              onRedeploy={handleRedeploy}
              onDeactivate={handleDeactivate}
              deploying={deploying}
              isBuilding={isGenerating}
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

          {/* CODE */}
          {mainTab === "code" && (
            <div className="flex-1 overflow-hidden p-6 flex flex-col">
              <div className="max-w-[860px] w-full mx-auto flex-1 rounded-xl overflow-hidden border border-white/[0.07] flex flex-col">
                {latestSessionQuery.isLoading ? (
                  <div className="p-7 space-y-2">
                    {[1,2,3,4].map((i) => <div key={i} className="h-8 bg-white/[0.03] rounded-lg animate-pulse-subtle border border-white/[0.06]" />)}
                  </div>
                ) : (
                  <CodeViewer bundle={latestSession?.bundle} />
                )}
              </div>
            </div>
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
    </>
  );
}
