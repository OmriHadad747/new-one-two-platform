CREATE TABLE daily_revenue_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date TIMESTAMPTZ NOT NULL,
  currency_code TEXT NOT NULL,
  total_revenue BIGINT NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  zero_revenue_order_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date)
);

COMMENT ON TABLE daily_revenue_snapshots IS 'Stores one pre-aggregated revenue and order-volume row per calendar day so any date range query is answered by summing a bounded set of rows.';
COMMENT ON COLUMN daily_revenue_snapshots.snapshot_date IS 'Calendar day this row covers (stored as midnight UTC)';
COMMENT ON COLUMN daily_revenue_snapshots.currency_code IS 'ISO 4217 currency code from the shop''s money; required for money helper formatting';
COMMENT ON COLUMN daily_revenue_snapshots.total_revenue IS 'Sum of all order totalPriceSet.shopMoney.amount in minor units for the day';
COMMENT ON COLUMN daily_revenue_snapshots.order_count IS 'Total number of orders created on snapshot_date';
COMMENT ON COLUMN daily_revenue_snapshots.zero_revenue_order_count IS 'Number of orders whose total revenue is zero (fully discounted)';

CREATE TABLE daily_product_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date TIMESTAMPTZ NOT NULL,
  product_external_id BIGINT NOT NULL,
  product_name TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  units_sold INTEGER NOT NULL DEFAULT 0,
  revenue_contribution BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date, product_external_id)
);

COMMENT ON TABLE daily_product_snapshots IS 'Stores pre-aggregated per-product sales figures for each calendar day so top-products queries over any date range require only a bounded aggregation over this table.';
COMMENT ON COLUMN daily_product_snapshots.snapshot_date IS 'Calendar day this row covers (stored as midnight UTC)';
COMMENT ON COLUMN daily_product_snapshots.product_external_id IS 'Shopify numeric product ID; raw segment parsed from the GID';
COMMENT ON COLUMN daily_product_snapshots.product_name IS 'Product title at snapshot time; retained for historical display even if product is later deleted';
COMMENT ON COLUMN daily_product_snapshots.currency_code IS 'ISO 4217 currency code for revenue_contribution';
COMMENT ON COLUMN daily_product_snapshots.units_sold IS 'Total quantity of this product sold across all line items on snapshot_date';
COMMENT ON COLUMN daily_product_snapshots.revenue_contribution IS 'Sum of line item totalDiscountedPrice in minor units for this product on snapshot_date';

CREATE INDEX idx_daily_product_snapshots_snapshot_date_product_external_id ON daily_product_snapshots (snapshot_date, product_external_id);

CREATE TABLE daily_customer_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date TIMESTAMPTZ NOT NULL,
  customer_external_id BIGINT NOT NULL,
  orders_placed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date, customer_external_id)
);

COMMENT ON TABLE daily_customer_activity IS 'Stores the order count placed by each identifiable customer on each calendar day, enabling repeat customer rate to be computed for any date range without scanning raw orders.';
COMMENT ON COLUMN daily_customer_activity.snapshot_date IS 'Calendar day this row covers (stored as midnight UTC)';
COMMENT ON COLUMN daily_customer_activity.customer_external_id IS 'Shopify numeric customer ID; raw segment parsed from the customer GID; anonymous orders are omitted entirely';
COMMENT ON COLUMN daily_customer_activity.orders_placed IS 'Number of orders placed by this customer on snapshot_date';

CREATE INDEX idx_daily_customer_activity_snapshot_date_customer_external_id ON daily_customer_activity (snapshot_date, customer_external_id);

CREATE TABLE snapshot_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  failure_reason TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL
);

COMMENT ON TABLE snapshot_runs IS 'Tracks every scheduled snapshot job execution and its outcome so duplicate runs are detected and failures are auditable.';
COMMENT ON COLUMN snapshot_runs.target_date IS 'Calendar day (midnight UTC) this run is computing snapshots for';
COMMENT ON COLUMN snapshot_runs.status IS 'Lifecycle status of this run attempt';
COMMENT ON COLUMN snapshot_runs.failure_reason IS 'Error message captured when status transitions to failed';
COMMENT ON COLUMN snapshot_runs.completed_at IS 'Timestamp when status transitions to completed or failed';

CREATE INDEX idx_snapshot_runs_target_date_status ON snapshot_runs (target_date, status);
CREATE INDEX idx_snapshot_runs_started_at ON snapshot_runs (started_at);