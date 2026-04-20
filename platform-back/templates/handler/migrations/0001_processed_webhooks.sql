-- Webhook idempotency table — every handler ships with this baseline.
-- Locked decision 8: every webhook route starts with INSERT … ON CONFLICT
-- DO NOTHING and returns early on conflict, so duplicate webhook deliveries
-- (Shopify retries, BullMQ retries) become no-ops downstream of the DB.
CREATE TABLE IF NOT EXISTS processed_webhooks (
  webhook_id  TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- TTL index — webhooks older than 30 days can be safely pruned (Shopify
-- retries cap out long before then). The deployer can opt to schedule
-- a periodic DELETE; the index is here so that delete is cheap.
CREATE INDEX IF NOT EXISTS processed_webhooks_received_at_idx
  ON processed_webhooks (received_at);
