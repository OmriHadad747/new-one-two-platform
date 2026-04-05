-- Rename execution_logs → webhook_invocation_logs for consistency with
-- widget_invocation_logs and admin_invocation_logs.

ALTER TABLE execution_logs RENAME TO webhook_invocation_logs;

ALTER INDEX idx_exec_logs_idempotency  RENAME TO idx_webhook_inv_logs_idempotency;
ALTER INDEX idx_exec_logs_tenant_app   RENAME TO idx_webhook_inv_logs_tenant_app;
ALTER INDEX idx_exec_logs_status       RENAME TO idx_webhook_inv_logs_status;
ALTER INDEX idx_exec_logs_queued_at    RENAME TO idx_webhook_inv_logs_queued_at;
