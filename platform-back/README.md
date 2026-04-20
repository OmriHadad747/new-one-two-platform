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

DATABASE_URL=postgres://...

SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...

# Outbound auth to handlers
CLOUD_RUN_SKIP_AUTH=true   # local dev only; unset in prod

# Edge CORS
ALLOWED_ORIGINS=https://admin.shopify.com,https://*.myshopify.com
```

## Run locally

```
pnpm install
pnpm dev
```
