# Local Testing Guide

Two phases: first verify the pipeline works with no LLM or Shopify involved, then layer in real generation and a real Shopify dev store.

---

## Phase A — Smoke Test (no credentials required)

This tests the full Pub/Sub lifecycle — session creation, message routing, DB persistence — by injecting a pre-built mock bundle. No Anthropic key, no Shopify account.

### Prerequisites

- Docker Desktop running
- `python3` on PATH (ships with macOS)

### Run it

```bash
./scripts/smoke-test.sh
```

Add `--clean` to tear everything down when done:

```bash
./scripts/smoke-test.sh --clean
```

### What it checks

| # | Check |
|---|-------|
| 1 | postgres, redis, fake-gcs, pubsub-emulator start and are healthy |
| 2 | pubsub-init creates all 3 topics + 3 subscriptions |
| 3 | Test tenant + app seeded in DB (idempotent) |
| 4 | Node.js `api` service starts and `/health` returns `service: api` |
| 5 | `POST /generation` returns `{jobId, sessionId}` with HTTP 202 |
| 6 | The published `GenerationRequest` lands in `generator-sub` |
| 7 | Injected mock `FeatureBundleMessage` is received by `api-completed-sub` |
| 8 | Bundle is persisted to DB within ~5s of injection |
| 9 | `GET /generation/:jobId/result` returns the full bundle |
| 10 | Unknown jobId returns 404 |

If any check fails the script exits 1. Failing checks print `docker compose logs` commands to debug.

---

## Phase B — Real AI Generation (Anthropic key, no Shopify yet)

This runs the full five-agent Python pipeline against real Claude models.

### Prerequisites

- Phase A passing
- An Anthropic API key

### Setup

```bash
# Copy env templates
cp generator/.env.example generator/.env
cp platform/.env.example platform/.env

# Fill in your key
echo "ANTHROPIC_API_KEY=sk-ant-your-key-here" >> generator/.env
```

The `platform/.env` needs a `KMS_DEV_KEY` to start the webhook-gateway and worker. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Paste the output into platform/.env as KMS_DEV_KEY=...
```

### Start the full stack

**Option A — everything in Docker** (simplest):

```bash
docker compose up
```

The compose file reads `platform/.env` and `generator/.env` automatically via `env_file:`.

**Option B — infra in Docker, services running locally** (faster iteration):

```bash
# 1. Start only the infrastructure services
docker compose up -d postgres redis fake-gcs pubsub-emulator pubsub-init bull-board

# 2. Run the Node.js platform (in platform/)
cd platform && pnpm dev          # all services, or use --filter for one:
# pnpm turbo run dev --filter=@new-one-two/api

# 3. Run the Python generator (in generator/)
cd generator && source .venv/bin/activate && python main.py
# Or use the VS Code launch config: "Full Stack (api + generator)"
```

### Create a tenant and app

Before calling `/generation` you need a tenant and app row in the DB. Use the tenant API (passing a fixed `id` makes reruns idempotent):

```bash
# 1. Create tenant
curl -s -X POST http://localhost:3002/tenants \
  -H "Content-Type: application/json" \
  -d '{
    "id":           "00000000-0000-0000-0000-000000000001",
    "slug":         "dev-tenant",
    "name":         "Dev Tenant",
    "appArchetype": "storefront_ui"
  }'
# → full Tenant object

# 2. Create app under that tenant
curl -s -X POST http://localhost:3002/tenants/00000000-0000-0000-0000-000000000001/apps \
  -H "Content-Type: application/json" \
  -d '{
    "id":         "00000000-0000-0000-0000-000000000002",
    "slug":       "dev-app",
    "name":       "Dev App",
    "shopDomain": "dev-store.myshopify.com"
  }'
# → full App object
```

Omit `id` from either request to auto-generate a UUID — copy it from the response to use in the generation call.

### Trigger real generation

```bash
# 1. Start a generation job (storefront_ui → produces widgetModule JS + handler)
curl -X POST http://localhost:3002/generation \
  -H "Content-Type: application/json" \
  -d '{
    "appId":        "00000000-0000-0000-0000-000000000002",
    "tenantId":     "00000000-0000-0000-0000-000000000001",
    "prompt":       "Build me a notify me when back in stock feature",
    "appArchetype": "storefront_ui",
    "platformApiCatalog": [
      {"method":"POST","path":"/features/waitlist/signup"},
      {"method":"GET", "path":"/features/waitlist/status"}
    ]
  }'
# → {"jobId":"<UUID>","sessionId":"<UUID>"}

# 2. Watch progress (SSE — keep open in a second terminal)
curl -N http://localhost:3002/generation/<jobId>/progress

# 3. Fetch the result once completed
curl http://localhost:3002/generation/<jobId>/result | python3 -m json.tool

