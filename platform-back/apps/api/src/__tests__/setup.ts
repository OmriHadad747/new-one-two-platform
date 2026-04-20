// Sets required env vars before any module-level code runs.
// Modules like admin.ts, widget.ts, and oauth.ts throw at evaluation time
// if these are missing — this file runs in the worker before test files load.

process.env["SHOPIFY_CLIENT_ID"] = "test-client-id";
process.env["SHOPIFY_CLIENT_SECRET"] = "test-client-secret";
process.env["JWT_SECRET"] = "test-jwt-secret";
process.env["PLATFORM_URL"] = "http://localhost:3002";
process.env["DASHBOARD_URL"] = "http://localhost:3000";
process.env["WEBHOOK_GATEWAY_URL"] = "http://localhost:3003";
process.env["GCP_PROJECT"] = "test-project";
process.env["DEPLOY_MODE"] = "local";
process.env["API_AUTH_REQUIRED"] = "false";
process.env["CLOUD_RUN_SKIP_AUTH"] = "true";
process.env["EXPECTED_AUDIENCE"] = "http://localhost:3002";
process.env["PLATFORM_SA_EMAIL"] = "";
process.env["NODE_ENV"] = "test";
