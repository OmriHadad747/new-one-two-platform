CREATE TABLE abandoned_cart_settings (
  singleton   BOOLEAN     PRIMARY KEY DEFAULT true CHECK (singleton = true),
  delay_hours INTEGER     NOT NULL DEFAULT 1,
  is_enabled  BOOLEAN     NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE abandoned_carts (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_token         TEXT        NOT NULL,
  shopify_checkout_id    TEXT        NOT NULL,
  customer_id            BIGINT      NULL,
  customer_email         TEXT        NULL,
  customer_display_name  TEXT        NULL,
  total_price_cents      BIGINT      NOT NULL,
  currency               TEXT        NOT NULL,
  recovery_url           TEXT        NULL,
  line_items_json        JSONB       NOT NULL DEFAULT '[]',
  status                 TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'recovered', 'ineligible')),
  ineligible_reason      TEXT        NULL,
  last_activity_at       TIMESTAMPTZ NOT NULL,
  reminder_sent_at       TIMESTAMPTZ NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (checkout_token)
);

CREATE INDEX idx_abandoned_carts_customer_email   ON abandoned_carts (customer_email);
CREATE INDEX idx_abandoned_carts_status           ON abandoned_carts (status);
CREATE INDEX idx_abandoned_carts_last_activity_at ON abandoned_carts (last_activity_at);

CREATE TABLE reminder_log (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  abandoned_cart_id     UUID        NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  customer_email        TEXT        NOT NULL,
  customer_display_name TEXT        NULL,
  total_price_cents     BIGINT      NOT NULL,
  currency              TEXT        NOT NULL,
  outcome               TEXT        NOT NULL DEFAULT 'sent' CHECK (outcome IN ('sent', 'skipped_recovered', 'skipped_no_email', 'failed')),
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reminder_log_abandoned_cart_id ON reminder_log (abandoned_cart_id);
CREATE INDEX idx_reminder_log_sent_at           ON reminder_log (sent_at);