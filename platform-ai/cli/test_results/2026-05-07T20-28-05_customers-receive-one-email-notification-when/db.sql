CREATE TABLE product_signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_external_id BIGINT NOT NULL,
  product_external_id BIGINT NOT NULL,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'notified', 'failed', 'unsubscribed')),
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL,
  UNIQUE (customer_email, variant_external_id)
);

COMMENT ON TABLE product_signups IS 'Records each customer''s request to be notified when a specific product variant returns to stock, and tracks whether the notification was delivered.';
COMMENT ON COLUMN product_signups.variant_external_id IS 'Shopify numeric variant ID the customer is waiting on';
COMMENT ON COLUMN product_signups.product_external_id IS 'Shopify numeric product ID for admin display and filtering';
COMMENT ON COLUMN product_signups.failure_reason IS 'populated when status is failed so the admin dashboard surfaces the reason inline';
COMMENT ON COLUMN product_signups.resolved_at IS 'set when the signup reaches a terminal state (notified, failed, unsubscribed)';

CREATE INDEX idx_product_signups_variant_external_id_status ON product_signups (variant_external_id, status);
CREATE INDEX idx_product_signups_status_created_at ON product_signups (status, created_at);
CREATE INDEX idx_product_signups_customer_email_variant_external_id ON product_signups (customer_email, variant_external_id);

CREATE TABLE notification_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signup_id UUID NOT NULL REFERENCES product_signups(id) ON DELETE CASCADE,
  variant_external_id BIGINT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed_permanent', 'failed_transient')),
  failure_reason TEXT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE notification_attempts IS 'Logs every email delivery attempt for a signup so the merchant can audit successes and failures and the system can prove a notification was sent at most once.';
COMMENT ON COLUMN notification_attempts.signup_id IS 'links this attempt to the originating signup record';
COMMENT ON COLUMN notification_attempts.variant_external_id IS 'denormalised for querying attempts by variant without joining';

CREATE INDEX idx_notification_attempts_signup_id ON notification_attempts (signup_id);
CREATE INDEX idx_notification_attempts_variant_external_id ON notification_attempts (variant_external_id);

CREATE TABLE restock_processing_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_external_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('processing', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  UNIQUE (variant_external_id)
);

COMMENT ON TABLE restock_processing_locks IS 'Provides a per-variant advisory lock row so concurrent inventory_levels/update deliveries for the same variant do not double-send notifications; the row is claimed atomically and released when processing completes.';
COMMENT ON COLUMN restock_processing_locks.variant_external_id IS 'the variant being processed; one lock row per variant';

CREATE INDEX idx_restock_processing_locks_variant_external_id_status ON restock_processing_locks (variant_external_id, status);