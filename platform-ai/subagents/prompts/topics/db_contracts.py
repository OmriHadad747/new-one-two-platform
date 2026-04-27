"""
Single source of truth for dbContracts declaration rules.

View:
  ARCHITECT — plan rules for populating dbContracts.

No handler view: the handler receives its schema as runtime data (the
architect-declared dbContracts rendered into the user prompt via
handler_agent._format_db_contracts), not as static prompt content.
"""

ARCHITECT = """\
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
  - Do NOT include a tenant_id column. Tenant isolation is schema-level
    (each tenant has its own Postgres schema; migrations run with
    search_path pinned to it) — a tenant_id column is redundant and
    the validator rejects it as drift from the new isolation model.
  - Shopify entity IDs (variant_id, product_id, order_id, customer_id,
    inventory_item_id, location_id) are numeric — use BIGINT or TEXT, NEVER UUID.
  - Internal record primary keys (id) use UUID.
  - customer_id on storefront-facing tables MUST be BIGINT NULL (nullable).
    Storefront widget visitors can be guests; customerId is null for guests.
  - Money/price columns (anything representing currency: total, subtotal,
    amount, price, cost, fee, tax, discount, refund, payout, balance,etc.) MUST
    be BIGINT storing integer minor units (cents for USD/EUR/GBP, yen for
    JPY, fils for BHD). NEVER TEXT, NUMERIC, FLOAT, DOUBLE PRECISION, or
    INTEGER. Reasons: TEXT can't be SUMmed or range-filtered; FLOAT drifts
    (0.1 + 0.2 ≠ 0.3); INTEGER overflows past $21.47M. Shopify returns
    amounts as decimal strings on the wire — the handler parses to integer
    minor units (`Math.round(parseFloat(price) * 100)` for 2-decimal
    currencies) before INSERT. Pair every money column with a sibling
    currency column (e.g. `total_cents BIGINT` + `currency TEXT`) so
    aggregations group by currency and never mix denominations.
    Naming convention: append `_cents` (or `_minor_units`) to make the
    storage format obvious — `total_cents`, `subtotal_cents`, `tax_cents`.
  - Structured JSON columns (line items, payload snapshots, settings
    blobs, anything you'd otherwise serialize with JSON.stringify) MUST
    be JSONB — never TEXT. JSONB lets the admin UI and downstream
    queries index, filter, and aggregate by sub-keys
    (`WHERE col @> '[{"sku": "ABC"}]'`); TEXT forces application-level
    parsing on every read and breaks any merchant-facing search. Naming
    convention: append `_json` for clarity (`line_items_json`,
    `payload_json`).
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
    become unqueryable once the parent is deleted.
  - Discrete-value columns (status, kind, channel, type — anything the handler
    or UI compares against a fixed set of literal strings) MUST declare an
    `enum` field on the column: a non-empty list of every allowed string value.
    The migration generator emits CHECK (<col> IN (...)) automatically; the
    handler is shown the list and may write only those values; the admin UI
    is shown the list and may filter only on those values. Without `enum`,
    each agent guesses and the guesses don't agree (handler writes
    'pending'/'sent'/'failed', UI invents 'converted'/'skipped' filters that
    are dead). Column shape:
      { "name": "status", "type": "TEXT", "constraints": "NOT NULL DEFAULT 'pending'",
        "enum": ["pending", "sent", "failed"] }
    The DEFAULT literal MUST be in the enum list.

  TABLE-LEVEL FLAGS:
  - singleton: true   — set when this table holds exactly one configuration
    row (e.g. abandonment settings, notification thresholds, app-wide toggles).
    A singleton table has NO `id UUID` column and NO uniqueConstraint; the
    migration generator emits a `singleton BOOLEAN PRIMARY KEY DEFAULT true
    CHECK (singleton = true)` column instead, which makes the row unique by
    construction. Handler reads use `WHERE singleton = true` and writes use
    `INSERT … ON CONFLICT (singleton) DO UPDATE` — both spelled out for the
    handler from the rendered contract. Use this ONLY when the admin UI
    actively manages the row (you also declared adminApiCatalog read+write
    routes); otherwise per the rule above, drop the table entirely.

    Singleton table shape (use this exact pattern — do NOT add an id column):
      {
        "table": "<settings_table_name>",
        "singleton": true,
        "columns": [
          { "name": "<setting_field>", "type": "<TYPE>", "constraints": "NOT NULL DEFAULT <value>" },
          { "name": "updated_at", "type": "TIMESTAMPTZ", "constraints": "NOT NULL DEFAULT now()" }
        ],
        "uniqueConstraint": null,
        "indexes": []
      }\
"""
