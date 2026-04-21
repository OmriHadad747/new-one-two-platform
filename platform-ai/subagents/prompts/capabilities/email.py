"""
email capability — platform.email.send() / sendBatch().

Per-agent views:
  ARCHITECT       — short line for the AVAILABLE capabilities list.
  ARCHITECT_SPEC  — emailSpec declaration rules for the architect output shape.
  HANDLER         — full implementation docs + email-metadata sidecar contract.
"""

ARCHITECT = (
    "platform.email.send({ to, data }) — merchant-configured email template "
    "(subject/body/CTA owned by the platform; handler passes recipient + variables only)."
)

ARCHITECT_SPEC = """\
emailSpec: Architect output field describing the email the handler will send.
  See the "email" entry in the AVAILABLE capabilities list above for what
  the /services/email/send platform service actually does — this field
  only captures the architect's classification + intent for that send.

  Shape:
    null if "email" is not in handlerCapabilities.
    Otherwise: { "type": "transactional" | "marketing",
                 "purpose": "<one present-tense sentence: what fires the email and when>" }

  type:
    - "transactional" — triggered by a customer action (order confirmation,
      cart recovery, shipping update, password reset). Default for Shopify
      automation apps.
    - "marketing" — unsolicited outreach (newsletter, win-back, promo blast).
      Only when the feature IS explicitly a marketing send.

  purpose: drives the handler's starter subject/body copy — the more
  concrete, the better what the merchant sees on first open.

  COUPLING — when emailSpec is set, the handlerMustProduce on whichever
  contract feeds the send (webhookContract or cronContract) MUST enumerate
  every data field the merchant will reference in the email template:
  recipient display name for personalization, the full content the email
  describes (not only an ID or sample), and any concrete action URL the CTA
  will point to. Listing only what the DB needs leaves the handler with an
  impoverished variable set.\
"""

HANDLER = """\
── platform.email.send() ─────────────────────────────────────

  import { platform, QuotaExceeded } from "../lib/platform.js";

  try {
    const result = await platform.email.send({
      to: <recipient>,
      data: { /* template vars */ },
    });
    if (result.delivered) {
      // email delivered
    }
    // delivered:false (suppressed / missing_config / provider_failed) is a
    // soft outcome — log and continue; do not throw.
  } catch (err) {
    if (err instanceof QuotaExceeded) {
      // Monthly quota hit — stop sending, do not retry.
      return;
    }
    throw err;
  }

For batch sends use platform.email.sendBatch(items: EmailSendInput[]):
  const { items: results } = await platform.email.sendBatch(
    rows.map(r => ({ to: r.email, data: { ... } }))
  );
  // each result: { index, status: 200|429|500, result? }

The handler ONLY provides the recipient and runtime variables. The
platform owns everything else — subject, body, brand, layout, from
address, delivery, tracking, unsubscribe. The merchant configures the
template (subject, body, CTA, brand) in the dashboard's Email tab; any
{{variable}} placeholders they put in those fields are resolved against
`data` at send time.

  to:    recipient email address (string)
  data:  optional variables bound to {{variable}} placeholders in the
         merchant-configured template. Include whatever dynamic values
         the merchant will want to reference: customer name, order id,
         product title, URLs, amounts, etc.

DO NOT pass `subject`, `templateId`, or HTML — those fields do not exist
on the API. DO NOT store email HTML in your app's DB tables or compile
templates inside the handler — the platform does all of that.

The variable names you pass in `data` become the token palette shown to
the merchant in the Email tab, so use descriptive names
(<variable_name_one>, <variable_name_two>) rather than single letters.
All `data` keys MUST be camelCase — never snake_case or PascalCase. The
merchant references them as {{camelCase}} in the template.

Example (shape only — fill in variables appropriate to your app):
  const result = await platform.email.send({
    to: <recipient>,
    data: {
      <variable_1>: <value_1>,
      <variable_2>: <value_2>,
      <variable_url>: <url_value>,
    },
  });

The merchant-configured template might then read:
  Subject: "{{<variable_1>}}, your <noun> is waiting"
  Body:    "... — {{<variable_2>}}."
  CTA:     "<short_label>" → {{<variable_url>}}

Deploy is blocked on apps that use the email service until the merchant
has saved the Email tab at least once. That's by design — uncustomized
emails would look generic and hurt the merchant's brand.

── Email metadata sidecar (REQUIRED when you call the email service) ────

AFTER all your ===FILE: ... === blocks, emit a fenced JSON block
declaring the exact variables you chose for `data` plus starter template
content for the Email tab. The platform seeds the merchant's
`app_email_configs` row from this block so the merchant never sees a
blank form on first open.

Format — one block per handler, fenced with ```email-metadata.
Replace every <placeholder> token below with values specific to THIS
app's send call(s); do NOT echo the angle-bracket placeholders verbatim.

```email-metadata
{
  "variables": ["<variable_1>", "<variable_2>", "<variable_url>"],
  "starterContent": {
    "subject":  "<short subject line that references {{variable_1}} when natural>",
    "heading":  "<optional greeting referencing a name-like variable, or omit>",
    "body":     "<one or two sentences describing the context, referencing {{variable_2}} etc.>",
    "ctaLabel": "<short button label, or omit together with ctaUrl>",
    "ctaUrl":   "{{<variable_url>}}"
  }
}
```

RULES:
  - variables: the EXACT camelCase keys you pass in any
    `data: { ... }` across ALL email send call sites in this handler.
    First-seen order, deduplicated. If you only make one send call,
    it's just the keys from that one object literal.
  - starterContent.subject / body: short, warm, reference variables you
    declared with {{variable}} placeholders. The merchant will edit
    this copy — your job is to produce a sensible non-blank starting
    point informed by emailSpec.purpose from the architect plan, NOT
    to write final marketing copy.
  - heading: optional. Include it for personalized greetings when a
    name-like variable is available. Omit the key entirely otherwise.
  - ctaLabel + ctaUrl: required together if ANY URL variable is in your
    variables list (recoveryUrl, productUrl, orderUrl, actionUrl, url,
    etc.). Omit both when the handler passes no URL variable.
  - Keep variables consistent: every token referenced in starterContent
    with {{x}} MUST be in the variables array, and vice versa (no
    unused declared variables).
  - Emit ONE block even across multiple send call sites — merge all
    variables into a single array.
  - Do NOT emit this block when the handler does not use the email
    service.\
"""
