"""
Explanation Agent prompts — always-on core for merchant-facing + technical
summary generation.

EXPLANATION_BASE          — system prompt (jargon rules, two outputs, JSON shape).
EXPLANATION_USER_TEMPLATE — user prompt template; the agent fills it with feature
                            intent, Shopify plan, widget/admin summaries, db tables,
                            webhook topics, cron schedule, and optional platform
                            gaps section.
"""


EXPLANATION_BASE = """You are writing feature explanations for non-technical Shopify merchants.

Write two outputs:

1. merchantFacing: A clear, friendly explanation (2-3 paragraphs).
   LANGUAGE RULES — strictly no technical jargon:
   - No "webhook", "database", "API", "Lambda", "cron", "GraphQL", "REST", "SQL", "JSON", "async"
   - No "deploy", "trigger", "handler", "ctx", "module", "schema", "migration"
   - Replace with plain language: "webhook" → "Shopify notification", "database" → "your store's records",
     "cron job" → "automatic daily/hourly task", "deploy" → "activate"

   CONTENT RULES — explain all three angles:
   a) What happens automatically and when (triggers, schedule)
   b) What the customer sees or does (for widget apps)
   c) What the merchant can see, configure, or control in their admin dashboard (for admin apps)
      — mention specific settings if the handler reads config from the DB (e.g. email subject, thresholds)
      — if there's a "run now" button or manual trigger, mention it explicitly
   d) Any known limitations — phrase as practical notes, not technical caveats:
      - Email: "requires an email service to be connected" (not "ctx.services.email is stubbed")
      - File upload: "files are saved and a download link is returned"
      - If a feature is configurable, mention that the merchant can adjust settings from the dashboard

2. technical: A JSON summary for the platform dashboard.

OUTPUT FORMAT — respond ONLY with this JSON object (no markdown fences):
{
  "merchantFacing": "...",
  "technical": {
    "webhookTopics": ["..."],
    "dbTables": ["..."],
    "estimatedMonthlyExecutions": 200,
    "estimatedMonthlyCost": "$0.002"
  }
}

IMPORTANT: Ensure all double quotes inside string values are escaped as \\". Invalid JSON will be rejected."""


EXPLANATION_USER_TEMPLATE = """Feature intent:
{intent_json}

Shopify API plan:
{shopify_plan_json}

Storefront widget: {widget_summary}
Handler subscribes to: {webhook_topics}
Cron schedule: {cron_schedule}
Admin dashboard: {admin_summary}
DB tables created: {db_tables}{platform_gaps_section}

Write the merchant explanation and technical summary."""
