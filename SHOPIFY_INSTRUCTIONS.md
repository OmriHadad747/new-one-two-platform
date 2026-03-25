# Shopify App Deployment

## Prerequisites

```bash
npm install -g @shopify/cli @shopify/app
```

You need a Shopify Partner account. Sign up at partners.shopify.com if you don't have one.

---

## 1. Create the app in the Partner Dashboard

1. Go to **partners.shopify.com → Apps → Create app → Create app manually**
2. Give it a name (e.g. `new-one-two`)
3. Copy the **Client ID** and **Client secret** — you'll need both below

---

## 2. Fill in the placeholders

**`shopify-app/shopify.app.toml`** — replace the two placeholders:

```toml
client_id        = "<your client ID from step 1>"
application_url  = "https://<your platform domain>"   # e.g. https://api.new-one-two.com
```

Also update `redirect_urls` to match:

```toml
[auth]
redirect_urls = [
  "https://<your platform domain>/oauth/callback",
  "http://localhost:3002/oauth/callback",
]
```

**Platform env / Secret Manager** — store the client secret so the OAuth route can use it:

```bash
# Local dev (.env)
SHOPIFY_CLIENT_ID=<client ID>
SHOPIFY_CLIENT_SECRET=<client secret>

# Production — store via your existing storeSecret flow
```

---

## 3. Log in to the Shopify CLI

```bash
cd shopify-app
shopify auth login
```

Select your Partner account when prompted.

---

## 4. Deploy the app and extensions

This pushes the `widget-runtime` theme extension to Shopify's CDN and syncs the app config (scopes, redirect URLs) from `shopify.app.toml`.

```bash
cd shopify-app
shopify app deploy
```

The CLI will ask you to confirm the scopes and redirect URLs before applying. After a successful deploy, the `widget-runtime` extension is available to install on any merchant store.

> Run this again any time you change `widget-runtime.js`, `app-block.liquid`, or `shopify.app.toml`.

---

## 5. Install the app on a dev store

Generate the install URL and open it in a browser:

```
https://<your platform domain>/oauth/install?shop=<dev-store>.myshopify.com
```

The OAuth flow will:
1. Redirect the merchant to Shopify for approval
2. Exchange the code for a token
3. Write the `platform_app.base_url` shop metafield (used by the App Block to find the platform)
4. Create the tenant in the platform DB
5. Redirect to `DASHBOARD_URL/merchants/<tenantId>`

---

## 6. Add the App Block to the theme

After install, the merchant (or you, in the theme editor):

1. Go to **Online Store → Themes → Customize**
2. Add a section → **Apps** → **Platform Widget**
3. Set the **App ID** field to the platform app's UUID (from the dashboard or DB)
4. Save — the widget loads from `GET /widgets/<shop>/<appId>.js`

---

## Local development

To test the OAuth flow and extension locally with a live tunnel:

```bash
cd shopify-app
shopify app dev
```

The CLI starts a tunnel (e.g. `https://abc123.trycloudflare.com`), overrides `application_url` temporarily, and hot-reloads extension changes. The platform API still needs to be running locally on port 3002.
