CREATE TABLE customer_point_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_external_id BIGINT NOT NULL,
  current_balance BIGINT NOT NULL DEFAULT 0,
  lifetime_earned BIGINT NOT NULL DEFAULT 0,
  lifetime_redeemed BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_external_id)
);

COMMENT ON TABLE customer_point_balances IS 'Maintains the running point balance and lifetime totals for every customer who has earned points.';
COMMENT ON COLUMN customer_point_balances.customer_external_id IS 'Shopify numeric customer ID';
COMMENT ON COLUMN customer_point_balances.current_balance IS 'Current redeemable point balance';
COMMENT ON COLUMN customer_point_balances.lifetime_earned IS 'Total points ever earned';
COMMENT ON COLUMN customer_point_balances.lifetime_redeemed IS 'Total points ever redeemed';

CREATE INDEX idx_customer_point_balances_current_balance ON customer_point_balances (current_balance DESC);

CREATE TABLE redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_external_id BIGINT NOT NULL,
  discount_code_external_id BIGINT NULL,
  discount_code_string TEXT NULL,
  points_debited BIGINT NOT NULL,
  discount_value_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  failure_reason TEXT NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE redemptions IS 'Tracks every discount code issued to a customer and its current state so double-application and concurrent redemptions can be prevented.';
COMMENT ON COLUMN redemptions.customer_external_id IS 'Shopify numeric customer ID who requested the discount';
COMMENT ON COLUMN redemptions.discount_code_external_id IS 'Shopify numeric DiscountCodeNode ID after successful creation';
COMMENT ON COLUMN redemptions.discount_code_string IS 'Human-readable discount code string returned to the customer';
COMMENT ON COLUMN redemptions.points_debited IS 'Number of points debited for this redemption';
COMMENT ON COLUMN redemptions.discount_value_minor IS 'Discount value in minor currency units at time of redemption';
COMMENT ON COLUMN redemptions.currency IS 'ISO 4217 currency code for the discount value';
COMMENT ON COLUMN redemptions.status IS 'Workflow status of this redemption attempt';
COMMENT ON COLUMN redemptions.failure_reason IS 'Error message when status=failed';
COMMENT ON COLUMN redemptions.started_at IS 'When the workflow picked up this row';
COMMENT ON COLUMN redemptions.finished_at IS 'When the workflow reached a terminal state';

CREATE INDEX idx_redemptions_customer_external_id_status ON redemptions (customer_external_id, status);

CREATE TABLE point_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_external_id BIGINT NOT NULL,
  order_external_id BIGINT NULL,
  redemption_id UUID NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('earned', 'redeemed', 'compensating_credit')),
  points_delta BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_external_id),
  FOREIGN KEY (redemption_id) REFERENCES redemptions(id) ON DELETE SET NULL
);

COMMENT ON TABLE point_transactions IS 'Immutable ledger recording every points credit and debit with its source, enabling idempotency checks and audit history.';
COMMENT ON COLUMN point_transactions.customer_external_id IS 'Shopify numeric customer ID whose balance was affected';
COMMENT ON COLUMN point_transactions.order_external_id IS 'Shopify numeric order ID that triggered an earning transaction; null for redemption debits';
COMMENT ON COLUMN point_transactions.redemption_id IS 'FK to redemptions row for debit transactions; null for earn transactions';
COMMENT ON COLUMN point_transactions.transaction_type IS 'Whether this transaction credits or debits points';
COMMENT ON COLUMN point_transactions.points_delta IS 'Signed integer — positive for credits, negative for debits';
COMMENT ON COLUMN point_transactions.balance_after IS 'Customer balance immediately after this transaction';

CREATE INDEX idx_point_transactions_customer_external_id ON point_transactions (customer_external_id);
CREATE INDEX idx_point_transactions_redemption_id ON point_transactions (redemption_id);