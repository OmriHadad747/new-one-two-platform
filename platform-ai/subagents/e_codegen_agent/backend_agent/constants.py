"""
Data constants used by the backend agent + adjacent validators / CLI.

Replaces the prompt-heavy topics/ + capabilities/ surface from the legacy
architect era. Only the data structures survive the refactor — the prompt
text now lives in `prompt.py` and is structured around the LLD AST.

Public surface:
  WEBHOOK_API_VERSION    str        — Admin GraphQL API version
  WEBHOOK_TOPICS         frozenset  — every topic the architect / LLD may
                                       reference (REST-valid, minus platform-
                                       owned topics platform-back handles itself)
  TEMPLATE_OWNED_TABLES  frozenset  — platform-shipped table names the handler
                                       must never touch directly
  TEMPLATE_OWNED_FILES   frozenset  — template-shipped source paths the
                                       generator must not overwrite
  NPM_PACKAGES           dict       — `npm:<id>` → tuple of bare package names
                                       the architect-declared capability
                                       authorises. The validator unions these
                                       sets to build the import allow-list.
"""

from __future__ import annotations

from catalogs.shopify_webhooks import (
    LATEST_WEBHOOK_API_VERSION,
    load_topic_names,
)


# ── Webhook surface ───────────────────────────────────────────────────────────

WEBHOOK_API_VERSION: str = LATEST_WEBHOOK_API_VERSION

# Topics platform-back owns or that have no generated-handler use case.
# Filtered OUT of WEBHOOK_TOPICS so the picker + validator never see them.
_PLATFORM_OWNED_EXCLUSIONS: frozenset[str] = frozenset(
    {
        # App lifecycle / billing — platform-back owns these.
        "app/uninstalled",
        "app/scopes_update",
        "app_purchases_one_time/update",
        "app_subscriptions/update",
        "app_subscriptions/approaching_capped_amount",
        # Mandatory GDPR — platform-back owns per Shopify policy.
        "customers/data_request",
        "customers/redact",
        "shop/redact",
        # Store-admin configuration — no generated-handler use case.
        "customer_account_settings/update",
        "checkout_and_accounts_configurations/update",
        "delivery_promise_settings/update",
        "locales/create",
        "locales/destroy",
        "locales/update",
        "domains/create",
        "domains/destroy",
        "domains/update",
        # Shopify Capital / financial-services internals.
        "finance_app_staff_member/grant",
        "finance_app_staff_member/revoke",
        "finance_app_staff_member/update",
        "finance_app_staff_member/delete",
        "finance_kyc_information/update",
        # Tax-service integrations — third-party tax-app surface only.
        "tax_partners/update",
        "tax_services/create",
        "tax_services/update",
        # Async patterns the generator does not teach.
        "bulk_operations/finish",
        "audit_events/admin_api_activity",
    }
)

WEBHOOK_TOPICS: frozenset[str] = (
    load_topic_names(WEBHOOK_API_VERSION) - _PLATFORM_OWNED_EXCLUSIONS
)


# ── Template-owned tables / files (handler must not author) ──────────────────

# Tables the platform-back template ships unconditionally (see
# platform-back/templates/backend/dbs/). Handler code uses helpers
# (`enqueueJob`, template router) instead of touching these tables.
TEMPLATE_OWNED_TABLES: frozenset[str] = frozenset({"cron_queue", "processed_webhooks"})

# Source files the handler template ships and must not be overwritten by
# generated output (the deployer would replace hand-written code silently).
TEMPLATE_OWNED_FILES: frozenset[str] = frozenset(
    {
        # TypeScript source files — generator must not overwrite
        "src/server.ts",
        "src/middleware/verify-platform.ts",
        "src/lib/db.ts",
        "src/lib/platform-call.ts",
        "src/lib/platform.ts",
        "src/lib/shopify.ts",
        "src/lib/cron-runner.ts",
        "src/lib/cron-enqueue.ts",
        "src/routes/webhook.ts",
        "src/migrate.ts",
        # Infrastructure files — generator must not overwrite
        "package.json",
        "tsconfig.json",
        "Dockerfile",
    }
)


# ── npm capability → authorised package names ─────────────────────────────────
#
# Validator (`_build_import_allowlist`) unions these with the template's
# pre-installed packages to decide which `import` statements are legal.
# Adding a new capability: add the key here + ship the package in the
# template's package.json.

NPM_PACKAGES: dict[str, tuple[str, ...]] = {
    "npm:qrcode": ("qrcode",),
    "npm:sharp": ("sharp",),
    "npm:pdfkit": ("pdfkit",),
    "npm:exceljs": ("exceljs",),
    "npm:csv": ("csv-parse", "csv-stringify"),
    "npm:xml": ("fast-xml-parser",),
    "npm:dayjs": ("dayjs",),
    "npm:jszip": ("jszip",),
}
