import mjml2html from "mjml";
import type { AppEmailConfig, TenantBrand } from "@platform-back/types";

// Pipeline: substitute {{vars}} → split body on blank lines → inject brand
// tokens into the base MJML template → compile MJML → derive plaintext.
//
// Base MJML template is hardcoded (one layout for MVP). Merchants
// customize content, not structure.

export interface RenderInput {
  config: AppEmailConfig;
  brand: TenantBrand | null;
  variables: Record<string, unknown>;
  unsubscribeUrl: string;
  storeName: string;
}

export interface RenderOutput {
  subject: string;
  html: string;
  text: string;
}

const PLATFORM_DEFAULTS = {
  primaryColor: "#1a73e8",
  fontFamily: "Helvetica, Arial, sans-serif",
  footerText: "",
  poweredBy: "Sent via Ton",
} as const;

// Missing variables render as empty string (intentional — merchants can
// reference variables a handler didn't pass and they simply don't appear).
// HTML-escaped by default to prevent injection from customer-supplied data.
export function substituteVariables(
  template: string,
  variables: Record<string, unknown>,
  opts: { escape?: boolean } = {},
): string {
  const escape = opts.escape ?? true;
  return template.replace(/\{\{\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\}\}/g, (_, key) => {
    const raw = variables[key];
    if (raw === undefined || raw === null) return "";
    const str = String(raw);
    return escape ? escapeHtml(str) : str;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildMjml(params: {
  storeName: string;
  logoUrl: string | null;
  primaryColor: string;
  fontFamily: string;
  subject: string;
  heading: string | null;
  paragraphs: string[];
  ctaLabel: string | null;
  ctaUrl: string | null;
  footerText: string;
  unsubscribeUrl: string;
}): string {
  const {
    storeName,
    logoUrl,
    primaryColor,
    fontFamily,
    subject,
    heading,
    paragraphs,
    ctaLabel,
    ctaUrl,
    footerText,
    unsubscribeUrl,
  } = params;

  const logoBlock = logoUrl
    ? `<mj-image src="${escapeAttr(logoUrl)}" alt="${escapeAttr(storeName)}" width="120px" padding="24px 0" />`
    : `<mj-text align="center" font-size="20px" font-weight="bold" padding="24px 0">${escapeHtml(storeName)}</mj-text>`;

  const headingBlock = heading
    ? `<mj-text font-size="24px" font-weight="bold" padding-bottom="16px">${escapeHtml(heading)}</mj-text>`
    : "";

  const paragraphBlocks = paragraphs
    .map(
      (p) =>
        `<mj-text font-size="16px" line-height="24px" padding-bottom="12px">${escapeHtml(p)}</mj-text>`,
    )
    .join("\n");

  const ctaBlock =
    ctaLabel && ctaUrl
      ? `<mj-button background-color="${escapeAttr(primaryColor)}" color="#ffffff" href="${escapeAttr(ctaUrl)}" padding="16px 0" font-weight="600">${escapeHtml(ctaLabel)}</mj-button>`
      : "";

  const footerBlock = footerText
    ? `<mj-text align="center" color="#666666" font-size="12px" padding-bottom="8px">${escapeHtml(footerText)}</mj-text>`
    : "";

  return `<mjml>
  <mj-head>
    <mj-title>${escapeHtml(subject)}</mj-title>
    <mj-attributes>
      <mj-all font-family="${escapeAttr(fontFamily)}" />
    </mj-attributes>
    <mj-style>
      a { color: ${primaryColor}; }
    </mj-style>
  </mj-head>
  <mj-body background-color="#f5f5f5">
    <mj-section background-color="#ffffff" padding="0 24px">
      <mj-column>
        ${logoBlock}
      </mj-column>
    </mj-section>

    <mj-section background-color="#ffffff" padding="0 24px 24px">
      <mj-column>
        ${headingBlock}
        ${paragraphBlocks}
        ${ctaBlock}
      </mj-column>
    </mj-section>

    <mj-section background-color="#f5f5f5" padding="24px">
      <mj-column>
        ${footerBlock}
        <mj-text align="center" color="#999999" font-size="11px">
          <a href="${escapeAttr(unsubscribeUrl)}" style="color:#999999">Unsubscribe</a>
          &nbsp;·&nbsp; ${PLATFORM_DEFAULTS.poweredBy}
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}

function buildPlaintext(params: {
  heading: string | null;
  paragraphs: string[];
  ctaLabel: string | null;
  ctaUrl: string | null;
  footerText: string;
  unsubscribeUrl: string;
}): string {
  const parts: string[] = [];
  if (params.heading) {
    parts.push(params.heading);
    parts.push("");
  }
  parts.push(...params.paragraphs);
  if (params.ctaLabel && params.ctaUrl) {
    parts.push("");
    parts.push(`${params.ctaLabel}: ${params.ctaUrl}`);
  }
  parts.push("");
  parts.push("---");
  if (params.footerText) parts.push(params.footerText);
  parts.push(`Unsubscribe: ${params.unsubscribeUrl}`);
  return parts.join("\n");
}

export function renderEmail(input: RenderInput): RenderOutput {
  const { config, brand, variables, unsubscribeUrl, storeName } = input;

  // Subject / heading / body are HTML-escaped (variables may include
  // customer-supplied content). CTA URL is NOT escaped — it must remain
  // a valid href.
  const subject = substituteVariables(config.subjectTemplate, variables);
  const heading = config.headingTemplate
    ? substituteVariables(config.headingTemplate, variables)
    : null;
  const rawBody = substituteVariables(config.bodyTemplate, variables);
  const ctaLabel = config.ctaLabel;
  const ctaUrl = config.ctaUrlTemplate
    ? substituteVariables(config.ctaUrlTemplate, variables, { escape: false })
    : null;

  const paragraphs = rawBody
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const primaryColor = brand?.primaryColor ?? PLATFORM_DEFAULTS.primaryColor;
  const fontFamily = PLATFORM_DEFAULTS.fontFamily;
  const footerText = brand?.footerText ?? PLATFORM_DEFAULTS.footerText;
  const logoUrl = brand?.logoUrl ?? null;

  const mjml = buildMjml({
    storeName,
    logoUrl,
    primaryColor,
    fontFamily,
    subject,
    heading,
    paragraphs,
    ctaLabel,
    ctaUrl,
    footerText,
    unsubscribeUrl,
  });

  const compiled = mjml2html(mjml, { validationLevel: "soft" });
  const html = compiled.html;

  const text = buildPlaintext({
    heading,
    paragraphs,
    ctaLabel,
    ctaUrl,
    footerText,
    unsubscribeUrl,
  });

  return { subject, html, text };
}
