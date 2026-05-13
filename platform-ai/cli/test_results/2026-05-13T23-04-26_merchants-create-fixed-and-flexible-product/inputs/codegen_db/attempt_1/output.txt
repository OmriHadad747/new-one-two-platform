CREATE TABLE bundles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('fixed', 'flexible')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  health_status TEXT NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy', 'warned', 'auto_disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE bundles IS 'Stores each bundle''s identity, mode, enabled state, and system-managed health status.';
COMMENT ON COLUMN bundles.mode IS 'Distinguishes fixed bundles (predefined set) from flexible bundles (customer picks from pool).';
COMMENT ON COLUMN bundles.health_status IS 'Merchant-facing health signal reflecting current variant availability state.';

CREATE INDEX idx_bundles_enabled ON bundles (enabled);
CREATE INDEX idx_bundles_health_status ON bundles (health_status);
CREATE INDEX idx_bundles_created_at ON bundles (created_at);

CREATE TABLE bundle_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  variant_external_id BIGINT NOT NULL,
  product_external_id BIGINT NOT NULL,
  observed_availability TEXT NULL CHECK (observed_availability IN ('available', 'out_of_stock', 'deleted')),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bundle_id, variant_external_id)
);

COMMENT ON TABLE bundle_items IS 'Stores variant-level products belonging to each bundle including last-observed availability.';
COMMENT ON COLUMN bundle_items.bundle_id IS 'The bundle this item belongs to.';
COMMENT ON COLUMN bundle_items.variant_external_id IS 'The specific product variant in Shopify (numeric REST id).';
COMMENT ON COLUMN bundle_items.product_external_id IS 'The parent product of the variant, used for deletion event matching.';
COMMENT ON COLUMN bundle_items.observed_availability IS 'Last known availability state; NULL means never observed.';

CREATE INDEX idx_bundle_items_variant_external_id ON bundle_items (variant_external_id);
CREATE INDEX idx_bundle_items_observed_availability ON bundle_items (observed_availability);

CREATE TABLE bundle_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  minimum_item_count INTEGER NOT NULL,
  discount_rate INTEGER NOT NULL,
  display_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bundle_id, minimum_item_count)
);

COMMENT ON TABLE bundle_tiers IS 'Stores each discount tier for a bundle with minimum item count, discount rate, and display order.';
COMMENT ON COLUMN bundle_tiers.bundle_id IS 'The bundle this tier belongs to.';
COMMENT ON COLUMN bundle_tiers.minimum_item_count IS 'Minimum number of items customer must select to earn this tier.';
COMMENT ON COLUMN bundle_tiers.discount_rate IS 'Discount rate stored as integer basis points (e.g. 1000 = 10.00%).';
COMMENT ON COLUMN bundle_tiers.display_order IS 'Merchant-defined display sequence; lower value renders first.';

CREATE INDEX idx_bundle_tiers_display_order ON bundle_tiers (display_order);

CREATE TABLE bundle_purchase_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id UUID NOT NULL REFERENCES bundles(id) ON DELETE RESTRICT,
  order_external_id BIGINT NOT NULL,
  order_placed_at TIMESTAMPTZ NOT NULL,
  variant_external_ids JSONB NOT NULL,
  item_count INTEGER NOT NULL,
  discount_rate_applied INTEGER NOT NULL,
  order_total_minor_units BIGINT NOT NULL,
  order_currency TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_external_id, bundle_id)
);

COMMENT ON TABLE bundle_purchase_records IS 'Records every bundle present in a paid order for purchase history and analytics; deduped by order+bundle.';
COMMENT ON COLUMN bundle_purchase_records.bundle_id IS 'The bundle that was purchased.';
COMMENT ON COLUMN bundle_purchase_records.order_external_id IS 'The paid Shopify order id that contained this bundle.';
COMMENT ON COLUMN bundle_purchase_records.variant_external_ids IS 'Array of Shopify variant ids selected by the customer at purchase time.';
COMMENT ON COLUMN bundle_purchase_records.discount_rate_applied IS 'Discount rate in basis points applied at purchase.';
COMMENT ON COLUMN bundle_purchase_records.order_total_minor_units IS 'Order total in currency minor units for correct multi-currency storage.';
COMMENT ON COLUMN bundle_purchase_records.order_currency IS 'ISO 4217 currency code of the order, required to format order_total_minor_units correctly.';

CREATE INDEX idx_bundle_purchase_records_bundle_id ON bundle_purchase_records (bundle_id);
CREATE INDEX idx_bundle_purchase_records_order_placed_at ON bundle_purchase_records (order_placed_at);

CREATE TABLE bundle_health_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('auto_disabled', 'warned', 'cleared')),
  affected_variant_external_id BIGINT NULL,
  reason TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE bundle_health_events IS 'Audit log of every automated health state change applied to a bundle.';
COMMENT ON COLUMN bundle_health_events.bundle_id IS 'The bundle whose health changed.';
COMMENT ON COLUMN bundle_health_events.event_kind IS 'Type of health change recorded.';
COMMENT ON COLUMN bundle_health_events.affected_variant_external_id IS 'The variant whose availability triggered this health change.';

CREATE INDEX idx_bundle_health_events_bundle_id ON bundle_health_events (bundle_id);
CREATE INDEX idx_bundle_health_events_occurred_at ON bundle_health_events (occurred_at);

CREATE TABLE inventory_item_variant_map (
  inventory_item_id BIGINT PRIMARY KEY,
  variant_external_id BIGINT NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE inventory_item_variant_map IS 'Maps Shopify inventory_item_id to variant_external_id so inventory_levels/update webhooks can resolve the affected variant without an extra Shopify API call after first observation.';
COMMENT ON COLUMN inventory_item_variant_map.inventory_item_id IS 'Shopify inventory item id delivered by inventory_levels/update webhook.';
COMMENT ON COLUMN inventory_item_variant_map.variant_external_id IS 'Corresponding Shopify variant id resolved via admin API.';

CREATE INDEX idx_inventory_item_variant_map_variant_external_id ON inventory_item_variant_map (variant_external_id);