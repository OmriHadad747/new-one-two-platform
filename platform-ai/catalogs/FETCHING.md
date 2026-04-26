# Fetching Shopify GraphQL schemas

One script, two surfaces, three outputs per (surface, version).

## Run it

```
python platform-ai/scripts/refresh_shopify_graphql_catalog.py <surface> <version>
```

- `<surface>` — `admin` or `storefront`
- `<version>` — e.g. `2026-04` (must match `WEBHOOK_API_VERSION` in `subagents/prompts/topics/webhook.py`)

### Auth

| surface | endpoint | auth |
|---|---|---|
| admin | `https://shopify.dev/admin-graphql-direct-proxy/<version>` | none (public proxy) |
| storefront | `https://<DEV_SHOP_DOMAIN>/api/<version>/graphql.json` | env vars `DEV_SHOP_DOMAIN` (default `hadad747teststore.myshopify.com`) + `DEV_STOREFRONT_TOKEN` |

## Outputs

Written to `catalogs/shopify_<surface>/<version>/`:

| file | role |
|---|---|
| `schema.introspection.json` | raw introspection result; build-time scrap kept for re-derivation |
| `schema.graphql` | full SDL; consumed offline by `validation/graphql_validation.py` to gate handler queries |
| `summary.md` | compressed op index injected into prompts; see [CLUSTERING.md](CLUSTERING.md) |

## When to run

On every `WEBHOOK_API_VERSION` bump. Refresh both surfaces in the same change.

## `--no-fetch`

```
python scripts/refresh_shopify_graphql_catalog.py <surface> <version> --no-fetch
```

Skips the HTTP call and rebuilds `summary.md` from the committed `schema.introspection.json`. Use after editing the build script's grouping/format. SDL is left untouched (so this works without `graphql-core` installed).