# 4. Approve + deploy (deploys to local Docker; Shopify App Block is stubbed)
curl -X POST http://localhost:3002/generation/<jobId>/approve
```

### What to verify

- The Python generator logs (via `docker compose logs generator-python -f`) show all five agent stages: `intent → schema → codegen (parallel) → validation → explanation`
- The result includes all four bundle fields: `widgetModule`, `handlerModule`, `dbMigration`, `explanation`
- For `storefront_ui` apps: `widgetModule` is a non-null JavaScript string containing `export function mount`
- For `backend_only` apps: `widgetModule` is `null`
- The `dbMigration.sql` has `tenant_id UUID NOT NULL` and `CREATE POLICY` in every `CREATE TABLE` (or is empty string if no DB tables needed)
- The `handlerModule.code` uses `ctx.shopify` and `ctx.db` — no raw `fetch()` or `require()`
- The `widgetModule` code only calls `host.call()` with paths listed in `platformApiCatalog`

---

## Phase C — Full Shopify Loop (real dev store)

### One-time Shopify setup

**1. Create a Shopify Partner account**
Go to partners.shopify.com → Create account (free).

**2. Create a development store**
Partners dashboard → Stores → Add store → Development store.
Note your store domain: `your-store.myshopify.com`

**3. Start ngrok first**
Before configuring the app URL you need to know your ngrok address. Start it now and keep it running:

```bash
ngrok http 3001
```

Note the HTTPS URL shown (e.g. `https://abc123.ngrok.io`). Use it everywhere below.

**4. Get an access token for your dev store**

Shopify's Dev Dashboard (mandatory as of January 2026) no longer shows a static token — instead you get a **Client ID + Client Secret** and exchange them for a short-lived token (expires in 24 hours).

**4a. Start the webhook gateway locally**

Before installing the app, make sure the webhook gateway is running so Shopify can reach it during and after the install flow:

```bash
cd platform/apps/webhook-gateway
npm run dev
```

The server listens on `http://localhost:3001` by default. Keep this terminal open throughout the setup.

**4b. Create the app in the Dev Dashboard**

1. Go to `https://dev.shopify.com/dashboard/` → **Create app**
2. Name it anything (e.g. "local-dev")
3. Go to **Versions** → fill in:
   - **App URL**: `https://shopify.dev/apps/default-app-home` (placeholder, not used)
   - **Webhooks API version**: `2026-01`
   - **Scopes**:
     ```
     read_products,read_inventory,write_inventory,read_orders,write_orders,read_customers,write_customers,read_price_rules,write_price_rules
     ```
4. Click **Release**
5. Go to **Home** → **Install app** → select your dev store → confirm
6. Go to **Settings** → copy **Client ID** and **Client Secret**

**4c. Exchange credentials for an access token**

```bash
curl -X POST "https://hadad747teststore.myshopify.com/admin/oauth/access_token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET"
```

Response:
```json
{ "access_token": "shpua_...", "expires_in": 86399 }
```

Paste `access_token` into `SHOPIFY_ACCESS_TOKEN` in `platform/.env`.

> **Token expires every 24 hours.** Re-run the curl above to get a fresh token when it expires.

### Environment variables for the full loop

Add to `platform/.env`:

```bash
# Your Shopify dev store
SHOPIFY_CLIENT_ID=abc123...               # client_id from Partner Dashboard
SHOPIFY_CLIENT_SECRET=shpss_...          # client_secret from Partner Dashboard

# Shopify Partners API (for App Block deployment)
# From partners.shopify.com → Settings → Partner API clients → Create API key
SHOPIFY_PARTNERS_TOKEN=prtapi_...
SHOPIFY_PARTNER_ORG_ID=1234567           # numeric org ID from partner dashboard URL

# Webhook gateway needs a public URL
WEBHOOK_BASE_URL=https://<your-ngrok>.ngrok.io
```

> `SHOPIFY_PARTNERS_TOKEN` is different from the store access token. It's a Partners API token
> from your partner account settings, used only for deploying App Block extensions.

### End-to-end test with Shopify

**1. Generate + deploy the back-in-stock feature**

```bash
# Generate (storefront_ui → produces widgetModule JS + handler)
curl -X POST http://localhost:3002/generation \
  -H "Content-Type: application/json" \
  -d '{"appId":"<app-uuid>","tenantId":"<tenant-uuid>","prompt":"Back in stock notifier","appArchetype":"storefront_ui",...}'

# Watch progress
curl -N http://localhost:3002/generation/<jobId>/progress

# Approve (runs DB migration, stores widget JS in tenant, deploys handler to local Docker)
curl -X POST http://localhost:3002/generation/<jobId>/approve
```

**2. Trigger the webhook from Shopify admin**

In your dev store, go to a product → adjust inventory (reduce to 0, then add back).
This fires `inventory_levels/update` to your ngrok URL.

**3. Verify end-to-end**

```bash
# Webhook gateway logs — should show the signed webhook received + enqueued
docker compose logs webhook-gateway --tail 50

# Worker logs — should show handler executed
docker compose logs worker --tail 50

# Bull Board UI — view the job queue
open http://localhost:3010
```

## Service ports at a glance

| Service | Port | Purpose |
|---------|------|---------|
| `api` | 3002 | Generation lifecycle REST + SSE |
| `webhook-gateway` | 3001 | Shopify webhook ingress + `GET /widgets/:shop/:appId.js` |
| `generator-python` | 8001 | FastAPI `/health` + `/trigger` |
| `postgres` | 5432 | Database |
| `redis` | 6379 | BullMQ job queue |
| `fake-gcs` | 4443 | Local Cloud Storage emulator |
| `pubsub-emulator` | 8085 | Local Pub/Sub emulator |
| `bull-board` | 3010 | Queue monitoring UI |
