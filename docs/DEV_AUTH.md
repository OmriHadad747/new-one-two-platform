# Dev authentication — `API_AUTH_REQUIRED=false` still needs a token for generation routes

Since Batch 4 (PR #15), a handful of `/generation/*` routes require an authenticated JWT to derive a `tenantId` — even with `API_AUTH_REQUIRED=false`. This is not a regression; it's the price of real RLS enforcement on `generation_sessions` (see migration `0003_rls_on_remaining_tables.sql`). Every read of a session must run inside `withTenantContext(tenantId, …)`, and the routes below don't carry `tenantId` in the URL, so the API derives it from the token instead.

## Which routes

These return **401** when no token is present, regardless of `API_AUTH_REQUIRED`:

```
POST   /generation/:jobId/approve
POST   /generation/:jobId/revise
POST   /generation/:jobId/cancel
PATCH  /generation/:jobId/chat
GET    /generation/:jobId/result
GET    /generation/app/:appId/latest
GET    /generation/app/:appId/latest-completed
GET    /generation/app/:appId/sessions
```

These still work without a token (unchanged):

```
POST   /generation/                    — body carries `tenantId`
GET    /generation/:jobId/progress     — SSE, reads only Pub/Sub, never touches the DB
GET    /health, /oauth, /widgets, /admin-ui — exempt by design (see plugins/auth.ts EXEMPT_PREFIXES)
```

## How to get a token in dev

The platform issues a signed JWT on successful Shopify OAuth install. The dev flow is:

1. Bring the stack up:
   ```
   docker compose up --build
   ```

2. Create a test tenant manually if you don't already have one:
   ```
   curl -X POST http://localhost:3002/tenants \
     -H "Content-Type: application/json" \
     -d '{"slug":"dev-tenant","name":"Dev Tenant"}'
   ```
   (POST `/tenants` is unauthenticated on purpose — it's the bootstrap.)

3. Complete Shopify OAuth once against your dev Partner app. The callback at
   `GET /oauth/callback` returns a `<script>`-style response that stores the
   JWT in `localStorage` on `DASHBOARD_URL` before redirecting. After that,
   the frontend's fetch wrapper (`platform-front/src/lib/api.ts:36`) reads
   the token and attaches `Authorization: Bearer <token>` to every request.

4. The token is long-lived (days). You don't re-auth every session — just
   hit Deploy / Approve / Revise as usual.

**If you're not using the dashboard** (e.g. testing the API with `curl` or
a browser extension), you can mint a token directly:

```ts
// In a REPL against the running @new-one-two/api process:
import { signJwt } from "./plugins/auth.js";
signJwt({ tenantId: "<your-dev-tenant-uuid>", shopDomain: "dev.myshopify.com" });
```

The signing secret comes from `JWT_SECRET` (or falls back to `SHOPIFY_CLIENT_SECRET`). Same key used by the real OAuth callback.

## Why not a bypass env var?

A `DEV_IMPERSONATE_TENANT_ID` hatch was considered and rejected. The risk of leaving it on in production outweighs the dev-ergonomics win, and the production mode assertion would need to be foolproof — easier to just mint a token once.

If this becomes painful often enough that a bypass is warranted, add a startup check that refuses to boot when `NODE_ENV=production` and `DEV_IMPERSONATE_TENANT_ID` is set. Until then, mint the token.

## Debugging "this worked yesterday"

If a generation route that used to work now 401s:

- The frontend's `localStorage` JWT may have expired. Check the `exp` claim (JWT debugger, or just reinstall).
- `JWT_SECRET` changed between restarts — tokens issued under the old secret now fail `verify`. Set a stable `JWT_SECRET` in `platform/.env` to avoid this.
- You're hitting the API directly without `Authorization: Bearer <token>`. Not the route's fault; attach the header.

The 401 response envelope has `code: "auth_required"` so the frontend can disambiguate from other 401 codes (`token_invalid` for a bad token, `token_missing` for a missing `Bearer` prefix).
