import { useEffect, useState } from "react";
import { useTenantBrand, useUpdateTenantBrand } from "@/hooks/useEmail";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

interface Props {
  tenantId: string;
}

/**
 * Tenant-level email brand settings. One row per tenant; shared across every
 * email-using app. Embedded in the main Settings page.
 */
export function BrandPanel({ tenantId }: Props) {
  const brandQuery = useTenantBrand(tenantId);
  const update = useUpdateTenantBrand(tenantId);

  const [logoUrl, setLogoUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#1a73e8");
  const [footerText, setFooterText] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  useEffect(() => {
    const b = brandQuery.data?.brand;
    if (!b) return;
    setLogoUrl(b.logoUrl ?? "");
    setPrimaryColor(b.primaryColor ?? "#1a73e8");
    setFooterText(b.footerText ?? "");
    setSupportEmail(b.supportEmail ?? "");
    setDirty(false);
  }, [brandQuery.data?.brand]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const markDirty = () => setDirty(true);

  const handleSave = async () => {
    try {
      await update.mutateAsync({
        logoUrl: logoUrl.trim() || null,
        primaryColor: primaryColor.trim() || null,
        footerText: footerText.trim() || null,
        supportEmail: supportEmail.trim() || null,
      });
      setDirty(false);
      setToast({ kind: "ok", msg: "Brand saved. Every email-using app will use these settings." });
    } catch (err) {
      setToast({ kind: "err", msg: err instanceof Error ? err.message : "Save failed" });
    }
  };

  return (
    <section className="bg-white/[0.03] rounded-xl p-5">
      <div className="mb-1">
        <h2 className="text-[14px] font-semibold text-ink">Email brand</h2>
        <p className="text-[12px] text-faint mt-0.5">
          Shared across every email-using app. Changes take effect immediately — no re-deploy.
        </p>
      </div>

      {toast && (
        <div
          className={cn(
            "mt-3 mb-1 px-3 py-2 rounded-lg text-[12px]",
            toast.kind === "ok"
              ? "bg-teal/10 text-teal"
              : "bg-danger/10 text-danger"
          )}
        >
          {toast.msg}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <Field label="Logo URL" hint="Paste a URL from your Shopify CDN or image host. Leave empty to use your store name as text.">
          <input
            type="text"
            value={logoUrl}
            onChange={(e) => { setLogoUrl(e.target.value); markDirty(); }}
            placeholder="https://cdn.shopify.com/..."
            className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-[13px] text-ink placeholder:text-faint focus:border-accent outline-none"
          />
          {logoUrl && (
            // Previewing raw user input — safe because it's a merchant's own logo URL
            // rendered in their own dashboard; no cross-tenant exposure.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Logo preview" className="mt-2 max-h-12 rounded-lg bg-white/[0.03] p-1" />
          )}
        </Field>

        <Field label="Primary color" hint="Used for CTA buttons and accents.">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={primaryColor}
              onChange={(e) => { setPrimaryColor(e.target.value); markDirty(); }}
              className="w-10 h-9 border border-white/[0.08] rounded-lg bg-transparent cursor-pointer"
            />
            <input
              type="text"
              value={primaryColor}
              onChange={(e) => { setPrimaryColor(e.target.value); markDirty(); }}
              placeholder="#1a73e8"
              className="flex-1 px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-[13px] text-ink placeholder:text-faint focus:border-accent outline-none font-mono"
            />
          </div>
        </Field>

        <Field label="Footer text" hint="Business info shown at the bottom of every email (address, phone, etc).">
          <textarea
            value={footerText}
            onChange={(e) => { setFooterText(e.target.value); markDirty(); }}
            rows={3}
            placeholder="Acme Coffee Co. · 123 Main St, Austin TX · (555) 555-5555"
            className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-[13px] text-ink placeholder:text-faint focus:border-accent outline-none"
          />
        </Field>

        <Field label="Support email" hint="Optional. Shown in the footer for customer questions.">
          <input
            type="email"
            value={supportEmail}
            onChange={(e) => { setSupportEmail(e.target.value); markDirty(); }}
            placeholder="support@yourstore.com"
            className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-[13px] text-ink placeholder:text-faint focus:border-accent outline-none"
          />
        </Field>
      </div>

      <div className="flex items-center gap-2 mt-4">
        <Button variant="primary" onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save brand"}
        </Button>
        {dirty && <span className="text-[11px] text-amber-400">Unsaved changes</span>}
      </div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink mb-0.5">{label}</div>
      {hint && <div className="text-[11px] text-faint mb-1.5 leading-relaxed">{hint}</div>}
      {children}
    </div>
  );
}
