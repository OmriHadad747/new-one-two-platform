import { useEffect, useState } from "react";
import { useEmailConfig, useUpdateEmailConfig, useSendTestEmail, useEmailStats } from "@/hooks/useEmail";
import type { EmailType } from "@/types/dashboard";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

interface Props {
  appId: string;
}

/**
 * Per-app email configuration tab. Only rendered when `app.usesEmail === true`.
 *
 * Merchants edit the subject, heading, body, CTA, and email type. Template
 * pre-fill (starter content) comes from the generator — this tab is how they
 * personalize it before deploy.
 *
 * First save flips `configured_by_merchant = TRUE` and unblocks deploy.
 */
export function EmailTab({ appId }: Props) {
  const configQuery = useEmailConfig(appId);
  const statsQuery = useEmailStats(appId);
  const update = useUpdateEmailConfig(appId);
  const sendTest = useSendTestEmail(appId);

  const [subject, setSubject] = useState("");
  const [heading, setHeading] = useState("");
  const [body, setBody] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [emailType, setEmailType] = useState<EmailType>("transactional");
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // Hydrate form from server once the config loads.
  useEffect(() => {
    const c = configQuery.data?.config;
    if (!c) return;
    setSubject(c.subjectTemplate);
    setHeading(c.headingTemplate ?? "");
    setBody(c.bodyTemplate);
    setCtaLabel(c.ctaLabel ?? "");
    setCtaUrl(c.ctaUrlTemplate ?? "");
    setEmailType(c.emailType);
    setDirty(false);
  }, [configQuery.data?.config]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const markDirty = () => setDirty(true);

  const handleSave = async () => {
    try {
      await update.mutateAsync({
        subjectTemplate: subject,
        headingTemplate: heading.trim() ? heading : null,
        bodyTemplate: body,
        ctaLabel: ctaLabel.trim() ? ctaLabel : null,
        ctaUrlTemplate: ctaUrl.trim() ? ctaUrl : null,
        emailType,
      });
      setDirty(false);
      setToast({ kind: "ok", msg: "Email template saved." });
    } catch (err) {
      setToast({ kind: "err", msg: err instanceof Error ? err.message : "Save failed" });
    }
  };

  const handleTest = async () => {
    const recipient = prompt("Send test to which email address?");
    if (!recipient) return;
    try {
      const result = await sendTest.mutateAsync(recipient);
      setToast({ kind: "ok", msg: `Test email sent to ${result.recipient}.` });
    } catch (err) {
      setToast({ kind: "err", msg: err instanceof Error ? err.message : "Test send failed" });
    }
  };

  const insertVariable = (name: string) => {
    // Copy to clipboard for the merchant to paste wherever.
    const token = `{{${name}}}`;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(token);
      setToast({ kind: "ok", msg: `Copied ${token}` });
    }
  };

  if (configQuery.isLoading) {
    return <div className="p-7 text-faint text-sm">Loading email config…</div>;
  }
  if (configQuery.isError || !configQuery.data?.config) {
    return (
      <div className="p-7 text-danger text-sm">
        Failed to load email config. The app may not have been deployed yet, or it doesn't send emails.
      </div>
    );
  }

  const variables = configQuery.data.variables;
  const configured = configQuery.data.config.configuredByMerchant;
  const stats = statsQuery.data;

  return (
    <main className="flex-1 overflow-y-auto p-7 max-w-4xl">
      {/* Unconfirmed banner */}
      {!configured && (
        <div className="mb-5 px-4 py-3 bg-amber-400/5 rounded-xl text-[13px] text-amber-400">
          <strong>Email content needs review.</strong> Ton pre-filled this template from your app description. Review and save it before deploying — deploy is blocked until you confirm.
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "mb-4 px-3 py-2 rounded-lg text-[12px]",
            toast.kind === "ok"
              ? "bg-teal/10 text-teal"
              : "bg-danger/10 text-danger"
          )}
        >
          {toast.msg}
        </div>
      )}

      {/* Email type */}
      <Section title="Email type">
        <div className="flex gap-2">
          <TypeButton
            label="Transactional"
            active={emailType === "transactional"}
            onClick={() => { setEmailType("transactional"); markDirty(); }}
          />
          <TypeButton
            label="Marketing"
            active={emailType === "marketing"}
            onClick={() => { setEmailType("marketing"); markDirty(); }}
          />
        </div>
        <p className="text-[11px] text-faint mt-2 leading-relaxed">
          <strong>Transactional</strong> — Triggered by a customer action (order, subscription, cart). No consent required.
          <br />
          <strong>Marketing</strong> — Unsolicited outreach (newsletter, promo). Requires opt-in under CAN-SPAM / GDPR.
          <br />
          <span className="text-faint">Informational in MVP — does not change delivery behavior yet.</span>
        </p>
      </Section>

      {/* Variables palette */}
      {variables.length > 0 && (
        <Section title="Available variables" subtitle="Click a token to copy. Paste it into any field below.">
          <div className="flex flex-wrap gap-1.5">
            {variables.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => insertVariable(v)}
                className="px-2 py-1 text-[11px] font-mono border border-white/[0.08] rounded-lg text-ink bg-white/[0.03] hover:bg-white/[0.07] hover:border-accent/40 transition-colors cursor-pointer"
              >
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* Form fields */}
      <Section title="Subject">
        <input
          type="text"
          value={subject}
          onChange={(e) => { setSubject(e.target.value); markDirty(); }}
          placeholder="Your cart is waiting — come back for {{cartTotal}}"
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-[13px] text-ink placeholder:text-faint focus:border-accent outline-none"
        />
      </Section>

      <Section title="Heading" subtitle="Optional. Appears as an H1 at the top of the email.">
        <input
          type="text"
          value={heading}
          onChange={(e) => { setHeading(e.target.value); markDirty(); }}
          placeholder="Hi {{customerName}}"
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-[13px] text-ink placeholder:text-faint focus:border-accent outline-none"
        />
      </Section>

      <Section title="Body" subtitle="Blank lines become paragraphs.">
        <textarea
          value={body}
          onChange={(e) => { setBody(e.target.value); markDirty(); }}
          rows={8}
          placeholder={"You left some items in your cart.\n\nCome back and complete your order before they're gone."}
          className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-[13px] text-ink placeholder:text-faint focus:border-accent outline-none font-mono leading-relaxed"
        />
      </Section>

      <Section title="Call-to-action button" subtitle="Optional. Both fields must be filled for the button to render.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            type="text"
            value={ctaLabel}
            onChange={(e) => { setCtaLabel(e.target.value); markDirty(); }}
            placeholder="Return to checkout"
            className="px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-[13px] text-ink placeholder:text-faint focus:border-accent outline-none"
          />
          <input
            type="text"
            value={ctaUrl}
            onChange={(e) => { setCtaUrl(e.target.value); markDirty(); }}
            placeholder="{{recoveryUrl}}"
            className="px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-[13px] text-ink placeholder:text-faint focus:border-accent outline-none font-mono"
          />
        </div>
      </Section>

      {/* Actions */}
      <div className="flex items-center gap-2 mt-6">
        <Button variant="primary" onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={handleTest} disabled={sendTest.isPending}>
          {sendTest.isPending ? "Sending…" : "Send test to me"}
        </Button>
        {dirty && <span className="text-[11px] text-amber-400">Unsaved changes</span>}
      </div>

      {/* Stats */}
      {stats && (
        <Section title="Delivery (last 30 days)">
          <div className="grid grid-cols-5 gap-2">
            <StatCell label="Sent" value={stats.sent} />
            <StatCell label="Delivered" value={stats.delivered} positive />
            <StatCell label="Bounced" value={stats.bounced} negative={stats.bounced > 0} />
            <StatCell label="Complained" value={stats.complained} negative={stats.complained > 0} />
            <StatCell label="Failed" value={stats.failed} negative={stats.failed > 0} />
          </div>
        </Section>
      )}
    </main>
  );
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function Section({
  title, subtitle, children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="mb-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink">{title}</div>
        {subtitle && <div className="text-[11px] text-faint mt-0.5">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function TypeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 text-[12px] font-medium rounded-lg transition-colors cursor-pointer",
        active
          ? "text-accent bg-accent/10"
          : "bg-white/[0.04] text-faint hover:text-ink hover:bg-white/[0.08]"
      )}
    >
      {label}
    </button>
  );
}

function StatCell({ label, value, positive, negative }: { label: string; value: number; positive?: boolean; negative?: boolean }) {
  return (
    <div className="px-3 py-2 rounded-xl bg-white/[0.03]">
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div
        className={cn(
          "text-[18px] font-semibold tabular-nums",
          positive ? "text-teal" : negative ? "text-danger" : "text-ink"
        )}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}
