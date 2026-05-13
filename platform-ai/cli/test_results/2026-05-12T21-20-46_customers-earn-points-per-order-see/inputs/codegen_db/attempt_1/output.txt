CREATE TABLE point_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_external_id BIGINT NOT NULL,
  cart_external_id TEXT NOT NULL,
  discount_external_id TEXT NULL,
  discount_code TEXT NULL,
  points_applied BIGINT NOT NULL,
  discount_value_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'cancelled', 'used')),
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cart_external_id, customer_external_id, status)
);

COMMENT ON TABLE point_redemptions IS 'Tracks every attempt to apply points as a discount against a cart, its lifecycle status, and the external discount reference.';
COMMENT ON COLUMN point_redemptions.customer_external_id IS 'Shopify customer numeric ID who applied the redemption';
COMMENT ON COLUMN point_redemptions.cart_external_id IS 'Shopify cart token the discount was applied to';
COMMENT ON COLUMN point_redemptions.discount_external_id IS 'Shopify DiscountCodeNode GID for the created discount code';
COMMENT ON COLUMN point_redemptions.discount_code IS 'Human-readable discount code string returned by Shopify for customer application';
COMMENT ON COLUMN point_redemptions.points_applied IS 'Number of points debited for this redemption';
COMMENT ON COLUMN point_redemptions.discount_value_minor IS 'Monetary discount value in currency minor units';
COMMENT ON COLUMN point_redemptions.currency IS 'ISO 4217 currency code for discount_value_minor';
COMMENT ON COLUMN point_redemptions.failure_reason IS 'Reason string when cancellation failed mid-flight';

CREATE INDEX idx_point_redemptions_customer_external_id ON point_redemptions (customer_external_id);

CREATE TABLE point_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_external_id BIGINT NOT NULL,
  order_external_id BIGINT NULL,
  refund_external_id BIGINT NULL,
  redemption_id UUID NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('earn', 'redemption_debit', 'refund_reversal', 'cancellation_credit')),
  points_delta BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (redemption_id) REFERENCES point_redemptions(id) ON DELETE SET NULL
);

COMMENT ON TABLE point_ledger IS 'Append-only record of every point event — earn, redemption debit, refund reversal, and redemption cancellation credit — providing a full audit trail per customer.';
COMMENT ON COLUMN point_ledger.customer_external_id IS 'Shopify customer numeric ID whose balance is affected';
COMMENT ON COLUMN point_ledger.order_external_id IS 'Shopify order numeric ID that triggered an earn or refund-reversal entry';
COMMENT ON COLUMN point_ledger.refund_external_id IS 'Shopify refund numeric ID that triggered a reversal entry';
COMMENT ON COLUMN point_ledger.redemption_id IS 'point_redemptions row that triggered a debit or cancellation-credit entry';
COMMENT ON COLUMN point_ledger.points_delta IS 'Positive for credits (earn, cancellation_credit), negative for debits';

CREATE INDEX idx_point_ledger_customer_external_id ON point_ledger (customer_external_id);
CREATE INDEX idx_point_ledger_order_external_id_entry_type ON point_ledger (order_external_id, entry_type);
CREATE INDEX idx_point_ledger_refund_external_id_entry_type ON point_ledger (refund_external_id, entry_type);
CREATE INDEX idx_point_ledger_redemption_id_entry_type ON point_ledger (redemption_id, entry_type);

CREATE TABLE customer_balance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_external_id BIGINT NOT NULL,
  available_points BIGINT NOT NULL DEFAULT 0,
  lifetime_earned BIGINT NOT NULL DEFAULT 0,
  lifetime_redeemed BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_external_id)
);

COMMENT ON TABLE customer_balance_snapshots IS 'Pre-aggregated current point balance per customer to allow instant, scalable reads from the cart widget and admin audit list.';
COMMENT ON COLUMN customer_balance_snapshots.customer_external_id IS 'Shopify customer numeric ID — unique per row';
COMMENT ON COLUMN customer_balance_snapshots.available_points IS 'Current spendable point balance, clamped to >= 0';
COMMENT ON COLUMN customer_balance_snapshots.lifetime_earned IS 'Cumulative points ever earned';
COMMENT ON COLUMN customer_balance_snapshots.lifetime_redeemed IS 'Cumulative points ever redeemed';

CREATE INDEX idx_customer_balance_snapshots_available_points ON customer_balance_snapshots (available_points);

CREATE TABLE earn_idempotency (
  order_external_id BIGINT PRIMARY KEY,
  customer_external_id BIGINT NOT NULL,
  points_earned BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE earn_idempotency IS 'Single-row-per-order dedup table used as the atomic INSERT-form claim for order earn events, preventing double-crediting on duplicate webhook delivery.';
COMMENT ON COLUMN earn_idempotency.order_external_id IS 'Shopify order numeric ID — one row per paid order';
COMMENT ON COLUMN earn_idempotency.customer_external_id IS 'Customer credited for this earn';
COMMENT ON COLUMN earn_idempotency.points_earned IS 'Points credited in this earn event';

CREATE TABLE refund_idempotency (
  refund_external_id BIGINT PRIMARY KEY,
  order_external_id BIGINT NOT NULL,
  customer_external_id BIGINT NOT NULL,
  points_reversed BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE refund_idempotency IS 'Single-row-per-refund dedup table used as the atomic INSERT-form claim for refund events, preventing double-reversal on duplicate webhook delivery.';
COMMENT ON COLUMN refund_idempotency.refund_external_id IS 'Shopify refund numeric ID — one row per refund';
COMMENT ON COLUMN refund_idempotency.order_external_id IS 'Parent order for this refund';
COMMENT ON COLUMN refund_idempotency.customer_external_id IS 'Customer debited for this reversal';
COMMENT ON COLUMN refund_idempotency.points_reversed IS 'Points reversed (actual, may be clamped)';