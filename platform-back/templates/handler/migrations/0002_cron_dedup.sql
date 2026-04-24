-- Adds opt-in idempotency to cron_queue.
--
-- Use case: admin "Run now" button gets double-clicked, or a webhook
-- fires twice during a retry storm and each delivery enqueues the
-- same follow-up job. Without dedup, that's two rows -> two runs.
--
-- enqueueJob now accepts an optional `dedupKey`. When a key is
-- supplied, the partial unique index below makes a second insert a
-- silent no-op IF a prior row with the same (job_name, dedup_key) is
-- still pending or processing. Once the prior row finishes ('done' or
-- 'failed'), a fresh enqueue with the same dedupKey is allowed again
-- — the dedup is "in-flight only", not "one-shot forever".
--
-- Rows without a dedupKey are unaffected (the partial predicate skips
-- them), so existing call sites keep their fire-and-forget semantics.

ALTER TABLE cron_queue
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS cron_queue_dedup_active_idx
  ON cron_queue (job_name, dedup_key)
  WHERE dedup_key IS NOT NULL
    AND status IN ('pending', 'processing');
