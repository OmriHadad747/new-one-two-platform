# Local Dev — Full Shopify Loop

End-to-end test with a real Shopify dev store, AI generation, and live webhooks.

---

## Prerequisites (one-time)

- Docker Desktop running
- pnpm installed
- Python venv set up: `cd generator && python3 -m venv .venv && pip install -r requirements.txt`
- ngrok account with **three** static domains configured (see ngrok config below)
- `platform/.env` filled in (see template at `platform/.env.example`)
- `generator/.env` with `ANTHROPIC_API_KEY`
- `platform-shopify-admin/.env` with `VITE_SHOPIFY_CLIENT_ID` (copy from `.env.example`)

### ngrok config (`~/Library/Application Support/ngrok/ngrok.yml`)

```yaml
version: "2"
authtoken: <your-authtoken>

tunnels:
  platform-api:
    proto: http
    addr: 3002
  webhook-gateway:
    proto: http
    addr: 3001
  admin-shell:
    proto: http
    addr: 3003
```

Start all three: `ngrok start --all`

---

## Run cycle

### Step 1 + 2 — Start infra

```bash
docker compose down -v && docker compose up -d postgres redis fake-gcs pubsub-emulator pubsub-init bull-board
```

### Step 3 — Start ngrok, sync URLs, and deploy Shopify app

Start ngrok, then run the helper script — it updates `platform/.env` and `shopify.app.toml` with the new URLs and runs `shopify app deploy` automatically:

```bash
ngrok start --all
# in another terminal, once ngrok is up:
./scripts/sync-ngrok.sh
```

The script prints the install link at the end — keep it handy for Step 5.


### Step 5 — Install the app

Use the install link printed by `sync-ngrok.sh` in Step 3 (format: `https://<api-ngrok>/oauth/install?shop=<your-store>.myshopify.com`).

Complete the OAuth flow. On success you will be redirected to **platform-front** at `http://localhost:3000/merchants/<tenantId>`.

The API logs will print the merchant access token — copy it and add it to `SM_DEV_SECRETS` in `platform/.env`:

```
SM_DEV_SECRETS={
  "projects/local/secrets/shopify-webhook-secret/versions/latest": "shpss_...",
  "projects/local/secrets/<your-store>-access-token/versions/latest": "shpua_..."
}
```

> **Why:** The deployer needs this token to call `POST /webhooks.json` on Shopify when registering the `inventory_levels/update` webhook during deploy. Without it, webhook registration is skipped and no events will arrive.

Restart the API after updating.

### Step 6 — Add App Block to your theme

1. Go to Shopify Admin → Online Store → Themes → duplicate the published theme (creates an unpublished copy)
2. On the duplicated theme → Customize
3. Navigate to a product page template
4. Add an App Block from the **new-one-two** app
5. In the block settings, set **App ID** to: `00000000-0000-0000-0000-000000000002`
6. Save

### Step 7 — Create app


### Step 8 — Generate the feature


### Step 9 — Deploy

The deployer will:
- Apply the DB migration
- Build and start the harness Docker container
- Register `inventory_levels/update` webhook with Shopify
- Return `{"deployed": true, "functionUrl": "http://localhost:9002"}`

### Step 10 — Save the result (optional)

---

## Test the back-in-stock flow

### Step 11 — Find an out-of-stock product

In Shopify Admin → Products, find a product that has inventory tracking enabled. Set a variant's inventory to **0** (this sets the baseline in `inventory_stock_state`). Wait for the `inventory_levels/update` webhook to fire (check webhook gateway logs).

### Step 12 — Subscribe via the storefront widget

Go to the product page on your dev store. The widget should appear. Enter an email and click "Notify me".

Verify the subscription was saved:
```bash
psql postgresql://new_one_two_u:paas_dev_password@localhost:5432/new_one_two \
  -c "SELECT * FROM back_in_stock_subscriptions;"
```

### Step 13 — Trigger the back-in-stock event

In Shopify Admin → Products, set the variant inventory back to **> 0**.

Shopify fires `inventory_levels/update` → webhook gateway → BullMQ → worker → harness.

Verify the full chain:
```bash
# Webhook gateway received it
# (check gateway terminal or)
open http://localhost:3010   # Bull Board — job should show as completed

# Harness processed it
docker logs harness-00000000-0000-0000-0000-000000000002 --tail 30
# Look for: "invoke completed" with status: "success"
# Look for: "EMAIL_SENT" log lines (one per subscriber)
```

---

## Quick reference

| Service | URL | ngrok tunnel | Purpose |
|---------|-----|-------------|---------|
| Platform Front | http://localhost:3000 | — (no tunnel needed) | Merchant dashboard — post-install redirect |
| Webhook Gateway | http://localhost:3001 | port 3001 | Shopify webhook ingress |
| API | http://localhost:3002 | port 3002 | Generation + OAuth callback + widget proxy |
| Admin Shell | http://localhost:3003 | port 3003 | Shopify Admin embedded app (loaded in iframe) |
| Generator | http://localhost:8001 | — | Python AI pipeline |
| Bull Board | http://localhost:3010 | — | Queue monitoring |

### OAuth install → redirect flow

```
merchant clicks install link
  → GET <api-ngrok>/oauth/install?shop=...
  → Shopify OAuth (Shopify's servers)
  → GET <api-ngrok>/oauth/callback?code=...
  → API creates tenant, stores tokens
  → 302 → http://localhost:3000/merchants/<tenantId>   ← platform-front
```

### Shopify Admin sidebar flow

```
merchant opens Shopify Admin → clicks your app in sidebar
  → Shopify loads <admin-ngrok>/?shop=...&host=...  (platform-shopify-admin)
  → App Bridge initialises, shell fetches apps list
  → merchant selects an app → admin UI module mounts
  → bridge.call() → POST <api-ngrok>/admin/:appId/*
    (session token verified — shop read from JWT claims, forwarded to harness)
```

## Troubleshooting

**No webhook arriving at gateway**
- Check the webhook is registered: Shopify Admin → Settings → Notifications → Webhooks
- The URL should be `https://<webhook-ngrok>/webhook/<tenant-slug>/<app-slug>`
- Re-install the app (hit the install URL) to re-register with the current ngrok URL

**"duplicate key" on deploy**
- A version with that semver already exists — trigger generation again (creates a new version)
