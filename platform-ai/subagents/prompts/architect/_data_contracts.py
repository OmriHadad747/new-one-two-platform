"""
Data contract prompt sections — DB schema, webhook, and cron handler contracts.
Always included for every archetype.
"""

CONTRACTS_HEADER = """\
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTRACTS — binding interfaces between components
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\
"""

DB_CONTRACTS = """\
dbContracts: Authoritative typed table definitions. The migration generator produces
  DDL mechanically from this — do NOT rely on prose guidance anywhere.

  Do NOT declare configuration/settings tables (e.g. points_per_dollar,
  notification_thresholds, abandonment_delay_hours) unless adminApiCatalog
  includes routes to read and write them. A config table with no admin UI is
  inaccessible — the merchant can never change the value. If no admin panel
  exists: hardcode defaults in the handler, or note the constraint in
  platformGaps. Only add a settings table when the admin panel actively manages it.

  Do NOT declare email-template state in your dbContracts. Columns like
  email_subject, email_body, email_body_template, email_cta_label, email_cta_url,
  email_from_name, or any other field representing the merchant-editable email
  template are PLATFORM-OWNED (app_email_configs) — the merchant edits them in
  the Ton dashboard's Email tab, not in your app's settings. Likewise, do NOT
  add adminApiCatalog routes to read or write those fields. Your app may still
  declare feature-specific behavior columns (e.g. abandonment_delay_hours,
  is_enabled) when they drive HANDLER logic — just not the template strings
  themselves.

  COLUMN RULES (violations cause validation failures at deploy time):
  - Every table MUST include tenant_id UUID NOT NULL — no exceptions.
  - Shopify entity IDs (variant_id, product_id, order_id, customer_id,
    inventory_item_id, location_id) are numeric — use BIGINT or TEXT, NEVER UUID.
  - Only tenant_id and internal record primary keys (id) use UUID.
  - customer_id on storefront-facing tables MUST be BIGINT NULL (nullable).
    Storefront widget visitors can be guests; customerId is null for guests.
  - State-tracking columns MUST be NULLABLE when stateMachine.unknownSentinel is "null".
  - Tables with one record per entity combination (e.g. per customer per product)
    MUST declare a uniqueConstraint on the natural deduplication key.
    uniqueConstraint shape: null | { "columns": ["col_a", "col_b"] }
    Do NOT add a "name" field — the migration generator does not accept it.
  - Every table gets exactly ONE creation timestamp. If a domain timestamp captures
    when the record was created (e.g. ran_at, sent_at, processed_at set at row insertion),
    do NOT also add created_at — they would always be identical. Only add created_at
    when no domain timestamp is set at insert time. Only add a separate domain timestamp
    when it is set asynchronously after the row already exists (e.g. notified_at,
    completed_at — written in a later update, not at INSERT time).
  - Log and audit tables that reference a parent record by ID MUST declare a
    FOREIGN KEY constraint: REFERENCES <parent_table>(id) ON DELETE CASCADE.
    Example: a notification_log row with subscription_id must include
    "NOT NULL REFERENCES back_in_stock_subscriptions(id) ON DELETE CASCADE" in constraints.
    Do NOT leave parent-record ID columns as bare UUID NOT NULL with no FK — orphaned rows
    become unqueryable once the parent is deleted.\
"""

WEBHOOK_CONTRACT = """\
webhookContract: Required when webhookTopics is non-empty. Declares what the handler
  must have ready before writing to the DB.
  - payloadFields: specific top-level fields from ctx.payload that the handler reads.
    List ONLY fields the handler actually uses — every field listed must appear in
    handlerMustProduce. Do not list fields that are read but then discarded.
  - handlerMustProduce: a plain English statement of what data the handler must resolve
    before executing DB writes. Every field named in payloadFields must be referenced here.
    State WHAT is needed — do NOT specify HOW to fetch it from Shopify. The Handler agent
    decides the implementation using the API context it receives.\
"""

CRON_CONTRACT = """\
cronContract: Required when cronSchedule is non-null. Declares what data each batch
  iteration must have before processing.
  - handlerMustProduce: what the cron handler resolves per batch item before acting.
    MUST NOT describe per-item Shopify reads inside the loop. Every piece of
    Shopify data the loop needs must come from the single bulk pre-fetch declared
    in cronBatching; the loop body may only consult that pre-fetched data, the
    DB, and local logic. If a "re-verify before acting" step sounds needed,
    include the required field (e.g. completedAt / status) in the bulk pre-fetch
    instead of re-querying per item.\
"""
