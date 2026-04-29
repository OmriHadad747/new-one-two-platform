CREATE TABLE abandoned_cart_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton = true),
  delay_minutes INTEGER NOT NULL DEFAULT 60,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE abandoned_cart_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_token TEXT NOT NULL,
  customer_email TEXT NULL,
  customer_id BIGINT NULL,
  cart_subtotal_cents BIGINT NOT NULL,
  currency TEXT NOT NULL,
  line_items_json JSONB NOT NULL DEFAULT '[]',
  recovery_url TEXT NULL,
  abandoned_at TIMESTAMPTZ NOT NULL,
  cart_updated_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped_no_email', 'skipped_completed')),
  failure_reason TEXT NULL,
  email_sent_at TIMESTAMPTZ NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cart_token)
);

CREATE INDEX idx_abandoned_cart_emails_status ON abandoned_cart_emails (status);
CREATE INDEX idx_abandoned_cart_emails_customer_email ON abandoned_cart_emails (customer_email);
CREATE INDEX idx_abandoned_cart_emails_detected_at ON abandoned_cart_emails (detected_at);