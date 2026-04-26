# Clustering operations in `summary.md`

`summary.md` lists every non-deprecated query/mutation, grouped by **resource cluster** so the architect prompt can be browsed by topic instead of as one ~75 KB flat list.

## Layout

```
# Shopify <Surface> GraphQL — <version>
<intro paragraph>

## Table of Contents
Queries — N ops in K clusters: …
Mutations — N ops in K clusters: …

## Queries — <cluster> (N ops)
<op signatures>

## Mutations — <cluster> (N ops)
<op signatures>
```

## Default clustering rule

`_resource_cluster(op_name, surface)` in [scripts/refresh_shopify_graphql_catalog.py](../scripts/refresh_shopify_graphql_catalog.py) — the **leading run of lowercase letters** of the CamelCase op name.

| op | cluster |
|---|---|
| `order`, `orderUpdate`, `orderCancelByUser` | `order` |
| `orders`, `ordersCount` | `orders` |
| `tagsAdd`, `tagsRemove` | `tags` |
| `bulkOperationCancel` | `bulk` |

Singular and plural variants are deliberately **not** merged — singular getters (`order`) and plural listings/counts (`orders`, `ordersCount`) are different access patterns. They sit alphabetically adjacent in the TOC.

## Post-processing — `_CLUSTER_OVERRIDES`

A small per-surface patch table for ops whose leading lowercase word is an **adjective or verb** rather than the resource. Keyed by exact op name → target cluster.

Authorized override patterns:
- **Verb-shaped** (Shopify broke its own `<resource><Verb>` convention): `removeFromReturn` → `return`.
- **Adjective-prefix** (real resource is the second CamelCase token): `pendingOrdersCount` → `orders`, `publishedProductsCount` → `products`, `assignedFulfillmentOrders` → `fulfillment`, `manualHoldsFulfillmentOrders` → `fulfillment`, `standardMetafieldDefinitionTemplates`/`standardMetafieldDefinitionEnable` → `metafield`, `standardMetaobjectDefinitionEnable` → `metaobject`.

Count-ops always go to the **plural** cluster (next to `ordersCount`, `productsCount`).

NOT overridden — these LOOK adjective-shaped but ARE real Shopify resource names: `BackupRegion`, `CombinedListing`, `StagedUpload`, `OnlineStore`, `ServerPixel`, `AutomaticDiscount*`.

## Drift safety

`_validate_overrides(surface, op_names)` runs after clustering on every refresh and prints a stderr warning for any override entry that is:

1. **Stale op_name** — op no longer exists in the schema (Shopify renamed/removed it).
2. **Stale target** — target cluster has no other ops landing there naturally.

Warn-don't-fail: a single stale entry on a new API version doesn't block the rest of the refresh. Update the table in the same PR.

Surface-scoped: admin overrides don't false-positive on storefront refreshes and vice versa.

## Slicer compatibility

[validation/catalog.py](../validation/catalog.py) `slice_summary()` reads section headers via `startswith("## Queries"/"## Mutations")` — sub-cluster headings extend that pattern transparently. The handler agent always sees one flat `## Queries — N approved` + `## Mutations — N approved` block of approved ops, regardless of how many clusters those ops span in the source.
