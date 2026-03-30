export type TenantStatus = "active" | "suspended" | "pending";
export type AppStatus = "active" | "inactive" | "deleted";
export type VersionStatus = "draft" | "building" | "ready" | "failed" | "archived";
export type DeployedFunctionRuntime = "nodejs20.x" | "nodejs18.x";
export type WebhookTopic = "orders/create" | "orders/updated" | "orders/cancelled" | "products/create" | "products/update" | "customers/create" | "customers/update" | "app/uninstalled" | (string & {});
export type LogLevel = "info" | "warn" | "error" | "debug";
export type ExecutionStatus = "queued" | "running" | "success" | "failed" | "timeout";
export interface Tenant {
    id: string;
    slug: string;
    name: string;
    status: TenantStatus;
    plan: string;
    webhookSigningKeyKmsArn: string;
    createdAt: Date;
    updatedAt: Date;
}
export interface App {
    id: string;
    tenantId: string;
    slug: string;
    name: string;
    status: AppStatus;
    shopifyApiKey: string;
    shopifyApiSecretEncrypted: string;
    shopDomain: string;
    createdAt: Date;
    updatedAt: Date;
}
export interface AppVersion {
    id: string;
    appId: string;
    tenantId: string;
    semver: string;
    status: VersionStatus;
    generatedCode: Record<string, string>;
    buildLogs: string | null;
    s3BundleKey: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface DeployedFunction {
    id: string;
    appVersionId: string;
    appId: string;
    tenantId: string;
    lambdaArn: string;
    lambdaAlias: string;
    runtime: DeployedFunctionRuntime;
    memoryMb: number;
    timeoutSec: number;
    envVarsEncrypted: string;
    deployedAt: Date;
    isActive: boolean;
}
export interface WebhookSubscription {
    id: string;
    appId: string;
    tenantId: string;
    deployedFunctionId: string;
    topic: WebhookTopic;
    shopifyWebhookId: string;
    callbackUrl: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}
export interface ExecutionLog {
    id: string;
    webhookSubscriptionId: string;
    deployedFunctionId: string;
    appId: string;
    tenantId: string;
    topic: WebhookTopic;
    shopifyWebhookId: string;
    status: ExecutionStatus;
    durationMs: number | null;
    requestPayloadHash: string;
    responseStatusCode: number | null;
    errorMessage: string | null;
    lambdaRequestId: string | null;
    queuedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
}
export interface WebhookJobPayload {
    executionLogId: string;
    tenantId: string;
    appId: string;
    deployedFunctionId: string;
    lambdaArn: string;
    topic: WebhookTopic;
    shopifyWebhookId: string;
    rawBodyBase64: string;
    headers: Record<string, string>;
    receivedAt: string;
}
export interface WebhookRouteParams {
    tenantSlug: string;
    appSlug: string;
}
export interface ResolvedWebhookContext {
    tenant: Tenant;
    app: App;
    deployedFunction: DeployedFunction;
    subscription: WebhookSubscription;
}
//# sourceMappingURL=index.d.ts.map