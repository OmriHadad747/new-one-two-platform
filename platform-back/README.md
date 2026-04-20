# platform-back

The platform edge. Verifies Shopify trust-domain auth (App Bridge JWT, App
Proxy HMAC, Shopify webhook HMAC) and forwards the request to the
per-tenant handler container running on Cloud Run.

This service replaces `platform/apps/api` over time. While the migration
is in progress, the old `platform/` directory is kept as a reference and
must not be modified.

## Routes (current)

- `POST /admin/:appId/*` — App Bridge JWT verified at edge, forwarded to
  the tenant's handler.

Routes planned: `POST /webhook/<topic>`, `POST /widget/*`,
`POST /services/email/send`, etc.

## Auth model

**Inbound (Shopify → platform-back):** Each trust domain has its own
verification. Today only admin (App Bridge JWT HS256, signed with the
Shopify app's client secret).

**Outbound (platform-back → handler):** Cloud Run IAM. Platform-back's
service account holds `roles/run.invoker` on each handler service.
Platform-back mints a Google-signed ID token (audience = handler URL)
via the metadata server and sends it as `Authorization: Bearer <token>`.
Cloud Run validates the token before the request reaches the handler
container. No HMAC, no shared secret.

In local dev, set `CLOUD_RUN_SKIP_AUTH=true` to skip token minting.

## Required environment

```
PORT=3010
HOST=0.0.0.0
NODE_ENV=development|production
LOG_LEVEL=info

# Database
DATABASE_URL=postgres://platform_user:<password>@<host>/new_one_two

# Shopify OAuth
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...

# JWT signing (platform ↔ handler auth token)
JWT_SECRET=...

# This service's own public URL — used as OAuth redirect base and as the
# EXPECTED_AUDIENCE when handlers verify inbound ID tokens.
PLATFORM_URL=https://api.newonetwo.com

# The platform-back service account email. Injected into every handler as
# PLATFORM_SA_EMAIL so verify-platform middleware can assert the caller SA.
# Missing in prod = silent 403 on every /services/* call.
PLATFORM_SA_EMAIL=api-sa@newonetwo-493019.iam.gserviceaccount.com

# Public URL of the webhook-gateway service (used when registering Shopify
# webhooks for deployed handlers).
WEBHOOK_GATEWAY_URL=https://webhooks.newonetwo.com

# Email delivery (Resend)
RESEND_API_KEY=re_...
EMAIL_UNSUBSCRIBE_SECRET=...   # HMAC key for unsubscribe tokens; fail-fast in prod

# GCP — deployer package
GCP_PROJECT=newonetwo-493019
GCP_REGION=us-central1                                          # default: us-central1
DOCKER_REGISTRY=us-central1-docker.pkg.dev/newonetwo-493019/new-one-two

# Edge CORS
ALLOWED_ORIGINS=https://admin.shopify.com,https://*.myshopify.com

# Outbound auth to handlers
CLOUD_RUN_SKIP_AUTH=true   # local dev only; unset in prod
```

## Run locally

```
pnpm install
pnpm dev
```
