/** Job payload enqueued by the webhook gateway for the worker. */
export interface WebhookJobPayload {
  executionLogId: string;
  tenantId: string;
  appId: string;
  deployedFunctionId: string;
  functionUrl: string; // Cloud Run service URL
  topic: string;
  shopifyWebhookId: string;
  rawBodyBase64: string; // base64-encoded raw body
  headers: Record<string, string>;
  receivedAt: string; // ISO timestamp
}

export interface WebhookRouteParams {
  tenantSlug: string;
  appSlug: string;
}
