CREATE TABLE abandonment_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  abandonment_delay_minutes INTEGER NOT NULL DEFAULT 60,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE abandoned_cart_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id BIGINT NOT NULL,
  customer_id BIGINT NULL,
  customer_email TEXT NOT NULL,
  customer_first_name TEXT NULL,
  cart_token TEXT NOT NULL,
  abandoned_at TIMESTAMPTZ NOT NULL,
  cart_total_price TEXT NOT NULL,
  cart_currency TEXT NOT NULL,
  line_items_snapshot JSONB NOT NULL DEFAULT '[]',
  recovery_url TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ NULL,
  failed_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX abandoned_cart_queue_checkout_id_uidx ON abandoned_cart_queue (checkout_id);
CREATE INDEX abandoned_cart_queue_customer_email_idx ON abandoned_cart_queue (customer_email);
CREATE INDEX abandoned_cart_queue_status_idx ON abandoned_cart_queue (status);
CREATE INDEX abandoned_cart_queue_abandoned_at_idx ON abandoned_cart_queue (abandoned_at);

CREATE TABLE abandonment_send_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id UUID NOT NULL REFERENCES abandoned_cart_queue(id) ON DELETE CASCADE,
  customer_email TEXT NOT NULL,
  checkout_id BIGINT NOT NULL,
  cart_total_price TEXT NOT NULL,
  status TEXT NOT NULL,
  failed_reason TEXT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX abandonment_send_log_customer_email_idx ON abandonment_send_log (customer_email);
CREATE INDEX abandonment_send_log_checkout_id_idx ON abandonment_send_log (checkout_id);
CREATE INDEX abandonment_send_log_sent_at_idx ON abandonment_send_log (sent_at);